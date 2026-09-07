/**
 * Email adapter — SMTP through nodemailer.
 *
 * Env: SMTP_HOST, SMTP_PORT (587), SMTP_SECURE (false), SMTP_USER, SMTP_PASS,
 *      SMTP_FROM ("WaterSim Pro <no-reply@example.com>").
 * NOTIFICATIONS_DRY_RUN=true logs instead of sending and reports success —
 * for demos and CI, never for production.
 */
'use strict';

const logger = require('../../utils/logger');

let transport = null;

const env = () => ({
  host: process.env.SMTP_HOST,
  port: parseInt(process.env.SMTP_PORT || '587', 10),
  secure: String(process.env.SMTP_SECURE || 'false') === 'true',
  user: process.env.SMTP_USER,
  pass: process.env.SMTP_PASS,
  from: process.env.SMTP_FROM || 'WaterSim Pro <no-reply@watersim.local>',
  dryRun: String(process.env.NOTIFICATIONS_DRY_RUN || 'false') === 'true',
});

function configured() {
  const e = env();
  if (e.dryRun) return { ok: true, reason: 'dry-run' };
  if (!e.host) return { ok: false, reason: 'SMTP_HOST is not set' };
  return { ok: true };
}

function getTransport() {
  if (transport) return transport;
  const e = env();
  // Required lazily so a deployment without email never loads the module.
  const nodemailer = require('nodemailer');
  transport = nodemailer.createTransport({
    host: e.host, port: e.port, secure: e.secure,
    auth: e.user ? { user: e.user, pass: e.pass } : undefined,
    connectionTimeout: 10_000, socketTimeout: 20_000,
  });
  return transport;
}

/** Drop the cached transport (config changed, or a test replaced env). */
function reset() { transport = null; }

/**
 * @returns {Promise<{ providerId: string }>}
 * Throws with `permanent = true` when retrying cannot help (bad address).
 */
async function send({ address, subject, body, html }) {
  const e = env();
  if (e.dryRun) {
    logger.info('DRY RUN email', { to: address, subject });
    return { providerId: `dry-run:${Date.now()}` };
  }
  const c = configured();
  if (!c.ok) { const err = new Error(`Email not configured — ${c.reason}`); err.permanent = true; throw err; }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(address))) {
    const err = new Error(`Invalid email address "${address}"`); err.permanent = true; throw err;
  }
  const info = await getTransport().sendMail({ from: e.from, to: address, subject, text: body, html });
  return { providerId: info.messageId || info.response || 'sent' };
}

module.exports = { channel: 'email', send, configured, reset };
