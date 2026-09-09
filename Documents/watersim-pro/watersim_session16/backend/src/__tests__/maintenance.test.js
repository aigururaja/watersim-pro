/**
 * Maintenance workflow and notifications (Phase 2).
 *
 * Real database. What is pinned: a critical alarm under a rule with
 * `create_task` raises a task assigned to the least-loaded engineer; one task
 * per event; the state machine's legal moves and its role gates; the
 * transitions and audit trail; the manager's acknowledgement as a separate
 * act from approval; a rule that needs no approval closes on completion;
 * notification policy → outbox rows; the worker in dry-run marks them sent;
 * a permanent adapter error goes straight to dead; and the API around it all.
 */
'use strict';

const { createTestUser, loginAs, makeProject, makeFlowsheet } = require('./helpers');
const { query } = require('../db/pool');
const { processEvaluation } = require('../alarms/evaluator');
const tasks = require('../maintenance/tasks');
const { emit, matchingSubscriptions } = require('../notifications');
const worker = require('../notifications/worker');
const whatsapp = require('../notifications/adapters/whatsapp');

const PW = 'Maint12345!';
const CANVAS = {
  nodes: [
    { id: 'n_in',  type: 'unitOp', data: { opType: 'inlet',      label: 'Inlet',  params: {} } },
    { id: 'ft',    type: 'unitOp', data: { opType: 'instrument', label: 'FT-201', params: { measurement: 'flow' } } },
    { id: 'n_out', type: 'unitOp', data: { opType: 'outlet',     label: 'Outlet', params: {} } },
  ],
  edges: [
    { id: 'e1', source: 'n_in', target: 'ft',    data: { streamType: 'stream' } },
    { id: 'e2', source: 'ft',   target: 'n_out', data: { streamType: 'stream' } },
  ],
};

let admin, manager, engineer, engineer2, operator, viewer;
let orgId, orgSlug, projectId, flowsheetId;
let ids = {};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const uniq = (p) => `${p}.${Date.now()}.${Math.floor(Math.random() * 1e6)}@test.example`;

async function addMember(role) {
  const email = uniq(`maint.${role}`);
  const res = await admin.post('/api/v1/admin/members').send({ email, firstName: 'Maint', lastName: role, role, password: PW });
  if (res.status !== 201) throw new Error(`invite ${role} failed: ${JSON.stringify(res.body)}`);
  const agent = await loginAs({ email, password: PW, orgSlug });
  const me = await agent.get('/api/v1/auth/me');
  const id = me.body.data?.user?.id || me.body.data?.id || me.body.user?.id || me.body.id;
  if (!id) throw new Error(`could not read my id from /auth/me: ${JSON.stringify(me.body)}`);
  return { agent, id, email };
}

async function mkRule(body) {
  const r = await admin.post(`/api/v1/projects/${projectId}/flowsheets/${flowsheetId}/alarms`)
    .send({ targetType: 'node_output', nodeId: 'ft', paramKey: 'TSS', severity: 'critical', ...body });
  if (r.status !== 201) throw new Error(`rule create ${r.status}: ${JSON.stringify(r.body)}`);
  return (await query('SELECT * FROM alarm_rules WHERE id = $1', [r.body.id])).rows[0];
}

/** Raise an event for `rule` through the real state machine and return the event row. */
async function raise(rule, value = 99) {
  await processEvaluation(flowsheetId, orgId, [{ rule, value }], [rule.id], { source: 'plc', rulesById: { [rule.id]: rule } });
  await sleep(150); // the post-raise hook runs on setImmediate
  return (await query(`SELECT * FROM alarm_events WHERE rule_id = $1 AND state = 'active'`, [rule.id])).rows[0];
}

beforeAll(async () => {
  process.env.NOTIFICATIONS_DRY_RUN = 'true';
  const a = await createTestUser('maint.admin@test.example', PW, 'admin');
  admin = await loginAs(a);
  orgSlug = a.orgSlug;
  const project = await makeProject(admin, 'Maintenance Project');
  projectId = project.id;
  orgId = (await query('SELECT organisation_id FROM projects WHERE id = $1', [projectId])).rows[0].organisation_id;
  const fs = await makeFlowsheet(admin, projectId, 'Maintenance FS');
  flowsheetId = fs.id;
  expect((await admin.patch(`/api/v1/projects/${projectId}/flowsheets/${flowsheetId}`).send({ canvasData: CANVAS })).status).toBe(200);

  [manager, engineer, engineer2, operator, viewer] = await Promise.all(
    ['manager', 'engineer', 'engineer', 'operator', 'viewer'].map(addMember)
  );
  ids = { manager: manager.id, engineer: engineer.id, engineer2: engineer2.id, operator: operator.id };
});

afterAll(() => { delete process.env.NOTIFICATIONS_DRY_RUN; });

describe('policy → task', () => {
  let rule, event, task;

  test('a critical alarm under create_task raises a task for the least-loaded engineer', async () => {
    rule = await mkRule({ name: 'TSS critical', maxValue: 30, paramKey: 'TSS' });
    await query(`UPDATE alarm_rules SET create_task = TRUE, task_assignee_role = 'engineer', task_due_within_h = 4 WHERE id = $1`, [rule.id]);
    rule = (await query('SELECT * FROM alarm_rules WHERE id = $1', [rule.id])).rows[0];
    expect(rule.create_task).toBe(true); // critical rules default on since migration 012

    event = await raise(rule, 50);
    expect(event).toBeTruthy();
    const { rows } = await query('SELECT * FROM maintenance_tasks WHERE source_event_id = $1', [event.id]);
    expect(rows).toHaveLength(1);
    task = rows[0];
    expect(task.state).toBe('assigned');
    expect([ids.engineer, ids.engineer2]).toContain(task.assigned_to);
    expect(task.priority).toBe('urgent');
    expect(task.requires_ack).toBe(true);
    expect(task.requires_approval).toBe(true);
    expect(task.created_source).toBe('evaluator');
    expect(new Date(task.due_at) - new Date(task.created_at)).toBeCloseTo(4 * 3600_000, -4);
    expect(task.title).toMatch(/TSS critical/);

    const tr = await query('SELECT * FROM task_transitions WHERE task_id = $1', [task.id]);
    expect(tr.rows).toHaveLength(1);
    expect(tr.rows[0].action).toBe('create');
    expect(tr.rows[0].actor_source).toBe('evaluator');

    const audit = await query(`SELECT * FROM audit_logs WHERE resource_id = $1 AND action = 'task.create'`, [task.id]);
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].user_id).toBeNull();
    expect(audit.rows[0].details.source).toBe('evaluator');
  });

  test('one task per event: a manual create on the same event returns the existing one', async () => {
    const r = await operator.agent.post(`/api/v1/alarms/events/${event.id}/task`).send({});
    expect(r.status).toBe(200);
    expect(r.body.id).toBe(task.id);
    expect(r.body.number).toMatch(/^WO-\d{5}$/);
  });

  test('a warning rule without the policy raises nothing; a person can still raise one', async () => {
    const warn = await mkRule({ name: 'NH4 warn', maxValue: 5, paramKey: 'NH4', severity: 'warning' });
    expect(warn.create_task).toBe(false);
    const ev = await raise(warn, 9);
    expect((await query('SELECT COUNT(*)::int AS n FROM maintenance_tasks WHERE source_event_id = $1', [ev.id])).rows[0].n).toBe(0);

    const r = await operator.agent.post(`/api/v1/alarms/events/${ev.id}/task`).send({ priority: 'low', assignedTo: ids.engineer2 });
    expect(r.status).toBe(201);
    expect(r.body.priority).toBe('low');
    expect(r.body.assignedTo).toBe(ids.engineer2);
    expect(r.body.requiresAck).toBe(false);
    expect(r.body.createdSource).toBe('user');
    expect((await viewer.agent.post(`/api/v1/alarms/events/${ev.id}/task`).send({})).status).toBe(403);
  });

  test('the second engineer is picked when the first is loaded', async () => {
    const loads = await query(`SELECT assigned_to, COUNT(*)::int AS n FROM maintenance_tasks WHERE organisation_id = $1 AND state IN ('assigned','in_progress','rejected') GROUP BY assigned_to`, [orgId]);
    const rule2 = await mkRule({ name: 'BOD critical', maxValue: 10, paramKey: 'BOD' });
    const ev = await raise(rule2, 40);
    const t = (await query('SELECT assigned_to FROM maintenance_tasks WHERE source_event_id = $1', [ev.id])).rows[0];
    const least = [ids.engineer, ids.engineer2].sort((x, y) => (loads.rows.find((l) => l.assigned_to === x)?.n || 0) - (loads.rows.find((l) => l.assigned_to === y)?.n || 0))[0];
    expect(t.assigned_to).toBe(least);
  });
});

describe('state machine', () => {
  let t;
  const T = () => `/api/v1/tasks/${t.id}`;

  beforeAll(async () => {
    const r = await operator.agent.post('/api/v1/tasks').send({ title: 'Replace RFP-P-201/1 seal', priority: 'high', assignedTo: ids.engineer });
    expect(r.status).toBe(201);
    t = r.body;
    expect(t.state).toBe('assigned');
  });

  test('a viewer can read but not touch; an operator cannot start work', async () => {
    expect((await viewer.agent.get(T())).status).toBe(200);
    expect((await viewer.agent.post('/api/v1/tasks').send({ title: 'nope nope' })).status).toBe(403);
    const r = await operator.agent.post(`${T()}/transition`).send({ action: 'start' });
    expect(r.status).toBe(403);
    expect(r.body.error).toMatch(/task\.work/);
  });

  test('another engineer cannot work a task assigned to someone else; the assignee can', async () => {
    const other = await engineer2.agent.post(`${T()}/transition`).send({ action: 'start' });
    expect(other.status).toBe(403);
    expect(other.body.error).toMatch(/assignee or a manager/);
    const r = await engineer.agent.post(`${T()}/transition`).send({ action: 'start' });
    expect(r.status).toBe(200);
    expect(r.body.state).toBe('in_progress');
    expect(r.body.startedAt).toBeTruthy();
  });

  test('illegal moves are refused with the state named', async () => {
    const r = await manager.agent.post(`${T()}/transition`).send({ action: 'approve' });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/in progress/);
    expect((await manager.agent.post(`${T()}/transition`).send({ action: 'reject' })).status).toBe(422); // note required
  });

  test('complete → the engineer cannot approve their own work; the manager rejects with a reason, then approves', async () => {
    let r = await engineer.agent.post(`${T()}/transition`).send({ action: 'complete', note: 'Seal replaced, test run OK' });
    expect(r.status).toBe(200);
    expect(r.body.state).toBe('completed');
    expect(r.body.completionNote).toBe('Seal replaced, test run OK');

    expect((await engineer.agent.post(`${T()}/transition`).send({ action: 'approve' })).status).toBe(403);

    r = await manager.agent.post(`${T()}/transition`).send({ action: 'reject', note: 'Please attach the vibration reading' });
    expect(r.status).toBe(200);
    expect(r.body.state).toBe('rejected');
    expect(r.body.rejectedReason).toMatch(/vibration/);

    // Back to work, complete again, approve.
    expect((await engineer.agent.post(`${T()}/transition`).send({ action: 'start' })).body.state).toBe('in_progress');
    expect((await engineer.agent.post(`${T()}/transition`).send({ action: 'complete', note: 'Reading attached: 2.1 mm/s' })).body.state).toBe('completed');
    r = await manager.agent.post(`${T()}/transition`).send({ action: 'approve' });
    expect(r.status).toBe(200);
    expect(r.body.state).toBe('approved');
    expect(r.body.approvedBy).toBe(ids.manager);
    expect(r.body.closedAt).toBeTruthy();

    const detail = await engineer.agent.get(T());
    const actions = detail.body.transitions.map((x) => x.action);
    expect(actions).toEqual(['create', 'start', 'complete', 'reject', 'start', 'complete', 'approve']);
    expect(detail.body.transitions[3].actorName).toMatch(/Maint manager/);
    expect(detail.body.allowedActions).toEqual([]); // an engineer cannot reopen
    const mgr = await manager.agent.get(T());
    expect(mgr.body.allowedActions).toEqual(['reopen']);

    const audit = await query(`SELECT action FROM audit_logs WHERE resource_id = $1 ORDER BY created_at`, [t.id]);
    expect(audit.rows.map((a) => a.action)).toEqual(expect.arrayContaining(['task.create', 'task.start', 'task.complete', 'task.reject', 'task.approve']));
  });

  test('a closed task cannot be edited; reopen brings it back', async () => {
    expect((await manager.agent.patch(T()).send({ title: 'Renamed task title' })).status).toBe(409);
    const r = await manager.agent.post(`${T()}/transition`).send({ action: 'reopen' });
    expect(r.body.state).toBe('open');
    expect((await manager.agent.patch(T()).send({ title: 'Renamed task title' })).status).toBe(200);
    expect((await manager.agent.post(`${T()}/transition`).send({ action: 'cancel' })).body.state).toBe('cancelled');
  });

  test('manager acknowledgement is recorded separately from approval, and only once', async () => {
    const rule = await mkRule({ name: 'pH critical', maxValue: 9, paramKey: 'pH' });
    const ev = await raise(rule, 11);
    const row = (await query('SELECT id FROM maintenance_tasks WHERE source_event_id = $1', [ev.id])).rows[0];
    expect((await engineer.agent.post(`/api/v1/tasks/${row.id}/transition`).send({ action: 'acknowledge' })).status).toBe(403);
    const r = await manager.agent.post(`/api/v1/tasks/${row.id}/transition`).send({ action: 'acknowledge' });
    expect(r.status).toBe(200);
    expect(r.body.state).toBe('assigned'); // unchanged
    expect(r.body.acknowledgedBy).toBe(ids.manager);
    expect((await manager.agent.post(`/api/v1/tasks/${row.id}/transition`).send({ action: 'acknowledge' })).status).toBe(409);
    const d = await manager.agent.get(`/api/v1/tasks/${row.id}`);
    expect(d.body.allowedActions).not.toContain('acknowledge');
  });

  test('a rule that needs no approval closes on completion', async () => {
    const rule = await mkRule({ name: 'TN critical', maxValue: 15, paramKey: 'TN' });
    await query(`UPDATE alarm_rules SET task_requires_approval = FALSE WHERE id = $1`, [rule.id]);
    const ev = await raise((await query('SELECT * FROM alarm_rules WHERE id = $1', [rule.id])).rows[0], 30);
    const row = (await query('SELECT * FROM maintenance_tasks WHERE source_event_id = $1', [ev.id])).rows[0];
    const t2 = await tasks.transition(row.id, orgId, 'start', { actor: { id: row.assigned_to, role: 'engineer' } });
    expect(t2.state).toBe('in_progress');
    const done = await tasks.transition(row.id, orgId, 'complete', { actor: { id: row.assigned_to, role: 'engineer' }, note: 'done' });
    expect(done.state).toBe('approved');
    expect(done.closedAt).toBeTruthy();
    expect(done.approvedBy).toBeNull();
  });

  test('the list filters and counts; assignees carry their load', async () => {
    const mine = await engineer.agent.get('/api/v1/tasks?assignedTo=me&open=true');
    expect(mine.status).toBe(200);
    expect(mine.body.tasks.every((x) => x.assignedTo === ids.engineer)).toBe(true);
    expect(Object.keys(mine.body.counts)).toEqual(tasks.STATES);
    // (the seal task was renamed by the reopen test above)
    const q = await viewer.agent.get('/api/v1/tasks?q=Renamed');
    expect(q.body.tasks.some((x) => /Renamed/.test(x.title))).toBe(true);
    const a = await operator.agent.get('/api/v1/tasks/assignees');
    expect(a.body.assignees.map((x) => x.role)).toEqual(expect.arrayContaining(['engineer', 'manager', 'admin']));
    expect(a.body.assignees.some((x) => x.role === 'operator')).toBe(false);
    expect(a.body.assignees.find((x) => x.id === ids.engineer).openTasks).toBeGreaterThanOrEqual(0);
  });

  test('comments', async () => {
    const r = await operator.agent.post(`${T()}/comments`).send({ body: 'Spares ordered.' });
    expect(r.status).toBe(201);
    const d = await viewer.agent.get(T());
    expect(d.body.comments.map((c) => c.body)).toContain('Spares ordered.');
    expect((await viewer.agent.post(`${T()}/comments`).send({ body: 'x' })).status).toBe(403);
  });
});

describe('notifications', () => {
  test('policy rows match by exact type, prefix and severity', async () => {
    const mk = (body) => manager.agent.post('/api/v1/notifications/subscriptions').send(body);
    expect((await mk({ role: 'engineer', eventType: 'task.assigned', minSeverity: 'info', channels: ['email'] })).status).toBe(201);
    expect((await mk({ role: 'manager', eventType: 'alarm.', minSeverity: 'critical', channels: ['email', 'whatsapp'] })).status).toBe(201);
    expect((await mk({ userId: ids.operator, eventType: '*', minSeverity: 'warning', channels: ['whatsapp'] })).status).toBe(201);
    expect((await mk({ role: 'viewer', eventType: 'nope.nope' })).status).toBe(422);
    expect((await mk({ eventType: 'alarm.raised' })).status).toBe(422);
    expect((await engineer.agent.post('/api/v1/notifications/subscriptions').send({ role: 'viewer', eventType: 'alarm.raised' })).status).toBe(403);

    expect((await matchingSubscriptions(orgId, 'alarm.raised', 'critical')).map((s) => s.role || 'user').sort()).toEqual(['manager', 'user']);
    expect((await matchingSubscriptions(orgId, 'alarm.raised', 'warning')).map((s) => s.role || 'user')).toEqual(['user']);
    expect((await matchingSubscriptions(orgId, 'alarm.cleared', 'critical')).length).toBe(2);
    expect((await matchingSubscriptions(orgId, 'task.assigned', 'info')).map((s) => s.role)).toEqual(['engineer']);
  });

  test('emit writes one outbox row per person per channel, with addresses from the profile', async () => {
    // The operator subscribed on WhatsApp but has no number yet → nothing queued for them.
    const r1 = await emit('alarm.raised', { orgId, severity: 'critical', payload: { alarm: { ruleName: 'X', message: 'TSS 50 exceeded max 30' } }, dedupeKey: `t1|${Date.now()}` });
    expect(r1.recipients).toBe(2); // manager (role) + operator (user)
    const rows = await query(`SELECT user_id, channel, address, state, subject FROM notification_outbox WHERE organisation_id = $1 AND event_type = 'alarm.raised' ORDER BY created_at DESC`, [orgId]);
    const mine = rows.rows.filter((r) => r.user_id === ids.manager);
    expect(mine.map((r) => r.channel).sort()).toEqual(['email']); // no phone → no whatsapp row
    expect(mine[0].address).toBe(manager.email);
    expect(mine[0].subject).toMatch(/CRITICAL/);
    expect(rows.rows.some((r) => r.user_id === ids.operator)).toBe(false);

    // Give the operator a number through the API, then the row appears.
    const put = await operator.agent.put('/api/v1/notifications/me/channels').send({ whatsapp: { enabled: true, address: '+919876543210' } });
    expect(put.status).toBe(200);
    expect(put.body.whatsapp.address).toBe('+919876543210');
    expect((await operator.agent.put('/api/v1/notifications/me/channels').send({ whatsapp: { enabled: true, address: '9876' } })).status).toBe(422);
    const r2 = await emit('alarm.raised', { orgId, severity: 'warning', payload: { alarm: { message: 'again' } }, dedupeKey: `t2|${Date.now()}` });
    expect(r2.queued).toBe(1);
    const wa = await query(`SELECT * FROM notification_outbox WHERE user_id = $1 AND channel = 'whatsapp' ORDER BY created_at DESC LIMIT 1`, [ids.operator]);
    expect(wa.rows[0].address).toBe('+919876543210');
    expect(wa.rows[0].body).toMatch(/again/);

    // The same dedupe key never queues twice.
    const key = `t3|${Date.now()}`;
    await emit('alarm.raised', { orgId, severity: 'warning', payload: {}, dedupeKey: key });
    const again = await emit('alarm.raised', { orgId, severity: 'warning', payload: {}, dedupeKey: key });
    expect(again.queued).toBe(0);
  });

  test('the worker in dry-run sends; a permanent error goes straight to dead; retry resets it', async () => {
    const out = await worker.drain({ limit: 100 });
    expect(out.claimed).toBeGreaterThan(0);
    expect(out.dead).toBe(0);
    const sent = await query(`SELECT COUNT(*)::int AS n FROM notification_outbox WHERE organisation_id = $1 AND state = 'sent'`, [orgId]);
    expect(sent.rows[0].n).toBeGreaterThan(0);

    // A bad address is permanent, whatever the provider.
    delete process.env.NOTIFICATIONS_DRY_RUN;
    await query(`INSERT INTO notification_outbox (organisation_id, user_id, channel, address, event_type, template, subject, body)
                 VALUES ($1, $2, 'whatsapp', 'not-a-number', 'notification.test', 'notification.test', 't', 'b')`, [orgId, ids.operator]);
    const bad = await worker.drain({ limit: 100 });
    expect(bad.dead).toBe(1);
    const dead = await query(`SELECT id, last_error FROM notification_outbox WHERE organisation_id = $1 AND state = 'dead'`, [orgId]);
    expect(dead.rows[0].last_error).toMatch(/E\.164/);

    // Unconfigured provider → dead with the reason; a manager can retry once it is set up.
    await query(`INSERT INTO notification_outbox (organisation_id, user_id, channel, address, event_type, template, subject, body)
                 VALUES ($1, $2, 'whatsapp', '+919876543210', 'notification.test', 'notification.test', 't', 'b')`, [orgId, ids.operator]);
    await worker.drain({ limit: 100 });
    const unconf = await query(`SELECT id, last_error FROM notification_outbox WHERE organisation_id = $1 AND state = 'dead' AND address = '+919876543210'`, [orgId]);
    expect(unconf.rows[0].last_error).toMatch(/not configured/);

    // Now "configure" Twilio with a fake fetch and retry through the API.
    process.env.TWILIO_ACCOUNT_SID = 'ACtest'; process.env.TWILIO_AUTH_TOKEN = 'tok'; process.env.TWILIO_WHATSAPP_FROM = '+14155238886';
    const calls = [];
    whatsapp.setFetch(async (url, opts) => { calls.push({ url, opts }); return { ok: true, status: 201, json: async () => ({ sid: 'SM123' }) }; });
    const retry = await manager.agent.post(`/api/v1/notifications/outbox/${unconf.rows[0].id}/retry`);
    expect(retry.status).toBe(200);
    expect(retry.body.state).toBe('sent');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toMatch(/ACtest\/Messages\.json$/);
    expect(decodeURIComponent(calls[0].opts.body)).toMatch(/To=whatsapp:\+919876543210/);
    whatsapp.setFetch(null);
    delete process.env.TWILIO_ACCOUNT_SID; delete process.env.TWILIO_AUTH_TOKEN; delete process.env.TWILIO_WHATSAPP_FROM;
    process.env.NOTIFICATIONS_DRY_RUN = 'true';

    expect((await engineer.agent.get('/api/v1/notifications/outbox')).status).toBe(403);
    const box = await manager.agent.get('/api/v1/notifications/outbox');
    expect(box.status).toBe(200);
    expect(box.body.counts.sent).toBeGreaterThan(0);
    expect(box.body.providers.dryRun).toBe(true);
  });

  test('a test message to me goes out on the chosen channel only', async () => {
    const r = await operator.agent.post('/api/v1/notifications/test').send({ channel: 'email' });
    expect(r.status).toBe(200);
    expect(r.body.channel).toBe('email');
    expect(r.body.state).toBe('sent');
    expect(r.body.address).toBe(operator.email);
    const me = await operator.agent.get('/api/v1/notifications/me');
    expect(me.body.email.address).toBe(operator.email);
    expect(me.body.whatsapp.address).toBe('+919876543210');
    expect(me.body.subscriptions.map((s) => s.eventType)).toContain('*');
  });

  test('the workflow itself notifies: the assignee hears about an assignment even with no policy', async () => {
    await query(`DELETE FROM notification_outbox WHERE organisation_id = $1 AND event_type = 'task.assigned'`, [orgId]);
    const r = await operator.agent.post('/api/v1/tasks').send({ title: 'Check blower belts', assignedTo: ids.engineer2 });
    expect(r.status).toBe(201);
    await sleep(100);
    const rows = await query(`SELECT user_id, channel FROM notification_outbox WHERE organisation_id = $1 AND event_type = 'task.assigned'`, [orgId]);
    expect(rows.rows.some((x) => x.user_id === ids.engineer2 && x.channel === 'email')).toBe(true);
  });
});

// ── WhatsApp through Meta's Cloud API, and its webhook ───────────────────────
describe('WhatsApp via Meta Cloud API', () => {
  const request = require('supertest');
  const app = require('../server');
  const META = { WHATSAPP_PROVIDER: 'meta', WHATSAPP_PHONE_NUMBER_ID: '1234567890', WHATSAPP_ACCESS_TOKEN: 'EAAtest', WHATSAPP_VERIFY_TOKEN: 'verify-me' };
  let calls;
  const accept = () => whatsapp.setFetch(async (url, opts) => {
    calls.push({ url, opts, body: JSON.parse(opts.body) });
    return { ok: true, status: 200, json: async () => ({ messages: [{ id: `wamid.${Date.now()}.${calls.length}` }] }) };
  });
  beforeAll(() => { delete process.env.NOTIFICATIONS_DRY_RUN; Object.assign(process.env, META); });
  afterAll(() => {
    for (const k of Object.keys(META)) delete process.env[k];
    for (const k of ['WHATSAPP_TEMPLATES', 'WHATSAPP_APP_SECRET', 'WHATSAPP_BUSINESS_ACCOUNT_ID']) delete process.env[k];
    whatsapp.setFetch(null);
    process.env.NOTIFICATIONS_DRY_RUN = 'true';
  });
  beforeEach(() => { calls = []; accept(); });

  const queueRow = async (eventType = 'notification.test') => (await query(
    `INSERT INTO notification_outbox (organisation_id, user_id, channel, address, event_type, template, subject, body)
     VALUES ($1, $2, 'whatsapp', '+919876543210', $3, $3, 'Test subject', $4) RETURNING id`,
    [orgId, ids.operator, eventType, 'Test subject\n\nline one\nline two\n\nOrg · sent by SafeKrit']
  )).rows[0].id;
  const rowOf = async (id) => (await query('SELECT state, last_error, payload FROM notification_outbox WHERE id = $1', [id])).rows[0];

  test('free text goes to the Graph API with the bearer token and a digits-only recipient', async () => {
    delete process.env.WHATSAPP_TEMPLATES;
    const id = await queueRow();
    expect((await worker.drain({ onlyId: id })).sent).toBe(1);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://graph.facebook.com/v21.0/1234567890/messages');
    expect(calls[0].opts.headers.Authorization).toBe('Bearer EAAtest');
    expect(calls[0].body).toMatchObject({ messaging_product: 'whatsapp', to: '919876543210', type: 'text' });
    const row = await rowOf(id);
    expect(row.state).toBe('sent');
    expect(row.payload).toMatchObject({ providerId: expect.stringMatching(/^wamid\./), provider: 'meta', kind: 'text' });
  });

  test('a mapped event goes out as the template with two body parameters, and the outbox says so', async () => {
    process.env.WHATSAPP_TEMPLATES = '{"*":"safekrit_alert","alarm.":"watersim_alarm"}';
    const id = await queueRow('alarm.raised');
    expect((await worker.drain({ onlyId: id })).sent).toBe(1);
    expect(calls[0].body.type).toBe('template');
    expect(calls[0].body.template.name).toBe('watersim_alarm');
    expect(calls[0].body.template.components[0].parameters.map((p) => p.text)).toEqual(['Test subject', 'line one · line two']);
    const box = await manager.agent.get('/api/v1/notifications/outbox?limit=10');
    const mine = box.body.outbox.find((o) => o.id === id);
    expect(mine).toMatchObject({ kind: 'template', providerId: expect.stringMatching(/^wamid\./), delivery: null });
    expect(box.body.providers.whatsapp).toMatchObject({ ok: true, provider: 'meta', reason: expect.stringMatching(/safekrit_alert/) });
    delete process.env.WHATSAPP_TEMPLATES;
  });

  test("Meta's refusals: outside the 24-hour window is dead with the hint; throttling retries", async () => {
    whatsapp.setFetch(async () => ({ ok: false, status: 400, json: async () => ({ error: { code: 131047, message: 'Re-engagement message' } }) }));
    const id = await queueRow();
    expect((await worker.drain({ onlyId: id })).dead).toBe(1);
    const dead = await rowOf(id);
    expect(dead.state).toBe('dead');
    expect(dead.last_error).toMatch(/131047.*24 h/);
    whatsapp.setFetch(async () => ({ ok: false, status: 400, json: async () => ({ error: { code: 130429, message: 'Rate limit hit' } }) }));
    const id2 = await queueRow();
    expect((await worker.drain({ onlyId: id2 })).failed).toBe(1);
    expect((await rowOf(id2)).state).toBe('failed');
  });

  test('the webhook: handshake, delivery statuses onto the row, a failure kills it, a reply verifies the number', async () => {
    const hook = '/api/v1/webhooks/whatsapp';
    const ok = await request(app).get(hook).query({ 'hub.mode': 'subscribe', 'hub.verify_token': 'verify-me', 'hub.challenge': '4242' });
    expect(ok.status).toBe(200);
    expect(ok.text).toBe('4242');
    expect((await request(app).get(hook).query({ 'hub.mode': 'subscribe', 'hub.verify_token': 'wrong', 'hub.challenge': '1' })).status).toBe(403);

    const id = await queueRow();
    await worker.drain({ onlyId: id });
    const wamid = (await rowOf(id)).payload.providerId;
    const status = (wid, s, extra = {}) => ({ object: 'whatsapp_business_account', entry: [{ id: 'WABA', changes: [{ field: 'messages', value: {
      messaging_product: 'whatsapp', statuses: [{ id: wid, status: s, timestamp: '1757000000', recipient_id: '919876543210', ...extra }] } }] }] });

    let r = await request(app).post(hook).send(status(wamid, 'delivered'));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: 'ok', statuses: 1, matched: 1 });
    expect((await rowOf(id)).payload.delivery).toMatchObject({ status: 'delivered', at: '2025-09-04T15:33:20.000Z', error: null });
    await request(app).post(hook).send(status(wamid, 'sent')); // arrives late — must not regress
    expect((await rowOf(id)).payload.delivery.status).toBe('delivered');
    await request(app).post(hook).send(status(wamid, 'read'));
    expect((await rowOf(id)).payload.delivery.status).toBe('read');
    expect((await rowOf(id)).state).toBe('sent');
    r = await request(app).post(hook).send(status('wamid.unknown', 'read'));
    expect(r.status).toBe(200);
    expect(r.body.matched).toBe(0);

    // A failure after acceptance kills the row with Meta's reason, ready for a retry.
    const id2 = await queueRow();
    await worker.drain({ onlyId: id2 });
    const wamid2 = (await rowOf(id2)).payload.providerId;
    await request(app).post(hook).send(status(wamid2, 'failed', { errors: [{ code: 131026, title: 'Message undeliverable', error_data: { details: 'Not on WhatsApp' } }] }));
    const failed = await rowOf(id2);
    expect(failed.state).toBe('dead');
    expect(failed.last_error).toBe('Delivery failed — 131026: Message undeliverable — Not on WhatsApp');
    expect(failed.payload.delivery.status).toBe('failed');
    const box = await manager.agent.get('/api/v1/notifications/outbox?state=dead');
    expect(box.body.outbox.find((o) => o.id === id2).delivery.status).toBe('failed');

    // The operator replies from the phone: the channel is verified.
    expect((await operator.agent.get('/api/v1/notifications/me')).body.whatsapp.verified).toBe(false);
    r = await request(app).post(hook).send({ object: 'whatsapp_business_account', entry: [{ changes: [{ value: {
      messaging_product: 'whatsapp', messages: [{ from: '919876543210', id: 'wamid.in1', timestamp: '1757000002', type: 'text', text: { body: 'hi' } }] } }] }] });
    expect(r.body).toMatchObject({ messages: 1, verified: 1 });
    expect((await operator.agent.get('/api/v1/notifications/me')).body.whatsapp.verified).toBe(true);
    expect((await request(app).post(hook).send({ object: 'page', entry: [] })).body.status).toBe('ignored');

    // With an app secret, an unsigned document is refused and a signed one accepted.
    process.env.WHATSAPP_APP_SECRET = 'app-secret';
    const doc = JSON.stringify(status(wamid, 'read'));
    expect((await request(app).post(hook).set('Content-Type', 'application/json').send(doc)).status).toBe(401);
    const sig = `sha256=${require('crypto').createHmac('sha256', 'app-secret').update(doc).digest('hex')}`;
    expect((await request(app).post(hook).set('Content-Type', 'application/json').set('X-Hub-Signature-256', sig).send(doc)).status).toBe(200);
    delete process.env.WHATSAPP_APP_SECRET;
  });

  test('a bare local number is stored as E.164 with the default country code', async () => {
    const put = await operator.agent.put('/api/v1/notifications/me/channels').send({ whatsapp: { enabled: true, address: '98765 43210' } });
    expect(put.status).toBe(200);
    expect(put.body.whatsapp.address).toBe('+919876543210');
    expect((await operator.agent.put('/api/v1/notifications/me/channels').send({ whatsapp: { enabled: true, address: '9876' } })).status).toBe(422);
  });

  test('the template catalogue: manager only, needs the WABA id, then lists approval and mapping', async () => {
    expect((await engineer.agent.get('/api/v1/notifications/whatsapp/templates')).status).toBe(403);
    let r = await manager.agent.get('/api/v1/notifications/whatsapp/templates');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: false, provider: 'meta', reason: expect.stringMatching(/WHATSAPP_BUSINESS_ACCOUNT_ID/) });
    process.env.WHATSAPP_BUSINESS_ACCOUNT_ID = 'WABA1';
    process.env.WHATSAPP_TEMPLATES = '{"*":"safekrit_alert"}';
    whatsapp.setFetch(async (url) => { calls.push({ url }); return { ok: true, status: 200, json: async () => ({ data: [
      { id: '1', name: 'safekrit_alert', status: 'APPROVED', category: 'UTILITY', language: 'en_US', components: [{ type: 'BODY', text: '*{{1}}*\n{{2}}' }] },
      { id: '2', name: 'hello_world', status: 'PENDING', category: 'UTILITY', language: 'en_US', components: [{ type: 'HEADER', format: 'TEXT', text: 'Hello' }, { type: 'BODY', text: 'Welcome' }] },
    ], paging: { cursors: { after: 'x' } } }) }; });
    r = await manager.agent.get('/api/v1/notifications/whatsapp/templates?refresh=true');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, provider: 'meta', cached: false });
    expect(calls[0].url).toMatch(/\/v21\.0\/WABA1\/message_templates\?/);
    expect(r.body.templates.find((t) => t.name === 'safekrit_alert')).toMatchObject({ status: 'APPROVED', params: 2, mappedTo: ['*'] });
    expect(r.body.templates.find((t) => t.name === 'hello_world')).toMatchObject({ status: 'PENDING', params: 0, mappedTo: [] });
    whatsapp.setFetch(async () => ({ ok: false, status: 400, json: async () => ({ error: { code: 190, message: 'Invalid OAuth access token' } }) }));
    r = await manager.agent.get('/api/v1/notifications/whatsapp/templates?refresh=true');
    expect(r.status).toBe(502);
    expect(r.body.error).toMatch(/system-user token/);
    delete process.env.WHATSAPP_BUSINESS_ACCOUNT_ID;
    delete process.env.WHATSAPP_TEMPLATES;
  });
});

// ── Receivers: email and WhatsApp set up for every kind of user ──────────────
describe('receivers', () => {
  test('a manager sees every active member with their addresses; an engineer cannot', async () => {
    expect((await engineer.agent.get('/api/v1/notifications/receivers')).status).toBe(403);
    const r = await manager.agent.get('/api/v1/notifications/receivers');
    expect(r.status).toBe(200);
    const roles = r.body.receivers.map((x) => x.role);
    for (const role of ['admin', 'manager', 'engineer', 'operator', 'viewer']) expect(roles).toContain(role);
    const op = r.body.receivers.find((x) => x.id === ids.operator);
    expect(op).toMatchObject({
      name: 'Maint operator', role: 'operator',
      email: { enabled: true, address: operator.email },
      whatsapp: { enabled: true, address: '+919876543210', verified: true },
      reachable: { email: true, whatsapp: true },
    });
    const v = r.body.receivers.find((x) => x.id === viewer.id);
    expect(v.whatsapp).toMatchObject({ enabled: false, address: null });
    expect(v.reachable).toEqual({ email: true, whatsapp: false });
    expect(r.body.providers.whatsapp).toBeDefined();
  });

  test("a manager sets a viewer's WhatsApp number and email override, and sends them a test", async () => {
    const put = await manager.agent.put(`/api/v1/notifications/receivers/${viewer.id}`)
      .send({ whatsapp: { enabled: true, address: '98765 43211' }, email: { enabled: true, address: 'viewer.alt@test.example' } });
    expect(put.status).toBe(200);
    expect(put.body.whatsapp).toMatchObject({ enabled: true, address: '+919876543211', verified: false });
    expect(put.body.email.address).toBe('viewer.alt@test.example');
    expect(put.body.reachable).toEqual({ email: true, whatsapp: true });
    expect((await query('SELECT phone_e164 FROM users WHERE id = $1', [viewer.id])).rows[0].phone_e164).toBeNull(); // the profile mobile is a separate thing
    const me = await viewer.agent.get('/api/v1/notifications/me');
    expect(me.body.whatsapp.address).toBe('+919876543211');
    expect(me.body.email.address).toBe('viewer.alt@test.example');

    // A bad number, an unknown member, and a stranger's test are refused.
    expect((await manager.agent.put(`/api/v1/notifications/receivers/${viewer.id}`).send({ whatsapp: { enabled: true, address: '12' } })).status).toBe(422);
    expect((await manager.agent.put('/api/v1/notifications/receivers/00000000-0000-4000-8000-000000000000').send({ email: { enabled: false } })).status).toBe(404);
    expect((await engineer.agent.post('/api/v1/notifications/test').send({ channel: 'email', userId: viewer.id })).status).toBe(403);

    // The manager's test to the viewer goes out (dry run) to the number just set.
    const t = await manager.agent.post('/api/v1/notifications/test').send({ channel: 'whatsapp', userId: viewer.id });
    expect(t.status).toBe(200);
    expect(t.body).toMatchObject({ channel: 'whatsapp', address: '+919876543211', state: 'sent' });

    // Switching WhatsApp off makes them unreachable there, and a test says so.
    const off = await manager.agent.put(`/api/v1/notifications/receivers/${viewer.id}`).send({ whatsapp: { enabled: false } });
    expect(off.body.reachable.whatsapp).toBe(false);
    expect((await manager.agent.post('/api/v1/notifications/test').send({ channel: 'whatsapp', userId: viewer.id })).status).toBe(422);
  });

  test('the default policy gives every role its rows once, and is reported as missing until then', async () => {
    let subs = await manager.agent.get('/api/v1/notifications/subscriptions');
    expect(subs.body.defaults.length).toBeGreaterThan(10);
    expect(subs.body.missingDefaults.length).toBeGreaterThan(0);
    expect((await engineer.agent.post('/api/v1/notifications/subscriptions/defaults')).status).toBe(403);
    const first = await manager.agent.post('/api/v1/notifications/subscriptions/defaults');
    expect(first.status).toBe(201);
    expect(first.body.added).toBeGreaterThan(0);
    expect(first.body.added + first.body.existing).toBe(first.body.total);
    const again = await manager.agent.post('/api/v1/notifications/subscriptions/defaults');
    expect(again.body).toMatchObject({ added: 0, existing: first.body.total });
    subs = await manager.agent.get('/api/v1/notifications/subscriptions');
    expect(subs.body.missingDefaults).toEqual([]);
    for (const role of ['viewer', 'operator', 'engineer', 'manager', 'admin']) {
      expect(subs.body.subscriptions.some((s) => s.role === role)).toBe(true);
    }
    // The manager's own "alarm." row from earlier is untouched: defaults never overwrite.
    expect(subs.body.subscriptions.some((s) => s.role === 'manager' && s.eventType === 'alarm.' && s.minSeverity === 'critical')).toBe(true);
    const rx = await manager.agent.get('/api/v1/notifications/receivers');
    expect(rx.body.receivers.find((x) => x.id === viewer.id).hears.some((h) => h.eventType === 'alarm.raised')).toBe(true);
  });

  test('an admin gives a member a number when inviting or editing them', async () => {
    const email = uniq('maint.phoned');
    const inv = await admin.post('/api/v1/admin/members').send({ email, firstName: 'Phoned', lastName: 'Viewer', role: 'viewer', password: PW, phone: '98765 43212' });
    expect(inv.status).toBe(201);
    expect(inv.body.phone).toBe('+919876543212');
    expect((await admin.post('/api/v1/admin/members').send({ email: uniq('maint.bad'), firstName: 'B', lastName: 'B', role: 'viewer', password: PW, phone: '12' })).status).toBe(422);
    let rx = await manager.agent.get('/api/v1/notifications/receivers');
    expect(rx.body.receivers.find((x) => x.id === inv.body.id).whatsapp).toMatchObject({ enabled: true, address: '+919876543212' });

    const up = await admin.patch(`/api/v1/admin/members/${inv.body.id}`).send({ phone: '+91 98765 43213' });
    expect(up.status).toBe(200);
    expect(up.body.phone).toBe('+919876543213');
    const list = await admin.get('/api/v1/admin/members');
    expect(list.body.find((m) => m.id === inv.body.id).phone).toBe('+919876543213');

    const cleared = await admin.patch(`/api/v1/admin/members/${inv.body.id}`).send({ phone: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.phone).toBeNull();
    rx = await manager.agent.get('/api/v1/notifications/receivers');
    expect(rx.body.receivers.find((x) => x.id === inv.body.id).reachable.whatsapp).toBe(false);
  });
});

// ── Login email and mobile on the profile; receiver addresses on the channel ──
describe('profile and receiver addresses differ', () => {
  test('a person sets a receiver email and WhatsApp that differ from the login and mobile; the outbox uses them', async () => {
    const me0 = await operator.agent.get('/api/v1/notifications/me');
    expect(me0.body.login.email).toBe(operator.email);
    const mobile = me0.body.login.phone;
    const put = await operator.agent.put('/api/v1/notifications/me/channels')
      .send({ email: { enabled: true, address: 'ops.alerts@test.example' }, whatsapp: { enabled: true, address: '+919876543299' } });
    expect(put.status).toBe(200);
    expect(put.body.email.address).toBe('ops.alerts@test.example');
    expect(put.body.whatsapp.address).toBe('+919876543299');
    expect(put.body.login).toEqual({ email: operator.email, phone: mobile }); // untouched
    const u = (await query('SELECT email, phone_e164 FROM users WHERE id = $1', [ids.operator])).rows[0];
    expect(u.email).toBe(operator.email);
    expect(u.phone_e164).toBe(mobile);

    const r = await emit('notification.test', { orgId, onlyUsers: [ids.operator], dedupeKey: `pv|${Date.now()}` });
    expect(r.queued).toBe(2);
    const rows = (await query(`SELECT channel, address FROM notification_outbox WHERE user_id = $1 AND event_type = 'notification.test' ORDER BY created_at DESC LIMIT 2`, [ids.operator])).rows;
    expect(rows.map((x) => x.address).sort()).toEqual(['+919876543299', 'ops.alerts@test.example']);

    const rx = await manager.agent.get('/api/v1/notifications/receivers');
    expect(rx.body.receivers.find((x) => x.id === ids.operator)).toMatchObject({
      login: operator.email, mobile, email: { address: 'ops.alerts@test.example' }, whatsapp: { address: '+919876543299' },
    });
  });

  test('an admin changes the login email and mobile without touching the receiver addresses', async () => {
    const newLogin = uniq('maint.operator.renamed');
    const up = await admin.patch(`/api/v1/admin/members/${ids.operator}`).send({ email: newLogin.toUpperCase(), phone: '+919800000099' });
    expect(up.status).toBe(200);
    expect(up.body.email).toBe(newLogin);
    expect(up.body.phone).toBe('+919800000099');
    const me = await operator.agent.get('/api/v1/notifications/me');
    expect(me.body.login).toEqual({ email: newLogin, phone: '+919800000099' });
    expect(me.body.email.address).toBe('ops.alerts@test.example');
    expect(me.body.whatsapp.address).toBe('+919876543299');
    expect((await admin.patch(`/api/v1/admin/members/${ids.operator}`).send({ email: manager.email })).status).toBe(409);
    expect((await admin.patch(`/api/v1/admin/members/${ids.operator}`).send({ email: 'nope' })).status).toBe(422);
    expect((await admin.patch(`/api/v1/admin/members/${ids.operator}`).send({ email: newLogin })).status).toBe(200); // own address again is fine
    const list = await admin.get('/api/v1/admin/members');
    expect(list.body.find((m) => m.id === ids.operator)).toMatchObject({ email: newLogin, phone: '+919800000099' });
  });
});
