/**
 * WaterSim Pro — Notifications API
 *
 * Mounted at: /api/v1/notifications
 *
 *   GET    /notifications/me                 — my channels, my effective subscriptions, provider status
 *   PUT    /notifications/me/channels        — { email: {enabled, address?}, whatsapp: {enabled, address} }
 *                                              the RECEIVER addresses; they default to the login email and
 *                                              profile mobile but may differ, and never write back to them
 *   POST   /notifications/test               — { channel, userId? } → a test message to me (or, manager+, to a receiver), sent now
 *   GET    /notifications/receivers          — every active member with their email and WhatsApp addresses (manager+)
 *   PUT    /notifications/receivers/:userId  — set a member's addresses and channels for them (manager+)
 *   POST   /notifications/subscriptions/defaults — install the default policy for every role (manager+)
 *   GET    /notifications/events             — the event-type catalogue
 *   GET    /notifications/subscriptions      — the organisation's policy
 *   POST   /notifications/subscriptions      — add a policy row               (manager+ · notify.policy)
 *   PATCH  /notifications/subscriptions/:id  — edit                            (manager+)
 *   DELETE /notifications/subscriptions/:id  — remove                          (manager+)
 *   GET    /notifications/outbox             — recent deliveries and failures  (manager+)
 *   POST   /notifications/outbox/:id/retry   — retry a failed/dead row now     (manager+)
 *   GET    /notifications/whatsapp/templates — the WhatsApp Business Account's templates and their approval (manager+)
 */
'use strict';

const express = require('express');
const { body, param, query: qv, validationResult } = require('express-validator');
const { query } = require('../db/pool');
const { authenticate, requireCapability } = require('../middleware/auth');
const { ROLES, can } = require('../auth/roles');
const { auditLog } = require('../utils/audit');
const { emit, EVENT_TYPES, CHANNELS } = require('../notifications');
const { DEFAULT_POLICY, installDefaultPolicy, missingDefaults } = require('../notifications/defaults');
const worker = require('../notifications/worker');
const whatsapp = require('../notifications/adapters/whatsapp');

const router = express.Router();
router.use(authenticate);

const orgId = (req) => req.user.org || req.user.organisationId;
const userId = (req) => req.user.sub || req.user.id;
const E164 = /^\+[1-9]\d{6,14}$/;

function vErr(req, res) {
  const e = validationResult(req);
  if (!e.isEmpty()) { res.status(422).json({ error: 'Validation failed', details: e.array() }); return true; }
  return false;
}

const fmtSub = (s) => ({
  id: s.id, userId: s.user_id, userName: s.user_name || null, role: s.role, eventType: s.event_type,
  minSeverity: s.min_severity, channels: s.channels, enabled: s.enabled, createdAt: s.created_at,
});

// ── GET /notifications/events ────────────────────────────────────────────────
router.get('/events', (_req, res) => {
  res.json({ events: Object.entries(EVENT_TYPES).map(([type, e]) => ({ type, ...e })), channels: CHANNELS });
});

// ── GET /notifications/me ────────────────────────────────────────────────────
async function sendMe(req, res, next) {
  try {
    const [u, ch, subs] = await Promise.all([
      query('SELECT email, phone_e164 FROM users WHERE id = $1', [userId(req)]),
      query('SELECT channel, address, enabled, verified FROM notification_channels WHERE user_id = $1', [userId(req)]),
      query(`SELECT s.*, u.first_name || ' ' || u.last_name AS user_name FROM notification_subscriptions s
               LEFT JOIN users u ON u.id = s.user_id
              WHERE s.organisation_id = $1 AND s.enabled = TRUE AND (s.user_id = $2 OR s.role = $3)
              ORDER BY s.event_type`, [orgId(req), userId(req), req.user.role]),
    ]);
    const byChannel = Object.fromEntries(ch.rows.map((c) => [c.channel, c]));
    res.json({
      email: { enabled: byChannel.email ? byChannel.email.enabled : true, address: byChannel.email?.address || u.rows[0]?.email || null, verified: byChannel.email?.verified ?? true },
      whatsapp: { enabled: byChannel.whatsapp ? byChannel.whatsapp.enabled : !!u.rows[0]?.phone_e164, address: byChannel.whatsapp?.address || u.rows[0]?.phone_e164 || null, verified: byChannel.whatsapp?.verified ?? false },
      // The profile's own contact details, for the page to show alongside.
      login: { email: u.rows[0]?.email || null, phone: u.rows[0]?.phone_e164 || null },
      subscriptions: subs.rows.map(fmtSub),
      providers: worker.providerStatus(),
    });
  } catch (err) { next(err); }
}
router.get('/me', sendMe);

// ── Channel addresses (mine, or a receiver's) ────────────────────────────────
const CHANNEL_BODY = [
  body('email').optional().isObject(),
  body('email.enabled').optional().isBoolean().toBoolean(),
  body('email.address').optional({ nullable: true }).isEmail().normalizeEmail({ gmail_remove_dots: false }),
  body('whatsapp').optional().isObject(),
  body('whatsapp.enabled').optional().isBoolean().toBoolean(),
  // A bare local number ("98765 43210") becomes E.164 with WHATSAPP_DEFAULT_COUNTRY_CODE.
  body('whatsapp.address').optional({ nullable: true }).customSanitizer((v) => whatsapp.toE164(v) || v).matches(E164).withMessage('WhatsApp number must be E.164 (+919876543210) or a 10-digit local number'),
];

/**
 * Save { email: {enabled, address?}, whatsapp: {enabled, address?} } for a user.
 * These are the receiver addresses: they start out as the login email and the
 * profile mobile, but a person may want alarms elsewhere, so they are stored on
 * the channel row and never written back to the profile. A changed WhatsApp
 * number is no longer verified. Returns a 422 body, or null.
 */
async function saveChannels(uid, input) {
  for (const channel of CHANNELS) {
    const c = input[channel];
    if (!c) continue;
    const cur = await query('SELECT address, enabled FROM notification_channels WHERE user_id = $1 AND channel = $2', [uid, channel]);
    const fallback = channel === 'email'
      ? (await query('SELECT email FROM users WHERE id = $1', [uid])).rows[0]?.email
      : (await query('SELECT phone_e164 FROM users WHERE id = $1', [uid])).rows[0]?.phone_e164;
    const address = c.address ?? cur.rows[0]?.address ?? fallback ?? null;
    const enabled = c.enabled ?? cur.rows[0]?.enabled ?? true;
    if (!address) {
      if (enabled && channel === 'whatsapp') return { error: 'Validation failed', details: [{ msg: 'a WhatsApp number is needed to enable WhatsApp', path: 'whatsapp.address' }] };
      continue;
    }
    await query(
      `INSERT INTO notification_channels (user_id, channel, address, enabled)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, channel) DO UPDATE SET address = EXCLUDED.address, enabled = EXCLUDED.enabled,
         verified = CASE WHEN notification_channels.address = EXCLUDED.address THEN notification_channels.verified ELSE FALSE END`,
      [uid, channel, address, enabled]
    );
  }
  return null;
}

// ── PUT /notifications/me/channels ───────────────────────────────────────────
router.put('/me/channels', CHANNEL_BODY, async (req, res, next) => {
  if (vErr(req, res)) return;
  try {
    const uid = userId(req);
    const problem = await saveChannels(uid, req.body);
    if (problem) return res.status(422).json(problem);
    auditLog(req, 'notification.channels.update', 'user', uid, { channels: Object.keys(req.body) });
    return sendMe(req, res, next); // answer with the same shape GET /me gives
  } catch (err) { next(err); }
});

// ── Receivers: every active member, as the outbox would reach them ───────────
// So a manager can set up email and WhatsApp for every role from one table
// instead of waiting for each person to visit their own settings.
async function listReceivers(orgId) {
  const { rows: users } = await query(
    `SELECT id, email, phone_e164, first_name, last_name, role, last_login_at FROM users
      WHERE organisation_id = $1 AND is_active = TRUE ORDER BY role, first_name, last_name`,
    [orgId]
  );
  if (!users.length) return [];
  const { rows: chans } = await query(
    'SELECT user_id, channel, address, enabled, verified FROM notification_channels WHERE user_id = ANY($1::uuid[])',
    [users.map((u) => u.id)]
  );
  const { rows: subs } = await query(
    'SELECT user_id, role, event_type, min_severity, channels FROM notification_subscriptions WHERE organisation_id = $1 AND enabled = TRUE',
    [orgId]
  );
  const prefs = new Map();
  for (const c of chans) { if (!prefs.has(c.user_id)) prefs.set(c.user_id, {}); prefs.get(c.user_id)[c.channel] = c; }
  return users.map((u) => {
    const p = prefs.get(u.id) || {};
    const email = { enabled: p.email ? p.email.enabled : true, address: p.email?.address || u.email, verified: p.email?.verified ?? true };
    const wa = { enabled: p.whatsapp ? p.whatsapp.enabled : !!u.phone_e164, address: p.whatsapp?.address || u.phone_e164 || null, verified: p.whatsapp?.verified ?? false };
    const hears = subs.filter((x) => x.user_id === u.id || x.role === u.role)
      .map((x) => ({ eventType: x.event_type, minSeverity: x.min_severity, channels: x.channels }));
    return {
      id: u.id, name: `${u.first_name} ${u.last_name}`, role: u.role, login: u.email, mobile: u.phone_e164 || null, lastLoginAt: u.last_login_at,
      email, whatsapp: wa, hears,
      reachable: { email: !!(email.enabled && email.address), whatsapp: !!(wa.enabled && wa.address) },
    };
  });
}

router.get('/receivers', requireCapability('notify.policy'), async (req, res, next) => {
  try {
    res.json({ receivers: await listReceivers(orgId(req)), providers: worker.providerStatus() });
  } catch (err) { next(err); }
});

router.put('/receivers/:userId', requireCapability('notify.policy'), [param('userId').isUUID(), ...CHANNEL_BODY], async (req, res, next) => {
  if (vErr(req, res)) return;
  try {
    const u = await query('SELECT id FROM users WHERE id = $1 AND organisation_id = $2 AND is_active = TRUE', [req.params.userId, orgId(req)]);
    if (!u.rows[0]) return res.status(404).json({ error: 'Member not found' });
    const problem = await saveChannels(req.params.userId, req.body);
    if (problem) return res.status(422).json(problem);
    auditLog(req, 'notification.receiver.update', 'user', req.params.userId, { channels: Object.keys(req.body) });
    const all = await listReceivers(orgId(req));
    res.json(all.find((r) => r.id === req.params.userId));
  } catch (err) { next(err); }
});

// ── POST /notifications/test ─────────────────────────────────────────────────
router.post('/test', [body('channel').isIn(CHANNELS), body('userId').optional({ nullable: true }).isUUID()], async (req, res, next) => {
  if (vErr(req, res)) return;
  try {
    const me = userId(req);
    const target = req.body.userId || me;
    if (target !== me) {
      if (!can(req.user.role, 'notify.policy')) return res.status(403).json({ error: 'Only a manager or admin can send a test to someone else' });
      const u = await query('SELECT id FROM users WHERE id = $1 AND organisation_id = $2 AND is_active = TRUE', [target, orgId(req)]);
      if (!u.rows[0]) return res.status(404).json({ error: 'Member not found' });
    }
    const queued = await emit('notification.test', {
      orgId: orgId(req), severity: 'info', onlyUsers: [target],
      dedupeKey: `test|${target}|${Date.now()}`,
    });
    // Only the requested channel; the other's row is dropped before sending.
    const { rows } = await query(
      `DELETE FROM notification_outbox WHERE user_id = $1 AND event_type = 'notification.test' AND channel <> $2 AND state = 'pending' RETURNING id`,
      [target, req.body.channel]
    );
    void rows;
    const pending = await query(
      `SELECT id FROM notification_outbox WHERE user_id = $1 AND event_type = 'notification.test' AND channel = $2 AND state = 'pending' ORDER BY created_at DESC LIMIT 1`,
      [target, req.body.channel]
    );
    if (!pending.rows[0]) {
      return res.status(422).json({ error: target === me ? `No ${req.body.channel} address on your profile — add one first` : `That member has no ${req.body.channel} address, or it is switched off` });
    }
    await worker.drain({ onlyId: pending.rows[0].id });
    const { rows: [row] } = await query('SELECT id, channel, address, state, attempts, last_error, sent_at FROM notification_outbox WHERE id = $1', [pending.rows[0].id]);
    auditLog(req, 'notification.test', 'notification', row.id, { channel: row.channel, state: row.state, userId: target });
    res.json({ ...row, queued: queued.queued, providers: worker.providerStatus() });
  } catch (err) { next(err); }
});

// ── Subscriptions (org policy) ───────────────────────────────────────────────
router.get('/subscriptions', async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT s.*, u.first_name || ' ' || u.last_name AS user_name FROM notification_subscriptions s
         LEFT JOIN users u ON u.id = s.user_id WHERE s.organisation_id = $1 ORDER BY s.role NULLS LAST, s.event_type`,
      [orgId(req)]
    );
    res.json({ subscriptions: rows.map(fmtSub), defaults: DEFAULT_POLICY, missingDefaults: missingDefaults(rows).map((d) => `${d.role}:${d.eventType}`) });
  } catch (err) { next(err); }
});

// ── POST /notifications/subscriptions/defaults ───────────────────────────────
// One click gives every role its rows (viewer, operator, engineer, manager,
// admin); rows the organisation already has are left exactly as they are.
router.post('/subscriptions/defaults', requireCapability('notify.policy'), async (req, res, next) => {
  try {
    const result = await installDefaultPolicy(orgId(req), userId(req));
    auditLog(req, 'notification.policy.defaults', 'organisation', orgId(req), result);
    res.status(201).json(result);
  } catch (err) { next(err); }
});

const SUB_BODY = [
  body('role').optional({ nullable: true }).isIn(ROLES),
  body('userId').optional({ nullable: true }).isUUID(),
  body('eventType').optional().isString().trim().custom((v) => {
    if (v === '*' || EVENT_TYPES[v] || (v.endsWith('.') && Object.keys(EVENT_TYPES).some((k) => k.startsWith(v)))) return true;
    throw new Error(`eventType must be one of ${Object.keys(EVENT_TYPES).join(', ')}, a prefix like "alarm.", or "*"`);
  }),
  body('minSeverity').optional().isIn(['info', 'warning', 'critical']),
  body('channels').optional().isArray({ min: 1 }).custom((a) => { if (a.some((c) => !CHANNELS.includes(c))) throw new Error(`channels must be from ${CHANNELS.join(', ')}`); return true; }),
  body('enabled').optional().isBoolean().toBoolean(),
];

router.post('/subscriptions', requireCapability('notify.policy'), [...SUB_BODY, body('eventType').exists()], async (req, res, next) => {
  if (vErr(req, res)) return;
  const { role = null, userId: uid = null } = req.body;
  if ((role == null) === (uid == null)) return res.status(422).json({ error: 'Validation failed', details: [{ msg: 'exactly one of role or userId', path: 'role' }] });
  try {
    if (uid) {
      const u = await query('SELECT id FROM users WHERE id = $1 AND organisation_id = $2', [uid, orgId(req)]);
      if (!u.rows[0]) return res.status(422).json({ error: 'Validation failed', details: [{ msg: 'user is not in your organisation', path: 'userId' }] });
    }
    const { rows } = await query(
      `INSERT INTO notification_subscriptions (organisation_id, user_id, role, event_type, min_severity, channels, enabled, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [orgId(req), uid, role, req.body.eventType, req.body.minSeverity || 'warning', req.body.channels || ['email'], req.body.enabled ?? true, userId(req)]
    );
    auditLog(req, 'notification.subscription.create', 'notification_subscription', rows[0].id, { role, userId: uid, eventType: req.body.eventType });
    res.status(201).json(fmtSub(rows[0]));
  } catch (err) { next(err); }
});

router.patch('/subscriptions/:id', requireCapability('notify.policy'), [param('id').isUUID(), ...SUB_BODY], async (req, res, next) => {
  if (vErr(req, res)) return;
  try {
    const fields = []; const vals = []; let i = 1;
    if (req.body.eventType !== undefined)   { fields.push(`event_type = $${i++}`);   vals.push(req.body.eventType); }
    if (req.body.minSeverity !== undefined) { fields.push(`min_severity = $${i++}`); vals.push(req.body.minSeverity); }
    if (req.body.channels !== undefined)    { fields.push(`channels = $${i++}`);     vals.push(req.body.channels); }
    if (req.body.enabled !== undefined)     { fields.push(`enabled = $${i++}`);      vals.push(req.body.enabled); }
    if (!fields.length) return res.status(422).json({ error: 'No fields to update' });
    vals.push(req.params.id, orgId(req));
    const { rows } = await query(`UPDATE notification_subscriptions SET ${fields.join(', ')} WHERE id = $${i} AND organisation_id = $${i + 1} RETURNING *`, vals);
    if (!rows[0]) return res.status(404).json({ error: 'Subscription not found' });
    auditLog(req, 'notification.subscription.update', 'notification_subscription', req.params.id, { fields: Object.keys(req.body) });
    res.json(fmtSub(rows[0]));
  } catch (err) { next(err); }
});

router.delete('/subscriptions/:id', requireCapability('notify.policy'), [param('id').isUUID()], async (req, res, next) => {
  if (vErr(req, res)) return;
  try {
    const { rows } = await query('DELETE FROM notification_subscriptions WHERE id = $1 AND organisation_id = $2 RETURNING id', [req.params.id, orgId(req)]);
    if (!rows[0]) return res.status(404).json({ error: 'Subscription not found' });
    auditLog(req, 'notification.subscription.delete', 'notification_subscription', req.params.id, {});
    res.json({ message: 'Subscription removed' });
  } catch (err) { next(err); }
});

// ── Outbox ───────────────────────────────────────────────────────────────────
router.get('/outbox', requireCapability('notify.policy'), [
  qv('state').optional().isIn(['pending', 'sending', 'sent', 'failed', 'dead']),
  qv('limit').optional().isInt({ min: 1, max: 500 }).toInt(),
], async (req, res, next) => {
  if (vErr(req, res)) return;
  try {
    const params = [orgId(req)];
    let where = 'o.organisation_id = $1';
    if (req.query.state) { params.push(req.query.state); where += ` AND o.state = $${params.length}`; }
    const { rows } = await query(
      `SELECT o.id, o.channel, o.address, o.event_type, o.subject, o.state, o.attempts, o.next_attempt_at, o.sent_at, o.last_error, o.created_at, o.payload,
              u.first_name || ' ' || u.last_name AS user_name
         FROM notification_outbox o LEFT JOIN users u ON u.id = o.user_id
        WHERE ${where} ORDER BY o.created_at DESC LIMIT ${req.query.limit ?? 100}`,
      params
    );
    const { rows: counts } = await query(`SELECT state, COUNT(*)::int AS n FROM notification_outbox WHERE organisation_id = $1 GROUP BY state`, [orgId(req)]);
    res.json({
      counts: Object.fromEntries(['pending', 'sending', 'sent', 'failed', 'dead'].map((s) => [s, counts.find((c) => c.state === s)?.n || 0])),
      providers: worker.providerStatus(),
      outbox: rows.map((o) => ({
        id: o.id, channel: o.channel, address: o.address, eventType: o.event_type, subject: o.subject, state: o.state,
        attempts: o.attempts, nextAttemptAt: o.next_attempt_at, sentAt: o.sent_at, lastError: o.last_error, createdAt: o.created_at, userName: o.user_name,
        providerId: o.payload?.providerId || null, delivery: o.payload?.delivery || null, kind: o.payload?.kind || null,
      })),
    });
  } catch (err) { next(err); }
});

router.post('/outbox/:id/retry', requireCapability('notify.policy'), [param('id').isUUID()], async (req, res, next) => {
  if (vErr(req, res)) return;
  try {
    const ok = await worker.retry(req.params.id, orgId(req));
    if (!ok) return res.status(404).json({ error: 'No failed or dead message with that id' });
    await worker.drain({ onlyId: req.params.id });
    const { rows: [row] } = await query('SELECT id, state, attempts, last_error, sent_at FROM notification_outbox WHERE id = $1', [req.params.id]);
    auditLog(req, 'notification.retry', 'notification', req.params.id, { state: row.state });
    res.json(row);
  } catch (err) { next(err); }
});

// ── GET /notifications/whatsapp/templates ────────────────────────────────────
// The templates on the WhatsApp Business Account with Meta's review status, so
// a manager can see that `watersim_alert` is APPROVED before relying on it.
router.get('/whatsapp/templates', requireCapability('notify.policy'), async (req, res) => {
  try {
    res.json({ provider: whatsapp.provider(), ...(await whatsapp.listTemplates({ force: req.query.refresh === 'true' })) });
  } catch (err) {
    res.status(502).json({ error: err.message, provider: whatsapp.provider() });
  }
});

module.exports = router;
