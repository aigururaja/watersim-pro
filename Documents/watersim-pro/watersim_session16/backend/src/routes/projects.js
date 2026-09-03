const express = require('express');
const { body, param, validationResult } = require('express-validator');
const { query } = require('../db/pool');
const { authenticate, requireRole } = require('../middleware/auth');
const { auditLog } = require('../utils/audit');
const logger = require('../utils/logger');

const router = express.Router();
router.use(authenticate);

function vErr(req, res) {
  const e = validationResult(req);
  if (!e.isEmpty()) { res.status(422).json({ error: 'Validation failed', details: e.array() }); return true; }
  return false;
}

// Helper: resolve req.user.sub / req.user.id (handle both shapes)
const userId = (req) => req.user.sub || req.user.id;
const orgId  = (req) => req.user.org  || req.user.organisationId;

// GET /api/v1/projects
router.get('/', async (req, res, next) => {
  try {
    const result = await query(
      `SELECT p.id, p.name, p.description, p.project_type, p.status, p.tags,
              p.created_at, p.updated_at,
              u.first_name || ' ' || u.last_name AS created_by_name,
              COUNT(f.id)::int AS flowsheet_count
       FROM   projects p
       JOIN   users u ON u.id = p.created_by
       LEFT   JOIN flowsheets f ON f.project_id = p.id AND f.is_snapshot = false
       WHERE  p.organisation_id = $1 AND p.status != 'deleted'
       GROUP  BY p.id, u.first_name, u.last_name
       ORDER  BY p.updated_at DESC`,
      [orgId(req)]
    );
    res.json(result.rows);
  } catch (err) {
    logger.error('List projects', { err: err.message });
    next(err);
  }
});

// POST /api/v1/projects (engineer+)
router.post('/', requireRole('engineer'), [
  body('name').trim().isLength({ min: 1, max: 200 }).withMessage('Name required (max 200 chars)'),
  body('description').optional().trim(),
  body('projectType').isIn(['wastewater', 'water_purification', 'combined'])
    .withMessage('projectType must be wastewater | water_purification | combined'),
  body('tags').optional().isArray(),
], async (req, res, next) => {
  if (vErr(req, res)) return;
  const { name, description, projectType, tags } = req.body;
  try {
    const result = await query(
      `INSERT INTO projects (organisation_id, created_by, name, description, project_type, tags)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [orgId(req), userId(req), name, description || null, projectType, tags || []]
    );
    auditLog(req, 'project.create', 'project', result.rows[0].id, { name });
    logger.info('Project created', { projectId: result.rows[0].id, userId: userId(req) });
    res.status(201).json(result.rows[0]);
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/projects/:id
router.get('/:id', [param('id').isUUID()], async (req, res, next) => {
  if (vErr(req, res)) return;
  try {
    const result = await query(
      `SELECT p.*, u.first_name || ' ' || u.last_name AS created_by_name,
              COUNT(f.id)::int AS flowsheet_count
       FROM   projects p
       JOIN   users u ON u.id = p.created_by
       LEFT   JOIN flowsheets f ON f.project_id = p.id AND f.is_snapshot = false
       WHERE  p.id = $1 AND p.organisation_id = $2 AND p.status != 'deleted'
       GROUP  BY p.id, u.first_name, u.last_name`,
      [req.params.id, orgId(req)]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Project not found' });
    res.json(result.rows[0]);
  } catch (err) { next(err); }
});

// PATCH /api/v1/projects/:id (engineer+)
router.patch('/:id', requireRole('engineer'), [
  param('id').isUUID(),
  body('name').optional().trim().isLength({ min: 1, max: 200 }),
  body('description').optional().trim(),
  body('status').optional().isIn(['active', 'archived']),
  body('tags').optional().isArray(),
  body('settings').optional().isObject(),
], async (req, res, next) => {
  if (vErr(req, res)) return;
  const allowed = ['name', 'description', 'status', 'tags'];
  const fields = []; const vals = []; let i = 1;
  for (const f of allowed) {
    if (req.body[f] !== undefined) { fields.push(`${f} = $${i++}`); vals.push(req.body[f]); }
  }
  // settings is JSONB — deep-merge with existing rather than overwrite
  if (req.body.settings !== undefined) {
    fields.push(`settings = settings || $${i++}::jsonb`);
    vals.push(JSON.stringify(req.body.settings));
  }
  if (!fields.length) return res.status(422).json({ error: 'No fields to update' });
  vals.push(req.params.id, orgId(req));
  try {
    const result = await query(
      `UPDATE projects SET ${fields.join(', ')} WHERE id = $${i} AND organisation_id = $${i + 1} RETURNING *`,
      vals
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Project not found' });
    auditLog(req, 'project.update', 'project', req.params.id, { fields: Object.keys(req.body) });
    res.json(result.rows[0]);
  } catch (err) { next(err); }
});

// ── Unit-costs sub-resource (stored in project settings.unitCosts) ──────────

/**
 * GET /api/v1/projects/:id/unit-costs
 * Returns effective unit costs = defaults merged with any project-level overrides.
 */
const { DEFAULT_UNIT_COSTS } = require('../simulation/costEstimator');

router.get('/:id/unit-costs', [param('id').isUUID()], async (req, res, next) => {
  if (vErr(req, res)) return;
  try {
    const r = await query(
      `SELECT settings FROM projects WHERE id = $1 AND organisation_id = $2 AND status != 'deleted'`,
      [req.params.id, orgId(req)]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'Project not found' });
    const overrides = r.rows[0].settings?.unitCosts || {};
    res.json({
      defaults: DEFAULT_UNIT_COSTS,
      overrides,
      effective: { ...DEFAULT_UNIT_COSTS, ...overrides },
    });
  } catch (err) { next(err); }
});

/**
 * PUT /api/v1/projects/:id/unit-costs
 * Replace project-level unit-cost overrides entirely.
 * Body: object with any subset of the 13 coefficient keys.
 */
router.put('/:id/unit-costs', requireRole('engineer'), [
  param('id').isUUID(),
  body().isObject().withMessage('Body must be a unit-costs object'),
], async (req, res, next) => {
  if (vErr(req, res)) return;
  // Only allow known coefficient keys
  const ALLOWED_KEYS = new Set(Object.keys(DEFAULT_UNIT_COSTS));
  const sanitized = {};
  for (const [k, v] of Object.entries(req.body)) {
    if (ALLOWED_KEYS.has(k) && typeof v === 'number' && v >= 0) sanitized[k] = v;
  }
  try {
    const r = await query(
      `UPDATE projects
         SET settings = jsonb_set(COALESCE(settings, '{}'::jsonb), '{unitCosts}', $1::jsonb)
       WHERE id = $2 AND organisation_id = $3 AND status != 'deleted'
       RETURNING settings`,
      [JSON.stringify(sanitized), req.params.id, orgId(req)]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'Project not found' });
    const overrides = r.rows[0].settings?.unitCosts || {};
    auditLog(req, 'project.update', 'project', req.params.id, { unitCosts: sanitized });
    logger.info('Unit costs updated', { projectId: req.params.id, userId: userId(req) });
    res.json({
      defaults:  DEFAULT_UNIT_COSTS,
      overrides,
      effective: { ...DEFAULT_UNIT_COSTS, ...overrides },
    });
  } catch (err) { next(err); }
});

/**
 * DELETE /api/v1/projects/:id/unit-costs
 * Reset all overrides — revert to global defaults.
 */
router.delete('/:id/unit-costs', requireRole('engineer'), [param('id').isUUID()], async (req, res, next) => {
  if (vErr(req, res)) return;
  try {
    await query(
      `UPDATE projects SET settings = settings - 'unitCosts' WHERE id = $1 AND organisation_id = $2`,
      [req.params.id, orgId(req)]
    );
    auditLog(req, 'project.update', 'project', req.params.id, { unitCostsReset: true });
    logger.info('Unit costs reset', { projectId: req.params.id, userId: userId(req) });
    res.json({ defaults: DEFAULT_UNIT_COSTS, overrides: {}, effective: DEFAULT_UNIT_COSTS });
  } catch (err) { next(err); }
});

// DELETE /api/v1/projects/:id  (soft delete, admin/engineer only)
router.delete('/:id', requireRole('engineer'), [param('id').isUUID()], async (req, res, next) => {
  if (vErr(req, res)) return;
  try {
    const result = await query(
      `UPDATE projects SET status = 'deleted' WHERE id = $1 AND organisation_id = $2 RETURNING id`,
      [req.params.id, orgId(req)]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Project not found' });
    auditLog(req, 'project.delete', 'project', req.params.id, {});
    logger.info('Project deleted', { projectId: req.params.id, userId: userId(req) });
    res.json({ message: 'Project deleted' });
  } catch (err) { next(err); }
});

module.exports = router;
