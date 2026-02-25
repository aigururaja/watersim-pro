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
const { authenticate } = require('../middleware/auth');
const logger = require('../utils/logger');
const { runSteadyState } = require('../simulation/solver');
const { runDynamic, DEFAULT_DIURNAL_PROFILE } = require('../simulation/dynamicSolver');
const { estimateCosts, DEFAULT_UNIT_COSTS } = require('../simulation/costEstimator');

const router = express.Router({ mergeParams: true }); // inherits :projectId + :flowsheetId
router.use(authenticate);

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

// ── POST — run a simulation ────────────────────────────────────────────────

router.post('/', [
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
], async (req, res, next) => {
  if (vErr(req, res)) return;

  const { projectId, flowsheetId } = req.params;
  const mode             = req.body.mode             || 'steady_state';
  const nodeParams       = req.body.nodeParams       || {};
  const timeSeriesConfig = req.body.timeSeriesConfig || null;
  const reqUnitCosts     = req.body.unitCosts        || {};

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

    const canvasData   = flowsheet.canvas_data || { nodes: [], edges: [] };
    const permitLimits = await loadPermitTemplate(orgId(req));

    // Create run record with 'running' status
    const insertRun = await query(
      `INSERT INTO simulation_runs
         (flowsheet_id, created_by, mode, status, config, started_at)
       VALUES ($1,$2,$3,'running',$4,NOW())
       RETURNING id`,
      [flowsheetId, userId(req), mode, JSON.stringify({ nodeParams, timeSeriesConfig, unitCosts })]
    );
    runId = insertRun.rows[0].id;

    logger.info('Simulation started', { runId, flowsheetId, mode });

    // ── Execute solver ────────────────────────────────────────────────────
    let results, warnings;
    try {
      if (mode === 'dynamic') {
        const out = runDynamic(canvasData, { nodeParams, timeSeriesConfig, permitLimits });
        results  = out;
        warnings = out.warnings || [];
      } else {
        const out = runSteadyState(canvasData, { nodeParams, permitLimits });
        results  = out;
        warnings = out.warnings || [];
      }
    } catch (solverErr) {
      // Mark run as failed
      await query(
        `UPDATE simulation_runs SET status='failed', error_message=$1, completed_at=NOW() WHERE id=$2`,
        [solverErr.message, runId]
      );
      logger.error('Solver error', { runId, err: solverErr.message });
      return res.status(422).json({
        error:   'Simulation solver failed',
        details: solverErr.message,
        run_id:  runId,
      });
    }

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

    // ── Persist results ────────────────────────────────────────────────────
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

    if (mode === 'dynamic') {
      return res.status(201).json({
        run_id:   runId,
        status:   'completed',
        mode,
        results: {
          mode:        results.mode,
          stepCount:   results.stepCount,
          profileUsed: results.profileUsed,
          steps:       results.steps,
        },
        warnings,
      });
    } else {
      return res.status(201).json({
        run_id:   runId,
        status:   'completed',
        mode,
        results:  {
          streamResults: results.streamResults,
          unitResults:   results.unitResults,
          summary:       results.summary,
          costBreakdown,
          permitLimitsUsed: permitLimits,
        },
        warnings,
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

// ── POST /batch — run multiple scenarios for flowsheet comparison ─────────

router.post('/batch', [
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

    const scenarioResults = scenarios.map((scenario) => {
      const np = scenario.nodeParams || {};
      try {
        const out = runSteadyState(canvasData, { nodeParams: np });
        return {
          name:     scenario.name,
          status:   'completed',
          results: {
            streamResults: out.streamResults,
            unitResults:   out.unitResults,
            summary:       out.summary,
          },
          warnings: out.warnings || [],
        };
      } catch (err) {
        return {
          name:     scenario.name,
          status:   'failed',
          error:    err.message,
          results:  null,
          warnings: [],
        };
      }
    });

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
