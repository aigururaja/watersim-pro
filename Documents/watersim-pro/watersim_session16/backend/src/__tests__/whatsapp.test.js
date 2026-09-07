/**
 * WhatsApp (Meta Cloud API / Twilio) and email adapters — unit level.
 *
 * What is pinned: numbers normalise the way Meta wants them (digits, default
 * country code for a bare local number) and store as E.164; the provider is
 * chosen from what is configured; WHATSAPP_TEMPLATES maps an event to an
 * approved template by exact name, prefix or "*"; a mapped event goes out as
 * a template with two body parameters (subject, details on one line), an
 * unmapped one as free text; Meta's error codes are sorted into permanent and
 * transient with a hint a manager can act on; the webhook handshake,
 * signature and document parsing; the template catalogue; and the email
 * adapter's accepted variable names and HTML → text alternative.
 *
 * No database rows are touched — only the adapters.
 */
'use strict';

const crypto = require('crypto');
const whatsapp = require('../notifications/adapters/whatsapp');
const email = require('../notifications/adapters/email');

const ENV_KEYS = [
  'WHATSAPP_PROVIDER', 'WHATSAPP_PHONE_NUMBER_ID', 'WHATSAPP_ACCESS_TOKEN', 'WHATSAPP_API_VERSION', 'WHATSAPP_BUSINESS_ACCOUNT_ID',
  'WHATSAPP_DEFAULT_COUNTRY_CODE', 'WHATSAPP_TEMPLATES', 'WHATSAPP_TEMPLATE_LANG', 'WHATSAPP_VERIFY_TOKEN', 'WHATSAPP_APP_SECRET',
  'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_WHATSAPP_FROM', 'NOTIFICATIONS_DRY_RUN',
  'SMTP_HOST', 'SMTP_SERVER', 'SMTP_PORT', 'SMTP_SECURE', 'SMTP_USE_TLS', 'SMTP_USER', 'SMTP_USERNAME', 'SMTP_PASS', 'SMTP_PASSWORD',
  'SMTP_FROM', 'SMTP_FROM_EMAIL', 'SMTP_FROM_NAME', 'FROM_EMAIL',
];
let saved;
beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
});
afterEach(() => {
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  whatsapp.setFetch(null);
  email.setTransportFactory(null);
});

const META = { WHATSAPP_PHONE_NUMBER_ID: '1234567890', WHATSAPP_ACCESS_TOKEN: 'EAAtest' };
const BODY = '[CRITICAL] Alarm: TSS high\n\nTSS 50 exceeded max 30\nFlowsheet: ITC STP\n\nITC · sent by WaterSim Pro · https://dt.example';

/** A fetch stand-in that records calls and answers with `reply`. */
function fakeFetch(reply = { ok: true, status: 200, body: { messages: [{ id: 'wamid.1' }] } }) {
  const calls = [];
  whatsapp.setFetch(async (url, opts = {}) => {
    calls.push({ url, opts, json: opts.body && opts.headers?.['Content-Type'] === 'application/json' ? JSON.parse(opts.body) : null });
    const r = typeof reply === 'function' ? reply(calls.length) : reply;
    return { ok: r.ok, status: r.status, json: async () => r.body };
  });
  return calls;
}

describe('numbers', () => {
  test('normalise to digits with the default country code for bare local numbers', () => {
    expect(whatsapp.normalizePhone('98765 43210')).toBe('919876543210');
    expect(whatsapp.normalizePhone('+91 98765-43210')).toBe('919876543210');
    expect(whatsapp.normalizePhone('0091 9876543210')).toBe('919876543210');
    expect(whatsapp.normalizePhone('+1 415 523 8886')).toBe('14155238886');
    expect(whatsapp.normalizePhone('9876')).toBeNull();
    expect(whatsapp.normalizePhone('not-a-number')).toBeNull();
    expect(whatsapp.normalizePhone(null)).toBeNull();
    process.env.WHATSAPP_DEFAULT_COUNTRY_CODE = '';
    expect(whatsapp.normalizePhone('9876543210')).toBe('9876543210');
    process.env.WHATSAPP_DEFAULT_COUNTRY_CODE = '+44';
    expect(whatsapp.normalizePhone('7911 123456')).toBe('447911123456');
  });

  test('store as E.164', () => {
    expect(whatsapp.toE164('98765 43210')).toBe('+919876543210');
    expect(whatsapp.toE164('+919876543210')).toBe('+919876543210');
    expect(whatsapp.toE164('9876')).toBeNull();
  });
});

describe('provider choice', () => {
  test('nothing configured → Meta, with the missing variables named', () => {
    expect(whatsapp.provider()).toBe('meta');
    const c = whatsapp.configured();
    expect(c.ok).toBe(false);
    expect(c.reason).toMatch(/WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_ACCESS_TOKEN/);
  });

  test('only Twilio configured → Twilio; both → Meta; WHATSAPP_PROVIDER forces', () => {
    Object.assign(process.env, { TWILIO_ACCOUNT_SID: 'AC', TWILIO_AUTH_TOKEN: 't', TWILIO_WHATSAPP_FROM: '+14155238886' });
    expect(whatsapp.provider()).toBe('twilio');
    expect(whatsapp.configured()).toMatchObject({ ok: true, provider: 'twilio' });
    Object.assign(process.env, META);
    expect(whatsapp.provider()).toBe('meta');
    process.env.WHATSAPP_PROVIDER = 'twilio';
    expect(whatsapp.provider()).toBe('twilio');
  });

  test('Meta configured says which templates are mapped', () => {
    Object.assign(process.env, META);
    expect(whatsapp.configured()).toMatchObject({ ok: true, provider: 'meta', reason: expect.stringMatching(/text only/) });
    process.env.WHATSAPP_TEMPLATES = '{"*":"watersim_alert"}';
    expect(whatsapp.configured().reason).toBe('template watersim_alert');
  });

  test('dry run is ok whatever is set', () => {
    process.env.NOTIFICATIONS_DRY_RUN = 'true';
    expect(whatsapp.configured()).toMatchObject({ ok: true, reason: 'dry-run' });
  });
});

describe('templates', () => {
  test('exact name, then the longest prefix, then "*"', () => {
    process.env.WHATSAPP_TEMPLATES = '{"*":"watersim_alert","alarm.":"watersim_alarm","alarm.cleared":"watersim_clear"}';
    expect(whatsapp.templateFor('alarm.raised')).toBe('watersim_alarm');
    expect(whatsapp.templateFor('alarm.cleared')).toBe('watersim_clear');
    expect(whatsapp.templateFor('task.assigned')).toBe('watersim_alert');
    expect(whatsapp.templateFor('notification.test')).toBe('watersim_alert');
  });

  test('a bare name is the default; broken JSON maps nothing', () => {
    process.env.WHATSAPP_TEMPLATES = 'watersim_alert';
    expect(whatsapp.templates()).toEqual({ '*': 'watersim_alert' });
    process.env.WHATSAPP_TEMPLATES = '{oops';
    expect(whatsapp.templates()).toEqual({});
    expect(whatsapp.templateFor('alarm.raised')).toBeNull();
    delete process.env.WHATSAPP_TEMPLATES;
    expect(whatsapp.templates()).toEqual({});
  });

  test('the details parameter is the body minus subject and footer, on one line', () => {
    expect(whatsapp.details(BODY, '[CRITICAL] Alarm: TSS high')).toBe('TSS 50 exceeded max 30 · Flowsheet: ITC STP');
    expect(whatsapp.details('Only a subject', 'Only a subject')).toBe('Only a subject');
    expect(whatsapp.param('a\nb\n\tc   d', 1024)).toBe('a · b · c d');
    expect(whatsapp.param('', 10)).toBe('-');
    expect(whatsapp.param('x'.repeat(50), 10)).toHaveLength(10);
  });
});

describe('sending through Meta', () => {
  test('free text: the Graph URL, the bearer token, a digits-only recipient, the message id back', async () => {
    Object.assign(process.env, META);
    const calls = fakeFetch();
    const r = await whatsapp.send({ address: '+919876543210', subject: '[CRITICAL] Alarm: TSS high', body: BODY, eventType: 'alarm.raised' });
    expect(r).toEqual({ providerId: 'wamid.1', provider: 'meta', kind: 'text', waTemplate: undefined });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://graph.facebook.com/v21.0/1234567890/messages');
    expect(calls[0].opts.method).toBe('POST');
    expect(calls[0].opts.headers.Authorization).toBe('Bearer EAAtest');
    expect(calls[0].json).toEqual({
      messaging_product: 'whatsapp', recipient_type: 'individual', to: '919876543210', type: 'text',
      text: { preview_url: false, body: BODY },
    });
  });

  test('a mapped event goes out as the template with two body parameters in the configured language', async () => {
    Object.assign(process.env, META, { WHATSAPP_TEMPLATES: '{"alarm.":"watersim_alarm"}', WHATSAPP_TEMPLATE_LANG: 'en', WHATSAPP_API_VERSION: 'v22.0' });
    const calls = fakeFetch();
    const r = await whatsapp.send({ address: '919876543210', subject: '[CRITICAL] Alarm: TSS high', body: BODY, eventType: 'alarm.raised' });
    expect(r).toMatchObject({ providerId: 'wamid.1', kind: 'template', waTemplate: 'watersim_alarm' });
    expect(calls[0].url).toMatch(/\/v22\.0\//);
    expect(calls[0].json.type).toBe('template');
    expect(calls[0].json.template).toEqual({
      name: 'watersim_alarm', language: { code: 'en' },
      components: [{ type: 'body', parameters: [
        { type: 'text', text: '[CRITICAL] Alarm: TSS high' },
        { type: 'text', text: 'TSS 50 exceeded max 30 · Flowsheet: ITC STP' },
      ] }],
    });
    // An event outside the prefix has no template → text.
    await whatsapp.send({ address: '919876543210', subject: 'T', body: 'T\n\nx', eventType: 'task.assigned' });
    expect(calls[1].json.type).toBe('text');
  });

  test("Meta's refusals: permanent with a hint, or transient", async () => {
    Object.assign(process.env, META);
    const attempt = async (status, error) => {
      fakeFetch({ ok: false, status, body: { error } });
      try { await whatsapp.send({ address: '+919876543210', subject: 'S', body: 'S\n\nx', eventType: 'x' }); } catch (err) { return err; }
      return null;
    };
    const window = await attempt(400, { code: 131047, message: 'Re-engagement message' });
    expect(window.permanent).toBe(true);
    expect(window.message).toMatch(/Meta 400 \(131047\): Re-engagement message — .*24 h.*WHATSAPP_TEMPLATES/);
    const params = await attempt(400, { code: 132000, message: 'Number of parameters does not match the expected number of params', error_data: { details: 'body: number of localizable_params (1) does not match the expected number of params (2)' } });
    expect(params.permanent).toBe(true);
    expect(params.message).toMatch(/localizable_params \(1\)/);
    const token = await attempt(401, { code: 190, message: 'Invalid OAuth access token' });
    expect(token.permanent).toBe(true);
    expect(token.message).toMatch(/system-user token/);
    const throttle = await attempt(400, { code: 130429, message: 'Rate limit hit' });
    expect(throttle.permanent).toBe(false);
    const tooMany = await attempt(429, { code: 4, message: 'Too many calls' });
    expect(tooMany.permanent).toBe(false);
    const down = await attempt(503, {});
    expect(down.permanent).toBe(false);
    expect(down.message).toMatch(/Meta 503: request failed/);
  });

  test('a bad number, an unconfigured provider, and a dry run never reach the network', async () => {
    const calls = fakeFetch();
    await expect(whatsapp.send({ address: 'not-a-number', body: 'x' })).rejects.toMatchObject({ permanent: true, message: expect.stringMatching(/E\.164/) });
    await expect(whatsapp.send({ address: '+919876543210', body: 'x' })).rejects.toMatchObject({ permanent: true, message: expect.stringMatching(/not configured/) });
    process.env.NOTIFICATIONS_DRY_RUN = 'true';
    const r = await whatsapp.send({ address: '98765 43210', body: 'x' });
    expect(r.providerId).toMatch(/^dry-run:/);
    expect(calls).toHaveLength(0);
  });
});

describe('sending through Twilio', () => {
  test('the form body, basic auth, and 4xx as permanent', async () => {
    Object.assign(process.env, { WHATSAPP_PROVIDER: 'twilio', TWILIO_ACCOUNT_SID: 'ACtest', TWILIO_AUTH_TOKEN: 'tok', TWILIO_WHATSAPP_FROM: '+14155238886' });
    const calls = fakeFetch({ ok: true, status: 201, body: { sid: 'SM1' } });
    const r = await whatsapp.send({ address: '98765 43210', subject: 'S', body: 'hello' });
    expect(r).toEqual({ providerId: 'SM1', provider: 'twilio', kind: 'text' });
    expect(calls[0].url).toBe('https://api.twilio.com/2010-04-01/Accounts/ACtest/Messages.json');
    expect(calls[0].opts.headers.Authorization).toBe(`Basic ${Buffer.from('ACtest:tok').toString('base64')}`);
    expect(decodeURIComponent(calls[0].opts.body)).toBe('From=whatsapp:+14155238886&To=whatsapp:+919876543210&Body=hello');
    fakeFetch({ ok: false, status: 400, body: { message: 'bad' } });
    await expect(whatsapp.send({ address: '+919876543210', body: 'x' })).rejects.toMatchObject({ permanent: true, message: 'Twilio 400: bad' });
    fakeFetch({ ok: false, status: 429, body: { message: 'slow down' } });
    await expect(whatsapp.send({ address: '+919876543210', body: 'x' })).rejects.toMatchObject({ permanent: false });
  });
});

describe('webhook helpers', () => {
  test('the handshake echoes the challenge only for the right token', () => {
    expect(whatsapp.verifyWebhook({ 'hub.mode': 'subscribe', 'hub.verify_token': 'x', 'hub.challenge': '1' })).toBeNull(); // unset
    process.env.WHATSAPP_VERIFY_TOKEN = 'secret-token';
    expect(whatsapp.verifyWebhook({ 'hub.mode': 'subscribe', 'hub.verify_token': 'secret-token', 'hub.challenge': '4242' })).toBe('4242');
    expect(whatsapp.verifyWebhook({ 'hub.mode': 'subscribe', 'hub.verify_token': 'wrong', 'hub.challenge': '4242' })).toBeNull();
    expect(whatsapp.verifyWebhook({ 'hub.mode': 'unsubscribe', 'hub.verify_token': 'secret-token', 'hub.challenge': '4242' })).toBeNull();
  });

  test('the signature is checked only when an app secret is set', () => {
    const body = Buffer.from('{"a":1}');
    expect(whatsapp.signatureOk(body, undefined)).toBe(true);
    process.env.WHATSAPP_APP_SECRET = 'app';
    const good = `sha256=${crypto.createHmac('sha256', 'app').update(body).digest('hex')}`;
    expect(whatsapp.signatureOk(body, good)).toBe(true);
    expect(whatsapp.signatureOk(body, 'sha256=00')).toBe(false);
    expect(whatsapp.signatureOk(body, undefined)).toBe(false);
    expect(whatsapp.signatureOk(undefined, good)).toBe(false);
  });

  test('statuses and messages come out of the document; anything else is ignored', () => {
    const doc = {
      object: 'whatsapp_business_account',
      entry: [{ id: 'WABA', changes: [{ field: 'messages', value: {
        messaging_product: 'whatsapp',
        statuses: [
          { id: 'wamid.a', status: 'delivered', timestamp: '1757000000', recipient_id: '919876543210' },
          { id: 'wamid.b', status: 'failed', timestamp: '1757000001', recipient_id: '919876543210', errors: [{ code: 131026, title: 'Message undeliverable', error_data: { details: 'Not on WhatsApp' } }] },
        ],
        messages: [
          { from: '919876543210', id: 'wamid.in', timestamp: '1757000002', type: 'text', text: { body: 'hi' } },
          { from: '919876543211', id: 'wamid.btn', timestamp: '1757000003', type: 'button', button: { text: 'Acknowledge' } },
          { from: '919876543212', id: 'wamid.img', timestamp: '1757000004', type: 'image', image: { id: 'x' } },
        ],
      } }] }],
    };
    const { statuses, messages } = whatsapp.parseWebhook(doc);
    expect(statuses).toEqual([
      { id: 'wamid.a', status: 'delivered', recipient: '919876543210', at: '2025-09-04T15:33:20.000Z', error: null },
      { id: 'wamid.b', status: 'failed', recipient: '919876543210', at: '2025-09-04T15:33:21.000Z', error: '131026: Message undeliverable — Not on WhatsApp' },
    ]);
    expect(messages.map((m) => [m.from, m.type, m.text])).toEqual([
      ['919876543210', 'text', 'hi'], ['919876543211', 'button', 'Acknowledge'], ['919876543212', 'image', ''],
    ]);
    expect(whatsapp.parseWebhook({})).toEqual({ statuses: [], messages: [] });
    expect(whatsapp.parseWebhook(null)).toEqual({ statuses: [], messages: [] });
  });
});

describe('template catalogue', () => {
  test('needs the WABA id; pages through Meta; annotates the mapping; caches', async () => {
    Object.assign(process.env, META);
    expect((await whatsapp.listTemplates()).ok).toBe(false);
    process.env.WHATSAPP_BUSINESS_ACCOUNT_ID = 'WABA1';
    process.env.WHATSAPP_TEMPLATES = '{"*":"watersim_alert"}';
    const page = (n) => (n === 1
      ? { ok: true, status: 200, body: { data: [{ id: '1', name: 'watersim_alert', status: 'APPROVED', category: 'UTILITY', language: 'en_US', components: [{ type: 'BODY', text: '*{{1}}*\n{{2}}' }] }], paging: { cursors: { after: 'c1' }, next: 'https://graph.facebook.com/next' } } }
      : { ok: true, status: 200, body: { data: [{ id: '2', name: 'hello_world', status: 'APPROVED', category: 'UTILITY', language: 'en_US', components: [{ type: 'HEADER', format: 'TEXT', text: 'Hello' }, { type: 'BODY', text: 'Welcome and goodbye' }] }], paging: { cursors: { after: 'c2' } } } });
    const calls = fakeFetch(page);
    const r = await whatsapp.listTemplates({ force: true });
    expect(r.ok).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[0].url).toMatch(/^https:\/\/graph\.facebook\.com\/v21\.0\/WABA1\/message_templates\?fields=/);
    expect(calls[1].url).toMatch(/after=c1/);
    expect(calls[0].opts.headers.Authorization).toBe('Bearer EAAtest');
    expect(r.templates).toEqual([
      { id: '1', name: 'watersim_alert', status: 'APPROVED', category: 'UTILITY', language: 'en_US', type: 'TEXT', body: '*{{1}}*\n{{2}}', params: 2, reason: null, mappedTo: ['*'] },
      { id: '2', name: 'hello_world', status: 'APPROVED', category: 'UTILITY', language: 'en_US', type: 'TEXT', body: 'Welcome and goodbye', params: 0, reason: null, mappedTo: [] },
    ]);
    const again = await whatsapp.listTemplates();
    expect(again.cached).toBe(true);
    expect(calls).toHaveLength(2);
  });
});

describe('email adapter', () => {
  test('accepts the CRM and CMMS variable names, and assumes Gmail for a Gmail user', () => {
    expect(email.configured().ok).toBe(false);
    Object.assign(process.env, { SMTP_USER: 'ops@gmail.com', SMTP_PASSWORD: 'app-password' });
    expect(email.configured()).toEqual({ ok: true, reason: 'smtp.gmail.com:587 as WaterSim Pro <ops@gmail.com>' });
    for (const k of ['SMTP_USER', 'SMTP_PASSWORD']) delete process.env[k];
    Object.assign(process.env, { SMTP_SERVER: 'mail.example.com', SMTP_USERNAME: 'u', SMTP_PASSWORD: 'p', FROM_EMAIL: 'stp@example.com', SMTP_FROM_NAME: 'ITC STP' });
    expect(email.configured().reason).toBe('mail.example.com:587 as ITC STP <stp@example.com>');
  });

  test('an HTML body goes out as html with a text alternative; plain text as text', async () => {
    Object.assign(process.env, { SMTP_HOST: 'mail.example.com', SMTP_USER: 'u', SMTP_PASS: 'p', SMTP_FROM: 'WaterSim Pro <no-reply@example.com>' });
    const sent = [];
    email.setTransportFactory(() => ({ sendMail: async (m) => { sent.push(m); return { messageId: '<id@example>' }; } }));
    const html = '<!doctype html><html><body><h2>Alarm &amp; task</h2><p>TSS 50 exceeded max 30</p><p>Open: https://dt.example/tasks</p><hr><div>ITC · sent by WaterSim Pro</div></body></html>';
    const r = await email.send({ address: 'eng@example.com', subject: 'S', body: html });
    expect(r.providerId).toBe('<id@example>');
    expect(sent[0]).toMatchObject({ from: 'WaterSim Pro <no-reply@example.com>', to: 'eng@example.com', subject: 'S', html });
    expect(sent[0].text).toBe('Alarm & task\nTSS 50 exceeded max 30\nOpen: https://dt.example/tasks\n\nITC · sent by WaterSim Pro');
    await email.send({ address: 'eng@example.com', subject: 'S', body: 'just words' });
    expect(sent[1].text).toBe('just words');
    expect(sent[1].html).toBeUndefined();
    await expect(email.send({ address: 'nope', subject: 'S', body: 'x' })).rejects.toMatchObject({ permanent: true });
  });

  test('an authentication failure is permanent and points at the Gmail app password', async () => {
    Object.assign(process.env, { SMTP_USER: 'ops@gmail.com', SMTP_PASSWORD: 'wrong' });
    email.setTransportFactory(() => ({ sendMail: async () => { const e = new Error('Invalid login'); e.code = 'EAUTH'; e.responseCode = 535; throw e; } }));
    await expect(email.send({ address: 'eng@example.com', subject: 'S', body: 'x' })).rejects.toMatchObject({ permanent: true, message: expect.stringMatching(/app password/) });
  });
});
