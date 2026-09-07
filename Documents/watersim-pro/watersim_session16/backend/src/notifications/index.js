/**
 * WaterSim Pro — Notifications
 *
 * emit(eventType, …) is the one entry point. It resolves WHO should hear
 * about an event from the organisation's subscription policy (role- or
 * user-scoped, by event type and minimum severity), resolves each person's
 * ADDRESS per channel, renders the message once, and writes one outbox row
 * per (person, channel). The worker (worker.js) sends; nothing here talks to
 * a provider, so an alarm evaluation never waits on SMTP.
 *
 * The third channel is the WebSocket room of the flowsheet the event belongs
 * to: every open page hears it immediately, whatever the policy says.
 *
 * emit() never throws — a notification failure must not break the alarm
 * evaluator or a task transition.
 */
'use strict';

const { query } = require('../db/pool');
const { broadcastToRoom, broadcastToOrg } = require('../collab/wsServer');
const { render, EVENT_TYPES, SEVERITY_RANK } = require('./templates');
const { queueWebhooks } = require('./webhooks');
const logger = require('../utils/logger');

const CHANNELS = ['email', 'whatsapp'];
const APP_URL = () => process.env.APP_URL || (process.env.PUBLIC_HOST ? `https://${process.env.PUBLIC_HOST}` : '');

/** Subscriptions in `orgId` that match `eventType` at `severity`. */
async function matchingSubscriptions(orgId, eventType, severity) {
  const { rows } = await query(
    `SELECT id, user_id, role, event_type, min_severity, channels
       FROM notification_subscriptions
      WHERE organisation_id = $1 AND enabled = TRUE`,
    [orgId]
  );
  const sevRank = SEVERITY_RANK[severity] ?? 0;
  return rows.filter((s) => {
    const typeOk = s.event_type === eventType
      || s.event_type === '*'
      || (s.event_type.endsWith('.') && eventType.startsWith(s.event_type));
    return typeOk && sevRank >= (SEVERITY_RANK[s.min_severity] ?? 0);
  });
}

/**
 * Resolve the recipients: Map<userId, Set<channel>>.
 * Role subscriptions name the role exactly (a policy row for "engineer" is
 * for engineers, not for everyone above them — managers get their own row).
 */
async function resolveRecipients(orgId, subs, alsoUsers = []) {
  const recipients = new Map();
  const add = (userId, channels) => {
    if (!recipients.has(userId)) recipients.set(userId, new Set());
    for (const c of channels) if (CHANNELS.includes(c)) recipients.get(userId).add(c);
  };
  const roles = [...new Set(subs.filter((s) => s.role).map((s) => s.role))];
  let byRole = new Map();
  if (roles.length) {
    const { rows } = await query(
      `SELECT id, role FROM users WHERE organisation_id = $1 AND is_active = TRUE AND role::text = ANY($2::text[])`,
      [orgId, roles]
    );
    byRole = rows.reduce((m, u) => { if (!m.has(u.role)) m.set(u.role, []); m.get(u.role).push(u.id); return m; }, new Map());
  }
  for (const s of subs) {
    if (s.user_id) add(s.user_id, s.channels || []);
    else for (const uid of byRole.get(s.role) || []) add(uid, s.channels || []);
  }
  for (const uid of alsoUsers) add(uid, ['email', 'whatsapp']);
  return recipients;
}

/** userId → { email, whatsapp } addresses that are enabled. */
async function resolveAddresses(userIds) {
  if (!userIds.length) return new Map();
  const { rows: users } = await query(
    `SELECT id, email, phone_e164, first_name, last_name FROM users WHERE id = ANY($1::uuid[]) AND is_active = TRUE`,
    [userIds]
  );
  const { rows: chans } = await query(
    `SELECT user_id, channel, address, enabled FROM notification_channels WHERE user_id = ANY($1::uuid[])`,
    [userIds]
  );
  const prefs = new Map();
  for (const c of chans) {
    if (!prefs.has(c.user_id)) prefs.set(c.user_id, {});
    prefs.get(c.user_id)[c.channel] = c;
  }
  const out = new Map();
  for (const u of users) {
    const p = prefs.get(u.id) || {};
    // Email defaults ON at the login address; a channel row can disable or redirect it.
    const email = p.email ? (p.email.enabled ? (p.email.address || u.email) : null) : u.email;
    // WhatsApp is opt-in: a channel row, or the profile number.
    const whatsapp = p.whatsapp ? (p.whatsapp.enabled ? (p.whatsapp.address || u.phone_e164) : null) : (u.phone_e164 || null);
    out.set(u.id, { email, whatsapp, name: `${u.first_name} ${u.last_name}` });
  }
  return out;
}

/**
 * @param {string} eventType   one of templates.EVENT_TYPES
 * @param {object} o
 * @param {string} o.orgId
 * @param {string} [o.severity='info']
 * @param {string} [o.flowsheetId]   WS room to broadcast to
 * @param {object} [o.payload]       { task | alarm | … } for the template
 * @param {string} [o.dedupeKey]     one delivery per (key, user, channel)
 * @param {string[]} [o.alsoUsers]   user ids that hear this regardless of policy
 * @param {string[]} [o.onlyUsers]   restrict to these users (test messages)
 * @returns {Promise<{ recipients: number, queued: number }>}
 */
async function emit(eventType, { orgId, severity = 'info', flowsheetId = null, payload = {}, dedupeKey = null, alsoUsers = [], onlyUsers = null, subject = null } = {}) {
  try {
    if (!orgId || !EVENT_TYPES[eventType]) return { recipients: 0, queued: 0 };

    const org = await query('SELECT name FROM organisations WHERE id = $1', [orgId]);
    const ctx = { orgName: org.rows[0]?.name, appUrl: APP_URL(), severity, subject, payload };
    const msg = render(eventType, ctx);

    // The WS rooms hear everything, immediately: the flowsheet's (open
    // canvases) and the organisation's (the live plant screen).
    try {
      const message = {
        type: 'notification',
        payload: { eventType, severity, subject: msg.subject, text: msg.text, payload, at: new Date().toISOString() },
      };
      if (flowsheetId) broadcastToRoom(flowsheetId, message);
      broadcastToOrg(orgId, message);
    } catch (err) { logger.debug('Notification broadcast failed', { err: err.message }); }

    // Outbound webhooks (Phase 5) hear every event, whatever the people policy says.
    if (!onlyUsers) {
      queueWebhooks(orgId, eventType, { ...payload, severity, flowsheetId }, { dedupeKey: dedupeKey || null })
        .catch((err) => logger.debug('Webhook queue failed', { err: err.message }));
    }

    let recipients;
    if (onlyUsers) {
      recipients = new Map(onlyUsers.map((uid) => [uid, new Set(CHANNELS)]));
    } else {
      const subs = await matchingSubscriptions(orgId, eventType, severity);
      recipients = await resolveRecipients(orgId, subs, alsoUsers);
    }
    if (!recipients.size) return { recipients: 0, queued: 0 };

    const addresses = await resolveAddresses([...recipients.keys()]);
    const rows = [];
    const key = dedupeKey || `${eventType}|${Date.now()}`;
    for (const [userId, channels] of recipients) {
      const addr = addresses.get(userId);
      if (!addr) continue;
      for (const channel of channels) {
        const address = addr[channel];
        if (!address) continue;
        rows.push({ userId, channel, address, dedupeKey: `${key}|${userId}|${channel}` });
      }
    }
    if (!rows.length) return { recipients: recipients.size, queued: 0 };

    const r = await query(
      `INSERT INTO notification_outbox
         (organisation_id, user_id, channel, address, event_type, template, subject, body, payload, dedupe_key)
       SELECT $1, u, c, a, $2, $2, $3, CASE WHEN c = 'email' THEN $4 ELSE $5 END, $6::jsonb, d
         FROM UNNEST($7::uuid[], $8::text[], $9::text[], $10::text[]) AS x(u, c, a, d)
       ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING`,
      [orgId, eventType, msg.subject, msg.html, msg.text, JSON.stringify({ ...payload, severity, flowsheetId }),
       rows.map((x) => x.userId), rows.map((x) => x.channel), rows.map((x) => x.address), rows.map((x) => x.dedupeKey)]
    );
    return { recipients: recipients.size, queued: r.rowCount };
  } catch (err) {
    logger.warn('Notification emit failed', { eventType, err: err.message });
    return { recipients: 0, queued: 0, error: err.message };
  }
}

module.exports = { emit, matchingSubscriptions, resolveRecipients, resolveAddresses, EVENT_TYPES, CHANNELS };
