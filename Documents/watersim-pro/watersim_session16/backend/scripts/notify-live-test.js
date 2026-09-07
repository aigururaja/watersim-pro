#!/usr/bin/env node
/**
 * Send one real test email and one real WhatsApp message through the same
 * adapters the outbox worker uses — no server, no database.
 *
 *   node scripts/notify-live-test.js --email you@example.com --phone +919876543210
 *
 * Reads backend/.env (SMTP_* / WHATSAPP_* — see .env.example). With
 * NOTIFICATIONS_DRY_RUN=true nothing is sent and the rendered message is
 * printed instead. For WhatsApp: a plain text is tried first; if Meta says
 * the number has not written to the business in the last 24 h (131047), the
 * mapped WHATSAPP_TEMPLATES entry is used — or, with --pick-template, the
 * first APPROVED two-parameter template on the account.
 */
'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { render } = require('../src/notifications/templates');
const email = require('../src/notifications/adapters/email');
const whatsapp = require('../src/notifications/adapters/whatsapp');

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : null; };
const TO_EMAIL = opt('email');
const TO_PHONE = opt('phone');
const PICK = args.includes('--pick-template');
if (!TO_EMAIL && !TO_PHONE) { console.error('usage: node scripts/notify-live-test.js --email you@example.com --phone +919876543210 [--pick-template]'); process.exit(2); }

const msg = render('notification.test', { orgName: process.env.ORG_NAME || 'ITC STP', appUrl: process.env.APP_URL || '', severity: 'info', payload: {} });
const show = (label, r) => console.log(`${label}:`, JSON.stringify(r));

(async () => {
  let failed = 0;
  if (TO_EMAIL) {
    show('email provider', email.configured());
    try { show('EMAIL sent', await email.send({ address: TO_EMAIL, subject: msg.subject, body: msg.html })); }
    catch (e) { failed += 1; console.log('EMAIL failed:', e.message, '| permanent =', !!e.permanent); }
  }
  if (TO_PHONE) {
    show('whatsapp provider', whatsapp.configured());
    try { show('WHATSAPP sent', await whatsapp.send({ address: TO_PHONE, subject: msg.subject, body: msg.text, eventType: 'notification.test' })); }
    catch (e) {
      console.log('WHATSAPP failed:', e.message, '| permanent =', !!e.permanent, '| code =', e.code || '');
      if (e.code === 131047 && PICK) {
        const list = await whatsapp.listTemplates({ force: true }).catch((err) => ({ ok: false, reason: err.message, templates: [] }));
        const ok = (list.templates || []).filter((t) => t.status === 'APPROVED' && t.params === 2);
        console.log('approved two-parameter templates:', ok.map((t) => `${t.name} (${t.language})`).join(', ') || `none (${list.reason || 'account has none'})`);
        const pick = ok.find((t) => /alert|notice|task_assigned/i.test(t.name)) || ok[0];
        if (pick) {
          process.env.WHATSAPP_TEMPLATES = JSON.stringify({ '*': pick.name });
          process.env.WHATSAPP_TEMPLATE_LANG = pick.language;
          console.log(`retrying as template ${pick.name}:`, JSON.stringify(pick.body));
          try { show('WHATSAPP template sent', await whatsapp.send({ address: TO_PHONE, subject: msg.subject, body: msg.text, eventType: 'notification.test' })); }
          catch (err) { failed += 1; console.log('WHATSAPP template failed:', err.message); }
        } else failed += 1;
      } else failed += 1;
    }
  }
  console.log(failed ? `done — ${failed} channel(s) failed` : 'done — every channel accepted the message');
  console.log('WhatsApp delivery is confirmed later on the webhook (Settings → Notifications → Recent deliveries), not by this script.');
  process.exit(failed ? 1 : 0);
})();
