/**
 * WaterSim Pro — Shared report-data builder
 *
 * Builds the structured report object from a simulation_runs DB row
 * (joined with flowsheet/project/org/user names). Used by both
 * routes/reports.js (per-run report + PDF) and routes/reports_org.js
 * (Excel exports) — previously duplicated verbatim in both files.
 *
 * Expects the row to carry: id, project_name, flowsheet_name, org_name,
 * created_by_name, mode, started_at, completed_at, results, run_config.
 */

'use strict';

const { buildPlainSummary } = require('./plainLanguage');
const logger = require('../utils/logger');

function buildReportData(row) {
  const results = row.results || {};
  const config  = row.run_config || {};

  const report = {
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

  // Plain-language layer — additive; a failure here must never break the
  // report endpoint (buildPlainSummary itself never throws, but be safe).
  // canvas_data (when the caller's query selected it) gives the treatment
  // steps true flow order and the operator's own node names — neither
  // survives into results.unitResults, which jsonb also reorders.
  try {
    report.plain = buildPlainSummary(report, row.canvas_data || null);
  } catch (err) {
    logger.warn('Plain-language summary generation failed — omitting from report', {
      runId: row.id, error: err.message,
    });
  }

  return report;
}

module.exports = { buildReportData };
