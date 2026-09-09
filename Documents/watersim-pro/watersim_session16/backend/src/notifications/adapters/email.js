/**
 * Email adapter — SMTP through nodemailer.
 *
 * Configured the way the enterprise CRM and the CMMS configure theirs: a Gmail
 * account with an app password over STARTTLS on port 587. Their variable names
 * are accepted alongside ours, so one .env block serves all three:
 *
 *   SMTP_HOST      (or SMTP_SERVER; smtp.gmail.com is assumed for a Gmail user)
 *   SMTP_PORT      587
 *   SMTP_SECURE    true only for implicit TLS on 465
 *   SMTP_USE_TLS   STARTTLS on the plain port (default true)
 *   SMTP_USER      (or SMTP_USERNAME)
 *   SMTP_PASS      (or SMTP_PASSWORD)
 *   SMTP_FROM      "SafeKrit <no-reply@example.com>", or
 *   SMTP_FROM_EMAIL + SMTP_FROM_NAME (or FROM_EMAIL); a Gmail account must send
 *                  as itself, so the user is the default sender.
 *
 * NOTIFICATIONS_DRY_RUN=true logs instead of sending and reports success —
 * for demos and CI, never for production.
 *
 * Outbox rows for email carry the rendered HTML as their body; it goes out as
 * text/html with a text/plain alternative derived from it, so a phone's
 * notification preview and a text-only client read the words, not the tags.
 */
'use strict';

const logger = require('../../utils/logger');

let transport = null;
let transportFactory = null; // test injection

const env = () => {
  const user = process.env.SMTP_USER || process.env.SMTP_USERNAME || '';
  const gmail = /@(gmail|googlemail)\.com$/i.test(user);
  const host = process.env.SMTP_HOST || process.env.SMTP_SERVER || (gmail ? 'smtp.gmail.com' : '');
  const port = parseInt(process.env.SMTP_PORT || '587', 10) || 587;
  const secure = String(process.env.SMTP_SECURE ?? (port === 465 ? 'true' : 'false')) === 'true';
  const useTls = String(process.env.SMTP_USE_TLS ?? 'true').toLowerCase() !== 'false';
  const fromName = process.env.SMTP_FROM_NAME || 'SafeKrit';
  const fromEmail = process.env.SMTP_FROM_EMAIL || process.env.FROM_EMAIL || '';
  const from = process.env.SMTP_FROM
    || (fromEmail ? `${fromName} <${fromEmail}>` : null)
    || (user.includes('@') ? `${fromName} <${user}>` : 'SafeKrit <no-reply@watersim.local>');
  return {
    host, port, secure, requireTLS: !secure && useTls, user,
    pass: process.env.SMTP_PASS || process.env.SMTP_PASSWORD || '',
    from,
    dryRun: String(process.env.NOTIFICATIONS_DRY_RUN || 'false') === 'true',
  };
};

function configured() {
  const e = env();
  if (e.dryRun) return { ok: true, reason: 'dry-run' };
  if (!e.host) return { ok: false, reason: 'SMTP_HOST is not set (Gmail: smtp.gmail.com, port 587, an app password as SMTP_PASSWORD)' };
  return { ok: true, reason: `${e.host}:${e.port} as ${e.from}` };
}

function getTransport() {
  if (transport) return transport;
  const e = env();
  if (transportFactory) { transport = transportFactory(e); return transport; }
  // Required lazily so a deployment without email never loads the module.
  const nodemailer = require('nodemailer');
  transport = nodemailer.createTransport({
    host: e.host, port: e.port, secure: e.secure, requireTLS: e.requireTLS,
    auth: e.user ? { user: e.user, pass: e.pass } : undefined,
    connectionTimeout: 10_000, socketTimeout: 20_000,
  });
  return transport;
}

/** Drop the cached transport (config changed, or a test replaced env). */
function reset() { transport = null; }

/** Tests hand in a factory returning { sendMail }; null restores nodemailer. */
function setTransportFactory(fn) { transportFactory = fn || null; reset(); }

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };

/** A readable text/plain rendering of the HTML the templates produce. */
function htmlToText(html) {
  return String(html || '')
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h\d|li|tr)>/gi, '\n')
    .replace(/<hr[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#?\w+);/g, (m, k) => ENTITIES[k] ?? (k[0] === '#' ? String.fromCodePoint(parseInt(k.slice(1), 10)) || m : m))
    .split('\n').map((l) => l.trim()).join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const isHtml = (s) => /^\s*<(!doctype|html|div|table|p)\b/i.test(String(s || ''));

/**
 * @returns {Promise<{ providerId: string }>}
 * Throws with `permanent = true` when retrying cannot help (bad address).
 */
async function send({ address, subject, body, html }) {
  const e = env();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(address))) {
    const err = new Error(`Invalid email address "${address}"`); err.permanent = true; throw err;
  }
  if (e.dryRun) {
    logger.info('DRY RUN email', { to: address, subject });
    return { providerId: `dry-run:${Date.now()}` };
  }
  const c = configured();
  if (!c.ok) { const err = new Error(`Email not configured — ${c.reason}`); err.permanent = true; throw err; }

  const htmlBody = html || (isHtml(body) ? body : null);
  const mail = {
    from: e.from, to: address, subject,
    text: htmlBody ? htmlToText(htmlBody) : String(body ?? ''),
    ...(htmlBody ? { html: htmlBody } : {}),
  };
  let info;
  try {
    info = await getTransport().sendMail(mail);
  } catch (err) {
    // Authentication and recipient refusals do not heal with time.
    const code = String(err.code || '');
    const rc = Number(err.responseCode) || 0;
    if (code === 'EAUTH' || code === 'EENVELOPE' || (rc >= 500 && rc < 600)) err.permanent = true;
    if (code === 'EAUTH' && /gmail/i.test(e.host)) err.message += ' — Gmail needs an app password (Google account → Security → 2-Step Verification → App passwords), not the account password';
    throw err;
  }
  return { providerId: info.messageId || info.response || 'sent' };
}

module.exports = { channel: 'email', send, configured, reset, setTransportFactory, htmlToText, isHtml };
