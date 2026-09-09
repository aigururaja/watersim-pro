/**
 * SafeKrit — WhatsApp template catalogue (Meta Cloud API)
 *
 * The templates SafeKrit submits to Meta for review, in the exact shape the
 * Business Management API takes (POST /{WABA_ID}/message_templates). Every
 * one is UTILITY, positional, and takes the two body parameters the adapter
 * fills (adapters/whatsapp.js): {{1}} the subject line, {{2}} the details on
 * one line. MAPPING is the WHATSAPP_TEMPLATES value to set once they show
 * APPROVED; scripts/whatsapp-templates.js submits, lists and previews them.
 *
 * Meta's review rules shaped every body — a template that breaks them is not
 * even created (since October 2025 the API refuses it outright):
 *   - a body may not begin or end with a variable, variables may not sit
 *     back to back, and each needs text around it — so every body has an
 *     opening sentence, a label before {{2}} and a closing sentence;
 *   - the variable count must stay small against the text (two in ~150
 *     characters is comfortable);
 *   - every variable needs a realistic sample value (example.body_text), with
 *     no newline, tab or run of spaces;
 *   - header ≤ 60 characters with no variable, body ≤ 1024, footer ≤ 60 and
 *     text only; names are lowercase letters, digits and underscores;
 *   - the rendered body — fixed text plus both values — also counts against
 *     1024, which is why the adapter trims {{2}} to what is left;
 *   - UTILITY means non-promotional and specific to the recipient. Alarms and
 *     tasks for the people on a plant's roster are exactly that, so no
 *     wording that reads as an offer, a sign-up or an app install.
 */
'use strict';

const CATEGORY = 'UTILITY';
const DEFAULT_LANGUAGE = 'en_US';
const FOOTER = 'SafeKrit · automated plant notification';
const language = () => process.env.WHATSAPP_TEMPLATE_LANG || DEFAULT_LANGUAGE;

/** key = the WHATSAPP_TEMPLATES entry the template serves ("*" default, "task." prefix, or an event type). */
const TEMPLATES = Object.freeze([
  {
    name: 'safekrit_alarm_raised',
    key: 'alarm.raised',
    purpose: 'A limit was breached or a PLC point went quiet — the message that wakes an engineer',
    header: 'Plant alarm',
    body: 'An alarm has been raised at your plant and needs attention.\n\n*{{1}}*\n\nDetails: {{2}}\n\nPlease check the equipment and acknowledge the alarm in SafeKrit.',
    samples: [
      '[CRITICAL] Alarm: Outlet TSS high',
      'Outlet TSS 48 mg/L is above the 30 mg/L limit · Flowsheet: ITC STP · Value: 48 · Raised: 07/09/2026, 22:14:05 · Source: live PLC data',
    ],
  },
  {
    name: 'safekrit_alarm_cleared',
    key: 'alarm.cleared',
    purpose: 'The breach ended',
    header: 'Plant alarm cleared',
    body: 'An earlier alarm at your plant has returned to normal.\n\n*{{1}}*\n\nDetails: {{2}}\n\nNo action is needed unless a maintenance task is still open for it.',
    samples: [
      '[Cleared] Outlet TSS high',
      'Outlet TSS is back to 22 mg/L · Flowsheet: ITC STP · Cleared: 07/09/2026, 23:02:10',
    ],
  },
  {
    name: 'safekrit_task_update',
    key: 'task.',
    purpose: 'Every maintenance task event: created, assigned, completed, approved, rejected, acknowledged, cancelled',
    header: 'Maintenance task update',
    body: 'There is an update on a maintenance task you are involved in.\n\n*{{1}}*\n\nDetails: {{2}}\n\nOpen the task in SafeKrit to review it or record your work.',
    samples: [
      'Task WO-0042 assigned to you: Clean the MBR membrane rack',
      'WO-0042 · Clean the MBR membrane rack · Priority: high · due 08/09/2026, 10:00:00 · Assigned to: Ravi Kumar',
    ],
  },
  {
    name: 'safekrit_alert',
    key: '*',
    purpose: 'Everything else: twin drift, daily equipment counters, the test message, any event added later',
    header: 'SafeKrit notification',
    body: 'A notification from your plant monitoring system.\n\n*{{1}}*\n\nDetails: {{2}}\n\nOpen SafeKrit for the full record.',
    samples: [
      '[Warning] Twin drift on FIT-201',
      'Inlet flow: model 118 m3/h, plant 96 m3/h · Residual -22 (z 3.4)',
    ],
  },
]);

/** WHATSAPP_TEMPLATES once every template above is APPROVED. */
const MAPPING = Object.freeze(Object.fromEntries(TEMPLATES.map((t) => [t.key, t.name])));

/** Realistic contexts for templates.render(), one per kind of message — what `preview` and the tests send through the adapter. */
const SAMPLE_EVENTS = Object.freeze({
  'alarm.raised': { severity: 'critical', payload: { alarm: { ruleName: 'Outlet TSS high', message: 'Outlet TSS 48 mg/L is above the 30 mg/L limit', flowsheetName: 'ITC STP', value: 48, triggeredAt: '2026-09-07T16:44:05Z', source: 'plc' } } },
  'alarm.cleared': { severity: 'info', payload: { alarm: { ruleName: 'Outlet TSS high', message: 'Outlet TSS is back to 22 mg/L', flowsheetName: 'ITC STP', clearedAt: '2026-09-07T17:32:10Z' } } },
  'task.assigned': { severity: 'warning', payload: { task: { id: 42, number: 'WO-0042', title: 'Clean the MBR membrane rack', priority: 'high', dueAt: '2026-09-08T04:30:00Z', assignedToName: 'Ravi Kumar', description: 'Membrane rack 2 — CIP with citric acid, then log the TMP.' } } },
  'task.completed': { severity: 'info', payload: { task: { id: 42, number: 'WO-0042', title: 'Clean the MBR membrane rack', priority: 'high', assignedToName: 'Ravi Kumar', completionNote: 'TMP back to 0.18 bar after CIP.' } } },
  'twin.drift': { severity: 'warning', payload: { tag: 'FIT-201', message: 'Inlet flow: model 118 m3/h, plant 96 m3/h', residual: -22, z: 3.4 } },
  'notification.test': { severity: 'info', payload: {} },
});

// ── Review rules ─────────────────────────────────────────────────────────────

const LIMITS = Object.freeze({ name: 512, header: 60, body: 1024, footer: 60, params: 2 });
const VAR = /\{\{(\d+)\}\}/g;
const NAME = /^[a-z0-9_]+$/;

/** Everything about a catalogue entry that Meta would refuse, as a list of sentences (empty when it will be created). */
function check(t) {
  const out = [];
  const name = String(t?.name || '');
  if (!NAME.test(name) || name.length > LIMITS.name) out.push('name must be lowercase letters, digits and underscores');
  const header = String(t?.header || '');
  if (header.length > LIMITS.header) out.push(`header is ${header.length} characters, the limit is ${LIMITS.header}`);
  if (/\{\{/.test(header)) out.push('header must not contain a variable');
  const body = String(t?.body || '');
  if (!body.trim()) out.push('body is empty');
  if (body.length > LIMITS.body) out.push(`body is ${body.length} characters, the limit is ${LIMITS.body}`);
  const vars = [...body.matchAll(VAR)].map((m) => Number(m[1]));
  const expected = Array.from({ length: LIMITS.params }, (_, i) => i + 1);
  if (vars.length !== LIMITS.params || vars.some((v, i) => v !== expected[i])) {
    out.push(`body must use exactly {{1}} and {{2}} once each, in order (SafeKrit sends two parameters) — found ${vars.map((v) => `{{${v}}}`).join(' ') || 'none'}`);
  }
  if (/^\s*[*_~]*\{\{\d+\}\}/.test(body)) out.push('body must not begin with a variable');
  if (/\{\{\d+\}\}[*_~]*\s*$/.test(body)) out.push('body must not end with a variable');
  if (/\}\}[\s*_~]*\{\{/.test(body)) out.push('variables must not sit back to back — put a word between them');
  if (t?.footer !== undefined) {
    const footer = String(t.footer || '');
    if (footer.length > LIMITS.footer) out.push(`footer is ${footer.length} characters, the limit is ${LIMITS.footer}`);
    if (/\{\{/.test(footer)) out.push('footer must not contain a variable');
  }
  const samples = Array.isArray(t?.samples) ? t.samples : [];
  if (samples.length !== vars.length) out.push(`every variable needs a sample value — ${vars.length} variable(s), ${samples.length} sample(s)`);
  samples.forEach((s, i) => {
    const v = String(s ?? '');
    if (!v.trim()) out.push(`sample {{${i + 1}}} is empty`);
    if (/[\r\n\t]/.test(v)) out.push(`sample {{${i + 1}}} has a newline or tab`);
    if (/ {4,}/.test(v)) out.push(`sample {{${i + 1}}} has four or more spaces in a row`);
  });
  return out;
}

/** The POST /{WABA_ID}/message_templates body for a catalogue entry. */
function toPayload(t, { lang = language(), allowCategoryChange = true } = {}) {
  const components = [];
  if (t.header) components.push({ type: 'HEADER', format: 'TEXT', text: t.header });
  components.push({ type: 'BODY', text: t.body, example: { body_text: [t.samples.map(String)] } });
  const footer = t.footer === undefined ? FOOTER : t.footer;
  if (footer) components.push({ type: 'FOOTER', text: footer });
  const payload = { name: t.name, language: lang, category: CATEGORY, components };
  if (allowCategoryChange) payload.allow_category_change = true;
  return payload;
}

/** The body with the parameters filled in — what the phone shows, for previews and tests. */
function fill(t, params) {
  return String(t.body).replace(VAR, (_, n) => String(params[Number(n) - 1] ?? ''));
}

/** The body's fixed text without its variables — what the parameter values must fit beside. */
function fixedLength(t) { return String(t.body).replace(VAR, '').length; }

/** The catalogue entry behind an approved template name, or null for a template SafeKrit did not write. */
function byName(name) { return TEMPLATES.find((t) => t.name === name) || null; }

module.exports = {
  CATEGORY, DEFAULT_LANGUAGE, FOOTER, LIMITS, TEMPLATES, MAPPING, SAMPLE_EVENTS,
  language, check, toPayload, fill, fixedLength, byName,
};
