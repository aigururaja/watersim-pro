/**
 * WaterSim Pro — PLC connection API   (mounted at /api/v1/plc)
 *
 *   GET    /protocols            — registered protocol descriptors
 *   GET    /connections          — org's connections (passwords masked)
 *   POST   /connections          — create (engineer+)
 *   PATCH  /connections/:id      — partial update (engineer+)
 *   DELETE /connections/:id      — delete, bindings cascade (engineer+)
 *   POST   /connections/:id/test — connectivity probe (engineer+)
 *
 * Every query is org-scoped by organisation_id. Config fields declared as
 * type 'password' in the driver descriptor (plus anything named like a
 * password/secret) are masked as '•••' in every response; a PATCH that sends
 * back the mask keeps the stored value.
 */
'use strict';

const express = require('express');
const { body, param, validationResult } = require('express-validator');
const { query } = require('../db/pool');
const { authenticate, requireRole } = require('../middleware/auth');
const { auditLog } = require('../utils/audit');
const logger = require('../utils/logger');
const { getDriver, listProtocols } = require('../plc/registry');

const router = express.Router();
router.use(authenticate);

function vErr(req, res) {
  const e = validationResult(req);
  if (!e.isEmpty()) { res.status(422).json({ error: 'Validation failed', details: e.array() }); return true; }
  return false;
}

const userId = (req) => req.user.sub || req.user.id;
const orgId  = (req) => req.user.org  || req.user.organisationId;

const MASK = '•••';
const SECRET_KEY_RE = /password|secret|api[_-]?key|token/i;

/** Keys of config fields that must never leave the API in clear text. */
function secretKeys(protocol, config = {}) {
  const keys = new Set();
  const driver = getDriver(protocol);
  for (const f of driver?.descriptor.configFields || []) {
    if (f.type === 'password') keys.add(f.key);
  }
  for (const k of Object.keys(config)) {
    if (SECRET_KEY_RE.test(k)) keys.add(k);
  }
  return keys;
}

/** Return a copy of the row with secret config values replaced by '•••'. */
function maskConnection(row) {
  const config = { ...(row.config || {}) };
  for (const k of secretKeys(row.protocol, config)) {
    if (config[k] !== undefined && config[k] !== null && config[k] !== '') config[k] = MASK;
  }
  return { ...row, config };
}

/**
 * Merge an incoming config against the stored one: any secret field sent back
 * as the mask keeps its stored value (so the UI can round-trip masked configs).
 */
function unmaskIncomingConfig(protocol, incoming, stored = {}) {
  const config = { ...incoming };
  for (const k of secretKeys(protocol, config)) {
    if (config[k] === MASK && stored[k] !== undefined) config[k] = stored[k];
  }
  return config;
}

const validProtocol = (p) => {
  if (!getDriver(p)) throw new Error(`Unknown protocol "${p}"`);
  return true;
};

// ── GET /protocols ───────────────────────────────────────────────────────────
router.get('/protocols', (_req, res) => {
  res.json(listProtocols());
});

// ── GET /connections ─────────────────────────────────────────────────────────
router.get('/connections', async (req, res, next) => {
  try {
    const r = await query(
      `SELECT id, organisation_id, name, protocol, config, enabled, status,
              last_seen, last_error, created_by, created_at, updated_at
       FROM plc_connections
       WHERE organisation_id = $1
       ORDER BY name ASC`,
      [orgId(req)]
    );
    res.json(r.rows.map(maskConnection));
  } catch (err) { next(err); }
});

// ── POST /connections (engineer+) ────────────────────────────────────────────
router.post('/connections', requireRole('engineer'), [
  body('name').trim().isLength({ min: 1, max: 120 }).withMessage('Name is required (max 120 chars)'),
  body('protocol').isString().custom(validProtocol),
  body('config').optional().isObject().withMessage('config must be an object'),
  body('enabled').optional().isBoolean().toBoolean(),
], async (req, res, next) => {
  if (vErr(req, res)) return;
  try {
    const driver = getDriver(req.body.protocol);
    const config = req.body.config || {};
    const configErrors = driver.validateConfig(config);
    if (configErrors.length) {
      return res.status(422).json({ error: 'Validation failed', details: configErrors.map((msg) => ({ msg })) });
    }

    const r = await query(
      `INSERT INTO plc_connections (organisation_id, name, protocol, config, enabled, created_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [orgId(req), req.body.name, req.body.protocol, JSON.stringify(config),
       req.body.enabled !== undefined ? req.body.enabled : true, userId(req)]
    );
    auditLog(req, 'plc_connection.create', 'plc_connection', r.rows[0].id,
      { name: req.body.name, protocol: req.body.protocol });
    logger.info('PLC connection created', { connectionId: r.rows[0].id, protocol: req.body.protocol });
    res.status(201).json(maskConnection(r.rows[0]));
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'A connection with this name already exists' });
    next(err);
  }
});

// ── PATCH /connections/:id (engineer+) ───────────────────────────────────────
router.patch('/connections/:id', requireRole('engineer'), [
  param('id').isUUID(),
  body('name').optional().trim().isLength({ min: 1, max: 120 }),
  body('protocol').optional().isString().custom(validProtocol),
  body('config').optional().isObject(),
  body('enabled').optional().isBoolean().toBoolean(),
], async (req, res, next) => {
  if (vErr(req, res)) return;
  try {
    const existing = await query(
      `SELECT * FROM plc_connections WHERE id = $1 AND organisation_id = $2`,
      [req.params.id, orgId(req)]
    );
    if (!existing.rows[0]) return res.status(404).json({ error: 'Connection not found' });
    const current = existing.rows[0];

    const fields = []; const vals = []; let i = 1;
    const protocol = req.body.protocol !== undefined ? req.body.protocol : current.protocol;

    if (req.body.config !== undefined) {
      const config = unmaskIncomingConfig(protocol, req.body.config, current.config || {});
      const configErrors = getDriver(protocol).validateConfig(config);
      if (configErrors.length) {
        return res.status(422).json({ error: 'Validation failed', details: configErrors.map((msg) => ({ msg })) });
      }
      fields.push(`config = $${i++}`); vals.push(JSON.stringify(config));
    }
    if (req.body.name     !== undefined) { fields.push(`name = $${i++}`);     vals.push(req.body.name); }
    if (req.body.protocol !== undefined) { fields.push(`protocol = $${i++}`); vals.push(req.body.protocol); }
    if (req.body.enabled  !== undefined) { fields.push(`enabled = $${i++}`);  vals.push(req.body.enabled); }
    if (!fields.length) return res.status(422).json({ error: 'No fields to update' });

    vals.push(req.params.id, orgId(req));
    const r = await query(
      `UPDATE plc_connections SET ${fields.join(', ')}
       WHERE id = $${i} AND organisation_id = $${i + 1}
       RETURNING *`,
      vals
    );
    auditLog(req, 'plc_connection.update', 'plc_connection', req.params.id, { fields: Object.keys(req.body) });
    res.json(maskConnection(r.rows[0]));
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'A connection with this name already exists' });
    next(err);
  }
});

// ── DELETE /connections/:id (engineer+) ──────────────────────────────────────
router.delete('/connections/:id', requireRole('engineer'), [param('id').isUUID()], async (req, res, next) => {
  if (vErr(req, res)) return;
  try {
    const r = await query(
      `DELETE FROM plc_connections WHERE id = $1 AND organisation_id = $2 RETURNING id, name`,
      [req.params.id, orgId(req)]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'Connection not found' });
    auditLog(req, 'plc_connection.delete', 'plc_connection', req.params.id, { name: r.rows[0].name });
    res.json({ message: 'Connection deleted' });
  } catch (err) { next(err); }
});

// ── POST /connections/:id/test (engineer+) ───────────────────────────────────
router.post('/connections/:id/test', requireRole('engineer'), [param('id').isUUID()], async (req, res, next) => {
  if (vErr(req, res)) return;
  try {
    const r = await query(
      `SELECT * FROM plc_connections WHERE id = $1 AND organisation_id = $2`,
      [req.params.id, orgId(req)]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'Connection not found' });
    const conn = r.rows[0];
    const driver = getDriver(conn.protocol);
    if (!driver) return res.status(422).json({ error: `Unknown protocol "${conn.protocol}"` });

    const start = Date.now();
    let result;
    try {
      // Context is optional for testConnection (neither built-in driver's
      // probe touches per-connection state) but passed for uniformity.
      result = await driver.testConnection(conn.config || {}, {
        connectionId:   conn.id,
        organisationId: conn.organisation_id,
      });
    } catch (err) {
      result = { ok: false, message: err.message };
    }
    const latencyMs = result.latencyMs !== undefined ? result.latencyMs : Date.now() - start;

    // Record the outcome so the UI's status chip reflects the last test too.
    await query(
      `UPDATE plc_connections
       SET status = $1, last_error = $2, last_seen = CASE WHEN $3 THEN NOW() ELSE last_seen END
       WHERE id = $4`,
      [result.ok ? 'online' : 'error', result.ok ? null : result.message, result.ok, conn.id]
    ).catch((err) => logger.warn('PLC test: status update failed', { err: err.message }));

    res.json({ ok: !!result.ok, message: result.message || (result.ok ? 'Connected' : 'Connection failed'), latencyMs });
  } catch (err) { next(err); }
});

module.exports = router;
