/**
 * WaterSim Pro — Report Routes
 *
 * GET  /projects/:projectId/flowsheets/:flowsheetId/simulate/:runId/report
 *      → Returns structured report JSON (used by the frontend ReportPage)
 *
 * GET  /projects/:projectId/flowsheets/:flowsheetId/simulate/:runId/report/pdf
 *      → Streams a generated PDF to the client
 *
 * These routes are mounted on the same simulate router (mergeParams: true),
 * so they share the :projectId, :flowsheetId, :runId params and auth.
 */

'use strict';

const express   = require('express');
const { param, validationResult } = require('express-validator');
const { query } = require('../db/pool');
const logger    = require('../utils/logger');
const { generatePdf } = require('../reports/pdfGenerator');

const router = express.Router({ mergeParams: true });
// Authentication is applied in server.js before these routes are reached,
// or on the parent simulate router — no need to re-apply here.

function vErr(req, res) {
  const e = validationResult(req);
  if (!e.isEmpty()) { res.status(422).json({ error: 'Validation failed', details: e.array() }); return true; }
  return false;
}

const orgId = (req) => req.user.org || req.user.organisationId;

/** Load a completed run, verifying org ownership. */
async function loadRun(runId, flowsheetId, projectId, myOrgId, res) {
  const r = await query(
    `SELECT sr.*,
            f.name AS flowsheet_name,
            f.canvas_data,
            p.name AS project_name,
            o.name AS org_name,
            u.first_name || ' ' || u.last_name AS created_by_name,
            sr.config AS run_config
     FROM simulation_runs sr
     JOIN flowsheets f   ON f.id = sr.flowsheet_id
     JOIN projects p     ON p.id = f.project_id
     JOIN organisations o ON o.id = p.organisation_id
     JOIN users u        ON u.id = sr.created_by
     WHERE sr.id = $1
       AND sr.flowsheet_id = $2
       AND f.project_id    = $3
       AND p.organisation_id = $4
       AND sr.status = 'completed'`,
    [runId, flowsheetId, projectId, myOrgId]
  );
  if (!r.rows[0]) {
    res.status(404).json({ error: 'Completed simulation run not found' });
    return null;
  }
  return r.rows[0];
}

/** Build the structured report data object from a DB row. */
function buildReportData(row) {
  const results = row.results || {};
  const config  = row.run_config || {};

  return {
    run_id:          row.id,
    project_name:    row.project_name,
    flowsheet_name:  row.flowsheet_name,
    org_name:        row.org_name,
    created_by:      row.created_by_name,
    mode:            row.mode,
    started_at:      row.started_at,
    completed_at:    row.completed_at,
    config:          config,
    warnings:        results.warnings || [],
    results: {
      summary:          results.summary          || {},
      streamResults:    results.streamResults    || {},
      unitResults:      results.unitResults      || {},
      costBreakdown:    results.costBreakdown    || null,
      permitLimitsUsed: results.permitLimitsUsed || null,
      // Dynamic mode fields
      mode:             results.mode,
      stepCount:        results.stepCount,
      profileUsed:      results.profileUsed,
      steps:            results.steps            || [],
    },
  };
}

// ── GET /:runId/report — structured JSON report ────────────────────────────

router.get(
  '/:runId/report',
  [param('runId').isUUID()],
  async (req, res, next) => {
    if (vErr(req, res)) return;
    const { projectId, flowsheetId, runId } = req.params;
    try {
      const row = await loadRun(runId, flowsheetId, projectId, orgId(req), res);
      if (!row) return;
      res.json(buildReportData(row));
    } catch (err) { next(err); }
  }
);

// ── GET /:runId/report/pdf — generated PDF download ────────────────────────

router.get(
  '/:runId/report/pdf',
  [param('runId').isUUID()],
  async (req, res, next) => {
    if (vErr(req, res)) return;
    const { projectId, flowsheetId, runId } = req.params;
    try {
      const row = await loadRun(runId, flowsheetId, projectId, orgId(req), res);
      if (!row) return;

      logger.info('Generating PDF report', { runId, flowsheetId, requestedBy: req.user.sub });

      const reportData = buildReportData(row);
      const pdfBuffer  = await generatePdf(reportData);

      const safeName = (row.flowsheet_name || 'report').replace(/[^a-zA-Z0-9_-]/g, '_');
      const filename = `watersim_${safeName}_${runId.slice(0, 8)}.pdf`;

      res.setHeader('Content-Type',        'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.setHeader('Content-Length',      pdfBuffer.length);
      res.setHeader('Cache-Control',       'private, max-age=300');

      logger.info('PDF report sent', { runId, bytes: pdfBuffer.length, filename });
      res.send(pdfBuffer);

    } catch (err) {
      logger.error('PDF generation error', { runId, error: err.message });
      next(err);
    }
  }
);

module.exports = router;
