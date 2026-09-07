/**
 * WaterSim Pro — Comms-loss alarm sweep
 *
 * The one alarm that fires when the PLC STOPS talking. A rule of
 * kind = 'quality' names a bound parameter and a `stale_after_s`; the sweep
 * runs every few seconds and breaches the rule when the binding's last sample
 * is not good, or is older than the limit. The value carried on the event is
 * the seconds since the last good read, so the message and the history both
 * say how long the point was dark.
 *
 * Everything else — one active event per rule, clear on recovery, broadcast,
 * acknowledgement — is the ordinary state machine in evaluator.js. This file
 * only decides which quality rules are breached and hands them over.
 *
 * A rule whose target has no binding is not a breach: there is nothing to
 * lose contact with. It is reported by GET /alarms as `unbound` instead.
 */
'use strict';

const { query } = require('../db/pool');
const { processEvaluation } = require('./evaluator');
const { buildNodeLabels } = require('./validTargets');
const logger = require('../utils/logger');

const SWEEP_MS = Math.max(1000, parseInt(process.env.ALARM_QUALITY_SWEEP_MS || '5000', 10) || 5000);
const LABEL_TTL_MS = 60_000;

const labelCache = new Map(); // flowsheetId -> { at, labels }
let timer = null;
let running = false;

async function nodeLabelsFor(flowsheetId) {
  const hit = labelCache.get(flowsheetId);
  if (hit && Date.now() - hit.at < LABEL_TTL_MS) return hit.labels;
  const f = await query('SELECT canvas_data FROM flowsheets WHERE id = $1', [flowsheetId]);
  const labels = buildNodeLabels(f.rows[0]?.canvas_data);
  labelCache.set(flowsheetId, { at: Date.now(), labels });
  return labels;
}

/**
 * Decide whether a binding state breaches a quality rule.
 * @returns {{ breached: boolean, staleS: number|null }}
 */
function judge(rule, binding, now = Date.now()) {
  if (!binding || binding.enabled === false) return { breached: false, staleS: null };
  const lastGood = binding.last_read_at ? new Date(binding.last_read_at).getTime() : null;
  const staleS = lastGood == null ? null : Math.max(0, Math.round((now - lastGood) / 1000));
  const limit = Number(rule.stale_after_s) || 0;
  if (binding.quality !== 'good') return { breached: true, staleS };
  if (lastGood == null) return { breached: true, staleS: null };
  return { breached: staleS > limit, staleS };
}

/** One pass over every enabled quality rule. Exported for tests. Never throws. */
async function sweep(now = Date.now()) {
  try {
    const { rows } = await query(
      `SELECT r.*, b.id AS binding_id, b.quality AS b_quality, b.last_read_at AS b_last_read_at,
              b.enabled AS b_enabled
         FROM alarm_rules r
         LEFT JOIN plc_bindings b
           ON b.flowsheet_id = r.flowsheet_id AND b.node_id = r.node_id AND b.param_key = r.param_key
        WHERE r.enabled = TRUE AND r.kind = 'quality'`
    );
    if (!rows.length) return { rules: 0, breaches: 0 };

    const byFlowsheet = new Map();
    for (const r of rows) {
      if (!byFlowsheet.has(r.flowsheet_id)) byFlowsheet.set(r.flowsheet_id, []);
      byFlowsheet.get(r.flowsheet_id).push(r);
    }

    let breachCount = 0;
    for (const [flowsheetId, rules] of byFlowsheet) {
      const breaches = [];
      for (const r of rules) {
        const binding = r.binding_id
          ? { enabled: r.b_enabled, quality: r.b_quality, last_read_at: r.b_last_read_at }
          : null;
        const { breached, staleS } = judge(r, binding, now);
        if (breached) breaches.push({ rule: r, value: staleS ?? Number(r.stale_after_s) });
      }
      breachCount += breaches.length;
      const nodeLabels = await nodeLabelsFor(flowsheetId).catch(() => ({}));
      await processEvaluation(flowsheetId, rules[0].organisation_id, breaches, rules.map((r) => r.id), {
        source: 'plc',
        nodeLabels,
        rulesById: Object.fromEntries(rules.map((r) => [r.id, r])),
      });
    }
    return { rules: rows.length, breaches: breachCount };
  } catch (err) {
    logger.warn('Quality sweep failed', { err: err.message });
    return { rules: 0, breaches: 0, error: err.message };
  }
}

function startQualitySweep({ force = false, intervalMs = SWEEP_MS } = {}) {
  if (timer) return;
  if (process.env.NODE_ENV === 'test' && !force) return;
  timer = setInterval(async () => {
    if (running) return;
    running = true;
    try { await sweep(); } finally { running = false; }
  }, intervalMs);
  timer.unref();
  logger.info('Alarm quality sweep started', { intervalMs });
}

function stopQualitySweep() {
  if (timer) { clearInterval(timer); timer = null; }
}

module.exports = { sweep, judge, startQualitySweep, stopQualitySweep };
