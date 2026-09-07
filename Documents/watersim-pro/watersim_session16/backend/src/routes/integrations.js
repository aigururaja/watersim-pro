/**
 * WaterSim Pro — Integrations administration (Phase 5)
 *
 * Mounted at: /api/v1/integrations · admin only (users.manage)
 *
 *   GET    /integrations/api-keys            list (never the key itself)
 *   POST   /integrations/api-keys            { name, scopes[], expiresInDays? } → the key, ONCE
 *   DELETE /integrations/api-keys/:id        revoke
 *   GET    /integrations/webhooks            list (secret masked)
 *   POST   /integrations/webhooks            { name, url, eventTypes[] } → the secret, ONCE
 *   PATCH  /integrations/webhooks/:id        { name?, url?, eventTypes?, enabled? }
 *   DELETE /integrations/webhooks/:id
 *   POST   /integrations/webhooks/:id/test   deliver a test event now
 *   POST   /integrations/webhooks/:id/rotate new secret, ONCE
 *   GET    /integrations/deliveries          recent webhook deliveries from the outbox
 */
'use strict';

const express = require('express');
const crypto = require('crypto');
const { body, param, query: qv, validationResult } = require('express-validator');
const { query } = require('../db/pool');
const { authenticate, requireCapability } = require('../middleware/auth');
const { auditLog } = require('../utils/audit');
const { SCOPES, generateKey } = require('../middleware/serviceAuth');
const { EVENT_TYPES } = require('../notifications/templates');
const { queueWebhooks } = require('../notifications/webhooks');
const worker = require('../notifications/worker');
const webhookAdapter = require('../notifications/adapters/webhook');

const router = express.Router();
router.use(authenticate);
router.use(requireCapability('users.manage'));

const orgId = (req) => req.user.org || req.user.organisationId;
const userId = (req) => req.user.sub || req.user.id;

function vErr(req, res) {
  const e = validationResult(req);
  if (!e.isEmpty()) { res.status(422).json({ error: 'Validation failed', details: e.array() }); return true; }
  return false;
}

const fmtKey = (k) => ({ id: k.id, name: k.name, prefix: k.key_prefix, scopes: k.scopes, expiresAt: k.expires_at, lastUsedAt: k.last_used_at, revokedAt: k.revoked_at, createdAt: k.created_at });
const fmtHook = (h) => ({ id: h.id, name: h.name, url: h.url, eventTypes: h.event_types, enabled: h.enabled, lastStatus: h.last_status, lastDeliveryAt: h.last_delivery_at, lastError: h.last_error, failures: h.failures, createdAt: h.created_at, secretPreview: `${String(h.secret).slice(0, 6)}…` });

const validEventTypes = (arr) => arr.every((t) => t === '*' || EVENT_TYPES[t] || (t.endsWith('.') && Object.keys(EVENT_TYPES).some((k) => k.startsWith(t))));

// ── API keys ─────────────────────────────────────────────────────────────────
router.get('/api-keys', async (req, res, next) => {
  try { const { rows } = await query('SELECT * FROM api_keys WHERE organisation_id = $1 ORDER BY created_at DESC', [orgId(req)]); res.json({ keys: rows.map(fmtKey), scopes: SCOPES }); }
  catch (err) { next(err); }
});

router.post('/api-keys', [
  body('name').isString().trim().isLength({ min: 2, max: 120 }),
  body('scopes').isArray({ min: 1 }).custom((a) => { if (a.some((s) => !SCOPES.includes(s))) throw new Error(`scopes must be from ${SCOPES.join(', ')}`); return true; }),
  body('expiresInDays').optional({ nullable: true }).isInt({ min: 1, max: 3650 }).toInt(),
], async (req, res, next) => {
  if (vErr(req, res)) return;
  try {
    const { key, prefix, hash } = generateKey();
    const expires = req.body.expiresInDays ? new Date(Date.now() + req.body.expiresInDays * 86400_000) : null;
    const { rows } = await query(
      `INSERT INTO api_keys (organisation_id, name, key_prefix, key_hash, scopes, expires_at, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [orgId(req), req.body.name, prefix, hash, req.body.scopes, expires, userId(req)]
    );
    auditLog(req, 'api_key.create', 'api_key', rows[0].id, { name: req.body.name, scopes: req.body.scopes, expiresAt: expires });
    res.status(201).json({ ...fmtKey(rows[0]), key, shownOnce: true });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'A key with this name already exists' });
    next(err);
  }
});

router.delete('/api-keys/:id', [param('id').isUUID()], async (req, res, next) => {
  if (vErr(req, res)) return;
  try {
    const { rows } = await query('UPDATE api_keys SET revoked_at = NOW() WHERE id = $1 AND organisation_id = $2 AND revoked_at IS NULL RETURNING id, name', [req.params.id, orgId(req)]);
    if (!rows[0]) return res.status(404).json({ error: 'Key not found or already revoked' });
    auditLog(req, 'api_key.revoke', 'api_key', req.params.id, { name: rows[0].name });
    res.json({ message: 'Key revoked' });
  } catch (err) { next(err); }
});

// ── Webhooks ─────────────────────────────────────────────────────────────────
router.get('/webhooks', async (req, res, next) => {
  try { const { rows } = await query('SELECT * FROM webhook_endpoints WHERE organisation_id = $1 ORDER BY name', [orgId(req)]); res.json({ webhooks: rows.map(fmtHook), eventTypes: Object.keys(EVENT_TYPES) }); }
  catch (err) { next(err); }
});

const HOOK_BODY = [
  body('name').optional().isString().trim().isLength({ min: 2, max: 120 }),
  body('url').optional().isString().trim().isLength({ min: 8, max: 2000 }).custom((u) => { const p = webhookAdapter.urlProblem(u); if (p) throw new Error(`url ${p}`); return true; }),
  body('eventTypes').optional().isArray({ min: 1 }).custom((a) => { if (!validEventTypes(a)) throw new Error('eventTypes must be event types, prefixes like "task.", or "*"'); return true; }),
  body('enabled').optional().isBoolean().toBoolean(),
];

router.post('/webhooks', [...HOOK_BODY, body('name').exists(), body('url').exists()], async (req, res, next) => {
  if (vErr(req, res)) return;
  try {
    const secret = crypto.randomBytes(24).toString('hex');
    const { rows } = await query(
      `INSERT INTO webhook_endpoints (organisation_id, name, url, secret, event_types, enabled, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [orgId(req), req.body.name, req.body.url, secret, req.body.eventTypes || ['*'], req.body.enabled ?? true, userId(req)]
    );
    auditLog(req, 'webhook.create', 'webhook_endpoint', rows[0].id, { name: req.body.name, url: req.body.url, eventTypes: rows[0].event_types });
    res.status(201).json({ ...fmtHook(rows[0]), secret, shownOnce: true });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'A webhook with this name already exists' });
    next(err);
  }
});

router.patch('/webhooks/:id', [param('id').isUUID(), ...HOOK_BODY], async (req, res, next) => {
  if (vErr(req, res)) return;
  try {
    const fields = []; const vals = []; let i = 1;
    if (req.body.name !== undefined)       { fields.push(`name = $${i++}`); vals.push(req.body.name); }
    if (req.body.url !== undefined)        { fields.push(`url = $${i++}`); vals.push(req.body.url); }
    if (req.body.eventTypes !== undefined) { fields.push(`event_types = $${i++}`); vals.push(req.body.eventTypes); }
    if (req.body.enabled !== undefined)    { fields.push(`enabled = $${i++}`); vals.push(req.body.enabled); }
    if (!fields.length) return res.status(422).json({ error: 'No fields to update' });
    vals.push(req.params.id, orgId(req));
    const { rows } = await query(`UPDATE webhook_endpoints SET ${fields.join(', ')} WHERE id = $${i} AND organisation_id = $${i + 1} RETURNING *`, vals);
    if (!rows[0]) return res.status(404).json({ error: 'Webhook not found' });
    auditLog(req, 'webhook.update', 'webhook_endpoint', req.params.id, { fields: Object.keys(req.body) });
    res.json(fmtHook(rows[0]));
  } catch (err) { next(err); }
});

router.delete('/webhooks/:id', [param('id').isUUID()], async (req, res, next) => {
  if (vErr(req, res)) return;
  try {
    const { rows } = await query('DELETE FROM webhook_endpoints WHERE id = $1 AND organisation_id = $2 RETURNING name', [req.params.id, orgId(req)]);
    if (!rows[0]) return res.status(404).json({ error: 'Webhook not found' });
    auditLog(req, 'webhook.delete', 'webhook_endpoint', req.params.id, { name: rows[0].name });
    res.json({ message: 'Webhook deleted' });
  } catch (err) { next(err); }
});

router.post('/webhooks/:id/rotate', [param('id').isUUID()], async (req, res, next) => {
  if (vErr(req, res)) return;
  try {
    const secret = crypto.randomBytes(24).toString('hex');
    const { rows } = await query('UPDATE webhook_endpoints SET secret = $3 WHERE id = $1 AND organisation_id = $2 RETURNING *', [req.params.id, orgId(req), secret]);
    if (!rows[0]) return res.status(404).json({ error: 'Webhook not found' });
    auditLog(req, 'webhook.rotate', 'webhook_endpoint', req.params.id, {});
    res.json({ ...fmtHook(rows[0]), secret, shownOnce: true });
  } catch (err) { next(err); }
});

router.post('/webhooks/:id/test', [param('id').isUUID()], async (req, res, next) => {
  if (vErr(req, res)) return;
  try {
    const { rows } = await query('SELECT * FROM webhook_endpoints WHERE id = $1 AND organisation_id = $2', [req.params.id, orgId(req)]);
    if (!rows[0]) return res.status(404).json({ error: 'Webhook not found' });
    const queued = await queueWebhooks(orgId(req), 'notification.test', { message: `Test delivery to ${rows[0].name}`, at: new Date().toISOString() }, { onlyEndpointId: rows[0].id, dedupeKey: `whtest|${rows[0].id}|${Date.now()}` });
    const out = await worker.drain({ onlyId: queued.ids[0] });
    const { rows: [row] } = await query('SELECT id, state, attempts, last_error, sent_at FROM notification_outbox WHERE id = $1', [queued.ids[0]]);
    auditLog(req, 'webhook.test', 'webhook_endpoint', req.params.id, { state: row?.state });
    res.json({ delivery: row, drained: out });
  } catch (err) { next(err); }
});

router.get('/deliveries', [qv('limit').optional().isInt({ min: 1, max: 500 }).toInt()], async (req, res, next) => {
  if (vErr(req, res)) return;
  try {
    const { rows } = await query(
      `SELECT o.id, o.address, o.event_type, o.state, o.attempts, o.last_error, o.sent_at, o.created_at, o.endpoint_id, w.name AS endpoint_name
         FROM notification_outbox o LEFT JOIN webhook_endpoints w ON w.id = o.endpoint_id
        WHERE o.organisation_id = $1 AND o.channel = 'webhook' ORDER BY o.created_at DESC LIMIT ${req.query.limit || 100}`,
      [orgId(req)]
    );
    res.json({ deliveries: rows.map((o) => ({ id: o.id, endpointId: o.endpoint_id, endpointName: o.endpoint_name, url: o.address, eventType: o.event_type, state: o.state, attempts: o.attempts, lastError: o.last_error, sentAt: o.sent_at, createdAt: o.created_at })) });
  } catch (err) { next(err); }
});

module.exports = router;
