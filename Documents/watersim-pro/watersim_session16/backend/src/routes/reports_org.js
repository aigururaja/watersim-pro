'use strict';

/**
 * WaterSim Pro — Org-Level Reports API
 *
 * Mounted at: /api/v1/reports
 *
 * GET    /reports                   — paginated run history for the whole org
 * GET    /reports/saved             — runs saved/bookmarked by the current user
 * POST   /reports/saved             — save/bookmark a run
 * DELETE /reports/saved/:runId      — unsave a run
 * GET    /reports/:runId/excel      — export single run as .xlsx
 * POST   /reports/compare/excel     — export comparison of N runs as .xlsx
 */

const express = require('express');
const { body, param, query: qv, validationResult } = require('express-validator');
const { query } = require('../db/pool');
const { authenticate } = require('../middleware/auth');
const { generateExcel } = require('../reports/excelGenerator');
const { buildReportData } = require('../reports/reportData');
const logger = require('../utils/logger');

const router = express.Router();
router.use(authenticate);

function vErr(req, res) {
  const e = validationResult(req);
  if (!e.isEmpty()) { res.status(422).json({ error: 'Validation failed', details: e.array() }); return true; }
  return false;
}

const orgId = req => req.user.org;

// ── Shared SQL for loading a completed run with its labels ─────────────────

const RUN_SELECT = `
  SELECT
    sr.id,
    sr.mode,
    sr.status,
    sr.started_at,
    sr.completed_at,
    sr.created_at,
    sr.results->'summary'            AS summary,
    sr.results->'costBreakdown'      AS cost_summary,
    sr.results->'permitLimitsUsed'   AS permit_limits_used,
    f.id       AS flowsheet_id,
    f.name     AS flowsheet_name,
    p.id       AS project_id,
    p.name     AS project_name,
    u.first_name || ' ' || u.last_name AS created_by,
    sv.label   AS saved_label,
    sv.notes   AS saved_notes,
    sv.id      AS saved_id,
    sv.created_at AS saved_at
  FROM simulation_runs sr
  JOIN flowsheets  f  ON f.id  = sr.flowsheet_id
  JOIN projects    p  ON p.id  = f.project_id
  JOIN users       u  ON u.id  = sr.created_by
  LEFT JOIN saved_reports sv
    ON sv.run_id = sr.id AND sv.saved_by = $1
  WHERE p.organisation_id = $2
    AND sr.status = 'completed'
`;

function formatRun(row) {
  return {
    id:             row.id,
    mode:           row.mode,
    flowsheetId:    row.flowsheet_id,
    flowsheetName:  row.flowsheet_name,
    projectId:      row.project_id,
    projectName:    row.project_name,
    createdBy:      row.created_by,
    startedAt:      row.started_at,
    completedAt:    row.completed_at,
    createdAt:      row.created_at,
    summary:        row.summary        || {},
    costSummary:    row.cost_summary   || null,
    permitLimits:   row.permit_limits_used || null,
    saved:          !!row.saved_id,
    savedLabel:     row.saved_label    || null,
    savedNotes:     row.saved_notes    || null,
    savedId:        row.saved_id       || null,
    savedAt:        row.saved_at       || null,
  };
}

// ── GET /reports — org run history (cursor-based pagination) ─────────────────
//
// Cursor pagination: instead of OFFSET (which degrades on large tables),
// we use a composite keyset cursor on (completed_at, id). A single-column
// completed_at cursor dropped rows when several runs shared the same
// completed_at (batch inserts) — the id tiebreaker makes ordering total.
//
// Query params:
//   limit      – rows per page (default 40, max 100)
//   cursor     – opaque string (base64 JSON {completedAt, id}); the client
//                passes back nextCursor verbatim. Legacy plain-ISO cursors
//                are still accepted for compatibility.
//   projectId  – UUID filter
//   mode       – 'steady_state' | 'dynamic'
//   compliance – 'pass' | 'fail' | 'unknown'
//
// Response:
//   { total, runs, nextCursor }
//   nextCursor is null when no more rows exist.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function encodeCursor(row) {
  const completedAt = row.completed_at instanceof Date
    ? row.completed_at.toISOString()
    : String(row.completed_at);
  return Buffer.from(JSON.stringify({ completedAt, id: row.id }), 'utf8').toString('base64');
}

/** Decode an opaque cursor → { completedAt, id } | { completedAt } | null. */
function decodeCursor(raw) {
  if (typeof raw !== 'string' || !raw) return null;
  // Preferred: base64-encoded JSON { completedAt, id }
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
    if (parsed && typeof parsed.completedAt === 'string' && !Number.isNaN(Date.parse(parsed.completedAt))
        && typeof parsed.id === 'string' && UUID_RE.test(parsed.id)) {
      return { completedAt: new Date(parsed.completedAt).toISOString(), id: parsed.id };
    }
  } catch { /* not base64 JSON — try legacy format */ }
  // Legacy: plain ISO timestamp (pre-composite clients)
  if (!Number.isNaN(Date.parse(raw))) {
    return { completedAt: new Date(raw).toISOString() };
  }
  return null;
}

router.get('/',
  [
    qv('limit').optional().isInt({ min: 1, max: 100 }).toInt(),
    qv('cursor').optional().isString().isLength({ max: 500 }),
    qv('projectId').optional().isUUID(),
    qv('mode').optional().isIn(['steady_state', 'dynamic']),
    qv('compliance').optional().isIn(['pass', 'fail', 'unknown']),
  ],
  async (req, res, next) => {
    if (vErr(req, res)) return;
    const limit = req.query.limit || 40;

    try {
      let sql    = RUN_SELECT;
      const params = [req.user.sub, orgId(req)];
      let pi = 3; // next param index

      if (req.query.projectId) {
        sql += ` AND p.id = $${pi++}`;
        params.push(req.query.projectId);
      }
      if (req.query.mode) {
        sql += ` AND sr.mode = $${pi++}`;
        params.push(req.query.mode);
      }
      if (req.query.compliance === 'pass') {
        sql += ` AND (sr.results->'summary'->>'compliant')::boolean = true`;
      } else if (req.query.compliance === 'fail') {
        sql += ` AND (sr.results->'summary'->>'compliant')::boolean = false`;
      }

      // Count uses the same parameterised filters (never string interpolation);
      // it is built BEFORE the cursor is applied so total stays accurate.
      const countSql    = `SELECT COUNT(*) FROM (${sql}) _c`;
      const countParams = [...params];

      // Composite keyset cursor: (completed_at, id) row comparison matches
      // the ORDER BY below exactly, so tied completed_at values can never
      // drop or duplicate rows across pages.
      if (req.query.cursor) {
        const cur = decodeCursor(req.query.cursor);
        if (!cur) return res.status(422).json({ error: 'Invalid cursor' });
        if (cur.id) {
          sql += ` AND (sr.completed_at, sr.id) < ($${pi}::timestamptz, $${pi + 1}::uuid)`;
          params.push(cur.completedAt, cur.id);
          pi += 2;
        } else {
          // Legacy single-column cursor
          sql += ` AND sr.completed_at < $${pi++}::timestamptz`;
          params.push(cur.completedAt);
        }
      }

      // Fetch limit+1 rows so we know if there are more
      const fetchSql = `${sql} ORDER BY sr.completed_at DESC, sr.id DESC LIMIT $${pi}`;
      const fetchParams = [...params, limit + 1];

      const [countResult, runsResult] = await Promise.all([
        query(countSql, countParams),
        query(fetchSql, fetchParams),
      ]);

      const allRows = runsResult.rows;
      const hasMore = allRows.length > limit;
      const pageRows = hasMore ? allRows.slice(0, limit) : allRows;
      const lastRow  = pageRows[pageRows.length - 1];

      res.json({
        total:       parseInt(countResult.rows[0].count),
        runs:        pageRows.map(formatRun),
        nextCursor:  hasMore && lastRow ? encodeCursor(lastRow) : null,
      });
    } catch (err) { next(err); }
  }
);

// ── GET /reports/saved — saved reports for the current user ───────────────────

router.get('/saved', async (req, res, next) => {
  try {
    const sql = RUN_SELECT + `
      AND sv.id IS NOT NULL
      ORDER BY sv.created_at DESC
      LIMIT 100
    `;
    const result = await query(sql, [req.user.sub, orgId(req)]);
    res.json(result.rows.map(formatRun));
  } catch (err) { next(err); }
});

// ── POST /reports/saved — save/bookmark a run ─────────────────────────────────

router.post('/saved',
  [
    body('runId').isUUID(),
    body('label').optional().isString().trim().isLength({ max: 255 }),
    body('notes').optional().isString().trim().isLength({ max: 2000 }),
  ],
  async (req, res, next) => {
    if (vErr(req, res)) return;
    const { runId, label, notes } = req.body;

    try {
      // Verify run belongs to org
      const check = await query(
        `SELECT sr.id FROM simulation_runs sr
         JOIN flowsheets f ON f.id = sr.flowsheet_id
         JOIN projects   p ON p.id = f.project_id
         WHERE sr.id = $1 AND p.organisation_id = $2 AND sr.status = 'completed'`,
        [runId, orgId(req)]
      );
      if (!check.rows.length) return res.status(404).json({ error: 'Run not found' });

      const result = await query(
        `INSERT INTO saved_reports (organisation_id, run_id, saved_by, label, notes)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (organisation_id, run_id, saved_by)
         DO UPDATE SET label = EXCLUDED.label, notes = EXCLUDED.notes
         RETURNING id, run_id, label, notes, created_at`,
        [orgId(req), runId, req.user.sub, label || null, notes || null]
      );
      res.status(201).json(result.rows[0]);
    } catch (err) { next(err); }
  }
);

// ── DELETE /reports/saved/:runId — unsave a run ───────────────────────────────

router.delete('/saved/:runId',
  [param('runId').isUUID()],
  async (req, res, next) => {
    if (vErr(req, res)) return;
    try {
      await query(
        `DELETE FROM saved_reports WHERE run_id = $1 AND saved_by = $2 AND organisation_id = $3`,
        [req.params.runId, req.user.sub, orgId(req)]
      );
      res.json({ success: true });
    } catch (err) { next(err); }
  }
);

// ── GET /reports/:runId/excel — single-run Excel export ───────────────────────

router.get('/:runId/excel',
  [param('runId').isUUID()],
  async (req, res, next) => {
    if (vErr(req, res)) return;
    const { runId } = req.params;
    try {
      const result = await query(
        `SELECT sr.*,
                f.name AS flowsheet_name,
                f.canvas_data,
                p.name AS project_name,
                o.name AS org_name,
                u.first_name || ' ' || u.last_name AS created_by_name,
                sr.config AS run_config
         FROM simulation_runs sr
         JOIN flowsheets f ON f.id = sr.flowsheet_id
         JOIN projects   p ON p.id = f.project_id
         JOIN organisations o ON o.id = p.organisation_id
         JOIN users u ON u.id = sr.created_by
         WHERE sr.id = $1 AND p.organisation_id = $2 AND sr.status = 'completed'`,
        [runId, orgId(req)]
      );
      if (!result.rows.length) return res.status(404).json({ error: 'Run not found' });

      const row = result.rows[0];
      const reportData = buildReportData(row);

      logger.info('Generating Excel report', { runId, by: req.user.sub });
      const xlsxBuffer = await generateExcel({ mode: 'single', data: reportData });

      const safeName = (row.flowsheet_name || 'report').replace(/[^a-zA-Z0-9_-]/g, '_');
      const filename  = `watersim_${safeName}_${runId.slice(0, 8)}.xlsx`;

      res.setHeader('Content-Type',        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.setHeader('Content-Length',       xlsxBuffer.length);
      res.setHeader('Cache-Control',        'private, max-age=300');
      res.send(xlsxBuffer);
    } catch (err) {
      logger.error('Excel generation error', { runId, error: err.message });
      next(err);
    }
  }
);

// ── POST /reports/compare/excel — multi-run comparison Excel export ────────────

router.post('/compare/excel',
  [
    body('runIds').isArray({ min: 2, max: 6 }),
    body('runIds.*').isUUID(),
  ],
  async (req, res, next) => {
    if (vErr(req, res)) return;
    const { runIds, labels = [] } = req.body;

    try {
      // Load all runs, verifying org ownership
      const placeholders = runIds.map((_, i) => `$${i + 3}`).join(', ');
      const result = await query(
        `SELECT sr.*,
                f.id   AS flowsheet_id,
                f.name AS flowsheet_name,
                f.canvas_data,
                p.id   AS project_id,
                p.name AS project_name,
                o.name AS org_name,
                u.first_name || ' ' || u.last_name AS created_by_name,
                sr.config AS run_config
         FROM simulation_runs sr
         JOIN flowsheets f ON f.id = sr.flowsheet_id
         JOIN projects   p ON p.id = f.project_id
         JOIN organisations o ON o.id = p.organisation_id
         JOIN users u ON u.id = sr.created_by
         WHERE p.organisation_id = $1
           AND sr.status = 'completed'
           AND sr.id = ANY($2::uuid[])`,
        [orgId(req), runIds]
      );

      if (result.rows.length === 0) return res.status(404).json({ error: 'No runs found' });

      // Order results to match requested runIds order, attach custom labels
      const rowMap = Object.fromEntries(result.rows.map(r => [r.id, r]));
      const runs = runIds
        .filter(id => rowMap[id])
        .map((id, i) => {
          const r    = buildReportData(rowMap[id]);
          r.label    = labels[i] || r.flowsheet_name;
          return r;
        });

      if (runs.length < 2) return res.status(422).json({ error: 'At least 2 valid runs required' });

      logger.info('Generating comparison Excel', { runIds, by: req.user.sub });
      const xlsxBuffer = await generateExcel({ mode: 'comparison', runs });

      const names    = runs.map(r => (r.flowsheet_name || '').replace(/[^a-zA-Z0-9]/g, '').slice(0, 12));
      const filename = `watersim_comparison_${names.join('_vs_')}.xlsx`;

      res.setHeader('Content-Type',        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.setHeader('Content-Length',       xlsxBuffer.length);
      res.setHeader('Cache-Control',        'private, max-age=60');
      res.send(xlsxBuffer);
    } catch (err) {
      logger.error('Comparison Excel error', { error: err.message });
      next(err);
    }
  }
);

module.exports = router;
