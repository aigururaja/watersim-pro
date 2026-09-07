/**
 * Webhook adapter — outbound events to another system (Phase 5).
 *
 * POSTs the outbox row's body (a JSON document) to the endpoint's URL with:
 *   X-WaterSim-Event       the event type
 *   X-WaterSim-Delivery    the outbox row id (idempotency key for the receiver)
 *   X-WaterSim-Timestamp   unix seconds
 *   X-WaterSim-Signature   sha256=HMAC-SHA256(secret, `${timestamp}.${body}`)
 *
 * 2xx is sent. 4xx other than 408 / 429 is permanent (the receiver rejected
 * the document; retrying cannot help). Anything else retries with the
 * worker's backoff. Loopback and private addresses are refused unless
 * WEBHOOK_ALLOW_LOCAL_HOSTS=true (an SSRF surface, like the PLC guard).
 */
'use strict';

const crypto = require('crypto');
const { query } = require('../../db/pool');
const logger = require('../../utils/logger');

const ALLOW_LOCAL = () => String(process.env.WEBHOOK_ALLOW_LOCAL_HOSTS || 'false') === 'true';
const DRY_RUN = () => String(process.env.NOTIFICATIONS_DRY_RUN || 'false') === 'true';
const TIMEOUT_MS = Math.max(1000, parseInt(process.env.WEBHOOK_TIMEOUT_MS || '10000', 10) || 10000);

let fetchImpl = (...args) => globalThis.fetch(...args);
function setFetch(fn) { fetchImpl = fn || ((...args) => globalThis.fetch(...args)); }

const PRIVATE = [/^localhost$/i, /^127\./, /^10\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./, /^0\./, /^\[?::1\]?$/, /^169\.254\./];

/** Why a URL may not be used, or null when it may. */
function urlProblem(url) {
  let u;
  try { u = new URL(String(url)); } catch { return 'not a valid URL'; }
  if (!['http:', 'https:'].includes(u.protocol)) return 'must be http or https';
  if (process.env.NODE_ENV === 'production' && u.protocol !== 'https:') return 'must be https in production';
  if (!ALLOW_LOCAL() && PRIVATE.some((re) => re.test(u.hostname))) return 'loopback and private addresses are refused (set WEBHOOK_ALLOW_LOCAL_HOSTS=true on an isolated network)';
  return null;
}

function sign(secret, timestamp, body) {
  return `sha256=${crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;
}

function configured() { return { ok: true }; }

async function send({ address, body, payload, subject, id, endpointId }) {
  const problem = urlProblem(address);
  if (problem) { const err = new Error(`Webhook URL refused — ${problem}`); err.permanent = true; throw err; }
  const ep = endpointId ? (await query('SELECT id, secret, enabled FROM webhook_endpoints WHERE id = $1', [endpointId])).rows[0] : null;
  if (endpointId && !ep) { const err = new Error('Webhook endpoint no longer exists'); err.permanent = true; throw err; }
  if (ep && !ep.enabled) { const err = new Error('Webhook endpoint is disabled'); err.permanent = true; throw err; }

  const timestamp = Math.floor(Date.now() / 1000);
  const headers = {
    'Content-Type': 'application/json',
    'User-Agent': 'WaterSim-Pro-Webhooks/1',
    'X-WaterSim-Event': subject || payload?.event || 'event',
    'X-WaterSim-Delivery': id || '',
    'X-WaterSim-Timestamp': String(timestamp),
  };
  if (ep) headers['X-WaterSim-Signature'] = sign(ep.secret, timestamp, body);

  if (DRY_RUN()) {
    logger.info('DRY RUN webhook', { to: address, event: headers['X-WaterSim-Event'] });
    return { providerId: `dry-run:${Date.now()}` };
  }

  let res;
  try {
    res = await fetchImpl(address, { method: 'POST', headers, body, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    if (ep) await query('UPDATE webhook_endpoints SET failures = failures + 1, last_error = $2, last_delivery_at = NOW() WHERE id = $1', [ep.id, String(err.message).slice(0, 500)]).catch(() => {});
    throw err; // network: retry
  }
  if (ep) {
    await query('UPDATE webhook_endpoints SET last_status = $2, last_delivery_at = NOW(), failures = CASE WHEN $3 THEN 0 ELSE failures + 1 END, last_error = $4 WHERE id = $1',
      [ep.id, res.status, res.ok, res.ok ? null : `HTTP ${res.status}`]).catch(() => {});
  }
  if (!res.ok) {
    const err = new Error(`Webhook HTTP ${res.status}`);
    err.permanent = res.status >= 400 && res.status < 500 && ![408, 429].includes(res.status);
    throw err;
  }
  return { providerId: `http:${res.status}` };
}

module.exports = { channel: 'webhook', send, configured, setFetch, urlProblem, sign };
