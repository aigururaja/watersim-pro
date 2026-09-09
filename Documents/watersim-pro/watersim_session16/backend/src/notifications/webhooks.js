/**
 * SafeKrit — Outbound webhooks (Phase 5)
 *
 * queueWebhooks() writes one outbox row (channel 'webhook') per enabled
 * endpoint whose event types match, carrying the event document as its body.
 * The worker delivers through adapters/webhook.js with an HMAC signature.
 *
 * The document every receiver gets:
 *   { event, id, organisationId, at, data }
 * where `data` is the same payload the templates render from (task, alarm,
 * counters …) with internal ids where the receiver might need to call back.
 */
'use strict';

const { query } = require('../db/pool');
const logger = require('../utils/logger');

const matches = (types, eventType) => (types || []).some((t) => t === '*' || t === eventType || (t.endsWith('.') && eventType.startsWith(t)));

/**
 * @returns {Promise<{ queued: number, ids: string[] }>}
 */
async function queueWebhooks(orgId, eventType, data = {}, { dedupeKey = null, onlyEndpointId = null } = {}) {
  try {
    const { rows } = await query(
      `SELECT id, url, event_types FROM webhook_endpoints WHERE organisation_id = $1 AND enabled = TRUE ${onlyEndpointId ? 'AND id = $2' : ''}`,
      onlyEndpointId ? [orgId, onlyEndpointId] : [orgId]
    );
    const targets = rows.filter((w) => onlyEndpointId || matches(w.event_types, eventType));
    if (!targets.length) return { queued: 0, ids: [] };

    const ids = [];
    for (const w of targets) {
      const id = (await query('SELECT gen_random_uuid() AS id')).rows[0].id;
      const doc = JSON.stringify({ event: eventType, id, organisationId: orgId, at: new Date().toISOString(), data });
      const r = await query(
        `INSERT INTO notification_outbox (id, organisation_id, user_id, channel, address, event_type, template, subject, body, payload, dedupe_key, endpoint_id)
         VALUES ($1, $2, NULL, 'webhook', $3, $4, $4, $4, $5, $6::jsonb, $7, $8)
         ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING RETURNING id`,
        [id, orgId, w.url, eventType, doc, JSON.stringify({ endpointId: w.id }), dedupeKey ? `${dedupeKey}|wh|${w.id}` : null, w.id]
      );
      if (r.rows[0]) ids.push(r.rows[0].id);
    }
    return { queued: ids.length, ids };
  } catch (err) {
    logger.warn('Webhook queue failed', { eventType, err: err.message });
    return { queued: 0, ids: [], error: err.message };
  }
}

module.exports = { queueWebhooks, matches };
