/**
 * WaterSim Pro — Simulation API Routes  (Session 6 — Steps 29–33)
 *
 * POST /simulate
 *   mode: 'steady_state' (default) | 'dynamic'
 *   Accepts: { mode, nodeParams, timeSeriesConfig, unitCosts }
 *   unitCosts (optional): override cost model coefficients
 *
 * POST /simulate/batch
 *   Runs N scenarios with different nodeParams against the same canvas.
 *   Accepts: { scenarios: [{ name, nodeParams }] }
 *
 * GET  /simulate/default-profile   — built-in 24h diurnal profile
 * GET  /simulate/default-unit-costs — default cost model coefficients
 * The /projects/:id/unit-costs routes (GET/PUT/DELETE) live in projects.js
 * GET  /simulate                   — list runs
 * GET  /simulate/:runId            — single run
 * GET  /simulate/:runId/export/csv — CSV export
 * GET  /simulate/:runId/export/json — JSON export
 */

'use strict';

const express = require('express');
const { body, param, validationResult } = require('express-validator');
const { query } = require('../db/pool');
const { authenticate, requireRole } = require('../middleware/auth');
const logger = require('../utils/logger');
const { runSimulation } = require('../simulation/runner');
const { DEFAULT_DIURNAL_PROFILE } = require('../simulation/dynamicSolver');
const { estimateCosts, DEFAULT_UNIT_COSTS } = require('../simulation/costEstimator');
const { simulationDuration } = require('../metrics');
const { evaluateForRun, evaluateRules, buildMessage } = require('../alarms/evaluator');
const { buildNodeLabels } = require('../alarms/validTargets');

const router = express.Router({ mergeParams: true }); // inherits :projectId + :flowsheetId
router.use(authenticate);

// Input bounds — reject absurdly large flowsheets before running anything.
const MAX_NODES = 200;
const MAX_EDGES = 400;

/** Returns an error string when the canvas exceeds size bounds, else null. */
function canvasTooLarge(canvasData) {
  const nodeCount = Array.isArray(canvasData?.nodes) ? canvasData.nodes.length : 0;
  const edgeCount = Array.isArray(canvasData?.edges) ? canvasData.edges.length : 0;
  if (nodeCount > MAX_NODES || edgeCount > MAX_EDGES) {
    return `Flowsheet too large to simulate (${nodeCount} nodes / ${edgeCount} edges; limits are ${MAX_NODES} nodes / ${MAX_EDGES} edges)`;
  }
  return null;
}

/** Build the top-level quality object from a solver result. */
function buildQuality(results, mode) {
  if (mode === 'dynamic') {
    const steps = Array.isArray(results?.steps) ? results.steps : [];
    return {
      converged:   steps.every(s => s.converged !== false),
      degraded:    steps.some(s => s.degraded === true),
      iterations:  null,
      maxResidual: null,
    };
  }
  return {
    converged:   results?.converged   ?? null,
    degraded:    results?.degraded    ?? false,
    iterations:  results?.iterations  ?? null,
    maxResidual: results?.maxResidual ?? null,
  };
}

function vErr(req, res) {
  const e = validationResult(req);
  if (!e.isEmpty()) { res.status(422).json({ error: 'Validation failed', details: e.array() }); return true; }
  return false;
}

const userId = (req) => req.user.sub || req.user.id;
const orgId  = (req) => req.user.org  || req.user.organisationId;

/** Verify flowsheet belongs to org and return it. */
async function loadFlowsheet(projectId, flowsheetId, orgId, res) {
  const r = await query(
    `SELECT f.* FROM flowsheets f
     JOIN projects p ON p.id = f.project_id
     WHERE f.id = $1 AND f.project_id = $2 AND p.organisation_id = $3 AND p.status != 'deleted'`,
    [flowsheetId, projectId, orgId]
  );
  if (!r.rows[0]) { res.status(404).json({ error: 'Flowsheet not found' }); return null; }
  return r.rows[0];
}

/**
 * Preview alarms — the PURE evaluator only.
 *
 * A preview is never persisted, so it must never write an alarm_event or
 * broadcast a transition either: this reads the flowsheet's enabled rules and
 * reports which of them the previewed results would breach, nothing more.
 * Never throws — a preview must not fail because of the alarm layer.
 */
async function previewAlarmBreaches(flowsheetId, organisationId, ctx, canvasData) {
  try {
    const r = await query(
      `SELECT * FROM alarm_rules
       WHERE flowsheet_id = $1 AND organisation_id = $2 AND enabled = TRUE`,
      [flowsheetId, organisationId]
    );
    if (!r.rows.length) return [];
    const nodeLabels = buildNodeLabels(canvasData);
    return evaluateRules(r.rows, ctx).map(({ rule, value }) => ({
      ruleId:     rule.id,
      ruleName:   rule.name,
      severity:   rule.severity,
      targetType: rule.target_type,
      nodeId:     rule.node_id,
      paramKey:   rule.param_key,
      value,
      limitMin:   rule.min_value,
      limitMax:   rule.max_value,
      message:    buildMessage(rule, value, nodeLabels),
    }));
  } catch (err) {
    logger.warn('Preview alarm evaluation failed', { flowsheetId, err: err.message });
    return [];
  }
}

/** Load org-level permit template (if any). Returns null if none configured. */
async function loadPermitTemplate(orgId) {
  try {
    const r = await query(
      `SELECT permit_limits FROM permit_templates WHERE organisation_id = $1 AND is_active = TRUE ORDER BY created_at DESC LIMIT 1`,
      [orgId]
    );
    return r.rows[0]?.permit_limits || null;
  } catch (_) {
    // Table may not exist yet in older deployments
    return null;
  }
}

// ── POST — run a simulation (operator+) ────────────────────────────────────

router.post('/', requireRole('operator'), [
  body('mode')
    .optional()
    .isIn(['steady_state', 'dynamic'])
    .withMessage('mode must be steady_state or dynamic'),
  body('nodeParams')
    .optional()
    .isObject()
    .withMessage('nodeParams must be an object'),
  body('timeSeriesConfig')
    .optional()
    .isObject()
    .withMessage('timeSeriesConfig must be an object'),
  body('unitCosts')
    .optional()
    .isObject()
    .withMessage('unitCosts must be an object'),
  body('preview')
    .optional()
    .isBoolean()
    .withMessage('preview must be a boolean'),
  body('canvasData')
    .optional()
    .isObject()
    .withMessage('canvasData must be an object'),
], async (req, res, next) => {
  if (vErr(req, res)) return;

  const { projectId, flowsheetId } = req.params;
  const mode             = req.body.mode             || 'steady_state';
  const nodeParams       = req.body.nodeParams       || {};
  const timeSeriesConfig = req.body.timeSeriesConfig || null;
  const reqUnitCosts     = req.body.unitCosts        || {};
  // Preview runs (live mode in the canvas) execute the solver but are never
  // recorded in simulation_runs — they may also carry an inline canvasData so
  // unsaved edits can be simulated without a save round-trip.
  const isPreview        = req.body.preview === true;

  let runId;
  try {
    const flowsheet = await loadFlowsheet(projectId, flowsheetId, orgId(req), res);
    if (!flowsheet) return;

    // Load project-level unit-cost overrides; request-body overrides take highest precedence
    let projectUnitCosts = {};
    try {
      const pr = await query(
        `SELECT settings FROM projects WHERE id = $1 AND organisation_id = $2 AND status != 'deleted'`,
        [projectId, orgId(req)]
      );
      projectUnitCosts = pr.rows[0]?.settings?.unitCosts || {};
    } catch (_) { /* non-fatal */ }
    const unitCosts = { ...projectUnitCosts, ...reqUnitCosts };

    const canvasData = (isPreview && req.body.canvasData)
      ? req.body.canvasData
      : (flowsheet.canvas_data || { nodes: [], edges: [] });

    // Reject oversized flowsheets before creating a run or spawning a worker.
    const sizeError = canvasTooLarge(canvasData);
    if (sizeError) return res.status(422).json({ error: sizeError });

    const permitLimits = await loadPermitTemplate(orgId(req));

    // Create run record with 'running' status (skipped for previews — live
    // mode would otherwise flood the run history with intermediate states)
    if (!isPreview) {
      const insertRun = await query(
        `INSERT INTO simulation_runs
           (flowsheet_id, created_by, mode, status, config, started_at)
         VALUES ($1,$2,$3,'running',$4,NOW())
         RETURNING id`,
        [flowsheetId, userId(req), mode, JSON.stringify({ nodeParams, timeSeriesConfig, unitCosts })]
      );
      runId = insertRun.rows[0].id;
      logger.info('Simulation started', { runId, flowsheetId, mode });
    } else {
      logger.debug('Preview simulation started', { flowsheetId, mode });
    }

    // ── Execute solver (worker thread — keeps the event loop free) ────────
    let results, warnings;
    const endSimTimer = simulationDuration.startTimer({ mode });
    try {
      results  = await runSimulation({
        mode,
        canvasData,
        config: { nodeParams, timeSeriesConfig, permitLimits },
      });
      warnings = results.warnings || [];
      endSimTimer({ status: 'completed' });
    } catch (simErr) {
      endSimTimer({ status: simErr.timedOut ? 'timeout' : 'failed' });
      // Mark run as failed (previews have no run row)
      if (runId) {
        await query(
          `UPDATE simulation_runs SET status='failed', error_message=$1, completed_at=NOW() WHERE id=$2`,
          [simErr.message, runId]
        ).catch(() => {});
      }
      if (simErr.timedOut) {
        logger.error('Simulation timed out', { runId, err: simErr.message });
        return res.status(504).json({
          error:   'Simulation timed out',
          details: simErr.message,
          run_id:  runId || null,
        });
      }
      logger.error('Solver error', { runId, err: simErr.message });
      return res.status(422).json({
        error:   'Simulation solver failed',
        details: simErr.message,
        run_id:  runId || null,
      });
    }

    // ── Quality flags (converged / degraded) — persisted and returned ─────
    const quality = buildQuality(results, mode);
    results.converged = quality.converged;
    results.degraded  = quality.degraded;

    // ── Cost estimation (steady-state only — attached to results) ─────────
    let costBreakdown = null;
    if (mode === 'steady_state') {
      try {
        costBreakdown = estimateCosts(results, unitCosts);
        results.costBreakdown = costBreakdown;
      } catch (costErr) {
        logger.warn('Cost estimation failed (non-fatal)', { err: costErr.message });
      }
    }

    // ── Persist results (previews are never persisted) ─────────────────────
    let alarms;
    if (!isPreview) {
      await query(
        `UPDATE simulation_runs
         SET status='completed', results=$1, completed_at=NOW()
         WHERE id=$2`,
        [JSON.stringify(results), runId]
      );
      logger.info('Simulation completed', {
        runId,
        nodes: results.summary?.nodeCount,
        warnings: warnings.length,
      });

      // Alarm evaluation runs against the PERSISTED run (source 'simulation'):
      // fire-and-forget so the state machine + WS broadcast never sit in the
      // response path, and never fail the run.
      evaluateForRun(flowsheetId, orgId(req), results, { nodeParams }, runId)
        .catch((err) => logger.warn('Alarm evaluation failed for run', { runId, err: err.message }));
    } else {
      // Preview: pure evaluation only — nothing written, nothing broadcast.
      alarms = await previewAlarmBreaches(
        flowsheetId, orgId(req),
        { nodeParams, unitResults: results.unitResults, summary: results.summary },
        canvasData
      );
    }

    // A run that did not converge (or was degraded by non-finite sweeps) is
    // still 'completed' — but the response carries the flags prominently in
    // top-level `quality` alongside the warnings.
    if (mode === 'dynamic') {
      return res.status(201).json({
        run_id:   runId || null,
        preview:  isPreview || undefined,
        status:   'completed',
        mode,
        quality,
        results: {
          mode:        results.mode,
          stepCount:   results.stepCount,
          profileUsed: results.profileUsed,
          steps:       results.steps,
        },
        warnings,
        alarms,
      });
    } else {
      return res.status(201).json({
        run_id:   runId || null,
        preview:  isPreview || undefined,
        status:   'completed',
        mode,
        quality,
        results:  {
          streamResults: results.streamResults,
          unitResults:   results.unitResults,
          summary:       results.summary,
          costBreakdown,
          permitLimitsUsed: permitLimits,
        },
        warnings,
        alarms,
      });
    }

  } catch (err) {
    // Unexpected error — mark run failed if it was created
    if (runId) {
      await query(
        `UPDATE simulation_runs SET status='failed', error_message=$1, completed_at=NOW() WHERE id=$2`,
        [err.message, runId]
      ).catch(() => {});
    }
    next(err);
  }
});

// ── POST /batch — run multiple scenarios for flowsheet comparison (operator+) ─

router.post('/batch', requireRole('operator'), [
  body('scenarios')
    .isArray({ min: 1, max: 10 })
    .withMessage('scenarios must be an array of 1–10 items'),
  body('scenarios.*.name')
    .isString().notEmpty()
    .withMessage('Each scenario must have a name'),
  body('scenarios.*.nodeParams')
    .optional().isObject()
    .withMessage('nodeParams must be an object'),
], async (req, res, next) => {
  if (vErr(req, res)) return;

  const { projectId, flowsheetId } = req.params;
  const scenarios = req.body.scenarios;

  try {
    const flowsheet = await loadFlowsheet(projectId, flowsheetId, orgId(req), res);
    if (!flowsheet) return;

    const canvasData = flowsheet.canvas_data || { nodes: [], edges: [] };

    const sizeError = canvasTooLarge(canvasData);
    if (sizeError) return res.status(422).json({ error: sizeError });

    const scenarioResults = [];
    for (const scenario of scenarios) {
      const np = scenario.nodeParams || {};
      const endSimTimer = simulationDuration.startTimer({ mode: 'steady_state' });
      try {
        const out = await runSimulation({
          mode:       'steady_state',
          canvasData,
          config:     { nodeParams: np },
        });
        endSimTimer({ status: 'completed' });
        scenarioResults.push({
          name:     scenario.name,
          status:   'completed',
          quality:  buildQuality(out, 'steady_state'),
          results: {
            streamResults: out.streamResults,
            unitResults:   out.unitResults,
            summary:       out.summary,
          },
          warnings: out.warnings || [],
        });
      } catch (err) {
        endSimTimer({ status: err.timedOut ? 'timeout' : 'failed' });
        scenarioResults.push({
          name:     scenario.name,
          status:   'failed',
          error:    err.message,
          results:  null,
          warnings: [],
        });
      }
    }

    // Persist as a batch run record
    const batchRun = await query(
      `INSERT INTO simulation_runs
         (flowsheet_id, created_by, mode, status, config, results, started_at, completed_at)
       VALUES ($1,$2,'steady_state','completed',$3,$4,NOW(),NOW())
       RETURNING id`,
      [
        flowsheetId, userId(req),
        JSON.stringify({ batch: true, scenarios: scenarios.map(s => s.name) }),
        JSON.stringify({ batch: true, scenarios: scenarioResults }),
      ]
    );

    logger.info('Batch simulation completed', {
      runId: batchRun.rows[0].id,
      scenarioCount: scenarios.length,
    });

    return res.status(201).json({
      run_id:        batchRun.rows[0].id,
      status:        'completed',
      mode:          'batch',
      scenarioCount: scenarios.length,
      scenarios:     scenarioResults,
    });

  } catch (err) { next(err); }
});

// ── GET /default-profile — return the built-in diurnal profile ─────────────

router.get('/default-profile', (_req, res) => {
  res.json({ profile: DEFAULT_DIURNAL_PROFILE });
});

// ── GET /default-unit-costs — return cost model defaults ──────────────────

router.get('/default-unit-costs', (_req, res) => {
  res.json({ unitCosts: DEFAULT_UNIT_COSTS });
});

// ── GET — list runs ────────────────────────────────────────────────────────

router.get('/', async (req, res, next) => {
  const { projectId, flowsheetId } = req.params;
  try {
    const flowsheet = await loadFlowsheet(projectId, flowsheetId, orgId(req), res);
    if (!flowsheet) return;

    const result = await query(
      `SELECT r.id, r.mode, r.status, r.config,
              r.results->'summary' AS summary,
              r.error_message,
              r.started_at, r.completed_at, r.created_at,
              u.first_name || ' ' || u.last_name AS created_by_name
       FROM simulation_runs r
       JOIN users u ON u.id = r.created_by
       WHERE r.flowsheet_id = $1
       ORDER BY r.created_at DESC
       LIMIT 20`,
      [flowsheetId]
    );
    res.json(result.rows);
  } catch (err) { next(err); }
});

// ── GET — single run ──────────────────────────────────────────────────────

router.get('/:runId', [param('runId').isUUID()], async (req, res, next) => {
  if (vErr(req, res)) return;
  const { projectId, flowsheetId, runId } = req.params;
  try {
    const flowsheet = await loadFlowsheet(projectId, flowsheetId, orgId(req), res);
    if (!flowsheet) return;

    const result = await query(
      `SELECT r.*, u.first_name || ' ' || u.last_name AS created_by_name
       FROM simulation_runs r
       JOIN users u ON u.id = r.created_by
       WHERE r.id = $1 AND r.flowsheet_id = $2`,
      [runId, flowsheetId]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Simulation run not found' });
    res.json(result.rows[0]);
  } catch (err) { next(err); }
});

// ── GET — export results as CSV ───────────────────────────────────────────

router.get('/:runId/export/csv', [param('runId').isUUID()], async (req, res, next) => {
  if (vErr(req, res)) return;
  const { projectId, flowsheetId, runId } = req.params;
  try {
    const flowsheet = await loadFlowsheet(projectId, flowsheetId, orgId(req), res);
    if (!flowsheet) return;

    const result = await query(
      `SELECT r.results, r.mode, r.completed_at, f.name AS flowsheet_name,
              u.first_name || ' ' || u.last_name AS created_by_name
       FROM simulation_runs r
       JOIN flowsheets f ON f.id = r.flowsheet_id
       JOIN users u ON u.id = r.created_by
       WHERE r.id = $1 AND r.flowsheet_id = $2 AND r.status = 'completed'`,
      [runId, flowsheetId]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Completed run not found' });

    const { results, flowsheet_name, completed_at, created_by_name } = result.rows[0];
    const runMode = result.rows[0].mode;
    const { streamResults = {}, unitResults = {}, summary = {} } = (runMode !== 'dynamic' && results) ? results : {};

    // Build CSV sections
    const lines = [];
    const esc = (v) => (v == null ? '' : String(v).includes(',') ? `"${v}"` : String(v));
    const row = (...cols) => lines.push(cols.map(esc).join(','));

    // Header block
    row('WaterSim Pro — Simulation Results Export');
    row('Flowsheet', flowsheet_name);
    row('Run ID', runId);
    row('Created by', created_by_name);
    row('Completed at', completed_at);
    row('Mode', runMode);

    const qKeys = ['Q', 'TSS', 'BOD', 'COD', 'TN', 'NH4', 'NO3', 'TP', 'DO', 'pH', 'temp'];
    const units  = { Q: 'm³/d', TSS: 'mg/L', BOD: 'mg/L', COD: 'mg/L', TN: 'mg/L',
                     NH4: 'mg/L', NO3: 'mg/L', TP: 'mg/L', DO: 'mg/L', pH: '—', temp: '°C' };

    if (runMode === 'dynamic' && results?.steps) {
      row('Step count', results.stepCount ?? results.steps.length);
      row();
      row('=== DYNAMIC SIMULATION — HOURLY PROFILE ===');
      row('Hour', 'Q_scale', 'BOD_scale', 'TN_scale',
          ...qKeys.map(k => `Influent ${k} (${units[k] || ''})`),
          ...qKeys.map(k => `Effluent ${k} (${units[k] || ''})`));
      for (const step of results.steps) {
        const sc = step.stepEntry || {};
        row(
          step.hour,
          sc.Q_scale ?? '', sc.BOD_scale ?? '', sc.TN_scale ?? '',
          ...qKeys.map(k => step.summary?.influent?.[k] ?? ''),
          ...qKeys.map(k => step.summary?.effluent?.[k] ?? ''),
        );
      }
    } else {
      row('Recycle iterations', summary.iterations ?? '—');
      row();

      row('=== SUMMARY ===');
      row('Nodes solved', summary.solvedNodes ?? '—');
      row('Recycle edges', summary.recycleEdges ?? 0);
      row('Permit compliant', summary.compliant ?? '—');
      if (summary.permit_violations?.length) {
        row('Violations', summary.permit_violations.join('; '));
      }
      row();

      row('=== INFLUENT / EFFLUENT QUALITY ===');
      row('Parameter', 'Unit', 'Influent', 'Effluent');
      for (const k of qKeys) {
        row(k, units[k] || '',
            summary.influent?.[k] ?? '—',
            summary.effluent?.[k] ?? '—');
      }
      row();

      row('=== UNIT OPERATION METRICS ===');
      const unitRows = Object.entries(unitResults);
      if (unitRows.length) {
        const metricKeys = [...new Set(unitRows.flatMap(([, v]) => Object.keys(v.metrics || {})))];
        row('Node ID', 'Type', ...metricKeys);
        for (const [nodeId, ur] of unitRows) {
          row(nodeId, ur.paletteType || ur.type, ...metricKeys.map(k => ur.metrics[k] ?? ''));
        }
      }
      row();

      row('=== STREAM (EDGE) RESULTS ===');
      const streamRows = Object.entries(streamResults);
      if (streamRows.length) {
        row('Edge ID', ...qKeys.map(k => `${k} (${units[k] || ''})`));
        for (const [eid, s] of streamRows) {
          row(eid, ...qKeys.map(k => s[k] ?? ''));
        }
      }
    }

    const csv = lines.join('\r\n');
    const filename = `watersim_${flowsheet_name.replace(/\s+/g, '_')}_${runId.slice(0, 8)}_${runMode}.csv`;
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.send(csv);

  } catch (err) { next(err); }
});

// ── GET — export results as JSON (machine-readable) ───────────────────────

router.get('/:runId/export/json', [param('runId').isUUID()], async (req, res, next) => {
  if (vErr(req, res)) return;
  const { projectId, flowsheetId, runId } = req.params;
  try {
    const flowsheet = await loadFlowsheet(projectId, flowsheetId, orgId(req), res);
    if (!flowsheet) return;

    const result = await query(
      `SELECT r.results, r.mode, r.config, r.completed_at, r.started_at,
              f.name AS flowsheet_name, p.name AS project_name,
              u.first_name || ' ' || u.last_name AS created_by_name
       FROM simulation_runs r
       JOIN flowsheets f ON f.id = r.flowsheet_id
       JOIN projects p ON p.id = f.project_id
       JOIN users u ON u.id = r.created_by
       WHERE r.id = $1 AND r.flowsheet_id = $2 AND r.status = 'completed'`,
      [runId, flowsheetId]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Completed run not found' });

    const { results, flowsheet_name, project_name, completed_at, started_at, created_by_name, mode, config } = result.rows[0];
    const filename = `watersim_${flowsheet_name.replace(/\s+/g, '_')}_${runId.slice(0, 8)}.json`;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.json({
      export_version: '1.1',
      run_id: runId,
      flowsheet: flowsheet_name,
      project: project_name,
      mode,
      config,
      created_by: created_by_name,
      started_at,
      completed_at,
      results,
    });

  } catch (err) { next(err); }
});

module.exports = router;
