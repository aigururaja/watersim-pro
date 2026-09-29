const express = require('express');
const { body, param, validationResult } = require('express-validator');
const { query } = require('../db/pool');
const { authenticate, requireRole } = require('../middleware/auth');
const { auditLog } = require('../utils/audit');
const logger = require('../utils/logger');
const Anthropic = require('@anthropic-ai/sdk');
const pidReader = require('../pid/pidReader');

const router = express.Router({ mergeParams: true }); // inherits :projectId
router.use(authenticate);

function vErr(req, res) {
  const e = validationResult(req);
  if (!e.isEmpty()) { res.status(422).json({ error: 'Validation failed', details: e.array() }); return true; }
  return false;
}

const userId = (req) => req.user.sub || req.user.id;
const orgId  = (req) => req.user.org  || req.user.organisationId;

// Verify project exists and belongs to user's org
async function checkProject(projectId, organisationId, res) {
  const r = await query(
    `SELECT id FROM projects WHERE id = $1 AND organisation_id = $2 AND status != 'deleted'`,
    [projectId, organisationId]
  );
  if (!r.rows.length) { res.status(404).json({ error: 'Project not found' }); return false; }
  return true;
}

// GET /api/v1/projects/:projectId/flowsheets
router.get('/', async (req, res, next) => {
  try {
    // The await must stay inside try — in Express 4 a rejection outside
    // try/catch never reaches next(err) and the request hangs forever.
    if (!await checkProject(req.params.projectId, orgId(req), res)) return;
    const result = await query(
      `SELECT f.id, f.name, f.description, f.version, f.is_snapshot, f.snapshot_tag,
              f.created_at, f.updated_at,
              u.first_name || ' ' || u.last_name AS created_by_name
       FROM   flowsheets f
       JOIN   users u ON u.id = f.created_by
       WHERE  f.project_id = $1
       ORDER  BY f.is_snapshot ASC, f.updated_at DESC`,
      [req.params.projectId]
    );
    res.json(result.rows);
  } catch (err) { next(err); }
});

// POST /api/v1/projects/:projectId/flowsheets (engineer+)
router.post('/', requireRole('engineer'), [
  body('name').trim().isLength({ min: 1, max: 200 }).withMessage('Name is required'),
  body('description').optional().trim(),
], async (req, res, next) => {
  if (vErr(req, res)) return;
  try {
    // checkProject await inside try — see note on GET / above.
    if (!await checkProject(req.params.projectId, orgId(req), res)) return;
    const result = await query(
      `INSERT INTO flowsheets (project_id, created_by, name, description, canvas_data)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [req.params.projectId, userId(req), req.body.name, req.body.description || null,
       JSON.stringify({ nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } })]
    );
    auditLog(req, 'flowsheet.create', 'flowsheet', result.rows[0].id, { name: req.body.name, projectId: req.params.projectId });
    logger.info('Flowsheet created', { flowsheetId: result.rows[0].id, userId: userId(req) });
    res.status(201).json(result.rows[0]);
  } catch (err) { next(err); }
});

// GET /api/v1/projects/:projectId/flowsheets/:id
router.get('/:id', [param('id').isUUID()], async (req, res, next) => {
  if (vErr(req, res)) return;
  try {
    const result = await query(
      `SELECT f.*, u.first_name || ' ' || u.last_name AS created_by_name
       FROM   flowsheets f
       JOIN   users u ON u.id = f.created_by
       JOIN   projects p ON p.id = f.project_id
       WHERE  f.id = $1 AND f.project_id = $2 AND p.organisation_id = $3`,
      [req.params.id, req.params.projectId, orgId(req)]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Flowsheet not found' });
    res.json(result.rows[0]);
  } catch (err) { next(err); }
});

// PATCH /api/v1/projects/:projectId/flowsheets/:id (engineer+)
//
// Optional optimistic concurrency: when the body carries `expectedVersion`,
// the update only applies if the stored version matches; a mismatch returns
// 409 with the current version. Without it, behaviour is unchanged
// (last-write-wins, backward compatible).
router.patch('/:id', requireRole('engineer'), [
  param('id').isUUID(),
  body('name').optional().trim().isLength({ min: 1, max: 200 }),
  body('description').optional().trim(),
  body('canvasData').optional().isObject(),
  body('expectedVersion').optional().isInt({ min: 0 }).toInt(),
], async (req, res, next) => {
  if (vErr(req, res)) return;
  const fields = []; const vals = []; let i = 1;
  if (req.body.canvasData  !== undefined) { fields.push(`canvas_data = $${i++}`); vals.push(JSON.stringify(req.body.canvasData)); }
  if (req.body.name        !== undefined) { fields.push(`name = $${i++}`);        vals.push(req.body.name); }
  if (req.body.description !== undefined) { fields.push(`description = $${i++}`); vals.push(req.body.description); }
  if (!fields.length) return res.status(422).json({ error: 'No fields to update' });
  // Auto-bump version when canvas is saved
  if (req.body.canvasData !== undefined) { fields.push(`version = version + 1`); }
  vals.push(req.params.id, req.params.projectId);
  const expectedVersion = req.body.expectedVersion;
  const versionClause = expectedVersion !== undefined ? ` AND f.version = $${i + 3}` : '';
  try {
    // Verify org ownership via join
    const result = await query(
      `UPDATE flowsheets f SET ${fields.join(', ')}
       FROM projects p
       WHERE f.id = $${i} AND f.project_id = $${i + 1}
         AND f.project_id = p.id AND p.organisation_id = $${i + 2}
         AND f.is_snapshot = false${versionClause}
       RETURNING f.*`,
      expectedVersion !== undefined ? [...vals, orgId(req), expectedVersion] : [...vals, orgId(req)]
    );
    if (!result.rows[0]) {
      if (expectedVersion !== undefined) {
        // Distinguish "gone" from "stale": re-read without the version guard.
        const current = await query(
          `SELECT f.version FROM flowsheets f
           JOIN projects p ON p.id = f.project_id
           WHERE f.id = $1 AND f.project_id = $2 AND p.organisation_id = $3 AND f.is_snapshot = false`,
          [req.params.id, req.params.projectId, orgId(req)]
        );
        if (current.rows[0]) {
          return res.status(409).json({
            error:          'Version conflict — the flowsheet was modified by someone else',
            currentVersion: current.rows[0].version,
            expectedVersion,
          });
        }
      }
      return res.status(404).json({ error: 'Flowsheet not found or is a read-only snapshot' });
    }
    auditLog(req, 'flowsheet.update', 'flowsheet', req.params.id, { fields: Object.keys(req.body) });
    res.json(result.rows[0]);
  } catch (err) { next(err); }
});

// DELETE /api/v1/projects/:projectId/flowsheets/:id
router.delete('/:id', requireRole('engineer'), [param('id').isUUID()], async (req, res, next) => {
  if (vErr(req, res)) return;
  try {
    const result = await query(
      `DELETE FROM flowsheets
       WHERE id = $1 AND project_id = $2
         AND project_id IN (SELECT id FROM projects WHERE id = $2 AND organisation_id = $3)
         AND is_snapshot = false
       RETURNING id`,
      [req.params.id, req.params.projectId, orgId(req)]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Flowsheet not found or is a read-only snapshot' });
    auditLog(req, 'flowsheet.delete', 'flowsheet', req.params.id, { projectId: req.params.projectId });
    res.json({ message: 'Flowsheet deleted' });
  } catch (err) { next(err); }
});

// POST /api/v1/projects/:projectId/flowsheets/:id/snapshot (engineer+)
router.post('/:id/snapshot', requireRole('engineer'), [
  param('id').isUUID(),
  body('tag').trim().isLength({ min: 1, max: 100 }).withMessage('Snapshot tag is required'),
], async (req, res, next) => {
  if (vErr(req, res)) return;
  try {
    const src = await query(
      `SELECT f.* FROM flowsheets f
       JOIN projects p ON p.id = f.project_id
       WHERE f.id = $1 AND f.project_id = $2 AND p.organisation_id = $3 AND f.is_snapshot = false`,
      [req.params.id, req.params.projectId, orgId(req)]
    );
    if (!src.rows[0]) return res.status(404).json({ error: 'Flowsheet not found' });
    const f = src.rows[0];
    const result = await query(
      `INSERT INTO flowsheets (project_id, created_by, name, description, version, is_snapshot, snapshot_tag, canvas_data)
       VALUES ($1,$2,$3,$4,$5,true,$6,$7) RETURNING *`,
      [f.project_id, userId(req), `${f.name} [${req.body.tag}]`,
       f.description, f.version, req.body.tag, f.canvas_data]
    );
    auditLog(req, 'flowsheet.snapshot', 'flowsheet', result.rows[0].id, { sourceFlowsheetId: req.params.id, tag: req.body.tag });
    logger.info('Snapshot created', { flowsheetId: req.params.id, tag: req.body.tag });
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Snapshot tag already exists for this project' });
    next(err);
  }
});

// ── P&ID picture ─────────────────────────────────────────────────────────────
//
// One P&ID picture per flowsheet, uploaded so AI can read it and build the
// flowsheet (POST …/background/read below). Stored apart from canvas_data (see
// migration 016). The browser downsizes the image before sending it, so the
// 4 MB cap here is a guard rather than the working size. The image itself is
// only ever read server-side; responses carry its metadata.

const BG_MAX_CHARS = 4 * 1024 * 1024;
const BG_DATA_URL = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/;

async function flowsheetInOrg(req) {
  const r = await query(
    `SELECT f.id FROM flowsheets f
     JOIN projects p ON p.id = f.project_id
     WHERE f.id = $1 AND f.project_id = $2 AND p.organisation_id = $3`,
    [req.params.id, req.params.projectId, orgId(req)]
  );
  return r.rows.length > 0;
}

/** Where the drawing's layout lands on the sheet: origin and flow units per pixel. */
function cleanPlacement(p = {}) {
  const n = (v, lo, hi, dflt) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Number(v))) : dflt);
  return {
    x:     n(p.x, -1e6, 1e6, 0),
    y:     n(p.y, -1e6, 1e6, 0),
    scale: n(p.scale, 0.05, 20, 1),
  };
}

const toPicture = (row) => ({
  fileName:  row.file_name,
  width:     row.width,
  height:    row.height,
  placement: typeof row.placement === 'string' ? JSON.parse(row.placement) : row.placement,
  updatedAt: row.updated_at,
});

// GET /api/v1/projects/:projectId/flowsheets/:id/background — 204 when none
router.get('/:id/background', [param('id').isUUID()], async (req, res, next) => {
  if (vErr(req, res)) return;
  try {
    if (!await flowsheetInOrg(req)) return res.status(404).json({ error: 'Flowsheet not found' });
    const r = await query(
      `SELECT file_name, width, height, placement, updated_at
       FROM flowsheet_backgrounds WHERE flowsheet_id = $1`, [req.params.id]);
    if (!r.rows[0]) return res.status(204).end();
    res.json(toPicture(r.rows[0]));
  } catch (err) { next(err); }
});

// PUT /api/v1/projects/:projectId/flowsheets/:id/background (engineer+)
// Uploads or replaces the picture.
router.put('/:id/background', requireRole('engineer'), [
  param('id').isUUID(),
  body('imageData').isString().isLength({ max: BG_MAX_CHARS })
    .withMessage('Image is too large — use a smaller image (4 MB max)')
    .matches(BG_DATA_URL).withMessage('Image must be a PNG, JPEG or WebP'),
  body('width').isInt({ min: 1, max: 20000 }),
  body('height').isInt({ min: 1, max: 20000 }),
  body('fileName').optional().isString().isLength({ max: 255 }),
  body('placement').optional().isObject(),
], async (req, res, next) => {
  if (vErr(req, res)) return;
  try {
    if (!await flowsheetInOrg(req)) return res.status(404).json({ error: 'Flowsheet not found' });
    const { imageData, width, height, fileName } = req.body;
    const result = await query(
      `INSERT INTO flowsheet_backgrounds (flowsheet_id, image_data, file_name, width, height, placement, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (flowsheet_id) DO UPDATE SET
         image_data = EXCLUDED.image_data, file_name = EXCLUDED.file_name,
         width = EXCLUDED.width, height = EXCLUDED.height,
         placement = EXCLUDED.placement, updated_by = EXCLUDED.updated_by, updated_at = NOW()
       RETURNING file_name, width, height, placement, updated_at`,
      [req.params.id, imageData, fileName || null, width, height,
       JSON.stringify(cleanPlacement(req.body.placement)), userId(req)]
    );
    auditLog(req, 'flowsheet.background.upload', 'flowsheet', req.params.id, { fileName: fileName || null, width, height });
    res.json(toPicture(result.rows[0]));
  } catch (err) { next(err); }
});

// POST /api/v1/projects/:projectId/flowsheets/:id/background/read (engineer+)
// Reads the stored P&ID picture with Claude and returns a PROPOSED flowsheet
// (units, connections, skipped items). Nothing is saved: the canvas shows the
// proposal for review and the user creates the blocks.
router.post('/:id/background/read', requireRole('engineer'), [param('id').isUUID()], async (req, res, next) => {
  if (vErr(req, res)) return;
  try {
    if (!await flowsheetInOrg(req)) return res.status(404).json({ error: 'Flowsheet not found' });
    if (!pidReader.isConfigured()) {
      return res.status(503).json({
        error: 'AI reading is not set up yet. Add ANTHROPIC_API_KEY to backend/.env and restart the server.',
        code: 'PID_READER_NOT_CONFIGURED',
      });
    }
    const r = await query('SELECT image_data FROM flowsheet_backgrounds WHERE flowsheet_id = $1', [req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Upload a P&ID picture first' });

    const started = Date.now();
    const proposal = await pidReader.readPid(r.rows[0].image_data);
    auditLog(req, 'flowsheet.background.read', 'flowsheet', req.params.id, {
      units: proposal.units.length, connections: proposal.connections.length, model: proposal.model,
    });
    logger.info('P&ID read', { flowsheetId: req.params.id, units: proposal.units.length, ms: Date.now() - started });
    res.json(proposal);
  } catch (err) {
    if (err instanceof pidReader.PidReadError) return res.status(err.status).json({ error: err.message });
    if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
      return res.status(503).json({ error: 'The Anthropic API key was rejected. Check ANTHROPIC_API_KEY in backend/.env.', code: 'PID_READER_BAD_KEY' });
    }
    if (err instanceof Anthropic.RateLimitError) {
      return res.status(429).json({ error: 'The AI service is busy. Wait a minute and try again.' });
    }
    if (err instanceof Anthropic.APIConnectionError) {
      return res.status(502).json({ error: 'Could not reach the AI service. Check the internet connection and try again.' });
    }
    if (err instanceof Anthropic.APIError) {
      logger.error('P&ID read failed', { status: err.status, message: err.message });
      return res.status(502).json({ error: `The AI service returned an error (${err.status ?? 'unknown'}). Try again.` });
    }
    next(err);
  }
});

// DELETE /api/v1/projects/:projectId/flowsheets/:id/background (engineer+)
router.delete('/:id/background', requireRole('engineer'), [param('id').isUUID()], async (req, res, next) => {
  if (vErr(req, res)) return;
  try {
    if (!await flowsheetInOrg(req)) return res.status(404).json({ error: 'Flowsheet not found' });
    await query('DELETE FROM flowsheet_backgrounds WHERE flowsheet_id = $1', [req.params.id]);
    auditLog(req, 'flowsheet.background.remove', 'flowsheet', req.params.id, {});
    res.status(204).end();
  } catch (err) { next(err); }
});

module.exports = router;
