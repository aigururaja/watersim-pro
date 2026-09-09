/**
 * WhatsApp adapter — Meta's WhatsApp Business Cloud API (Graph API), with
 * Twilio's WhatsApp API kept as the alternative provider.
 *
 * The Meta path is the one the enterprise CRM uses (its whatsapp_service.py):
 * the same environment names, the same phone normalisation, free text inside
 * the 24-hour customer-service window and a pre-approved template outside it.
 * The WhatsApp Business Account Infercon registered for the CRM therefore
 * sends for SafeKrit too — the same phone number id and system-user token,
 * no second registration.
 *
 * Env (Meta — chosen when set, or when WHATSAPP_PROVIDER=meta):
 *   WHATSAPP_PHONE_NUMBER_ID       the registered sender's phone_number_id
 *   WHATSAPP_ACCESS_TOKEN          permanent system-user access token
 *   WHATSAPP_API_VERSION           Graph API version (v21.0)
 *   WHATSAPP_BUSINESS_ACCOUNT_ID   WABA id — only needed to list templates
 *   WHATSAPP_DEFAULT_COUNTRY_CODE  prepended to bare local numbers (91)
 *   WHATSAPP_TEMPLATES             JSON, event type → approved template name;
 *                                  "*" is the default and "alarm." a prefix:
 *                                  {"*":"safekrit_alert","alarm.":"watersim_alarm"}
 *   WHATSAPP_TEMPLATE_LANG         the templates' language code (en_US)
 *   WHATSAPP_VERIFY_TOKEN          webhook handshake (routes/webhooks.js)
 *   WHATSAPP_APP_SECRET            webhook signature check (optional)
 * Env (Twilio — chosen when only TWILIO_* are set, or WHATSAPP_PROVIDER=twilio):
 *   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_WHATSAPP_FROM (E.164)
 * NOTIFICATIONS_DRY_RUN=true logs instead of sending.
 *
 * Meta's rules that shape this file:
 *   - Free-form text may only be sent within 24 h of the recipient's last
 *     message to the business. Everything else — every alarm that wakes an
 *     engineer at night — must be an approved template. Every SafeKrit
 *     template takes two body parameters: {{1}} the subject line and {{2}} the
 *     details on one line. The templates themselves — the wording Meta
 *     reviews, and the WHATSAPP_TEMPLATES mapping to set once they are
 *     APPROVED — live in ../whatsappTemplates.js; scripts/whatsapp-templates.js
 *     submits them. Meta counts the rendered body (the template's fixed text
 *     plus both values) against 1024 characters, so {{2}} is trimmed to what
 *     the template leaves (templateParams).
 *   - Meta answers 200 as soon as it accepts a message; that is not delivery.
 *     The outcome arrives later on the webhook (sent → delivered → read, or
 *     failed with a reason) and notifications/inbound.js writes it onto the
 *     outbox row, keyed by the message id stored here as providerId.
 */
'use strict';

const crypto = require('crypto');
const logger = require('../../utils/logger');
const catalogue = require('../whatsappTemplates');

const GRAPH = 'https://graph.facebook.com';
const E164 = /^\+[1-9]\d{6,14}$/;

const env = () => ({
  provider: String(process.env.WHATSAPP_PROVIDER || '').trim().toLowerCase(),
  dryRun: String(process.env.NOTIFICATIONS_DRY_RUN || 'false') === 'true',
  meta: {
    phoneId: process.env.WHATSAPP_PHONE_NUMBER_ID || '',
    token: process.env.WHATSAPP_ACCESS_TOKEN || '',
    version: process.env.WHATSAPP_API_VERSION || 'v21.0',
    wabaId: process.env.WHATSAPP_BUSINESS_ACCOUNT_ID || '',
    cc: String(process.env.WHATSAPP_DEFAULT_COUNTRY_CODE ?? '91').replace(/\D/g, ''),
    lang: process.env.WHATSAPP_TEMPLATE_LANG || 'en_US',
    verifyToken: process.env.WHATSAPP_VERIFY_TOKEN || '',
    appSecret: process.env.WHATSAPP_APP_SECRET || '',
  },
  twilio: {
    sid: process.env.TWILIO_ACCOUNT_SID || '',
    token: process.env.TWILIO_AUTH_TOKEN || '',
    from: process.env.TWILIO_WHATSAPP_FROM || '',
  },
});

// Injectable for tests.
let fetchImpl = (...args) => globalThis.fetch(...args);
function setFetch(fn) { fetchImpl = fn || ((...args) => globalThis.fetch(...args)); }

// ── Provider choice ──────────────────────────────────────────────────────────

/** 'meta' | 'twilio' — explicit WHATSAPP_PROVIDER, else whichever is configured, else meta. */
function provider() {
  const e = env();
  if (e.provider === 'twilio' || e.provider === 'meta') return e.provider;
  if (e.meta.phoneId && e.meta.token) return 'meta';
  if (e.twilio.sid && e.twilio.token && e.twilio.from) return 'twilio';
  return 'meta';
}

function configured() {
  const e = env();
  const p = provider();
  if (e.dryRun) return { ok: true, reason: 'dry-run', provider: p };
  if (p === 'twilio') {
    const missing = ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_WHATSAPP_FROM'].filter((k) => !process.env[k]);
    return missing.length ? { ok: false, reason: `${missing.join(', ')} not set`, provider: p } : { ok: true, provider: p };
  }
  const missing = ['WHATSAPP_PHONE_NUMBER_ID', 'WHATSAPP_ACCESS_TOKEN'].filter((k) => !process.env[k]);
  if (missing.length) return { ok: false, reason: `${missing.join(', ')} not set`, provider: p };
  const map = templates();
  const names = [...new Set(Object.values(map))];
  return {
    ok: true, provider: p,
    reason: names.length ? `template${names.length > 1 ? 's' : ''} ${names.join(', ')}` : 'no template mapped — text only, inside the 24-hour window',
    templates: map,
  };
}

// ── Numbers ──────────────────────────────────────────────────────────────────

/**
 * Digits only, the way Meta wants them: country code + number, no '+'.
 * A leading '00' is dropped; a bare local number (10 digits or fewer) gets
 * WHATSAPP_DEFAULT_COUNTRY_CODE in front. Null when it cannot be a number.
 */
function normalizePhone(raw, cc = env().meta.cc) {
  if (raw == null) return null;
  let digits = String(raw).replace(/\D/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.length < 7) return null;
  if (cc && digits.length <= 10) digits = cc + digits;
  return digits;
}

/** E.164 for storage ('+' and the normalised digits), or null. */
function toE164(raw) {
  const d = normalizePhone(raw);
  return d && E164.test(`+${d}`) ? `+${d}` : null;
}

// ── Templates ────────────────────────────────────────────────────────────────

let tplCache = { src: null, map: {} };

/** The WHATSAPP_TEMPLATES map, parsed once per value. */
function templates() {
  const src = process.env.WHATSAPP_TEMPLATES || '';
  if (tplCache.src === src) return tplCache.map;
  let map = {};
  if (src.trim()) {
    try {
      const parsed = JSON.parse(src);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        for (const [k, v] of Object.entries(parsed)) if (typeof v === 'string' && v.trim()) map[k] = v.trim();
      } else if (typeof parsed === 'string' && parsed.trim()) {
        map = { '*': parsed.trim() };
      }
    } catch {
      // A bare template name is accepted as the default.
      if (/^[a-z0-9_]+$/i.test(src.trim())) map = { '*': src.trim() };
      else logger.warn('WHATSAPP_TEMPLATES is not valid JSON — no template will be used', { value: src.slice(0, 80) });
    }
  }
  tplCache = { src, map };
  return map;
}

/** The template for an event: exact, then the longest matching prefix ("alarm."), then "*". */
function templateFor(eventType) {
  const map = templates();
  const t = String(eventType || '');
  if (map[t]) return map[t];
  const prefixes = Object.keys(map).filter((k) => k.endsWith('.') && t.startsWith(k)).sort((a, b) => b.length - a.length);
  if (prefixes.length) return map[prefixes[0]];
  return map['*'] || null;
}

/** A template body parameter: no newlines or tabs, no runs of spaces, never empty. */
function param(s, max = 1024) {
  const out = String(s ?? '').replace(/[\r\n\t]+/g, ' · ').replace(/\s+/g, ' ').replace(/( · )+/g, ' · ').trim().slice(0, max).trim();
  return out || '-';
}

/** The rendered text minus its subject line and footer, on one line. */
function details(body, subject) {
  const lines = String(body || '').split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length && subject && lines[0] === String(subject).trim()) lines.shift();
  if (lines.length > 1 && /sent by SafeKrit/i.test(lines[lines.length - 1])) lines.pop();
  return lines.join(' · ') || String(subject || '-');
}

/**
 * The template for a message and the two body parameters it takes — what
 * sendMeta posts and what previews show. Meta counts the rendered body (the
 * template's fixed text plus both values) against 1024 characters, so the
 * details are trimmed to what the template leaves; a template SafeKrit did
 * not write is assumed to carry 300 characters of its own.
 */
function templateParams({ subject, body, eventType }) {
  const name = templateFor(eventType);
  if (!name) return { name: null, params: [] };
  const known = catalogue.byName(name);
  const p1 = param(subject, 200);
  const fixed = known ? catalogue.fixedLength(known) : 300;
  const p2 = param(details(body, subject), Math.max(120, catalogue.LIMITS.body - fixed - p1.length));
  return { name, params: [p1, p2] };
}

// ── Meta errors ──────────────────────────────────────────────────────────────

// Codes that mean "later": throttling, pairing limits, Meta downtime.
const TRANSIENT = new Set([1, 2, 4, 17, 32, 80007, 130429, 131048, 131056, 133004, 133005, 133006]);
const HINT = {
  131047: 'the recipient has not messaged this number in the last 24 h, so only an approved template may be sent — register one and set WHATSAPP_TEMPLATES',
  132000: 'the template takes a different number of parameters — SafeKrit sends two ({{1}} subject, {{2}} details)',
  132001: 'the template does not exist in this language, or is not approved yet',
  132012: 'a template parameter does not match the format Meta approved',
  132015: 'the template is paused by Meta (quality rating)',
  132016: 'the template is disabled by Meta',
  131026: 'the number is not on WhatsApp, or has blocked the business',
  131030: 'the number is not in the test-recipient list of this unverified sender',
  131031: 'the business account is restricted or disabled',
  133010: 'the phone number is not registered on the Cloud API',
  190: 'the access token is invalid or expired — generate a permanent system-user token',
  100: 'Meta rejected the request — check WHATSAPP_PHONE_NUMBER_ID and the message',
  10: 'the token lacks the whatsapp_business_messaging permission',
};

function metaError(status, error = {}) {
  const code = Number(error.code) || 0;
  const detail = error.error_data?.details || error.error_user_msg || '';
  const hint = HINT[code];
  const err = new Error(`Meta ${status}${code ? ` (${code})` : ''}: ${error.message || 'request failed'}${detail ? ` — ${detail}` : ''}${hint ? ` — ${hint}` : ''}`.slice(0, 900));
  err.code = code;
  err.status = status;
  err.permanent = status >= 400 && status < 500 && status !== 429 && !TRANSIENT.has(code);
  return err;
}

// ── Sending ──────────────────────────────────────────────────────────────────

async function sendMeta({ to, subject, body, eventType }) {
  const e = env().meta;
  const { name, params } = templateParams({ subject, body, eventType });
  const message = name
    ? {
      messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'template',
      template: {
        name, language: { code: e.lang },
        components: [{ type: 'body', parameters: params.map((text) => ({ type: 'text', text })) }],
      },
    }
    : {
      messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'text',
      text: { preview_url: false, body: String(body).slice(0, 4096) },
    };

  const res = await fetchImpl(`${GRAPH}/${e.version}/${encodeURIComponent(e.phoneId)}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${e.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(message),
    signal: AbortSignal.timeout(15_000),
  });
  let data = {};
  try { data = await res.json(); } catch { /* non-JSON error body */ }
  if (!res.ok) throw metaError(res.status, data.error || {});
  return { providerId: data.messages?.[0]?.id || 'accepted', provider: 'meta', kind: name ? 'template' : 'text', waTemplate: name || undefined };
}

async function sendTwilio({ address, body }) {
  const e = env().twilio;
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
  return { providerId: data.sid || 'sent', provider: 'twilio', kind: 'text' };
}

/**
 * @param {object} o  { address, subject, body, eventType }
 * @returns {Promise<{ providerId: string, provider: string, kind: string, waTemplate?: string }>}
 * Throws with `permanent = true` when retrying cannot help.
 */
async function send({ address, subject, body, eventType, template }) {
  const e = env();
  const digits = normalizePhone(address);
  if (!digits || !E164.test(`+${digits}`)) {
    const err = new Error(`Invalid WhatsApp number "${address}" — use E.164 (+91…)`); err.permanent = true; throw err;
  }
  const p = provider();
  if (e.dryRun) {
    logger.info('DRY RUN WhatsApp', { provider: p, to: `+${digits}`, template: p === 'meta' ? templateFor(eventType || template) : undefined, chars: String(body).length });
    return { providerId: `dry-run:${Date.now()}`, provider: p, kind: 'dry-run' };
  }
  const c = configured();
  if (!c.ok) { const err = new Error(`WhatsApp not configured — ${c.reason}`); err.permanent = true; throw err; }
  if (p === 'twilio') return sendTwilio({ address: `+${digits}`, body });
  return sendMeta({ to: digits, subject, body, eventType: eventType || template });
}

// ── Template catalogue (Meta) ────────────────────────────────────────────────

let listCache = { at: 0, key: null, data: null };
const LIST_TTL_MS = 300_000;

/** The WABA's message templates with their review status, cached five minutes. */
async function listTemplates({ force = false } = {}) {
  const e = env().meta;
  if (!e.token || !e.wabaId) {
    return { ok: false, reason: 'WHATSAPP_ACCESS_TOKEN and WHATSAPP_BUSINESS_ACCOUNT_ID are needed to read templates', templates: [], mapping: templates() };
  }
  const key = `${e.wabaId}|${e.version}`;
  if (!force && listCache.data && listCache.key === key && Date.now() - listCache.at < LIST_TTL_MS) {
    return { ok: true, cached: true, templates: annotate(listCache.data), mapping: templates() };
  }
  const out = [];
  let after = null;
  for (let page = 0; page < 20; page++) {
    const u = new URL(`${GRAPH}/${e.version}/${encodeURIComponent(e.wabaId)}/message_templates`);
    u.searchParams.set('fields', 'name,status,category,language,components,id,rejected_reason');
    u.searchParams.set('limit', '100');
    if (after) u.searchParams.set('after', after);
    const res = await fetchImpl(u.toString(), { headers: { Authorization: `Bearer ${e.token}` }, signal: AbortSignal.timeout(25_000) });
    let data = {};
    try { data = await res.json(); } catch { /* non-JSON */ }
    if (!res.ok) throw metaError(res.status, data.error || {});
    for (const t of data.data || []) {
      const header = (t.components || []).find((c) => c.type === 'HEADER');
      const body = (t.components || []).find((c) => c.type === 'BODY');
      out.push({
        id: t.id, name: t.name, status: t.status, category: t.category, language: t.language,
        type: header ? String(header.format || 'TEXT').toUpperCase() : 'TEXT',
        body: body?.text || '',
        params: body?.text ? new Set(body.text.match(/\{\{\d+\}\}/g) || []).size : 0,
        reason: t.rejected_reason && t.rejected_reason !== 'NONE' ? t.rejected_reason : null,
      });
    }
    after = data.paging?.cursors?.after;
    if (!after || !data.paging?.next) break;
  }
  listCache = { at: Date.now(), key, data: out };
  return { ok: true, cached: false, templates: annotate(out), mapping: templates() };
}

function annotate(list) {
  const map = templates();
  return list.map((t) => ({ ...t, mappedTo: Object.entries(map).filter(([, n]) => n === t.name).map(([k]) => k) }));
}

// ── Webhook helpers (Meta) ───────────────────────────────────────────────────

/** Meta's GET handshake: the challenge to echo, or null to refuse. */
function verifyWebhook(q = {}) {
  const e = env().meta;
  const mode = q['hub.mode'];
  const token = q['hub.verify_token'];
  const challenge = q['hub.challenge'];
  if (mode === 'subscribe' && e.verifyToken && token === e.verifyToken) return String(challenge ?? '');
  return null;
}

/** X-Hub-Signature-256 over the raw body; true when no app secret is configured. */
function signatureOk(rawBody, header) {
  const secret = env().meta.appSecret;
  if (!secret) return true;
  if (!header || !rawBody) return false;
  const expected = `sha256=${crypto.createHmac('sha256', secret).update(rawBody).digest('hex')}`;
  const a = Buffer.from(expected); const b = Buffer.from(String(header));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const tsToIso = (ts) => (ts ? new Date(Number(ts) * 1000).toISOString() : new Date().toISOString());

/** Statuses and inbound messages out of a Meta webhook document. */
function parseWebhook(payload) {
  const doc = payload && typeof payload === 'object' ? payload : {};
  const statuses = []; const messages = [];
  for (const entry of doc.entry || []) {
    for (const change of entry.changes || []) {
      const v = change.value || {};
      for (const st of v.statuses || []) {
        statuses.push({
          id: st.id, status: st.status, recipient: st.recipient_id || null, at: tsToIso(st.timestamp),
          error: (st.errors || []).map((x) => `${x.code}: ${x.title}${x.error_data?.details ? ` — ${x.error_data.details}` : ''}`).join('; ') || null,
        });
      }
      for (const m of v.messages || []) {
        messages.push({
          id: m.id, from: m.from, type: m.type, at: tsToIso(m.timestamp),
          text: m.type === 'text' ? (m.text?.body || '') : (m.button?.text || m.interactive?.button_reply?.title || m.interactive?.list_reply?.title || ''),
        });
      }
    }
  }
  return { statuses, messages };
}

module.exports = {
  channel: 'whatsapp', send, configured, provider, setFetch,
  normalizePhone, toE164, templates, templateFor, templateParams, details, param, metaError,
  listTemplates, verifyWebhook, signatureOk, parseWebhook, E164,
};
