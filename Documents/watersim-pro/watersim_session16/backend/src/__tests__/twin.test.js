/**
 * Digital twin (Phase 4).
 *
 * Real database, real solver (worker pool). What is pinned: the twin merges
 * measured points into the model and reports each instrument's residual; the
 * running spread turns a wild reading into a z past the drift rule's limit
 * and the ordinary alarm state machine raises it; what-if scenarios start
 * from the twin's state and are never persisted; shadow mode routes writes to
 * the simulator and reflects a command onto its status contacts, and leaving
 * it is a manager's act; commissioning scripts refuse a live PLC and play
 * against a shadow one; equipment counters come out of XS/XA transitions.
 */
'use strict';

const { createTestUser, loginAs, makeProject, makeFlowsheet } = require('./helpers');
const { query } = require('../db/pool');
const { backfillBindingTags } = require('../historian');
const twin = require('../twin');
const { runCounters } = require('../twin/counters');
const simulator = require('../plc/drivers/simulator');
const { tick } = require('../plc/poller');

const PW = 'TwinPass123!';
const CANVAS = {
  nodes: [
    { id: 'n_in',  type: 'unitOp', data: { opType: 'inlet',      label: 'Inlet',   params: {} } },
    { id: 'p1',    type: 'unitOp', data: { opType: 'pump',       label: 'P-201',   params: {} } },
    { id: 'v1',    type: 'unitOp', data: { opType: 'valve',      label: 'XV-201',  params: {} } },
    { id: 'ft',    type: 'unitOp', data: { opType: 'instrument', label: 'FT-201',  params: { measurement: 'flow' } } },
    { id: 'n_out', type: 'unitOp', data: { opType: 'outlet',     label: 'Outlet',  params: {} } },
  ],
  edges: [
    { id: 'e1', source: 'n_in', target: 'p1',    data: { streamType: 'stream' } },
    { id: 'e2', source: 'p1',   target: 'v1',    data: { streamType: 'stream' } },
    { id: 'e3', source: 'v1',   target: 'ft',    data: { streamType: 'stream' } },
    { id: 'e4', source: 'ft',   target: 'n_out', data: { streamType: 'stream' } },
  ],
};

let admin, engineer, viewer, projectId, flowsheetId, orgId, connectionId;
let ftBinding, cmdBinding, xsTag, xaTag;
const base = () => `/api/v1/projects/${projectId}/flowsheets/${flowsheetId}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function tag(body) {
  const r = await admin.post('/api/v1/tags').send({ flowsheetId, ...body });
  if (r.status !== 201) throw new Error(`tag ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body;
}
async function bind(body) {
  const r = await admin.post(`${base()}/plc-bindings`).send({ connectionId, ...body });
  if (r.status !== 201) throw new Error(`bind ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body;
}
const setMeasured = (v) => query(`UPDATE plc_bindings SET last_value = $1, quality = 'good', last_read_at = NOW() WHERE id = $2`, [v, ftBinding.id]);

beforeAll(async () => {
  const a = await createTestUser('twin.admin@test.example', PW, 'admin');
  admin = await loginAs(a);
  const project = await makeProject(admin, 'Twin Project');
  projectId = project.id;
  orgId = (await query('SELECT organisation_id FROM projects WHERE id = $1', [projectId])).rows[0].organisation_id;
  const fs = await makeFlowsheet(admin, projectId, 'Twin FS');
  flowsheetId = fs.id;
  expect((await admin.patch(base()).send({ canvasData: CANVAS })).status).toBe(200);

  const mk = async (role) => {
    const email = `twin.${role}.${Date.now()}@test.example`;
    expect((await admin.post('/api/v1/admin/members').send({ email, firstName: 'T', lastName: role, role, password: PW })).status).toBe(201);
    return loginAs({ email, password: PW, orgSlug: a.orgSlug });
  };
  engineer = await mk('engineer');
  viewer = await mk('viewer');

  connectionId = (await admin.post('/api/v1/plc/connections').send({ name: 'Twin Sim', protocol: 'simulator', config: {} })).body.id;

  await tag({ tag: 'RFP-FT-201.FT', name: 'Reactor feed flow', signalType: 'AI', kind: 'flow_meter', signal: 'Flow', nodeId: 'ft', paramKey: 'measured', engUnit: 'm3/d', rangeMin: 0, rangeMax: 800 });
  xsTag = await tag({ tag: 'RFP-P-201/1.XS', name: 'Reactor feed pump 1', signalType: 'DI', kind: 'pump', signal: 'Run status', nodeId: 'p1', paramKey: 'running' });
  xaTag = await tag({ tag: 'RFP-P-201/1.XA', name: 'Reactor feed pump 1', signalType: 'DI', kind: 'pump', signal: 'Trip', nodeId: 'p1', paramKey: 'tripped' });
  await tag({ tag: 'RFP-P-201/1.XY', name: 'Reactor feed pump 1', signalType: 'DO', kind: 'pump', signal: 'Run command', nodeId: 'p1', paramKey: 'run_cmd' });
  await tag({ tag: 'RFP-XV-201/1.ZSO', name: 'Feed valve', signalType: 'DI', kind: 'butterfly_valve', signal: 'Open limit', nodeId: 'v1', paramKey: 'opened' });
  await tag({ tag: 'RFP-XV-201/1.XY', name: 'Feed valve', signalType: 'DO', kind: 'butterfly_valve', signal: 'Open command', nodeId: 'v1', paramKey: 'run_cmd' });

  ftBinding = await bind({ nodeId: 'ft', paramKey: 'measured', address: 'const:650' });
  await bind({ nodeId: 'p1', paramKey: 'running', address: 'mem:p1.run' });
  cmdBinding = await bind({ nodeId: 'p1', paramKey: 'run_cmd', address: 'mem:p1.run', direction: 'write' });
  await bind({ nodeId: 'v1', paramKey: 'opened', address: 'mem:v1.open' });
  await bind({ nodeId: 'v1', paramKey: 'run_cmd', address: 'mem:v1.cmd', direction: 'write' });
  await backfillBindingTags();
  await setMeasured(650);
});

describe('configuration', () => {
  test('an engineer enables the twin; a viewer cannot', async () => {
    expect((await viewer.put(`/api/v1/twin/${flowsheetId}`).send({ enabled: true })).status).toBe(403);
    const r = await engineer.put(`/api/v1/twin/${flowsheetId}`).send({ enabled: true, cadenceS: 30, driftZ: 3 });
    expect(r.status).toBe(200);
    expect(r.body).toEqual(expect.objectContaining({ enabled: true, cadenceS: 30, driftZ: 3 }));
    const list = await viewer.get('/api/v1/twin');
    expect(list.status).toBe(200);
    const mine = list.body.twins.find((t) => t.flowsheetId === flowsheetId);
    expect(mine.config.enabled).toBe(true);
    expect(mine.boundPoints).toBe(5);
    expect(list.body.connections[0].mode).toBe('live');
  });
});

describe('solve and residuals', () => {
  test('the twin merges the measured flow and reports the residual against the model', async () => {
    const r = await engineer.post(`/api/v1/twin/${flowsheetId}/solve`);
    expect(r.status).toBe(200);
    expect(r.body.error).toBeNull();
    expect(r.body.nodeParams.ft.measured).toBe(650);
    expect(r.body.residuals).toHaveLength(1);
    const res = r.body.residuals[0];
    expect(res.tag).toBe('RFP-FT-201.FT');
    expect(res.measured).toBe(650);
    expect(Number.isFinite(res.modelled)).toBe(true);
    expect(res.residual).toBeCloseTo(650 - res.modelled, 6);
    expect(res.z).toBe(0); // too little history for a spread
    expect(r.body.nodeMetrics.ft.metrics.source).toBe('measured');
    expect(r.body.nodeMetrics.ft.metrics.reading).toBe(650);

    const d = await viewer.get(`/api/v1/twin/${flowsheetId}`);
    expect(d.body.state.seq).toBe(1);
    expect(d.body.residualStats[0].n).toBe(1);
  });

  test('a wild reading becomes a z past the drift rule and raises through the alarm machine', async () => {
    const rule = await engineer.post(`${base()}/alarms`).send({ name: 'FT-201 drift', targetType: 'param', nodeId: 'ft', paramKey: 'measured', kind: 'drift', maxValue: 3, severity: 'warning', createTask: false });
    expect(rule.status).toBe(201);
    expect(rule.body.kind).toBe('drift');
    expect((await engineer.post(`${base()}/alarms`).send({ name: 'bad drift', targetType: 'effluent', paramKey: 'TSS', kind: 'drift', maxValue: 3 })).status).toBe(422);

    for (const v of [655, 645, 652, 648, 651, 649]) { await setMeasured(v); await twin.solveTwin(flowsheetId); }
    let ev = await query(`SELECT * FROM alarm_events WHERE rule_id = $1 AND state = 'active'`, [rule.body.id]);
    expect(ev.rows).toHaveLength(0);

    await setMeasured(900);
    const s = await twin.solveTwin(flowsheetId);
    expect(Math.abs(s.residuals[0].z)).toBeGreaterThan(3);
    ev = await query(`SELECT * FROM alarm_events WHERE rule_id = $1 AND state = 'active'`, [rule.body.id]);
    expect(ev.rows).toHaveLength(1);
    expect(ev.rows[0].message).toMatch(/model and plant disagree/);
    expect(ev.rows[0].source).toBe('simulation');

    // Back to normal readings: the spread has widened, so the next ordinary
    // reading sits inside it and the drift clears.
    for (const v of [650, 651]) { await setMeasured(v); await twin.solveTwin(flowsheetId); }
    ev = await query(`SELECT state FROM alarm_events WHERE rule_id = $1`, [rule.body.id]);
    expect(ev.rows[0].state).toBe('cleared');

    const series = await viewer.get(`/api/v1/twin/${flowsheetId}/residuals?range=1h`);
    expect(series.status).toBe(200);
    expect(series.body.series[0].points.length).toBeGreaterThanOrEqual(9);
    expect(series.body.columns).toEqual(['ts', 'modelled', 'measured', 'residual', 'z']);

    const list = await viewer.get('/api/v1/twin');
    expect(list.body.twins.find((t) => t.flowsheetId === flowsheetId).state.seq).toBeGreaterThanOrEqual(9);
  });

  test('the loop solves only twins that are due', async () => {
    // Other enabled twins in this database (the seeded plant) may be due on
    // the first pass; ours was just solved, so it joins only once its 30 s
    // cadence has passed.
    const first = await twin.tick(Date.now());
    const second = await twin.tick(Date.now() + 60_000);
    expect(second).toBe(first + 1);
  });

  test('a value evaluation never touches a drift rule', async () => {
    const { evaluateForRun } = require('../alarms/evaluator');
    await evaluateForRun(flowsheetId, orgId, { unitResults: {}, summary: {} }, { nodeParams: { ft: { measured: 5 } } }, null);
    const rows = await query(`SELECT COUNT(*)::int AS n FROM alarm_events e JOIN alarm_rules r ON r.id = e.rule_id WHERE r.kind = 'drift' AND r.flowsheet_id = $1`, [flowsheetId]);
    expect(rows.rows[0].n).toBe(1); // still the one event from before, untouched
  });
});

describe('what-if from the live state', () => {
  test('scenarios start from the twin and are never persisted', async () => {
    const before = (await query('SELECT COUNT(*)::int AS n FROM simulation_runs WHERE flowsheet_id = $1', [flowsheetId])).rows[0].n;
    const r = await viewer.post(`/api/v1/twin/${flowsheetId}/scenarios`).send({ scenarios: [{ name: 'More flow', nodeParams: { ft: { measured: 720 } } }] });
    expect(r.status).toBe(403); // scenario.run is operator+
    const ok = await engineer.post(`/api/v1/twin/${flowsheetId}/scenarios`).send({ scenarios: [{ name: 'More flow', nodeParams: { ft: { measured: 720 } } }] });
    expect(ok.status).toBe(200);
    expect(ok.body.baseline.name).toBe('Live (twin)');
    expect(ok.body.scenarios[0]).toEqual(expect.objectContaining({ name: 'More flow', ok: true }));
    expect(ok.body.scenarios[0].delta).toBeTruthy();
    expect(ok.body.persisted).toBe(false);
    const after = (await query('SELECT COUNT(*)::int AS n FROM simulation_runs WHERE flowsheet_id = $1', [flowsheetId])).rows[0].n;
    expect(after).toBe(before);
  });
});

describe('shadow mode', () => {
  test('entering is an engineer’s act, leaving a manager’s', async () => {
    expect((await viewer.put(`/api/v1/twin/connections/${connectionId}/mode`).send({ mode: 'shadow' })).status).toBe(403);
    const r = await engineer.put(`/api/v1/twin/connections/${connectionId}/mode`).send({ mode: 'shadow' });
    expect(r.status).toBe(200);
    expect(r.body.mode).toBe('shadow');
    const back = await engineer.put(`/api/v1/twin/connections/${connectionId}/mode`).send({ mode: 'live' });
    expect(back.status).toBe(403);
    expect(back.body.error).toMatch(/task\.approve/);
  });

  test('a write in shadow lands in the simulator and the status contacts respond', async () => {
    const w = await engineer.post(`${base()}/plc-bindings/${cmdBinding.id}/write`).send({ value: 1 });
    expect(w.status).toBe(200);
    expect(w.body.shadow).toBe(true);
    expect(w.body.reflected.map((x) => x.fn)).toEqual(['XS']);
    expect(simulator._memory.get(`${connectionId}::p1.run`)).toBe(1);

    // The valve: command and switch on different registers — the reflector bridges them.
    const vcmd = (await query(`SELECT id FROM plc_bindings WHERE flowsheet_id = $1 AND node_id = 'v1' AND param_key = 'run_cmd'`, [flowsheetId])).rows[0];
    const wv = await engineer.post(`${base()}/plc-bindings/${vcmd.id}/write`).send({ value: 1 });
    expect(wv.body.reflected.map((x) => x.fn)).toEqual(['ZSO']);
    expect(simulator._memory.get(`${connectionId}::v1.open`)).toBe(1);

    // The poller reads the shadow namespace: the pump now reads as running.
    await query(`UPDATE plc_bindings SET last_read_at = NULL WHERE connection_id = $1`, [connectionId]);
    await tick();
    const xs = await query(`SELECT last_value, quality FROM plc_bindings WHERE flowsheet_id = $1 AND param_key = 'running'`, [flowsheetId]);
    expect(xs.rows[0].last_value).toBe(1);
    expect(xs.rows[0].quality).toBe('good');
    const audit = await query(`SELECT details FROM audit_logs WHERE resource_id = $1 AND action = 'plc_binding.write' ORDER BY created_at DESC LIMIT 1`, [cmdBinding.id]);
    expect(audit.rows[0].details.shadow).toBe(true);
  });

  test('a commissioning script plays against the shadow plant and refuses a live one', async () => {
    const list = await viewer.get('/api/v1/twin/scripts');
    expect(list.status).toBe(200);
    const reactor = list.body.scripts.find((s) => s.id === 'reactor');
    expect(reactor.actionableSteps).toBeGreaterThan(3);

    expect((await viewer.post(`/api/v1/twin/${flowsheetId}/scripts/reactor/run`).send({})).status).toBe(403);
    const run = await engineer.post(`/api/v1/twin/${flowsheetId}/scripts/reactor/run`).send({ speedup: 100000 });
    expect(run.status).toBe(202);
    expect(run.body.status).toBe('running');
    await sleep(2500);
    const runs = await viewer.get(`/api/v1/twin/${flowsheetId}/scripts/runs`);
    const mine = runs.body.runs.find((r) => r.runId === run.body.runId);
    expect(['running', 'completed']).toContain(mine.status);
    expect(mine.log.length).toBeGreaterThanOrEqual(2);
    const wrote = mine.log.flatMap((l) => l.written.map((w) => w.tag));
    expect(wrote).toContain('RFP-XV-201/1.XY');
    expect(wrote).toContain('RFP-P-201/1.XY');
    if (mine.status === 'running') engineer.post(`/api/v1/twin/${flowsheetId}/scripts/runs/${run.body.runId}/cancel`);

    // Leave shadow as the admin (manager+), then the script refuses.
    await sleep(300);
    const back = await admin.put(`/api/v1/twin/connections/${connectionId}/mode`).send({ mode: 'live' });
    expect(back.status).toBe(200);
    const refused = await engineer.post(`/api/v1/twin/${flowsheetId}/scripts/reactor/run`).send({});
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatch(/shadow mode/);
    const modeAudit = await query(`SELECT action FROM audit_logs WHERE resource_id = $1 AND action LIKE 'plc_connection.mode.%' ORDER BY created_at`, [connectionId]);
    expect(modeAudit.rows.map((r) => r.action)).toEqual(['plc_connection.mode.shadow', 'plc_connection.mode.live']);
  });
});

describe('equipment counters', () => {
  test('run hours, starts and trips from XS / XA transitions', async () => {
    const t0 = Date.parse('2026-09-06T10:00:00Z');
    const at = (min) => new Date(t0 + min * 60_000);
    // A pump polled every five minutes: off at 10:00, running 10:01–10:31,
    // off at 10:32, running again from 10:40 to 10:50. A gap wider than the
    // 15-minute cap would NOT count (that is a lost link), so the samples
    // here are dense enough to be believed.
    const xs = [[0, 0], [1, 1], [6, 1], [11, 1], [16, 1], [21, 1], [26, 1], [31, 1], [32, 0], [40, 1], [45, 1], [50, 1]];
    const xa = [[0, 0], [45, 1]];
    await query(`INSERT INTO tag_samples (tag_id, ts, value, quality) SELECT * FROM UNNEST($1::uuid[], $2::timestamptz[], $3::float8[], $4::text[])`, [
      [...xs.map(() => xsTag.id), ...xa.map(() => xaTag.id)],
      [...xs, ...xa].map(([m]) => at(m).toISOString()),
      [...xs, ...xa].map(([, v]) => v),
      [...xs, ...xa].map(() => 'good'),
    ]);
    await query(`UPDATE historian_jobs SET watermark = $1 WHERE name = 'counters'`, [new Date(t0 - 60_000)]);
    const out = await runCounters(t0 + 3600_000);
    expect(out.tags).toBeGreaterThanOrEqual(2);

    const r = await viewer.get('/api/v1/twin/counters?loopTag=RFP-P-201&days=30');
    expect(r.status).toBe(200);
    const drive = r.body.drives.find((d) => d.key === 'RFP-P-201/1');
    expect(drive).toBeTruthy();
    // running 10:01→10:32 (31 min) and 10:40→10:50 (10 min) = 41 min
    expect(drive.runHours).toBeCloseTo(41 / 60, 2);
    expect(drive.starts).toBe(2);
    expect(drive.trips).toBe(1);
    expect(drive.running).toBe(true);
  });
});
