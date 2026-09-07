/**
 * WaterSim Pro — Period report
 *
 * Every report builder before Phase 1 took a simulation RUN. This one takes a
 * PERIOD: the historian's series for a set of tags between two instants, the
 * statistics over that window, and the alarm events raised on the tags'
 * flowsheets in the same window. CSV is produced here; PDF and Excel go
 * through the same hardened Python runner as the run reports, with
 * period_report.py doing the drawing.
 */
'use strict';

const path = require('path');
const { query } = require('../db/pool');
const { readHistory, historyToCsv } = require('../historian/query');
const { runPython } = require('./pySpawn');

const PY_SCRIPT = path.join(__dirname, 'period_report.py');

const CONTENT_TYPES = {
  csv: 'text/csv; charset=utf-8',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pdf: 'application/pdf',
};

const opErr = (message, status) => Object.assign(new Error(message), { status, isOperational: true });

/**
 * Assemble the payload the Python script draws from. Exported so the JSON can
 * be tested without Python.
 */
async function buildPeriodPayload({ orgId, userId, tagIds, from, to, bucket = 'auto', title }) {
  const history = await readHistory({ orgId, tagIds, from, to, bucket, maxPoints: 2000 });
  if (!history.series.length) throw opErr('None of those tags belong to your organisation', 404);

  const [org, user, fs] = await Promise.all([
    query('SELECT name FROM organisations WHERE id = $1', [orgId]),
    userId ? query('SELECT first_name, last_name, email FROM users WHERE id = $1', [userId]) : { rows: [] },
    query('SELECT DISTINCT flowsheet_id FROM tags WHERE id = ANY($1::uuid[]) AND flowsheet_id IS NOT NULL', [history.series.map((s) => s.tagId)]),
  ]);
  const flowsheetIds = fs.rows.map((r) => r.flowsheet_id);

  let events = [];
  if (flowsheetIds.length) {
    const ev = await query(
      `SELECT e.triggered_at, e.cleared_at, e.severity, e.state, e.message, e.acknowledged, r.name AS rule
         FROM alarm_events e JOIN alarm_rules r ON r.id = e.rule_id
        WHERE e.organisation_id = $1 AND e.flowsheet_id = ANY($2::uuid[])
          AND e.triggered_at >= $3 AND e.triggered_at < $4
        ORDER BY e.triggered_at DESC LIMIT 200`,
      [orgId, flowsheetIds, from, to]
    );
    events = ev.rows.map((e) => ({
      triggeredAt: new Date(e.triggered_at).toISOString(),
      clearedAt: e.cleared_at ? new Date(e.cleared_at).toISOString() : null,
      severity: e.severity, state: e.state, rule: e.rule, message: e.message, acknowledged: !!e.acknowledged,
    }));
  }

  const who = user.rows[0] ? [user.rows[0].first_name, user.rows[0].last_name].filter(Boolean).join(' ') || user.rows[0].email : null;

  return {
    title: title || 'Plant history report',
    org: org.rows[0]?.name || null,
    generatedAt: new Date().toISOString(),
    generatedBy: who,
    from: from.toISOString(),
    to: to.toISOString(),
    bucket: history.bucket,
    series: history.series.map((s) => {
      const withValue = s.points.filter((p) => p[1] != null).length;
      return {
        tagId: s.tagId, tag: s.tag, name: s.name, unit: s.unit, area: s.area, kind: s.kind,
        signalType: s.signalType, rangeMin: s.rangeMin, rangeMax: s.rangeMax,
        stats: { ...s.stats, availabilityPct: s.points.length ? +((withValue / s.points.length) * 100).toFixed(1) : 0 },
        points: s.points.map((p) => [new Date(p[0]).toISOString(), p[1], p[2], p[3]]),
      };
    }),
    events,
    counts: {
      critical: events.filter((e) => e.severity === 'critical').length,
      warning: events.filter((e) => e.severity === 'warning').length,
      info: events.filter((e) => e.severity === 'info').length,
    },
    _history: history,
  };
}

/**
 * @returns {Promise<{ buffer: Buffer, filename: string, contentType: string }>}
 */
async function buildPeriodReport({ format = 'pdf', ...rest }) {
  const payload = await buildPeriodPayload(rest);
  const stamp = `${payload.from.slice(0, 10)}_${payload.to.slice(0, 10)}`;
  const filename = `watersim_history_${stamp}.${format}`;

  if (format === 'csv') {
    return { buffer: Buffer.from(historyToCsv(payload._history, 'avg'), 'utf8'), filename, contentType: CONTENT_TYPES.csv };
  }
  const { _history, ...forPython } = payload;
  const buffer = await runPython(PY_SCRIPT, { ...forPython, format }, format === 'pdf' ? 'Period PDF' : 'Period Excel');
  return { buffer, filename, contentType: CONTENT_TYPES[format] };
}

module.exports = { buildPeriodReport, buildPeriodPayload };
