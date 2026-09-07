/**
 * The CMMS boundary (Phase 5).
 *
 * Real database. What is pinned: an API key is shown once and admits only its
 * scopes; the asset read API describes a loop as the CMMS's asset with its
 * points, history, counters and events, and refuses other organisations; a
 * work-order status from the CMMS becomes a task transition by the system
 * actor and closes the task when the work order closes; an emitted event is
 * queued to every matching webhook and delivered with a valid HMAC; a refused
 * receiver dead-letters; loopback URLs are rejected.
 */
'use strict';

const crypto = require('crypto');
const { createTestUser, loginAs, makeProject, makeFlowsheet, request, app } = require('./helpers');
const { query } = require('../db/pool');
const { backfillBindingTags } = require('../historian');
const tasks = require('../maintenance/tasks');
const { emit } = require('../notifications');
const worker = require('../notifications/worker');
const webhook = require('../notifications/adapters/webhook');

const PW = 'CmmsPass123!';
const CANVAS = {
  nodes: [
    { id: 'n_in', type: 'unitOp', data: { opType: 'inlet', label: 'Inlet', params: {} } },
    { id: 'p1', type: 'unitOp', data: { opType: 'pump', label: 'P-201', params: {} } },
    { id: 'ft', type: 'unitOp', data: { opType: 'instrument', label: 'FT-201', params: { measurement: 'flow' } } },
    { id: 'n_out', type: 'unitOp', data: { opType: 'outlet', label: 'Outlet', params: {} } },
  ],
  edges: [
    { id: 'e1', source: 'n_in', target: 'p1', data: { streamType: 'stream' } },
    { id: 'e2', source: 'p1', target: 'ft', data: { streamType: 'stream' } },
    { id: 'e3', source: 'ft', target: 'n_out', data: { streamType: 'stream' } },
  ],
};

let admin, engineer, other, projectId, flowsheetId, orgId, connectionId;
let readKey, writeKey, ftTag;
const withKey = (key) => (path) => request(app).get(path).set('Authorization', `Bearer ${key}`);
const postKey = (key, path, body) => request(app).post(path).set('X-API-Key', key).send(body);

beforeAll(async () => {
  process.env.WEBHOOK_ALLOW_LOCAL_HOSTS = 'false';
  delete process.env.NOTIFICATIONS_DRY_RUN;
  const a = await createTestUser('cmms.admin@test.example', PW, 'admin');
  admin = await loginAs(a);
  const project = await makeProject(admin, 'CMMS Project');
  projectId = project.id;
  orgId = (await query('SELECT organisation_id FROM projects WHERE id = $1', [projectId])).rows[0].organisation_id;
  const fs = await makeFlowsheet(admin, projectId, 'CMMS FS');
  flowsheetId = fs.id;
  expect((await admin.patch(`/api/v1/projects/${projectId}/flowsheets/${flowsheetId}`).send({ canvasData: CANVAS })).status).toBe(200);
  const email = `cmms.eng.${Date.now()}@test.example`;
  expect((await admin.post('/api/v1/admin/members').send({ email, firstName: 'C', lastName: 'E', role: 'engineer', password: PW })).status).toBe(201);
  engineer = await loginAs({ email, password: PW, orgSlug: a.orgSlug });
  other = await loginAs(await createTestUser('cmms.other@test.example', PW, 'admin'));

  connectionId = (await admin.post('/api/v1/plc/connections').send({ name: 'CMMS Sim', protocol: 'simulator', config: {} })).body.id;
  const tag = (b) => admin.post('/api/v1/tags').send({ flowsheetId, ...b });
  ftTag = (await tag({ tag: 'RFP-FT-201.FT', name: 'Reactor feed flow', signalType: 'AI', kind: 'flow_meter', signal: 'Flow', nodeId: 'ft', paramKey: 'measured', engUnit: 'm3/d', rangeMin: 0, rangeMax: 800 })).body;
  await tag({ tag: 'RFP-P-201/1.XS', name: 'Reactor feed pump 1', signalType: 'DI', kind: 'pump', signal: 'Run status', nodeId: 'p1', paramKey: 'running' });
  await tag({ tag: 'RFP-P-201/2.XS', name: 'Reactor feed pump 2', signalType: 'DI', kind: 'pump', signal: 'Run status', nodeId: 'p1', paramKey: 'running2' });
  await tag({ tag: 'RFP-P-201/1.XY', name: 'Reactor feed pump 1', signalType: 'DO', kind: 'pump', signal: 'Run command', nodeId: 'p1', paramKey: 'run_cmd' });
  const bind = (b) => admin.post(`/api/v1/projects/${projectId}/flowsheets/${flowsheetId}/plc-bindings`).send({ connectionId, ...b });
  await bind({ nodeId: 'ft', paramKey: 'measured', address: 'const:650' });
  await bind({ nodeId: 'p1', paramKey: 'running', address: 'const:1' });
  await backfillBindingTags();
  await query(`UPDATE plc_bindings SET last_value = 650, quality = 'good', last_read_at = NOW() WHERE flowsheet_id = $1 AND param_key = 'measured'`, [flowsheetId]);
  await query(`INSERT INTO tag_samples (tag_id, ts, value, quality) VALUES ($1, NOW() - INTERVAL '10 minutes', 640, 'good'), ($1, NOW() - INTERVAL '5 minutes', 660, 'good')`, [ftTag.id]);
});

afterAll(() => { webhook.setFetch(null); });

describe('API keys', () => {
  test('an admin mints a key shown once; scopes gate what it may read', async () => {
    expect((await engineer.post('/api/v1/integrations/api-keys').send({ name: 'x', scopes: ['assets:read'] })).status).toBe(403);
    const r = await admin.post('/api/v1/integrations/api-keys').send({ name: 'CMMS reader', scopes: ['assets:read', 'history:read', 'counters:read', 'events:read'], expiresInDays: 30 });
    expect(r.status).toBe(201);
    expect(r.body.key).toMatch(/^wsk_[A-Za-z0-9]{8}_[a-f0-9]{48}$/);
    expect(r.body.shownOnce).toBe(true);
    readKey = r.body.key;
    const w = await admin.post('/api/v1/integrations/api-keys').send({ name: 'CMMS writer', scopes: ['workorders:write'] });
    writeKey = w.body.key;
    const list = await admin.get('/api/v1/integrations/api-keys');
    expect(list.body.keys.map((k) => k.name).sort()).toEqual(['CMMS reader', 'CMMS writer']);
    expect(JSON.stringify(list.body)).not.toContain(readKey);
    expect((await admin.post('/api/v1/integrations/api-keys').send({ name: 'bad', scopes: ['everything'] })).status).toBe(422);

    expect((await withKey('wsk_nope1234_' + 'a'.repeat(48))('/api/v1/assets')).status).toBe(401);
    expect((await withKey(writeKey)('/api/v1/assets')).status).toBe(403);
    expect((await request(app).get('/api/v1/assets')).status).toBe(401);
  });
});

describe('asset read API', () => {
  test('lists loops as assets with sub-assets and WaterSim ids; an admin may read it too', async () => {
    const r = await withKey(readKey)('/api/v1/assets?area=RFP');
    expect(r.status).toBe(200);
    expect(r.body.apiVersion).toBe('v1');
    const pump = r.body.assets.find((a) => a.assetCode === 'RFP-P-201');
    expect(pump).toEqual(expect.objectContaining({ kind: 'pump', units: 2, subAssets: ['RFP-P-201/1', 'RFP-P-201/2'], points: 3, boundPoints: 1 }));
    expect(pump.watersim.flowsheetId).toBe(flowsheetId);
    expect(r.body.assets.find((a) => a.assetCode === 'RFP-FT-201').analogPoints).toBe(1);
    expect((await admin.get('/api/v1/assets')).status).toBe(200);
    expect((await engineer.get('/api/v1/assets')).status).toBe(403);
    expect((await other.get('/api/v1/assets')).body.assets).toEqual([]);
  });

  test('one asset: points with live state; a unit narrows to its own points', async () => {
    const r = await withKey(readKey)('/api/v1/assets/RFP-P-201');
    expect(r.status).toBe(200);
    expect(r.body.points.map((p) => p.tag).sort()).toEqual(['RFP-P-201/1.XS', 'RFP-P-201/1.XY', 'RFP-P-201/2.XS']);
    const u = await withKey(readKey)(`/api/v1/assets/${encodeURIComponent('RFP-P-201/1')}`);
    expect(u.body.subAsset).toBe('RFP-P-201/1');
    expect(u.body.points).toHaveLength(2);
    expect((await withKey(readKey)('/api/v1/assets/nonsense')).status).toBe(422);
    expect((await withKey(readKey)('/api/v1/assets/ZZZ-P-999')).status).toBe(404);
  });

  test('history, counters and events on an asset', async () => {
    const h = await withKey(readKey)('/api/v1/assets/RFP-FT-201/history?range=1h&bucket=raw');
    expect(h.status).toBe(200);
    expect(h.body.series[0].tag).toBe('RFP-FT-201.FT');
    expect(h.body.series[0].points.length).toBe(2);
    const c = await withKey(readKey)('/api/v1/assets/RFP-P-201/counters?days=7');
    expect(c.status).toBe(200);
    expect(c.body.drives).toEqual([]);

    const rule = await admin.post(`/api/v1/projects/${projectId}/flowsheets/${flowsheetId}/alarms`).send({ name: 'Flow high', targetType: 'param', nodeId: 'ft', paramKey: 'measured', maxValue: 600, severity: 'critical' });
    await query(`INSERT INTO alarm_events (organisation_id, rule_id, flowsheet_id, source, state, severity, message, value, limit_max) VALUES ($1,$2,$3,'plc','active','critical','FT-201 high',650,600)`, [orgId, rule.body.id, flowsheetId]);
    const e = await withKey(readKey)('/api/v1/assets/RFP-FT-201/events');
    expect(e.status).toBe(200);
    expect(e.body.events[0]).toEqual(expect.objectContaining({ rule: 'Flow high', severity: 'critical' }));
    expect((await withKey(writeKey)('/api/v1/assets/RFP-FT-201/events')).status).toBe(403);
  });
});

describe('inbound work-order status', () => {
  let taskId;
  test('links a work order to a task, then drives it to closure by the system actor', async () => {
    const t = await admin.post('/api/v1/tasks').send({ title: 'Replace pump seal (CMMS)', priority: 'high', autoAssign: false });
    taskId = t.body.id;
    expect(t.body.state).toBe('open');
    expect((await postKey(readKey, '/api/v1/cmms/work-orders/WO-CMMS-7/status', { status: 'in_progress' })).status).toBe(403);
    expect((await postKey(writeKey, '/api/v1/cmms/work-orders/WO-CMMS-7/status', { status: 'in_progress' })).status).toBe(404);

    let r = await postKey(writeKey, '/api/v1/cmms/work-orders/WO-CMMS-7/status', { status: 'in_progress', taskId });
    expect(r.status).toBe(200);
    expect(r.body.state).toBe('in_progress');
    expect(r.body.externalRef).toBe('WO-CMMS-7');
    expect(r.body.externalSystem).toBe('cmms');

    r = await postKey(writeKey, '/api/v1/cmms/work-orders/WO-CMMS-7/status', { status: 'completed', note: 'Seal replaced' });
    expect(r.body.state).toBe('completed');
    // Idempotent: the same status again is answered, not refused.
    expect((await postKey(writeKey, '/api/v1/cmms/work-orders/WO-CMMS-7/status', { status: 'completed' })).status).toBe(200);
    r = await postKey(writeKey, '/api/v1/cmms/work-orders/WO-CMMS-7/status', { status: 'closed' });
    expect(r.body.state).toBe('approved');
    expect(r.body.closedAt).toBeTruthy();

    const tr = await query(`SELECT action, actor_source FROM task_transitions WHERE task_id = $1 ORDER BY created_at`, [taskId]);
    expect(tr.rows.map((x) => `${x.action}:${x.actor_source}`)).toEqual(['create:user', 'start:cmms', 'complete:cmms', 'approve:cmms']);
    const audit = await query(`SELECT details FROM audit_logs WHERE resource_id = $1 AND action = 'task.approve'`, [taskId]);
    expect(audit.rows[0].details.source).toBe('cmms');
    expect((await postKey(writeKey, '/api/v1/cmms/work-orders/WO-CMMS-8/status', { status: 'closed', taskId })).status).toBe(409); // another id on the same task
  });

  test('the asset events list carries the linked task', async () => {
    const t = await admin.post('/api/v1/tasks').send({ title: 'Grease bearings', tagId: ftTag.id, autoAssign: false });
    const e = await withKey(readKey)('/api/v1/assets/RFP-FT-201/events');
    expect(e.body.tasks.map((x) => x.id)).toContain(t.body.id);
  });
});

describe('webhooks', () => {
  let hook, secret;
  const calls = [];

  test('an admin registers an endpoint (secret shown once); loopback is refused', async () => {
    expect((await admin.post('/api/v1/integrations/webhooks').send({ name: 'local', url: 'http://localhost:9999/hook' })).status).toBe(422);
    expect((await admin.post('/api/v1/integrations/webhooks').send({ name: 'ftp', url: 'ftp://cmms.example.com/hook' })).status).toBe(422);
    const r = await admin.post('/api/v1/integrations/webhooks').send({ name: 'CMMS', url: 'https://cmms.example.com/api/v1/integrations/watersim/webhook', eventTypes: ['task.', 'alarm.raised', 'equipment.counters.daily'] });
    expect(r.status).toBe(201);
    expect(r.body.secret).toMatch(/^[a-f0-9]{48}$/);
    hook = r.body; secret = r.body.secret;
    const list = await admin.get('/api/v1/integrations/webhooks');
    expect(list.body.webhooks[0].secretPreview).toMatch(/…$/);
    expect(JSON.stringify(list.body)).not.toContain(secret);
  });

  test('an event is queued to the matching endpoint and delivered with a valid signature', async () => {
    webhook.setFetch(async (url, opts) => { calls.push({ url, opts }); return { ok: true, status: 200, json: async () => ({}) }; });
    const t = await admin.post('/api/v1/tasks').send({ title: 'Webhook task', autoAssign: false });
    await new Promise((r) => setTimeout(r, 150));
    const rows = await query(`SELECT * FROM notification_outbox WHERE organisation_id = $1 AND channel = 'webhook' AND event_type = 'task.created'`, [orgId]);
    expect(rows.rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.rows[0].endpoint_id).toBe(hook.id);
    const doc = JSON.parse(rows.rows[0].body);
    expect(doc.event).toBe('task.created');
    expect(doc.data.task.id).toBe(t.body.id);

    // An alarm.cleared is not subscribed → nothing queued.
    await emit('alarm.cleared', { orgId, severity: 'warning', payload: { alarm: { message: 'x' } }, dedupeKey: `wh-clear|${Date.now()}` });
    expect((await query(`SELECT COUNT(*)::int AS n FROM notification_outbox WHERE organisation_id = $1 AND channel = 'webhook' AND event_type = 'alarm.cleared'`, [orgId])).rows[0].n).toBe(0);

    const out = await worker.drain({ limit: 100 });
    expect(out.sent).toBeGreaterThanOrEqual(1);
    const call = calls.find((c) => JSON.parse(c.opts.body).event === 'task.created');
    expect(call.url).toBe(hook.url);
    const ts = call.opts.headers['X-WaterSim-Timestamp'];
    const expected = `sha256=${crypto.createHmac('sha256', secret).update(`${ts}.${call.opts.body}`).digest('hex')}`;
    expect(call.opts.headers['X-WaterSim-Signature']).toBe(expected);
    expect(call.opts.headers['X-WaterSim-Event']).toBe('task.created');
    const ep = (await query('SELECT last_status, failures FROM webhook_endpoints WHERE id = $1', [hook.id])).rows[0];
    expect(ep.last_status).toBe(200);
    expect(ep.failures).toBe(0);
  });

  test('a receiver that rejects the document dead-letters; a test delivery reports its state', async () => {
    webhook.setFetch(async () => ({ ok: false, status: 400, json: async () => ({}) }));
    const r = await admin.post(`/api/v1/integrations/webhooks/${hook.id}/test`);
    expect(r.status).toBe(200);
    expect(r.body.delivery.state).toBe('dead');
    expect(r.body.delivery.last_error).toMatch(/HTTP 400/);
    const d = await admin.get('/api/v1/integrations/deliveries');
    expect(d.body.deliveries.some((x) => x.state === 'dead' && x.endpointId === hook.id)).toBe(true);

    webhook.setFetch(async () => { throw new Error('ECONNRESET'); });
    const r2 = await admin.post(`/api/v1/integrations/webhooks/${hook.id}/test`);
    expect(r2.body.delivery.state).toBe('failed'); // network: will retry
    expect((await admin.get('/api/v1/integrations/webhooks')).body.webhooks[0].failures).toBeGreaterThanOrEqual(1);
  });

  test('rotate and delete', async () => {
    const rot = await admin.post(`/api/v1/integrations/webhooks/${hook.id}/rotate`);
    expect(rot.body.secret).not.toBe(secret);
    expect((await admin.delete(`/api/v1/integrations/webhooks/${hook.id}`)).status).toBe(200);
    expect((await admin.delete(`/api/v1/integrations/api-keys/${(await admin.get('/api/v1/integrations/api-keys')).body.keys[0].id}`)).status).toBe(200);
  });
});
