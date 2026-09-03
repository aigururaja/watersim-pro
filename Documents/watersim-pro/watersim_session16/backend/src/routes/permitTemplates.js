/**
 * WaterSim Pro — Permit Templates API  (Session 6 — Step 32)
 *
 * Org-level effluent permit limit configuration.
 * Admins and engineers can create/edit templates; operators are read-only.
 *
 * GET    /permit-templates              — list org templates
 * POST   /permit-templates              — create new template (admin/engineer)
 * GET    /permit-templates/:id          — get single template
 * PATCH  /permit-templates/:id          — update template (admin/engineer)
 * DELETE /permit-templates/:id          — delete template (admin only)
 * POST   /permit-templates/:id/activate — set as active org template (admin/engineer)
 */

'use strict';

const express = require('express');
const { body, param, validationResult } = require('express-validator');
const { query, withTransaction } = require('../db/pool');
const { authenticate, requireRole } = require('../middleware/auth');
const { auditLog } = require('../utils/audit');

const router = express.Router();
router.use(authenticate);

function vErr(req, res) {
  const e = validationResult(req);
  if (!e.isEmpty()) { res.status(422).json({ error: 'Validation failed', details: e.array() }); return true; }
  return false;
}

const userId = (req) => req.user.sub || req.user.id;
const orgId  = (req) => req.user.org  || req.user.organisationId;

const VALID_LIMIT_KEYS = ['BOD', 'TSS', 'TN', 'TP', 'NH4', 'NO3', 'pH_min', 'pH_max'];

function sanitizeLimits(raw) {
  if (!raw || typeof raw !== 'object') return {};
  const out = {};
  for (const k of VALID_LIMIT_KEYS) {
    if (k in raw) {
      const v = raw[k];
      out[k] = (v === null || v === '') ? null : parseFloat(v);
    }
  }
  return out;
}

// ── GET / — list templates ─────────────────────────────────────────────────

router.get('/', async (req, res, next) => {
  try {
    const result = await query(
      `SELECT t.id, t.name, t.description, t.is_active, t.permit_limits,
              t.created_at, t.updated_at,
              u.first_name || ' ' || u.last_name AS created_by_name
       FROM permit_templates t
       JOIN users u ON u.id = t.created_by
       WHERE t.organisation_id = $1
       ORDER BY t.is_active DESC, t.created_at DESC`,
      [orgId(req)]
    );
    res.json(result.rows);
  } catch (err) { next(err); }
});

// ── POST / — create template (engineer+) ───────────────────────────────────

router.post('/', requireRole('engineer'), [
  body('name').isString().trim().notEmpty().withMessage('name is required'),
  body('description').optional().isString(),
  body('permit_limits').optional().isObject().withMessage('permit_limits must be an object'),
  body('is_active').optional().isBoolean(),
], async (req, res, next) => {
  if (vErr(req, res)) return;

  const { name, description, permit_limits, is_active } = req.body;
  const limits = sanitizeLimits(permit_limits || {});

  try {
    // Deactivate-then-insert must be atomic — otherwise a crash or a
    // concurrent request can leave the org with zero or two active templates.
    // The partial unique index (migration 006) backstops the invariant.
    const result = await withTransaction(async (client) => {
      if (is_active) {
        await client.query(
          `UPDATE permit_templates SET is_active = FALSE WHERE organisation_id = $1`,
          [orgId(req)]
        );
      }
      return client.query(
        `INSERT INTO permit_templates
           (organisation_id, created_by, name, description, is_active, permit_limits)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING *`,
        [orgId(req), userId(req), name, description || null, is_active ?? false, JSON.stringify(limits)]
      );
    });
    auditLog(req, 'permit_template.create', 'permit_template', result.rows[0].id, { name, is_active: is_active ?? false });
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Another template was activated concurrently — please retry' });
    next(err);
  }
});

// ── GET /:id — single template ─────────────────────────────────────────────

router.get('/:id', [param('id').isUUID()], async (req, res, next) => {
  if (vErr(req, res)) return;
  try {
    const result = await query(
      `SELECT t.*, u.first_name || ' ' || u.last_name AS created_by_name
       FROM permit_templates t
       JOIN users u ON u.id = t.created_by
       WHERE t.id = $1 AND t.organisation_id = $2`,
      [req.params.id, orgId(req)]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Template not found' });
    res.json(result.rows[0]);
  } catch (err) { next(err); }
});

// ── PATCH /:id — update template (engineer+) ──────────────────────────────

router.patch('/:id', requireRole('engineer'), [
  param('id').isUUID(),
  body('name').optional().isString().trim().notEmpty(),
  body('description').optional().isString(),
  body('permit_limits').optional().isObject(),
], async (req, res, next) => {
  if (vErr(req, res)) return;

  try {
    const existing = await query(
      `SELECT * FROM permit_templates WHERE id = $1 AND organisation_id = $2`,
      [req.params.id, orgId(req)]
    );
    if (!existing.rows[0]) return res.status(404).json({ error: 'Template not found' });

    const t = existing.rows[0];
    const newName        = req.body.name        ?? t.name;
    const newDescription = req.body.description ?? t.description;
    const newLimits      = req.body.permit_limits != null
      ? sanitizeLimits(req.body.permit_limits)
      : t.permit_limits;

    const result = await query(
      `UPDATE permit_templates
       SET name=$1, description=$2, permit_limits=$3, updated_at=NOW()
       WHERE id=$4 AND organisation_id=$5
       RETURNING *`,
      [newName, newDescription, JSON.stringify(newLimits), req.params.id, orgId(req)]
    );
    auditLog(req, 'permit_template.update', 'permit_template', req.params.id, { fields: Object.keys(req.body) });
    res.json(result.rows[0]);
  } catch (err) { next(err); }
});

// ── DELETE /:id — delete template (admin only) ────────────────────────────

router.delete('/:id', requireRole('admin'), [param('id').isUUID()], async (req, res, next) => {
  if (vErr(req, res)) return;
  try {
    const result = await query(
      `DELETE FROM permit_templates WHERE id=$1 AND organisation_id=$2 RETURNING id`,
      [req.params.id, orgId(req)]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Template not found' });
    auditLog(req, 'permit_template.delete', 'permit_template', req.params.id, {});
    res.json({ deleted: true, id: req.params.id });
  } catch (err) { next(err); }
});

// ── POST /:id/activate — set as the active org template (engineer+) ───────

router.post('/:id/activate', requireRole('engineer'), [param('id').isUUID()], async (req, res, next) => {
  try {
    if (vErr(req, res)) return;

    // Deactivate-all + activate-one must be atomic: the old two-statement
    // toggle could leave the org with zero active templates if the process
    // died between statements, or two active under concurrency. The partial
    // unique index from migration 006 (one active row per organisation)
    // backstops the invariant at the database level.
    const result = await withTransaction(async (client) => {
      const check = await client.query(
        `SELECT id FROM permit_templates WHERE id=$1 AND organisation_id=$2 FOR UPDATE`,
        [req.params.id, orgId(req)]
      );
      if (!check.rows[0]) return null;

      await client.query(
        `UPDATE permit_templates SET is_active=FALSE WHERE organisation_id=$1 AND is_active=TRUE`,
        [orgId(req)]
      );
      return client.query(
        `UPDATE permit_templates SET is_active=TRUE WHERE id=$1 AND organisation_id=$2 RETURNING *`,
        [req.params.id, orgId(req)]
      );
    });

    if (!result || !result.rows[0]) return res.status(404).json({ error: 'Template not found' });
    auditLog(req, 'permit_template.activate', 'permit_template', req.params.id, {});
    res.json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Another template was activated concurrently — please retry' });
    next(err);
  }
});

module.exports = router;
