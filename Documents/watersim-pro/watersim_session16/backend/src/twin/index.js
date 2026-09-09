/**
 * SafeKrit — Server-side digital twin (Phase 4)
 *
 * The loop that runs whether or not a browser is open. On its cadence, for
 * every flowsheet with an enabled twin:
 *
 *   1. MERGE   every good, recent PLC sample on the flowsheet into the
 *              node parameters it is bound to (the same rule the canvas's
 *              live mode applies in the browser: measured beats modelled);
 *   2. SOLVE   the steady-state model through the existing worker pool;
 *   3. RESIDUALS  for every instrument that has a live measurement, the
 *              model's own reading (`metrics.modelled`) is subtracted from the
 *              transmitter's, the difference is appended to twin_residuals,
 *              and its z is taken against the running spread of that
 *              instrument's residuals (Welford, no history scan);
 *   4. DRIFT   alarm rules of kind 'drift' on the instrument breach when
 *              |z| exceeds their limit — through the ordinary event state
 *              machine, so a drift is acknowledged, tasked and notified like
 *              any other alarm;
 *   5. PERSIST a compact twin_state and broadcast `twin:state` to the
 *              flowsheet room and the organisation room.
 *
 * The twin never evaluates value rules against its results: those belong to
 * the plant (PLC) and to persisted runs. It also never writes a run.
 */
'use strict';

const { query } = require('../db/pool');
const { runSimulation } = require('../simulation/runner');
const { processEvaluation } = require('../alarms/evaluator');
const { buildNodeLabels } = require('../alarms/validTargets');
const { broadcastToRoom, broadcastToOrg } = require('../collab/wsServer');
const { runCounters } = require('./counters');
const logger = require('../utils/logger');

const TICK_MS = Math.max(1000, parseInt(process.env.TWIN_TICK_MS || '5000', 10) || 5000);
const FRESH_MS = Math.max(10_000, parseInt(process.env.TWIN_MEASUREMENT_FRESH_MS || '300000', 10) || 300_000);
const MIN_N_FOR_Z = 5;
const COUNTERS_EVERY_MS = 60_000;

let timer = null;
let running = false;
let lastCountersAt = 0;
const lastSolvedAt = new Map(); // flowsheetId → ms

// ── Measurements → parameters ────────────────────────────────────────────────

/**
 * The flowsheet whose MEASUREMENTS a twin reads. A twin flowsheet imported
 * from a monitoring project carries `source_flowsheet_id`: its PLC bindings,
 * drift rules and instrument tags live on that source. A flowsheet that was
 * not imported is its own source.
 */
async function liveFlowsheetId(flowsheetId) {
  const { rows } = await query('SELECT COALESCE(source_flowsheet_id, id) AS live_id FROM flowsheets WHERE id = $1', [flowsheetId]);
  return rows[0]?.live_id || flowsheetId;
}

/**
 * Good, recent samples on the flowsheet (through its live source), as
 * { nodeId: { paramKey: value } } plus the list of measured instrument points
 * for the residuals.
 */
async function measuredParams(flowsheetId, now = Date.now()) {
  const liveId = await liveFlowsheetId(flowsheetId);
  const { rows } = await query(
    `SELECT b.node_id, b.param_key, b.last_value, b.quality, b.last_read_at, b.tag_id,
            t.tag, t.fn, t.signal_type
       FROM plc_bindings b
       LEFT JOIN tags t ON t.id = b.tag_id
      WHERE b.flowsheet_id = $1 AND b.enabled = TRUE AND b.direction IN ('read', 'read_write')
        AND b.last_value IS NOT NULL AND b.quality = 'good'`,
    [liveId]
  );
  const nodeParams = {};
  const points = [];
  for (const r of rows) {
    if (!r.last_read_at || now - new Date(r.last_read_at).getTime() > FRESH_MS) continue;
    if (!nodeParams[r.node_id]) nodeParams[r.node_id] = {};
    nodeParams[r.node_id][r.param_key] = Number(r.last_value);
    if (r.param_key === 'measured' && r.tag_id) {
      points.push({ tagId: r.tag_id, tag: r.tag, nodeId: r.node_id, measured: Number(r.last_value), at: r.last_read_at });
    }
  }
  return { nodeParams, points };
}

// ── Residual statistics (Welford) ────────────────────────────────────────────

async function updateResidual(tagId, residual, ts) {
  const cur = await query('SELECT n, mean, m2 FROM twin_residual_stats WHERE tag_id = $1', [tagId]);
  let { n, mean, m2 } = cur.rows[0] || { n: 0, mean: 0, m2: 0 };
  n = Number(n); mean = Number(mean); m2 = Number(m2);
  // Drift is the residual leaving its USUAL value: z is taken against the
  // running mean and spread of this instrument's residuals, both from BEFORE
  // this sample, so a systematic model offset is not drift and a single wild
  // reading cannot widen the band it is judged against.
  const sd = n > 1 ? Math.sqrt(m2 / (n - 1)) : 0;
  const z = n >= MIN_N_FOR_Z && sd > 1e-9 ? (residual - mean) / sd : 0;
  const n1 = n + 1;
  const delta = residual - mean;
  const mean1 = mean + delta / n1;
  const m21 = m2 + delta * (residual - mean1);
  await query(
    `INSERT INTO twin_residual_stats (tag_id, n, mean, m2, last_z, updated_at) VALUES ($1, $2, $3, $4, $5, NOW())
     ON CONFLICT (tag_id) DO UPDATE SET n = EXCLUDED.n, mean = EXCLUDED.mean, m2 = EXCLUDED.m2, last_z = EXCLUDED.last_z, updated_at = NOW()`,
    [tagId, n1, mean1, m21, z]
  );
  await query('INSERT INTO twin_residuals (tag_id, ts, modelled, measured, residual, z) VALUES ($1, $2, $3, $4, $5, $6)',
    [tagId, ts, null, null, residual, z]).catch(() => {});
  return { z, n: n1, sd };
}

// ── One solve ────────────────────────────────────────────────────────────────

/**
 * Solve one flowsheet's twin now. Returns the state row's content. Errors are
 * recorded on twin_state (`error`) and returned, never thrown, so the loop
 * keeps every other twin running.
 */
async function solveTwin(flowsheetId, { now = Date.now(), reason = 'cadence' } = {}) {
  const t0 = Date.now();
  const fs = await query(
    `SELECT f.id, f.canvas_data, f.name, p.organisation_id, p.settings,
            COALESCE(f.source_flowsheet_id, f.id) AS live_id,
            c.drift_z, c.enabled
       FROM flowsheets f JOIN projects p ON p.id = f.project_id
       LEFT JOIN twin_config c ON c.flowsheet_id = f.id
      WHERE f.id = $1`,
    [flowsheetId]
  );
  const row = fs.rows[0];
  if (!row) return null;
  const orgId = row.organisation_id;
  // Drift rules and the alarms they raise belong to the PLANT's flowsheet.
  const liveId = row.live_id;
  const canvasData = row.canvas_data || { nodes: [], edges: [] };
  lastSolvedAt.set(flowsheetId, now);

  const { nodeParams, points } = await measuredParams(flowsheetId, now);

  let results = null;
  let error = null;
  try {
    const permit = await query(
      `SELECT permit_limits FROM permit_templates WHERE organisation_id = $1 AND is_active = TRUE ORDER BY created_at DESC LIMIT 1`, [orgId]
    ).catch(() => ({ rows: [] }));
    results = await runSimulation({
      mode: 'steady_state', canvasData,
      config: { nodeParams, timeSeriesConfig: null, permitLimits: permit.rows[0]?.permit_limits || null },
    });
  } catch (err) {
    error = err.message;
  }

  // ── Residuals ──
  const residuals = [];
  if (results?.unitResults) {
    const ts = new Date(now);
    for (const p of points) {
      const m = results.unitResults[p.nodeId]?.metrics;
      const modelled = m && Number.isFinite(Number(m.modelled)) ? Number(m.modelled) : null;
      if (modelled == null) continue;
      const residual = p.measured - modelled;
      try {
        const { z, n } = await updateResidual(p.tagId, residual, ts);
        await query('UPDATE twin_residuals SET modelled = $3, measured = $4 WHERE tag_id = $1 AND ts = $2', [p.tagId, ts, modelled, p.measured]).catch(() => {});
        residuals.push({ tagId: p.tagId, tag: p.tag, nodeId: p.nodeId, measured: p.measured, modelled, residual, z, n, unit: m.unit || null });
      } catch (err) {
        logger.warn('Twin residual update failed', { tagId: p.tagId, err: err.message });
      }
    }
  }

  // ── Drift alarms ──
  if (residuals.length) await evaluateDrift(liveId, orgId, residuals, canvasData);

  // ── Compact state ──
  const nodeMetrics = {};
  for (const [id, u] of Object.entries(results?.unitResults || {})) nodeMetrics[id] = { type: u.type, metrics: u.metrics || {} };
  const summary = results?.summary || null;
  const durationMs = Date.now() - t0;
  const measured = Object.fromEntries(points.map((p) => [p.tagId, { tag: p.tag, nodeId: p.nodeId, value: p.measured, at: p.at }]));
  const { rows } = await query(
    `INSERT INTO twin_state (flowsheet_id, organisation_id, seq, solved_at, duration_ms, summary, node_metrics, node_params, measured, residuals, error)
     VALUES ($1, $2, 1, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (flowsheet_id) DO UPDATE SET
       seq = twin_state.seq + 1, solved_at = EXCLUDED.solved_at, duration_ms = EXCLUDED.duration_ms,
       summary = EXCLUDED.summary, node_metrics = EXCLUDED.node_metrics, node_params = EXCLUDED.node_params,
       measured = EXCLUDED.measured, residuals = EXCLUDED.residuals, error = EXCLUDED.error, updated_at = NOW()
     RETURNING seq`,
    [flowsheetId, orgId, error ? null : new Date(now), durationMs, JSON.stringify(summary), JSON.stringify(nodeMetrics),
     JSON.stringify(nodeParams), JSON.stringify(measured), JSON.stringify(residuals), error]
  );

  const state = { flowsheetId, seq: Number(rows[0]?.seq || 0), solvedAt: error ? null : new Date(now).toISOString(), durationMs, summary, nodeMetrics, nodeParams, measured, residuals, error, reason };
  try {
    const message = { type: 'twin:state', payload: { flowsheetId, seq: state.seq, solvedAt: state.solvedAt, summary, residuals, error, durationMs } };
    broadcastToRoom(flowsheetId, message);
    broadcastToOrg(orgId, message);
  } catch (err) { logger.debug('Twin broadcast failed', { err: err.message }); }
  if (error) logger.warn('Twin solve failed', { flowsheetId, err: error });
  return state;
}

/** Drift rules: |z| above the rule's max_value on the instrument's `measured`. */
async function evaluateDrift(flowsheetId, orgId, residuals, canvasData) {
  try {
    const { rows: rules } = await query(
      `SELECT * FROM alarm_rules WHERE flowsheet_id = $1 AND organisation_id = $2 AND enabled = TRUE AND kind = 'drift'`,
      [flowsheetId, orgId]
    );
    if (!rules.length) return;
    const byNode = new Map(residuals.map((r) => [r.nodeId, r]));
    const breaches = [];
    const evaluated = [];
    for (const rule of rules) {
      const r = byNode.get(rule.node_id);
      if (!r || rule.param_key !== 'measured') continue; // no measurement this pass → not evaluated, never cleared by absence
      evaluated.push(rule.id);
      if (Math.abs(r.z) > Number(rule.max_value)) breaches.push({ rule, value: +r.z.toFixed(3) });
    }
    if (!evaluated.length) return;
    await processEvaluation(flowsheetId, orgId, breaches, evaluated, {
      source: 'simulation', nodeLabels: buildNodeLabels(canvasData),
      rulesById: Object.fromEntries(rules.map((x) => [x.id, x])),
    });
  } catch (err) {
    logger.warn('Twin drift evaluation failed', { flowsheetId, err: err.message });
  }
}

// ── The loop ─────────────────────────────────────────────────────────────────

async function tick(now = Date.now()) {
  const { rows } = await query(`SELECT flowsheet_id, cadence_s FROM twin_config WHERE enabled = TRUE`);
  const due = rows.filter((c) => now - (lastSolvedAt.get(c.flowsheet_id) || 0) >= Number(c.cadence_s) * 1000);
  for (const c of due) {
    try { await solveTwin(c.flowsheet_id, { now }); } catch (err) { logger.warn('Twin solve threw', { flowsheetId: c.flowsheet_id, err: err.message }); }
  }
  if (now - lastCountersAt >= COUNTERS_EVERY_MS) {
    lastCountersAt = now;
    await runCounters(now).catch((err) => logger.warn('Equipment counters failed', { err: err.message }));
  }
  return due.length;
}

function startTwin({ force = false, tickMs = TICK_MS } = {}) {
  if (timer) return;
  if (process.env.NODE_ENV === 'test' && !force) return;
  timer = setInterval(async () => {
    if (running) return;
    running = true;
    try { await tick(); } catch (err) { logger.error('Twin tick failed', { error: err.message }); } finally { running = false; }
  }, tickMs);
  timer.unref();
  logger.info('Digital twin loop started', { tickMs });
}

function stopTwin() {
  if (timer) { clearInterval(timer); timer = null; }
}

module.exports = { solveTwin, measuredParams, evaluateDrift, tick, startTwin, stopTwin, updateResidual, liveFlowsheetId, MIN_N_FOR_Z };
