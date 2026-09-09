/**
 * SafeKrit — Digital twin API (Phase 4)
 *
 * Mounted at: /api/v1/twin
 *
 *   GET  /twin                              every flowsheet in the org with its twin config and last state
 *   GET  /twin/:flowsheetId                 config + latest state (summary, per-node metrics, residuals)
 *   PUT  /twin/:flowsheetId                 { enabled, cadenceS, driftZ }          (engineer+ · twin.configure)
 *   POST /twin/:flowsheetId/solve           solve now                              (engineer+ · twin.configure)
 *   GET  /twin/:flowsheetId/residuals       residual series per instrument (?range=24h)
 *   POST /twin/:flowsheetId/scenarios       what-if from the live state           (operator+ · scenario.run)
 *   GET  /twin/counters                     run hours / starts / trips per drive  (?loopTag=&days=)
 *   GET  /twin/scripts                      the commissioning scripts
 *   POST /twin/:flowsheetId/scripts/:id/run play one in shadow mode              (engineer+ · twin.commission)
 *   GET  /twin/:flowsheetId/scripts/runs    recent runs · POST …/runs/:runId/cancel
 *   PUT  /twin/connections/:id/mode         { mode: 'live' | 'shadow' }           (enter: engineer+ · leave: manager+)
 */
'use strict';

const express = require('express');
const { body, param, query: qv, validationResult } = require('express-validator');
const { query } = require('../db/pool');
const { authenticate, requireCapability } = require('../middleware/auth');
const { can } = require('../auth/roles');
const { auditLog } = require('../utils/audit');
const { runSimulation } = require('../simulation/runner');
const { broadcastToOrg } = require('../collab/wsServer');
const twin = require('../twin');
const { readCounters } = require('../twin/counters');
const scripts = require('../twin/scripts');

const router = express.Router();
router.use(authenticate);
router.use(requireCapability('twin.view'));

const orgId = (req) => req.user.org || req.user.organisationId;
const userId = (req) => req.user.sub || req.user.id;

function vErr(req, res) {
  const e = validationResult(req);
  if (!e.isEmpty()) { res.status(422).json({ error: 'Validation failed', details: e.array() }); return true; }
  return false;
}
const opErr = (res, err, next) => (err.isOperational && err.status ? res.status(err.status).json({ error: err.message }) : next(err));

async function ownFlowsheet(req, res) {
  const r = await query(
    `SELECT f.id, f.name, f.canvas_data, p.id AS project_id, p.name AS project_name,
            COALESCE(f.source_flowsheet_id, f.id) AS live_id, f.source_flowsheet_id
       FROM flowsheets f JOIN projects p ON p.id = f.project_id
      WHERE f.id = $1 AND p.organisation_id = $2 AND p.status != 'deleted'`,
    [req.params.flowsheetId, orgId(req)]
  );
  if (!r.rows[0]) { res.status(404).json({ error: 'Flowsheet not found' }); return null; }
  return r.rows[0];
}

const fmtConfig = (c) => (c ? { enabled: c.enabled, cadenceS: c.cadence_s, driftZ: Number(c.drift_z), updatedAt: c.updated_at } : { enabled: false, cadenceS: 60, driftZ: 3, updatedAt: null });
const fmtState = (s) => (s ? {
  seq: Number(s.seq), solvedAt: s.solved_at, durationMs: s.duration_ms, summary: s.summary, nodeMetrics: s.node_metrics,
  nodeParams: s.node_params, measured: s.measured, residuals: s.residuals || [], error: s.error, updatedAt: s.updated_at,
} : null);

// ── Static-path routes first ─────────────────────────────────────────────────
router.get('/counters', [qv('loopTag').optional().isString().trim(), qv('days').optional().isInt({ min: 1, max: 365 }).toInt()], async (req, res, next) => {
  if (vErr(req, res)) return;
  try { res.json({ drives: await readCounters(orgId(req), { loopTag: req.query.loopTag || null, days: req.query.days || 30 }) }); }
  catch (err) { next(err); }
});

router.get('/scripts', (_req, res) => res.json({ scripts: scripts.listScripts() }));

router.put('/connections/:id/mode', [param('id').isUUID(), body('mode').isIn(['live', 'shadow'])], async (req, res, next) => {
  if (vErr(req, res)) return;
  try {
    const cur = await query('SELECT * FROM plc_connections WHERE id = $1 AND organisation_id = $2', [req.params.id, orgId(req)]);
    if (!cur.rows[0]) return res.status(404).json({ error: 'Connection not found' });
    const c = cur.rows[0];
    const to = req.body.mode;
    if (to === c.mode) return res.json({ id: c.id, name: c.name, mode: c.mode, changed: false });
    // Entering shadow is an engineer's act; leaving it is a manager's.
    const cap = to === 'shadow' ? 'twin.commission' : 'task.approve';
    if (!can(req.user.role, cap)) return res.status(403).json({ error: `Switching to ${to} needs ${cap}` });
    const r = await query(
      `UPDATE plc_connections SET mode = $1, mode_changed_by = $2, mode_changed_at = NOW() WHERE id = $3 RETURNING id, name, mode, mode_changed_at`,
      [to, userId(req), c.id]
    );
    auditLog(req, `plc_connection.mode.${to}`, 'plc_connection', c.id, { from: c.mode, to, name: c.name });
    broadcastToOrg(orgId(req), { type: 'twin:mode', payload: { connectionId: c.id, name: c.name, mode: to, by: userId(req), at: r.rows[0].mode_changed_at } });
    res.json({ ...r.rows[0], changed: true });
  } catch (err) { next(err); }
});

// ── GET /twin ────────────────────────────────────────────────────────────────
router.get('/', async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT f.id, f.name, p.id AS project_id, p.name AS project_name,
              f.source_flowsheet_id, p.source_project_id, sp.name AS source_project_name,
              c.enabled, c.cadence_s, c.drift_z, c.updated_at AS config_updated_at,
              s.seq, s.solved_at, s.duration_ms, s.summary, s.residuals, s.error,
              (SELECT COUNT(*)::int FROM plc_bindings b WHERE b.flowsheet_id = COALESCE(f.source_flowsheet_id, f.id) AND b.enabled = TRUE) AS bound_points,
              (SELECT COUNT(*)::int FROM alarm_events e WHERE e.flowsheet_id = COALESCE(f.source_flowsheet_id, f.id) AND e.state = 'active' AND e.source = 'simulation') AS drift_alarms
         FROM flowsheets f JOIN projects p ON p.id = f.project_id
         LEFT JOIN projects sp ON sp.id = p.source_project_id
         LEFT JOIN twin_config c ON c.flowsheet_id = f.id
         LEFT JOIN twin_state  s ON s.flowsheet_id = f.id
        WHERE p.organisation_id = $1 AND p.status = 'active' AND p.kind = 'twin' AND f.is_snapshot = false
        ORDER BY c.enabled DESC NULLS LAST, p.name, f.name`,
      [orgId(req)]
    );
    const conns = await query(`SELECT id, name, protocol, mode, mode_changed_at FROM plc_connections WHERE organisation_id = $1 ORDER BY name`, [orgId(req)]);
    res.json({
      twins: rows.map((r) => ({
        flowsheetId: r.id, flowsheetName: r.name, projectId: r.project_id, projectName: r.project_name,
        sourceFlowsheetId: r.source_flowsheet_id, sourceProjectId: r.source_project_id, sourceProjectName: r.source_project_name,
        config: r.cadence_s != null ? fmtConfig(r) : fmtConfig(null),
        state: r.seq != null ? { seq: Number(r.seq), solvedAt: r.solved_at, durationMs: r.duration_ms, summary: r.summary, residuals: r.residuals || [], error: r.error } : null,
        boundPoints: r.bound_points, driftAlarms: r.drift_alarms,
      })),
      connections: conns.rows.map((c) => ({ id: c.id, name: c.name, protocol: c.protocol, mode: c.mode, modeChangedAt: c.mode_changed_at })),
    });
  } catch (err) { next(err); }
});

// ── GET /twin/:flowsheetId ───────────────────────────────────────────────────
router.get('/:flowsheetId', [param('flowsheetId').isUUID()], async (req, res, next) => {
  if (vErr(req, res)) return;
  try {
    const f = await ownFlowsheet(req, res); if (!f) return;
    const [c, s, stats] = await Promise.all([
      query('SELECT * FROM twin_config WHERE flowsheet_id = $1', [f.id]),
      query('SELECT * FROM twin_state WHERE flowsheet_id = $1', [f.id]),
      query(`SELECT st.tag_id, t.tag, st.n, st.mean, CASE WHEN st.n > 1 THEN sqrt(st.m2 / (st.n - 1)) END AS sd, st.last_z, st.updated_at
               FROM twin_residual_stats st JOIN tags t ON t.id = st.tag_id WHERE t.flowsheet_id = $1`, [f.live_id]),
    ]);
    res.json({
      flowsheetId: f.id, flowsheetName: f.name, projectId: f.project_id, projectName: f.project_name,
      sourceFlowsheetId: f.source_flowsheet_id,
      config: fmtConfig(c.rows[0]), state: fmtState(s.rows[0]),
      residualStats: stats.rows.map((r) => ({ tagId: r.tag_id, tag: r.tag, n: r.n, mean: Number(r.mean), sd: r.sd == null ? null : Number(r.sd), lastZ: r.last_z == null ? null : Number(r.last_z), updatedAt: r.updated_at })),
    });
  } catch (err) { next(err); }
});

// ── PUT /twin/:flowsheetId ───────────────────────────────────────────────────
router.put('/:flowsheetId', requireCapability('twin.configure'), [
  param('flowsheetId').isUUID(),
  body('enabled').optional().isBoolean().toBoolean(),
  body('cadenceS').optional().isInt({ min: 5, max: 3600 }).toInt(),
  body('driftZ').optional().isFloat({ min: 0.5, max: 20 }).toFloat(),
], async (req, res, next) => {
  if (vErr(req, res)) return;
  try {
    const f = await ownFlowsheet(req, res); if (!f) return;
    const { rows } = await query(
      `INSERT INTO twin_config (flowsheet_id, organisation_id, enabled, cadence_s, drift_z, updated_by)
       VALUES ($1, $2, COALESCE($3, FALSE), COALESCE($4, 60), COALESCE($5, 3), $6)
       ON CONFLICT (flowsheet_id) DO UPDATE SET
         enabled = COALESCE($3, twin_config.enabled), cadence_s = COALESCE($4, twin_config.cadence_s),
         drift_z = COALESCE($5, twin_config.drift_z), updated_by = $6
       RETURNING *`,
      [f.id, orgId(req), req.body.enabled ?? null, req.body.cadenceS ?? null, req.body.driftZ ?? null, userId(req)]
    );
    auditLog(req, 'twin.configure', 'flowsheet', f.id, { enabled: rows[0].enabled, cadenceS: rows[0].cadence_s, driftZ: rows[0].drift_z });
    res.json(fmtConfig(rows[0]));
  } catch (err) { next(err); }
});

// ── POST /twin/:flowsheetId/solve ────────────────────────────────────────────
router.post('/:flowsheetId/solve', requireCapability('twin.configure'), [param('flowsheetId').isUUID()], async (req, res, next) => {
  if (vErr(req, res)) return;
  try {
    const f = await ownFlowsheet(req, res); if (!f) return;
    const state = await twin.solveTwin(f.id, { reason: 'manual' });
    auditLog(req, 'twin.solve', 'flowsheet', f.id, { seq: state?.seq, error: state?.error || null, residuals: state?.residuals?.length || 0 });
    res.json(state);
  } catch (err) { next(err); }
});

// ── GET /twin/:flowsheetId/residuals ─────────────────────────────────────────
router.get('/:flowsheetId/residuals', [param('flowsheetId').isUUID(), qv('range').optional().matches(/^\d+(m|h|d)$/), qv('limit').optional().isInt({ min: 10, max: 5000 }).toInt()], async (req, res, next) => {
  if (vErr(req, res)) return;
  try {
    const f = await ownFlowsheet(req, res); if (!f) return;
    const m = String(req.query.range || '24h').match(/^(\d+)(m|h|d)$/);
    const ms = Number(m[1]) * { m: 60_000, h: 3600_000, d: 86400_000 }[m[2]];
    const { rows } = await query(
      `SELECT r.tag_id, t.tag, t.name, t.node_id, r.ts, r.modelled, r.measured, r.residual, r.z
         FROM twin_residuals r JOIN tags t ON t.id = r.tag_id
        WHERE t.flowsheet_id = $1 AND r.ts >= $2
        ORDER BY r.ts DESC LIMIT ${req.query.limit || 2000}`,
      [f.live_id, new Date(Date.now() - ms)]
    );
    const series = new Map();
    for (const r of rows.reverse()) {
      if (!series.has(r.tag_id)) series.set(r.tag_id, { tagId: r.tag_id, tag: r.tag, name: r.name, nodeId: r.node_id, points: [] });
      series.get(r.tag_id).points.push([new Date(r.ts).getTime(), r.modelled, r.measured, r.residual, r.z]);
    }
    res.json({ columns: ['ts', 'modelled', 'measured', 'residual', 'z'], series: [...series.values()] });
  } catch (err) { next(err); }
});

// ── POST /twin/:flowsheetId/scenarios — what-if from the live state ─────────
router.post('/:flowsheetId/scenarios', requireCapability('scenario.run'), [
  param('flowsheetId').isUUID(),
  body('scenarios').isArray({ min: 1, max: 6 }).withMessage('scenarios must list 1–6 items'),
  body('scenarios.*.name').isString().trim().isLength({ min: 1, max: 80 }),
  body('scenarios.*.nodeParams').isObject(),
], async (req, res, next) => {
  if (vErr(req, res)) return;
  try {
    const f = await ownFlowsheet(req, res); if (!f) return;
    const canvasData = f.canvas_data || { nodes: [], edges: [] };
    // Baseline: the twin's measured parameters if it has solved, else live measurements now.
    const st = await query('SELECT node_params, summary, solved_at FROM twin_state WHERE flowsheet_id = $1', [f.id]);
    let baseParams = st.rows[0]?.node_params || null;
    if (!baseParams) baseParams = (await twin.measuredParams(f.id)).nodeParams;
    const merge = (over) => {
      const out = JSON.parse(JSON.stringify(baseParams || {}));
      for (const [node, params] of Object.entries(over || {})) out[node] = { ...(out[node] || {}), ...params };
      return out;
    };
    const run = async (name, nodeParams) => {
      try {
        const r = await runSimulation({ mode: 'steady_state', canvasData, config: { nodeParams, timeSeriesConfig: null, permitLimits: null } });
        return { name, ok: true, summary: r.summary, effluent: r.summary?.effluent || null, warnings: (r.warnings || []).length };
      } catch (err) { return { name, ok: false, error: err.message }; }
    };
    const baseline = st.rows[0]?.summary
      ? { name: 'Live (twin)', ok: true, summary: st.rows[0].summary, effluent: st.rows[0].summary?.effluent || null, solvedAt: st.rows[0].solved_at }
      : await run('Live (now)', baseParams);
    const results = [];
    for (const s of req.body.scenarios) results.push(await run(s.name, merge(s.nodeParams)));
    const diff = (a, b) => {
      if (!a?.effluent || !b?.effluent) return null;
      const out = {};
      for (const k of Object.keys(b.effluent)) {
        const x = Number(a.effluent[k]); const y = Number(b.effluent[k]);
        if (Number.isFinite(x) && Number.isFinite(y)) out[k] = +(y - x).toFixed(4);
      }
      return out;
    };
    auditLog(req, 'twin.scenarios', 'flowsheet', f.id, { scenarios: req.body.scenarios.map((s) => s.name) });
    res.json({ baseline, scenarios: results.map((r) => ({ ...r, delta: diff(baseline, r) })), persisted: false });
  } catch (err) { next(err); }
});

// ── Commissioning scripts ────────────────────────────────────────────────────
router.get('/:flowsheetId/scripts/runs', [param('flowsheetId').isUUID()], async (req, res, next) => {
  if (vErr(req, res)) return;
  try { const f = await ownFlowsheet(req, res); if (!f) return; res.json({ runs: scripts.listRuns(f.id) }); } catch (err) { next(err); }
});

router.post('/:flowsheetId/scripts/:scriptId/run', requireCapability('twin.commission'), [
  param('flowsheetId').isUUID(), param('scriptId').isString().trim().isLength({ min: 1, max: 40 }),
  body('speedup').optional().isFloat({ min: 1, max: 100000 }).toFloat(),
], async (req, res, next) => {
  if (vErr(req, res)) return;
  try {
    const f = await ownFlowsheet(req, res); if (!f) return;
    const run = await scripts.startScript({ flowsheetId: f.id, orgId: orgId(req), sectionId: req.params.scriptId, speedup: req.body.speedup || 360, req });
    auditLog(req, 'twin.script.start', 'flowsheet', f.id, { runId: run.runId, script: run.sectionId, speedup: run.speedup });
    res.status(202).json(run);
  } catch (err) { opErr(res, err, next); }
});

router.post('/:flowsheetId/scripts/runs/:runId/cancel', requireCapability('twin.commission'), [param('flowsheetId').isUUID()], async (req, res, next) => {
  if (vErr(req, res)) return;
  try {
    const f = await ownFlowsheet(req, res); if (!f) return;
    const run = scripts.cancelScript(req.params.runId);
    if (!run || run.flowsheetId !== f.id) return res.status(404).json({ error: 'No running script with that id' });
    auditLog(req, 'twin.script.cancel', 'flowsheet', f.id, { runId: run.runId });
    res.json(run);
  } catch (err) { next(err); }
});

module.exports = router;
