const express = require('express');
const { body, param, validationResult } = require('express-validator');
const { query } = require('../db/pool');
const { authenticate, requireRole } = require('../middleware/auth');
const logger = require('../utils/logger');

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
  if (!await checkProject(req.params.projectId, orgId(req), res)) return;
  try {
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

// POST /api/v1/projects/:projectId/flowsheets
router.post('/', [
  body('name').trim().isLength({ min: 1, max: 200 }).withMessage('Name is required'),
  body('description').optional().trim(),
], async (req, res, next) => {
  if (vErr(req, res)) return;
  if (!await checkProject(req.params.projectId, orgId(req), res)) return;
  try {
    const result = await query(
      `INSERT INTO flowsheets (project_id, created_by, name, description, canvas_data)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [req.params.projectId, userId(req), req.body.name, req.body.description || null,
       JSON.stringify({ nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } })]
    );
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

// PATCH /api/v1/projects/:projectId/flowsheets/:id
router.patch('/:id', [
  param('id').isUUID(),
  body('name').optional().trim().isLength({ min: 1, max: 200 }),
  body('description').optional().trim(),
  body('canvasData').optional().isObject(),
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
  try {
    // Verify org ownership via join
    const result = await query(
      `UPDATE flowsheets f SET ${fields.join(', ')}
       FROM projects p
       WHERE f.id = $${i} AND f.project_id = $${i + 1}
         AND f.project_id = p.id AND p.organisation_id = $${i + 2}
         AND f.is_snapshot = false
       RETURNING f.*`,
      [...vals, orgId(req)]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Flowsheet not found or is a read-only snapshot' });
    res.json(result.rows[0]);
  } catch (err) { next(err); }
});

// DELETE /api/v1/projects/:projectId/flowsheets/:id
router.delete('/:id', requireRole('engineer'), [param('id').isUUID()], async (req, res, next) => {
  if (vErr(req, res)) return;
  try {
    const result = await query(
      `DELETE FROM flowsheets f USING projects p
       WHERE f.id = $1 AND f.project_id = $2
         AND f.project_id = p.id AND p.organisation_id = $3
         AND f.is_snapshot = false
       RETURNING f.id`,
      [req.params.id, req.params.projectId, orgId(req)]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Flowsheet not found or is a read-only snapshot' });
    res.json({ message: 'Flowsheet deleted' });
  } catch (err) { next(err); }
});

// POST /api/v1/projects/:projectId/flowsheets/:id/snapshot
router.post('/:id/snapshot', [
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
    logger.info('Snapshot created', { flowsheetId: req.params.id, tag: req.body.tag });
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Snapshot tag already exists for this project' });
    next(err);
  }
});

module.exports = router;
