#!/usr/bin/env node
/**
 * SafeKrit's WhatsApp templates on the Meta WhatsApp Business Account —
 * submit them for review, watch their status, preview what they will say.
 *
 *   node scripts/whatsapp-templates.js list       catalogue, and each template's review status on the WABA
 *   node scripts/whatsapp-templates.js preview    every kind of event as {{1}} / {{2}}, filled into its template
 *   node scripts/whatsapp-templates.js json       the exact create payloads (to paste into WhatsApp Manager or curl)
 *   node scripts/whatsapp-templates.js submit     create every catalogue template the WABA does not have yet
 *        [--only <name>] [--dry-run] [--strict-category]
 *
 * Reads backend/.env: WHATSAPP_ACCESS_TOKEN and WHATSAPP_BUSINESS_ACCOUNT_ID
 * (the CRM's), WHATSAPP_API_VERSION, WHATSAPP_TEMPLATE_LANG. The catalogue
 * itself is src/notifications/whatsappTemplates.js. Review usually takes
 * minutes and at most a day: `list` shows PENDING → APPROVED, or REJECTED
 * with Meta's reason. When every template is APPROVED, set WHATSAPP_TEMPLATES
 * to the mapping `list` prints and restart the backend.
 *
 * --strict-category leaves allow_category_change out of the request, so a
 * template Meta reads as marketing is rejected instead of recategorised.
 */
'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const catalogue = require('../src/notifications/whatsappTemplates');
const whatsapp = require('../src/notifications/adapters/whatsapp');
const { render, EVENT_TYPES } = require('../src/notifications/templates');

const GRAPH = 'https://graph.facebook.com';
const args = process.argv.slice(2);
const cmd = args.find((a) => !a.startsWith('--')) || 'list';
const opt = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : null; };
const flag = (name) => args.includes(`--${name}`);
const only = opt('only');

const env = () => ({
  token: process.env.WHATSAPP_ACCESS_TOKEN || '',
  wabaId: process.env.WHATSAPP_BUSINESS_ACCOUNT_ID || '',
  version: process.env.WHATSAPP_API_VERSION || 'v21.0',
  lang: catalogue.language(),
});
const selected = () => catalogue.TEMPLATES.filter((t) => !only || t.name === only);
const mappingLine = () => `WHATSAPP_TEMPLATES=${JSON.stringify(catalogue.MAPPING)}`;
const payloadFor = (t) => catalogue.toPayload(t, { lang: env().lang, allowCategoryChange: !flag('strict-category') });

function fail(msg, code = 2) { console.error(msg); process.exit(code); }

/** The WABA's templates (name, language, status, params, reason) — the adapter's list, uncached. */
async function onAccount() {
  const list = await whatsapp.listTemplates({ force: true });
  if (!list.ok) throw new Error(list.reason);
  return list.templates;
}

async function createTemplate(payload) {
  const e = env();
  const res = await fetch(`${GRAPH}/${e.version}/${encodeURIComponent(e.wabaId)}/message_templates`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${e.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(25_000),
  });
  let data = {};
  try { data = await res.json(); } catch { /* non-JSON error body */ }
  if (!res.ok) throw whatsapp.metaError(res.status, data.error || {});
  return data; // { id, status, category }
}

// ── Commands ─────────────────────────────────────────────────────────────────

async function list() {
  const e = env();
  console.log(`Catalogue — ${catalogue.TEMPLATES.length} ${catalogue.CATEGORY} templates, language ${e.lang}:`);
  for (const t of catalogue.TEMPLATES) {
    const problems = catalogue.check(t);
    console.log(`  ${t.name.padEnd(24)} serves "${t.key}"  ${problems.length ? `INVALID — ${problems.join('; ')}` : 'ok'}`);
  }
  if (!e.token || !e.wabaId) {
    console.log('\nWHATSAPP_ACCESS_TOKEN and WHATSAPP_BUSINESS_ACCOUNT_ID are not set in backend/.env, so the account cannot be read.');
    return;
  }
  const have = await onAccount();
  console.log(`\nOn the WhatsApp Business Account (${have.length} templates in all):`);
  for (const t of catalogue.TEMPLATES) {
    const rows = have.filter((h) => h.name === t.name);
    if (!rows.length) { console.log(`  ${t.name.padEnd(24)} not submitted yet`); continue; }
    for (const r of rows) {
      const paramNote = r.params !== 2 ? ` (takes ${r.params} parameters — SafeKrit sends 2)` : '';
      console.log(`  ${r.name.padEnd(24)} ${String(r.language).padEnd(6)} ${r.status}${paramNote}${r.reason ? ` — ${r.reason}` : ''}`);
    }
  }
  const others = have.filter((h) => !catalogue.byName(h.name));
  if (others.length) console.log(`  (+${others.length} other template(s) on the account, e.g. ${others.slice(0, 3).map((o) => o.name).join(', ')})`);
  const allApproved = catalogue.TEMPLATES.every((t) => have.some((h) => h.name === t.name && h.language === e.lang && h.status === 'APPROVED'));
  console.log(allApproved
    ? `\nEvery template is APPROVED — set ${mappingLine()} and restart the backend.`
    : `\nWhen every template shows APPROVED, set ${mappingLine()} and restart the backend.`);
}

function preview() {
  process.env.WHATSAPP_TEMPLATES = JSON.stringify(catalogue.MAPPING);
  const orgName = process.env.ORG_NAME || 'ITC STP';
  const appUrl = process.env.APP_URL || 'https://dt.inferconautomation.com';
  for (const [eventType, ctx] of Object.entries(catalogue.SAMPLE_EVENTS)) {
    const msg = render(eventType, { orgName, appUrl, ...ctx });
    const { name, params } = whatsapp.templateParams({ subject: msg.subject, body: msg.text, eventType });
    const t = catalogue.byName(name);
    console.log(`\n══ ${eventType} (${EVENT_TYPES[eventType]?.label || eventType}) → ${name}`);
    console.log(`{{1}} = ${params[0]}`);
    console.log(`{{2}} = ${params[1]}`);
    if (t) console.log(`── on the phone ──\n${t.header}\n\n${catalogue.fill(t, params)}\n\n${catalogue.FOOTER}`);
  }
}

async function submit() {
  const e = env();
  const dry = flag('dry-run');
  const targets = selected();
  if (!targets.length) fail(`no catalogue template named "${only}" — choose from ${catalogue.TEMPLATES.map((t) => t.name).join(', ')}`);
  const canRead = Boolean(e.token && e.wabaId);
  if (!dry && !canRead) fail('WHATSAPP_ACCESS_TOKEN and WHATSAPP_BUSINESS_ACCOUNT_ID must be set in backend/.env to submit');
  const have = canRead ? await onAccount() : [];
  let created = 0; let failed = 0;
  for (const t of targets) {
    const problems = catalogue.check(t);
    if (problems.length) { failed += 1; console.log(`${t.name}: not submitted — ${problems.join('; ')}`); continue; }
    const there = have.find((h) => h.name === t.name && h.language === e.lang);
    if (there) {
      const hint = there.status === 'REJECTED' ? ` — ${there.reason || 'no reason given'}; edit it in WhatsApp Manager, or delete it there and run submit again` : '';
      console.log(`${t.name}: already on the account (${there.status})${hint}`);
      continue;
    }
    const payload = payloadFor(t);
    if (dry) { console.log(`${t.name}: would POST ${JSON.stringify(payload)}`); continue; }
    try {
      const r = await createTemplate(payload);
      created += 1;
      console.log(`${t.name}: submitted — id ${r.id}, status ${r.status}, category ${r.category}`);
    } catch (err) {
      failed += 1;
      console.log(`${t.name}: FAILED — ${err.message}`);
    }
  }
  console.log(`\n${created} submitted, ${failed} failed.${dry ? ' (dry run — nothing sent)' : ''}`);
  console.log(`Run "node scripts/whatsapp-templates.js list" to watch the review; when every template is APPROVED set ${mappingLine()} and restart the backend.`);
  process.exit(failed ? 1 : 0);
}

/**
 * delete --only <name> --yes: remove one template (every language of that
 * name) from the WABA — for retiring a superseded template, e.g. the
 * watersim_* set after the safekrit_* set was approved and mapped. Refuses
 * a template the current WHATSAPP_TEMPLATES mapping still points at.
 */
async function deleteTemplate() {
  const e = env();
  if (!only) fail('delete needs --only <template name>');
  if (!flag('yes')) fail(`delete removes "${only}" from the WhatsApp Business Account for good — re-run with --yes to confirm`);
  if (!e.token || !e.wabaId) fail('WHATSAPP_ACCESS_TOKEN and WHATSAPP_BUSINESS_ACCOUNT_ID must be set in backend/.env');
  const mapped = Object.values(whatsapp.templates());
  if (mapped.includes(only)) fail(`"${only}" is still mapped in WHATSAPP_TEMPLATES — change the mapping first`);
  const have = await onAccount();
  if (!have.some((h) => h.name === only)) { console.log(`${only}: not on the account`); return; }
  const u = new URL(`${GRAPH}/${e.version}/${encodeURIComponent(e.wabaId)}/message_templates`);
  u.searchParams.set('name', only);
  const res = await fetch(u.toString(), { method: 'DELETE', headers: { Authorization: `Bearer ${e.token}` }, signal: AbortSignal.timeout(25_000) });
  let data = {};
  try { data = await res.json(); } catch { /* non-JSON error body */ }
  if (!res.ok) throw whatsapp.metaError(res.status, data.error || {});
  console.log(`${only}: deleted (${JSON.stringify(data)})`);
}

(async () => {
  try {
    if (cmd === 'list') await list();
    else if (cmd === 'preview') preview();
    else if (cmd === 'json') console.log(JSON.stringify(selected().map(payloadFor), null, 2));
    else if (cmd === 'submit') await submit();
    else if (cmd === 'delete') await deleteTemplate();
    else fail('usage: node scripts/whatsapp-templates.js list | preview | json | submit [--only <name>] [--dry-run] [--strict-category] | delete --only <name> --yes');
  } catch (err) {
    fail(`${cmd} failed: ${err.message}`, 1);
  }
})();
