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
const { query } = require('../db/pool');
const { authenticate, requireRole } = require('../middleware/auth');

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

// ── POST / — create template ───────────────────────────────────────────────

router.post('/', [
  body('name').isString().trim().notEmpty().withMessage('name is required'),
  body('description').optional().isString(),
  body('permit_limits').optional().isObject().withMessage('permit_limits must be an object'),
  body('is_active').optional().isBoolean(),
], async (req, res, next) => {
  if (vErr(req, res)) return;
  const role = req.user.role;
  if (!['admin', 'engineer'].includes(role)) {
    return res.status(403).json({ error: 'Forbidden — admin or engineer required' });
  }

  const { name, description, permit_limits, is_active } = req.body;
  const limits = sanitizeLimits(permit_limits || {});

  try {
    // If setting active, deactivate all other templates for this org first
    if (is_active) {
      await query(
        `UPDATE permit_templates SET is_active = FALSE WHERE organisation_id = $1`,
        [orgId(req)]
      );
    }

    const result = await query(
      `INSERT INTO permit_templates
         (organisation_id, created_by, name, description, is_active, permit_limits)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [orgId(req), userId(req), name, description || null, is_active ?? false, JSON.stringify(limits)]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) { next(err); }
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

// ── PATCH /:id — update template ──────────────────────────────────────────

router.patch('/:id', [
  param('id').isUUID(),
  body('name').optional().isString().trim().notEmpty(),
  body('description').optional().isString(),
  body('permit_limits').optional().isObject(),
], async (req, res, next) => {
  if (vErr(req, res)) return;
  const role = req.user.role;
  if (!['admin', 'engineer'].includes(role)) {
    return res.status(403).json({ error: 'Forbidden — admin or engineer required' });
  }

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
    res.json(result.rows[0]);
  } catch (err) { next(err); }
});

// ── DELETE /:id — delete template ─────────────────────────────────────────

router.delete('/:id', [param('id').isUUID()], async (req, res, next) => {
  if (vErr(req, res)) return;
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Forbidden — admin only' });
  }
  try {
    const result = await query(
      `DELETE FROM permit_templates WHERE id=$1 AND organisation_id=$2 RETURNING id`,
      [req.params.id, orgId(req)]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Template not found' });
    res.json({ deleted: true, id: req.params.id });
  } catch (err) { next(err); }
});

// ── POST /:id/activate — set as the active org template ───────────────────

router.post('/:id/activate', [param('id').isUUID()], async (req, res, next) => {
  if (vErr(req, res)) return;
  const role = req.user.role;
  if (!['admin', 'engineer'].includes(role)) {
    return res.status(403).json({ error: 'Forbidden — admin or engineer required' });
  }
  try {
    // Verify template belongs to org
    const check = await query(
      `SELECT id FROM permit_templates WHERE id=$1 AND organisation_id=$2`,
      [req.params.id, orgId(req)]
    );
    if (!check.rows[0]) return res.status(404).json({ error: 'Template not found' });

    // Deactivate all, then activate the selected one
    await query(
      `UPDATE permit_templates SET is_active=FALSE WHERE organisation_id=$1`,
      [orgId(req)]
    );
    const result = await query(
      `UPDATE permit_templates SET is_active=TRUE WHERE id=$1 RETURNING *`,
      [req.params.id]
    );
    res.json(result.rows[0]);
  } catch (err) { next(err); }
});

module.exports = router;
