/**
 * WhatsApp adapter — Twilio's WhatsApp API, over plain fetch (no SDK).
 *
 * Env: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_WHATSAPP_FROM
 *      (the sender in E.164, e.g. +14155238886 — the Twilio sandbox number
 *      until the business number is approved).
 * NOTIFICATIONS_DRY_RUN=true logs instead of sending.
 *
 * Twilio was chosen over the Meta Cloud API for time-to-first-message (open
 * question 2 in the plan); both need WhatsApp Business verification and
 * approved templates for messages outside a 24-hour customer window, and
 * that lead time is measured in weeks — start it early.
 */
'use strict';

const logger = require('../../utils/logger');

const env = () => ({
  sid: process.env.TWILIO_ACCOUNT_SID,
  token: process.env.TWILIO_AUTH_TOKEN,
  from: process.env.TWILIO_WHATSAPP_FROM,
  dryRun: String(process.env.NOTIFICATIONS_DRY_RUN || 'false') === 'true',
});

const E164 = /^\+[1-9]\d{6,14}$/;

function configured() {
  const e = env();
  if (e.dryRun) return { ok: true, reason: 'dry-run' };
  const missing = ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_WHATSAPP_FROM'].filter((k) => !process.env[k]);
  return missing.length ? { ok: false, reason: `${missing.join(', ')} not set` } : { ok: true };
}

// Injectable for tests.
let fetchImpl = (...args) => globalThis.fetch(...args);
function setFetch(fn) { fetchImpl = fn || ((...args) => globalThis.fetch(...args)); }

/**
 * @returns {Promise<{ providerId: string }>}
 * Throws with `permanent = true` on 4xx other than 429.
 */
async function send({ address, body }) {
  const e = env();
  if (!E164.test(String(address))) {
    const err = new Error(`Invalid WhatsApp number "${address}" — use E.164 (+91…)`); err.permanent = true; throw err;
  }
  if (e.dryRun) {
    logger.info('DRY RUN WhatsApp', { to: address, chars: String(body).length });
    return { providerId: `dry-run:${Date.now()}` };
  }
  const c = configured();
  if (!c.ok) { const err = new Error(`WhatsApp not configured — ${c.reason}`); err.permanent = true; throw err; }

  const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(e.sid)}/Messages.json`;
  const form = new URLSearchParams({ From: `whatsapp:${e.from}`, To: `whatsapp:${address}`, Body: String(body).slice(0, 1600) });
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${e.sid}:${e.token}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: form.toString(),
    signal: AbortSignal.timeout(15_000),
  });
  let data = {};
  try { data = await res.json(); } catch { /* non-JSON error body */ }
  if (!res.ok) {
    const err = new Error(`Twilio ${res.status}: ${data.message || data.error_message || res.statusText}`);
    err.permanent = res.status >= 400 && res.status < 500 && res.status !== 429;
    throw err;
  }
  return { providerId: data.sid || 'sent' };
}

module.exports = { channel: 'whatsapp', send, configured, setFetch };
