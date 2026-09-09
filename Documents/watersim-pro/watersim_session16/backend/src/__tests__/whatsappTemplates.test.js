/**
 * The WhatsApp template catalogue — what SafeKrit submits to Meta for review.
 *
 * Pinned: every catalogue entry passes the rules Meta enforces at creation
 * (no variable at the start or end of the body, none back to back, exactly
 * the two parameters the adapter sends, a sample per variable, the length
 * limits); check() catches each of those rules; MAPPING routes every event
 * type to a catalogue template; the sample events render, through the
 * adapter, into parameters that fit Meta's rendered-body limit; and the
 * create payload has the shape the Business Management API takes.
 *
 * No database rows are touched and nothing leaves the process.
 */
'use strict';

const catalogue = require('../notifications/whatsappTemplates');
const whatsapp = require('../notifications/adapters/whatsapp');
const { render, EVENT_TYPES } = require('../notifications/templates');

const ENV_KEYS = ['WHATSAPP_TEMPLATES', 'WHATSAPP_TEMPLATE_LANG', 'NOTIFY_TZ'];
let saved;
beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
});
afterEach(() => {
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

const good = catalogue.TEMPLATES[0];
const has = (re) => expect.arrayContaining([expect.stringMatching(re)]);

describe('catalogue entries', () => {
  test.each(catalogue.TEMPLATES.map((t) => [t.name, t]))('%s passes the rules Meta enforces at creation', (_, t) => {
    expect(catalogue.check(t)).toEqual([]);
    expect(t.header.length).toBeLessThanOrEqual(catalogue.LIMITS.header);
    expect(t.body.length).toBeLessThanOrEqual(catalogue.LIMITS.body);
    expect(t.samples).toHaveLength(2);
    expect(t.body).toMatch(/\{\{1\}\}[\s\S]*\{\{2\}\}/);
  });

  test('names are unique, keys are unique, and the footer fits', () => {
    expect(new Set(catalogue.TEMPLATES.map((t) => t.name)).size).toBe(catalogue.TEMPLATES.length);
    expect(new Set(catalogue.TEMPLATES.map((t) => t.key)).size).toBe(catalogue.TEMPLATES.length);
    expect(catalogue.FOOTER.length).toBeLessThanOrEqual(catalogue.LIMITS.footer);
    expect(catalogue.MAPPING['*']).toBe('safekrit_alert');
  });
});

describe('check()', () => {
  const withBody = (body) => ({ ...good, body });

  test('refuses a body that begins or ends with a variable, or stacks them', () => {
    expect(catalogue.check(withBody('{{1}} then {{2}} and more.'))).toEqual(has(/begin with a variable/));
    expect(catalogue.check(withBody('Text first, then {{1}} and {{2}}'))).toEqual(has(/end with a variable/));
    // The body the runbook used to suggest: refused on all three counts.
    const old = catalogue.check(withBody('*{{1}}*\n{{2}}'));
    expect(old).toEqual(has(/begin with a variable/));
    expect(old).toEqual(has(/end with a variable/));
    expect(old).toEqual(has(/back to back/));
  });

  test('refuses the wrong number or order of variables', () => {
    expect(catalogue.check(withBody('Only {{1}} here.'))).toEqual(has(/exactly \{\{1\}\} and \{\{2\}\}/));
    expect(catalogue.check(withBody('First {{2}} then {{1}} here.'))).toEqual(has(/exactly/));
    expect(catalogue.check(withBody('A {{1}} b {{2}} c {{3}} d.'))).toEqual(has(/exactly/));
  });

  test('refuses bad names, long headers, variables in the header or footer, and bad samples', () => {
    expect(catalogue.check({ ...good, name: 'WaterSim-Alert' })).toEqual(has(/name must be lowercase/));
    expect(catalogue.check({ ...good, header: 'h'.repeat(61) })).toEqual(has(/header is 61 characters/));
    expect(catalogue.check({ ...good, header: 'Alarm {{1}}' })).toEqual(has(/header must not contain a variable/));
    expect(catalogue.check({ ...good, footer: 'Sent to {{1}}' })).toEqual(has(/footer must not contain a variable/));
    expect(catalogue.check({ ...good, footer: 'f'.repeat(61) })).toEqual(has(/footer is 61 characters/));
    expect(catalogue.check({ ...good, samples: ['only one'] })).toEqual(has(/sample value/));
    const bad = catalogue.check({ ...good, samples: ['a\nb', 'c    d'] });
    expect(bad).toEqual(has(/newline or tab/));
    expect(bad).toEqual(has(/four or more spaces/));
  });
});

describe('MAPPING', () => {
  test('routes every event type to a catalogue template, alarms and tasks to their own', () => {
    process.env.WHATSAPP_TEMPLATES = JSON.stringify(catalogue.MAPPING);
    for (const type of Object.keys(EVENT_TYPES)) expect(catalogue.byName(whatsapp.templateFor(type))).not.toBeNull();
    expect(whatsapp.templateFor('alarm.raised')).toBe('safekrit_alarm_raised');
    expect(whatsapp.templateFor('alarm.cleared')).toBe('safekrit_alarm_cleared');
    expect(whatsapp.templateFor('task.assigned')).toBe('safekrit_task_update');
    expect(whatsapp.templateFor('task.rejected')).toBe('safekrit_task_update');
    expect(whatsapp.templateFor('twin.drift')).toBe('safekrit_alert');
    expect(whatsapp.templateFor('equipment.counters.daily')).toBe('safekrit_alert');
    expect(whatsapp.templateFor('something.new')).toBe('safekrit_alert');
  });
});

describe('sample events through the adapter', () => {
  beforeEach(() => {
    process.env.WHATSAPP_TEMPLATES = JSON.stringify(catalogue.MAPPING);
    process.env.NOTIFY_TZ = 'Asia/Kolkata';
  });

  test.each(Object.keys(catalogue.SAMPLE_EVENTS))('%s renders into two parameters that fit the rendered body', (type) => {
    const msg = render(type, { orgName: 'ITC STP', appUrl: 'https://plant.example.com', ...catalogue.SAMPLE_EVENTS[type] });
    const { name, params } = whatsapp.templateParams({ subject: msg.subject, body: msg.text, eventType: type });
    const t = catalogue.byName(name);
    expect(t).not.toBeNull();
    expect(params).toHaveLength(2);
    for (const p of params) {
      expect(p).not.toMatch(/[\r\n\t]/);
      expect(p).not.toMatch(/ {4,}/);
      expect(p.trim()).not.toBe('');
    }
    expect(params[0]).toBe(msg.subject); // subjects are short and single-line already
    const shown = catalogue.fill(t, params);
    expect(shown.length).toBeLessThanOrEqual(catalogue.LIMITS.body);
    expect(shown).not.toMatch(/sent by SafeKrit/i); // the footer line is not repeated inside the body
    expect(shown).toContain(msg.subject);
  });

  test('a task message carries the link to open it', () => {
    const msg = render('task.assigned', { orgName: 'ITC STP', appUrl: 'https://plant.example.com', ...catalogue.SAMPLE_EVENTS['task.assigned'] });
    const { params } = whatsapp.templateParams({ subject: msg.subject, body: msg.text, eventType: 'task.assigned' });
    expect(params[1]).toContain('Open: https://plant.example.com/tasks?open=42');
    expect(params[1]).toContain('Assigned to: Ravi Kumar');
  });

  test('an oversized message is trimmed to the rendered-body limit rather than refused', () => {
    const long = Array.from({ length: 60 }, (_, i) => `line ${i} ${'x'.repeat(40)}`).join('\n');
    const subject = 'S'.repeat(300);
    const { name, params } = whatsapp.templateParams({ subject, body: `${subject}\n\n${long}`, eventType: 'alarm.raised' });
    const t = catalogue.byName(name);
    expect(params[0]).toHaveLength(200);
    expect(params[1].length).toBeGreaterThanOrEqual(120);
    expect(catalogue.fill(t, params).length).toBeLessThanOrEqual(catalogue.LIMITS.body);
  });

  test('a template SafeKrit did not write is given a conservative allowance', () => {
    process.env.WHATSAPP_TEMPLATES = JSON.stringify({ '*': 'staff_task_assigned_18t5k' });
    const long = 'y'.repeat(2000);
    const { name, params } = whatsapp.templateParams({ subject: 'Hello', body: `Hello\n\n${long}`, eventType: 'notification.test' });
    expect(name).toBe('staff_task_assigned_18t5k');
    expect(params[1].length).toBeLessThan(1024 - 300);
  });

  test('no mapped template means no parameters (free text goes out instead)', () => {
    delete process.env.WHATSAPP_TEMPLATES;
    expect(whatsapp.templateParams({ subject: 'x', body: 'x\ny', eventType: 'alarm.raised' })).toEqual({ name: null, params: [] });
  });
});

describe('toPayload()', () => {
  test('is the Business Management API create request', () => {
    process.env.WHATSAPP_TEMPLATE_LANG = 'en_US';
    const p = catalogue.toPayload(good);
    expect(p).toMatchObject({ name: good.name, language: 'en_US', category: 'UTILITY', allow_category_change: true });
    expect(p.components.map((c) => c.type)).toEqual(['HEADER', 'BODY', 'FOOTER']);
    expect(p.components[0]).toEqual({ type: 'HEADER', format: 'TEXT', text: good.header });
    expect(p.components[1]).toEqual({ type: 'BODY', text: good.body, example: { body_text: [good.samples] } });
    expect(p.components[2]).toEqual({ type: 'FOOTER', text: catalogue.FOOTER });
  });

  test('honours the language and the strict-category choice', () => {
    expect(catalogue.toPayload(good, { lang: 'en', allowCategoryChange: false })).not.toHaveProperty('allow_category_change');
    expect(catalogue.toPayload(good, { lang: 'en' }).language).toBe('en');
    process.env.WHATSAPP_TEMPLATE_LANG = 'en_GB';
    expect(catalogue.toPayload(good).language).toBe('en_GB');
  });

  test('a template without a header or footer sends only the body', () => {
    const p = catalogue.toPayload({ ...good, header: '', footer: '' });
    expect(p.components.map((c) => c.type)).toEqual(['BODY']);
  });
});
