/**
 * Alarm rule kinds (Phase 1 hardening) and the comms-loss sweep.
 *
 * What is pinned: HIGH-critical and LOW-warning coexist on one target; the
 * same kind twice is still 409; a kind that disagrees with its limits is 422;
 * a value evaluation never touches a quality rule; the sweep raises a
 * comms-loss event from a stale binding and clears it when the link is good
 * again; and one active event per rule survives a concurrent raise.
 */
'use strict';

const { createTestUser, loginAs, makeProject, makeFlowsheet } = require('./helpers');
const { query } = require('../db/pool');
const { sweep, judge } = require('../alarms/qualitySweep');
const { processEvaluation, evaluateForRun } = require('../alarms/evaluator');

const PW = 'Kinds12345!';

const CANVAS = {
  nodes: [
    { id: 'n_in',  type: 'unitOp', data: { opType: 'inlet',      label: 'Inlet',   params: {} } },
    { id: 'ft',    type: 'unitOp', data: { opType: 'instrument', label: 'FT-201',  params: { measurement: 'flow' } } },
    { id: 'n_out', type: 'unitOp', data: { opType: 'outlet',     label: 'Outlet',  params: {} } },
  ],
  edges: [
    { id: 'e1', source: 'n_in', target: 'ft',    data: { streamType: 'stream' } },
    { id: 'e2', source: 'ft',   target: 'n_out', data: { streamType: 'stream' } },
  ],
};

let agent, projectId, flowsheetId, organisationId, connectionId;
const base = () => `/api/v1/projects/${projectId}/flowsheets/${flowsheetId}`;

beforeAll(async () => {
  const admin = await createTestUser('kinds.admin@test.example', PW, 'admin');
  agent = await loginAs(admin);
  const project = await makeProject(agent, 'Kinds Project');
  projectId = project.id;
  organisationId = (await query('SELECT organisation_id FROM projects WHERE id = $1', [projectId])).rows[0].organisation_id;
  const fs = await makeFlowsheet(agent, projectId, 'Kinds FS');
  flowsheetId = fs.id;
  expect((await agent.patch(base()).send({ canvasData: CANVAS })).status).toBe(200);

  const conn = await agent.post('/api/v1/plc/connections').send({ name: 'Kinds Sim', protocol: 'simulator', config: {} });
  expect(conn.status).toBe(201);
  connectionId = conn.body.id || conn.body.data?.id;
});

const mkRule = (body) => agent.post(`${base()}/alarms`).send({ targetType: 'node_output', nodeId: 'ft', paramKey: 'TSS', severity: 'warning', ...body });

describe('one rule per limit', () => {
  test('a high-critical and a low-warning rule coexist on the same target', async () => {
    const hi = await mkRule({ name: 'TSS high', maxValue: 30, severity: 'critical' });
    expect(hi.status).toBe(201);
    expect(hi.body.kind).toBe('high');
    const lo = await mkRule({ name: 'TSS low', minValue: 2 });
    expect(lo.status).toBe(201);
    expect(lo.body.kind).toBe('low');
    const range = await mkRule({ name: 'TSS band', minValue: 5, maxValue: 25 });
    expect(range.status).toBe(201);
    expect(range.body.kind).toBe('range');
  });

  test('the same kind twice on one target is still refused', async () => {
    const dup = await mkRule({ name: 'TSS high again', maxValue: 40 });
    expect(dup.status).toBe(409);
    expect(dup.body.error).toMatch(/of this kind/);
  });

  test('a kind that disagrees with its limits is refused with the reason', async () => {
    const r = await mkRule({ name: 'bad', kind: 'high', minValue: 1, maxValue: 5, paramKey: 'BOD' });
    expect(r.status).toBe(422);
    expect(r.body.details[0].msg).toMatch(/maxValue only/);
    const q = await mkRule({ name: 'bad q', kind: 'quality', paramKey: 'BOD' });
    expect(q.status).toBe(422);
    expect(q.body.details[0].msg).toMatch(/staleAfterS/);
    const q2 = await mkRule({ name: 'bad q2', kind: 'quality', staleAfterS: 30, paramKey: 'BOD' });
    expect(q2.status).toBe(422);
    expect(q2.body.details[0].msg).toMatch(/targetType param/);
  });

  test('PATCH re-settles the kind from the merged limits', async () => {
    const r = await mkRule({ name: 'NH4 high', paramKey: 'NH4', maxValue: 5 });
    expect(r.body.kind).toBe('high');
    const p = await agent.patch(`${base()}/alarms/${r.body.id}`).send({ minValue: 1 });
    expect(p.status).toBe(200);
    expect(p.body.kind).toBe('range');
    const p2 = await agent.patch(`${base()}/alarms/${r.body.id}`).send({ maxValue: null });
    expect(p2.status).toBe(200);
    expect(p2.body.kind).toBe('low');
    // A rename alone keeps the kind.
    const p3 = await agent.patch(`${base()}/alarms/${r.body.id}`).send({ name: 'NH4 low' });
    expect(p3.body.kind).toBe('low');
  });
});

describe('comms-loss (quality) rules', () => {
  let ruleId, bindingId;

  test('creates against a bound instrument parameter', async () => {
    const b = await agent.post(`${base()}/plc-bindings`).send({ nodeId: 'ft', paramKey: 'measured', connectionId, address: 'const:5' });
    expect(b.status).toBe(201);
    bindingId = b.body.id || b.body.data?.id;

    const r = await agent.post(`${base()}/alarms`).send({
      name: 'FT-201 comms loss', targetType: 'param', nodeId: 'ft', paramKey: 'measured',
      kind: 'quality', staleAfterS: 30, severity: 'critical',
    });
    expect(r.status).toBe(201);
    expect(r.body.kind).toBe('quality');
    expect(r.body.stale_after_s).toBe(30);
    expect(r.body.min_value).toBeNull();
    ruleId = r.body.id;
  });

  test('judge(): not good, never read, or older than the limit is a breach', () => {
    const rule = { stale_after_s: 30 };
    const now = Date.now();
    expect(judge(rule, null, now).breached).toBe(false);
    expect(judge(rule, { enabled: false, quality: 'stale' }, now).breached).toBe(false);
    expect(judge(rule, { quality: 'good', last_read_at: new Date(now - 5000) }, now)).toEqual({ breached: false, staleS: 5 });
    expect(judge(rule, { quality: 'good', last_read_at: new Date(now - 45_000) }, now)).toEqual({ breached: true, staleS: 45 });
    expect(judge(rule, { quality: 'stale', last_read_at: new Date(now - 1000) }, now).breached).toBe(true);
    expect(judge(rule, { quality: 'good', last_read_at: null }, now)).toEqual({ breached: true, staleS: null });
  });

  test('the sweep raises on a stale binding and clears when it is good again', async () => {
    await query(`UPDATE plc_bindings SET quality = 'stale', last_read_at = NOW() - INTERVAL '90 seconds' WHERE id = $1`, [bindingId]);
    const first = await sweep();
    expect(first.breaches).toBeGreaterThanOrEqual(1);
    const ev = await query(`SELECT * FROM alarm_events WHERE rule_id = $1 AND state = 'active'`, [ruleId]);
    expect(ev.rows).toHaveLength(1);
    expect(ev.rows[0].message).toMatch(/comms lost/);
    expect(ev.rows[0].message).toMatch(/FT-201/);
    expect(ev.rows[0].value).toBeGreaterThanOrEqual(89);
    expect(ev.rows[0].source).toBe('plc');

    // Still stale: no second event.
    await sweep();
    expect((await query(`SELECT COUNT(*)::int AS n FROM alarm_events WHERE rule_id = $1`, [ruleId])).rows[0].n).toBe(1);

    // A value evaluation on the flowsheet must not clear it.
    await evaluateForRun(flowsheetId, organisationId, { unitResults: {}, summary: {} }, { nodeParams: { ft: { measured: 5 } } }, null);
    expect((await query(`SELECT state FROM alarm_events WHERE rule_id = $1`, [ruleId])).rows[0].state).toBe('active');

    await query(`UPDATE plc_bindings SET quality = 'good', last_read_at = NOW() WHERE id = $1`, [bindingId]);
    await sweep();
    const after = await query(`SELECT state, cleared_at FROM alarm_events WHERE rule_id = $1`, [ruleId]);
    expect(after.rows[0].state).toBe('cleared');
    expect(after.rows[0].cleared_at).toBeTruthy();
  });

  test('the org alarm list shows the comms-loss event', async () => {
    const r = await agent.get('/api/v1/alarms/events?limit=50');
    expect(r.status).toBe(200);
    const mine = (r.body.events || []).find((e) => e.ruleId === ruleId || e.rule_id === ruleId);
    expect(mine).toBeTruthy();
  });
});

describe('one active event per rule', () => {
  test('two concurrent raises produce one event', async () => {
    const r = await agent.post(`${base()}/alarms`).send({ name: 'BOD high', targetType: 'node_output', nodeId: 'ft', paramKey: 'BOD', maxValue: 10 });
    expect(r.status).toBe(201);
    const rule = (await query('SELECT * FROM alarm_rules WHERE id = $1', [r.body.id])).rows[0];
    await Promise.all([
      processEvaluation(flowsheetId, organisationId, [{ rule, value: 50 }], [rule.id], { source: 'simulation' }),
      processEvaluation(flowsheetId, organisationId, [{ rule, value: 60 }], [rule.id], { source: 'simulation' }),
    ]);
    const n = await query(`SELECT COUNT(*)::int AS n FROM alarm_events WHERE rule_id = $1 AND state = 'active'`, [rule.id]);
    expect(n.rows[0].n).toBe(1);
  });
});
