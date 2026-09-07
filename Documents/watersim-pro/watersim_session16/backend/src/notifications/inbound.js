/**
 * WaterSim Pro — Inbound WhatsApp events (Meta webhook)
 *
 * Meta accepts a message with HTTP 200 and reports what became of it later,
 * on the webhook: sent → delivered → read, or failed with a reason. Those
 * statuses are matched to the outbox row by the message id the adapter stored
 * as payload.providerId and written under payload.delivery, where the
 * settings page shows them. A failure kills the row (state 'dead', the reason
 * in last_error) so a manager sees it and can retry once the cause is fixed.
 *
 * An inbound message from a person is the opt-in the platform needs: it opens
 * the 24-hour window for free-form text and proves the number is real, so the
 * matching notification_channels row is marked verified.
 */
'use strict';

const { query, isSqlite } = require('../db/pool');
const logger = require('../utils/logger');
const whatsapp = require('./adapters/whatsapp');

const RANK = { sent: 1, delivered: 2, read: 3, failed: 4 };

async function findByProviderId(providerId) {
  const where = isSqlite ? "json_extract(payload, '$.providerId') = $1" : "payload->>'providerId' = $1";
  const { rows } = await query(
    `SELECT id, payload, state FROM notification_outbox WHERE channel = 'whatsapp' AND ${where} ORDER BY created_at DESC LIMIT 1`,
    [providerId]
  );
  return rows[0] || null;
}

const asObject = (p) => (p && typeof p === 'object' ? p : (() => { try { return JSON.parse(p || '{}'); } catch { return {}; } })());

/** @returns {Promise<boolean>} whether a row was found */
async function applyStatus(st) {
  if (!st.id || !st.status) return false;
  const row = await findByProviderId(st.id);
  if (!row) return false;
  const payload = asObject(row.payload);
  const prev = payload.delivery;
  // Statuses may arrive out of order; never let 'sent' overwrite 'read'.
  if (prev && st.status !== 'failed' && (RANK[prev.status] || 0) >= (RANK[st.status] || 0)) return true;
  const next = { ...payload, delivery: { status: st.status, at: st.at, error: st.error || null } };
  if (st.status === 'failed') {
    await query(
      `UPDATE notification_outbox SET payload = $2::jsonb, state = 'dead', last_error = $3 WHERE id = $1`,
      [row.id, JSON.stringify(next), `Delivery failed — ${st.error || 'no reason given'}`.slice(0, 1000)]
    );
    logger.warn('WhatsApp delivery failed', { id: row.id, error: st.error });
  } else {
    await query(`UPDATE notification_outbox SET payload = $2::jsonb WHERE id = $1`, [row.id, JSON.stringify(next)]);
  }
  return true;
}

/** @returns {Promise<number>} users whose WhatsApp channel became verified */
async function applyInbound(m) {
  if (!m.from) return 0;
  const e164 = `+${String(m.from).replace(/D/g, '')}`;
  // Channel rows that carry this number, not yet verified.
  const upd = await query(
    `UPDATE notification_channels SET verified = TRUE WHERE channel = 'whatsapp' AND address = $1 AND verified = FALSE RETURNING user_id`,
    [e164]
  );
  // People whose profile number this is but who have no channel row yet get one, verified.
  const ins = await query(
    `INSERT INTO notification_channels (user_id, channel, address, enabled, verified)
       SELECT u.id, 'whatsapp', u.phone_e164, TRUE, TRUE FROM users u
        WHERE u.phone_e164 = $1 AND u.is_active = TRUE
          AND NOT EXISTS (SELECT 1 FROM notification_channels c WHERE c.user_id = u.id AND c.channel = 'whatsapp')
     RETURNING user_id`,
    [e164]
  );
  const verified = upd.rowCount + ins.rowCount;
  logger.info('WhatsApp inbound message', { from: e164, type: m.type, chars: String(m.text || '').length, verified });
  return verified;
}

/**
 * Handle one webhook document. Never throws — Meta must get its 200.
 * @returns {Promise<{ statuses: number, matched: number, messages: number, verified: number }>}
 */
async function processWebhook(payload) {
  const out = { statuses: 0, matched: 0, messages: 0, verified: 0 };
  let parsed;
  try { parsed = whatsapp.parseWebhook(payload); } catch (err) { logger.warn('WhatsApp webhook unreadable', { err: err.message }); return out; }
  for (const st of parsed.statuses) {
    out.statuses += 1;
    try { if (await applyStatus(st)) out.matched += 1; } catch (err) { logger.warn('WhatsApp status not applied', { id: st.id, err: err.message }); }
  }
  for (const m of parsed.messages) {
    out.messages += 1;
    try { out.verified += await applyInbound(m); } catch (err) { logger.warn('WhatsApp inbound not applied', { from: m.from, err: err.message }); }
  }
  return out;
}

module.exports = { processWebhook, applyStatus, applyInbound, findByProviderId };
