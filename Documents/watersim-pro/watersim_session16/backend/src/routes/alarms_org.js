/**
 * WaterSim Pro — Org-level alarm API
 *
 * Mounted at: /api/v1/alarms
 *
 *   GET  /alarms/events             — org-wide event history (filtered, paged)
 *   POST /alarms/events/:id/ack     — acknowledge an event (operator+, idempotent)
 *   GET  /alarms/events/export.csv  — the same query as CSV (Node-generated)
 *   GET  /alarms/report/pdf         — the same query as a reportlab PDF
 *
 * Every query is scoped by organisation_id; the projects join additionally
 * keeps events from deleted projects out of the org-wide views.
 */
'use strict';

const path = require('path');
const express = require('express');
const { param, query: qv, validationResult } = require('express-validator');
const { query } = require('../db/pool');
const { authenticate, requireRole } = require('../middleware/auth');
const { auditLog } = require('../utils/audit');
const { runPython } = require('../reports/pySpawn');
const logger = require('../utils/logger');

const PY_SCRIPT = path.join(__dirname, '..', 'alarms', 'alarm_report.py');

const router = express.Router();
router.use(authenticate);

function vErr(req, res) {
  const e = validationResult(req);
  if (!e.isEmpty()) { res.status(422).json({ error: 'Validation failed', details: e.array() }); return true; }
  return false;
}

const orgId = (req) => req.user.org || req.user.organisationId;

// ── Shared filtering ─────────────────────────────────────────────────────────

const FROM = `
  FROM alarm_events e
  JOIN alarm_rules  r ON r.id = e.rule_id
  JOIN flowsheets   f ON f.id = e.flowsheet_id
  JOIN projects     p ON p.id = f.project_id
  LEFT JOIN users   u ON u.id = e.acknowledged_by`;

/** Filters shared by the list, CSV and PDF endpoints (validators below). */
const eventFilters = [
  qv('flowsheetId').optional().isUUID(),
  qv('severity').optional().isIn(['info', 'warning', 'critical']),
  qv('state').optional().isIn(['active', 'cleared']),
  qv('acknowledged').optional().isBoolean().toBoolean(),
  qv('from').optional().isISO8601(),
  qv('to').optional().isISO8601(),
];

/**
 * Build the WHERE clause + params for the current request.
 * @returns {{ where: string, params: Array, next: number }}
 */
function buildWhere(req) {
  const params = [orgId(req)];
  let where = ` WHERE e.organisation_id = $1 AND p.status != 'deleted'`;
  let i = 2;

  if (req.query.flowsheetId)  { where += ` AND e.flowsheet_id = $${i++}`; params.push(req.query.flowsheetId); }
  if (req.query.severity)     { where += ` AND e.severity = $${i++}`;     params.push(req.query.severity); }
  if (req.query.state)        { where += ` AND e.state = $${i++}`;        params.push(req.query.state); }
  if (req.query.acknowledged !== undefined) {
    where += ` AND e.acknowledged = $${i++}`; params.push(req.query.acknowledged);
  }
  if (req.query.from)         { where += ` AND e.triggered_at >= $${i++}::timestamptz`; params.push(req.query.from); }
  if (req.query.to)           { where += ` AND e.triggered_at <= $${i++}::timestamptz`; params.push(req.query.to); }

  return { where, params, next: i };
}

const EVENT_COLUMNS = `
  e.id, e.rule_id, e.flowsheet_id, e.run_id, e.source, e.state, e.severity,
  e.message, e.value, e.limit_min, e.limit_max, e.triggered_at, e.last_seen_at,
  e.cleared_at, e.acknowledged, e.acknowledged_by, e.acknowledged_at,
  r.name AS rule_name,
  f.name AS flowsheet_name,
  p.id   AS project_id,
  p.name AS project_name,
  CASE WHEN u.id IS NULL THEN NULL ELSE u.first_name || ' ' || u.last_name END AS acknowledged_by_name`;

/** Fetch the filtered events, newest first. */
async function fetchEvents(req, limit, offset = 0) {
  const { where, params, next } = buildWhere(req);
  const sql = `SELECT ${EVENT_COLUMNS} ${FROM} ${where}
               ORDER BY e.triggered_at DESC, e.id DESC
               LIMIT $${next} OFFSET $${next + 1}`;
  const r = await query(sql, [...params, limit, offset]);
  return r.rows;
}

function formatEvent(row) {
  return {
    id:                row.id,
    ruleId:            row.rule_id,
    ruleName:          row.rule_name,
    flowsheetId:       row.flowsheet_id,
    flowsheetName:     row.flowsheet_name,
    projectId:         row.project_id,
    projectName:       row.project_name,
    runId:             row.run_id,
    source:            row.source,
    state:             row.state,
    severity:          row.severity,
    message:           row.message,
    value:             row.value,
    limitMin:          row.limit_min,
    limitMax:          row.limit_max,
    triggeredAt:       row.triggered_at,
    lastSeenAt:        row.last_seen_at,
    clearedAt:         row.cleared_at,
    acknowledged:      row.acknowledged,
    acknowledgedBy:    row.acknowledged_by,
    acknowledgedByName: row.acknowledged_by_name,
    acknowledgedAt:    row.acknowledged_at,
  };
}

// ── GET /alarms/events — org-wide history ────────────────────────────────────
router.get('/events', [
  ...eventFilters,
  qv('limit').optional().isInt({ min: 1, max: 200 }).toInt(),
  qv('offset').optional().isInt({ min: 0 }).toInt(),
], async (req, res, next) => {
  if (vErr(req, res)) return;
  try {
    const limit  = req.query.limit  || 50;
    const offset = req.query.offset || 0;

    const { where, params } = buildWhere(req);
    const [countRes, rows] = await Promise.all([
      query(`SELECT COUNT(*)::int AS n ${FROM} ${where}`, params),
      fetchEvents(req, limit, offset),
    ]);

    res.json({ total: countRes.rows[0].n, events: rows.map(formatEvent) });
  } catch (err) { next(err); }
});

// ── GET /alarms/events/export.csv ────────────────────────────────────────────
//
// Node-generated CSV (no Python): every field is escaped for embedded quotes,
// commas and newlines so a multi-line alarm message can never break the row
// structure of the download.

const CSV_HEADER = [
  'triggered_at', 'cleared_at', 'state', 'severity', 'rule', 'flowsheet', 'project',
  'message', 'value', 'min', 'max', 'source', 'acknowledged', 'acknowledged_by',
  'acknowledged_at',
];

/** RFC4180 field escaping. */
function csvCell(v) {
  if (v === null || v === undefined) return '';
  const s = v instanceof Date ? v.toISOString() : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const csvRow = (cells) => cells.map(csvCell).join(',');

router.get('/events/export.csv', eventFilters, async (req, res, next) => {
  if (vErr(req, res)) return;
  try {
    const rows = await fetchEvents(req, 5000, 0);

    const lines = [csvRow(CSV_HEADER)];
    for (const e of rows) {
      lines.push(csvRow([
        e.triggered_at, e.cleared_at, e.state, e.severity, e.rule_name,
        e.flowsheet_name, e.project_name, e.message, e.value, e.limit_min,
        e.limit_max, e.source, e.acknowledged, e.acknowledged_by_name,
        e.acknowledged_at,
      ]));
    }

    const filename = `watersim_alarms_${new Date().toISOString().slice(0, 10)}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Cache-Control', 'private, max-age=60');
    res.send(lines.join('\r\n'));
  } catch (err) { next(err); }
});

// ── GET /alarms/report/pdf ───────────────────────────────────────────────────

const PDF_EVENT_LIMIT = 500;

/** Compact human number: 52.1 stays "52.1", 3.14159265 → "3.14159". */
function fmtNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? String(Number(n.toPrecision(6))) : null;
}

/** "12.4 / max 10", "3 / min 5", "12.4 / 5–10" or just the value. */
function valueLimit(row) {
  const v   = fmtNum(row.value);
  const min = fmtNum(row.limit_min);
  const max = fmtNum(row.limit_max);
  const val = v === null ? '—' : v;
  if (min !== null && max !== null) return `${val} / ${min}–${max}`;
  if (max !== null) return `${val} / max ${max}`;
  if (min !== null) return `${val} / min ${min}`;
  return val;
}

const iso = (d) => (d instanceof Date ? d.toISOString() : (d || null));

router.get('/report/pdf', eventFilters, async (req, res, next) => {
  if (vErr(req, res)) return;
  try {
    const { where, params } = buildWhere(req);

    const [rows, tiles, frequent, orgRow] = await Promise.all([
      fetchEvents(req, PDF_EVENT_LIMIT, 0),
      query(
        `SELECT COUNT(*)::int                                                     AS total,
                COUNT(*) FILTER (WHERE e.severity = 'critical')::int              AS critical,
                COUNT(*) FILTER (WHERE e.severity = 'warning')::int               AS warning,
                COUNT(*) FILTER (WHERE e.severity = 'info')::int                  AS info,
                COUNT(*) FILTER (WHERE e.state = 'active')::int                   AS active,
                COUNT(*) FILTER (WHERE e.state = 'cleared')::int                  AS cleared,
                COUNT(*) FILTER (WHERE e.acknowledged)::int                       AS acknowledged,
                MIN(e.triggered_at)                                               AS first_at,
                MAX(e.triggered_at)                                               AS last_at
         ${FROM} ${where}`,
        params
      ),
      query(
        `SELECT r.name AS rule_name, COUNT(*)::int AS count, MAX(e.triggered_at) AS last_seen
         ${FROM} ${where}
         GROUP BY r.name
         ORDER BY count DESC, last_seen DESC
         LIMIT 10`,
        params
      ),
      query(`SELECT name FROM organisations WHERE id = $1`, [orgId(req)]),
    ]);

    const t = tiles.rows[0] || {};
    const payload = {
      org_name:     orgRow.rows[0]?.name || '',
      generated_at: new Date().toISOString(),
      filters: {
        flowsheetId:  req.query.flowsheetId  || null,
        severity:     req.query.severity     || null,
        state:        req.query.state        || null,
        acknowledged: req.query.acknowledged !== undefined ? req.query.acknowledged : null,
      },
      period: {
        from:  req.query.from || iso(t.first_at),
        to:    req.query.to   || iso(t.last_at),
      },
      tiles: {
        total:        t.total        || 0,
        critical:     t.critical     || 0,
        warning:      t.warning      || 0,
        info:         t.info         || 0,
        active:       t.active       || 0,
        cleared:      t.cleared      || 0,
        acknowledged: t.acknowledged || 0,
      },
      frequent: frequent.rows.map((f) => ({
        rule:     f.rule_name,
        count:    f.count,
        lastSeen: iso(f.last_seen),
      })),
      truncated: (t.total || 0) > PDF_EVENT_LIMIT,
      eventLimit: PDF_EVENT_LIMIT,
      events: rows.map((e) => ({
        triggeredAt: iso(e.triggered_at),
        severity:    e.severity,
        rule:        e.rule_name,
        flowsheet:   e.flowsheet_name,
        project:     e.project_name,
        message:     e.message,
        valueLimit:  valueLimit(e),
        state:       e.state,
        acknowledged: e.acknowledged,
      })),
    };

    logger.info('Generating alarm PDF report', { org: orgId(req), events: payload.events.length });
    const pdfBuffer = await runPython(PY_SCRIPT, payload, 'Alarm PDF');

    const filename = `watersim_alarms_${new Date().toISOString().slice(0, 10)}.pdf`;
    res.setHeader('Content-Type',        'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length',      pdfBuffer.length);
    res.setHeader('Cache-Control',       'private, max-age=60');
    res.send(pdfBuffer);
  } catch (err) {
    logger.error('Alarm PDF generation error', { error: err.message });
    next(err);
  }
});

// ── POST /alarms/events/:id/ack — acknowledge (operator+) ────────────────────
//
// Idempotent: COALESCE keeps the FIRST acknowledger, so a repeat ack returns
// 200 with the unchanged row rather than rewriting who saw it first.
router.post('/events/:id/ack', requireRole('operator'), [
  param('id').isUUID(),
], async (req, res, next) => {
  if (vErr(req, res)) return;
  try {
    const r = await query(
      `UPDATE alarm_events
       SET acknowledged    = TRUE,
           acknowledged_by = COALESCE(acknowledged_by, $1),
           acknowledged_at = COALESCE(acknowledged_at, NOW())
       WHERE id = $2 AND organisation_id = $3
       RETURNING *`,
      [req.user.sub || req.user.id, req.params.id, orgId(req)]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'Alarm event not found' });

    auditLog(req, 'alarm_event.ack', 'alarm_event', req.params.id, {
      flowsheetId: r.rows[0].flowsheet_id,
      ruleId:      r.rows[0].rule_id,
      severity:    r.rows[0].severity,
      state:       r.rows[0].state,
    });
    res.json(r.rows[0]);
  } catch (err) { next(err); }
});

module.exports = router;
