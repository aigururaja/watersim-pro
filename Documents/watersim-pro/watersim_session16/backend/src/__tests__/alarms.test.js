/**
 * Alarm system tests — valid targets, rule validation, the pure evaluator, the
 * event state machine, the simulation hooks and the org-wide API.
 *
 * Follows plc.test.js's supertest + real-DB patterns (createTestUser / loginAs
 * / makeProject / makeFlowsheet). The PDF test is gated on a real reportlab
 * probe and skips LOUDLY (never silently) when Python/reportlab is missing —
 * same shape as the gate in plcDrivers.test.js.
 */
'use strict';

const { spawnSync } = require('child_process');

const {
  request, app, createTestUser, loginAs, makeProject, makeFlowsheet,
} = require('./helpers');
const { query } = require('../db/pool');
const { PYTHON_BIN } = require('../reports/pySpawn');

const { listValidTargets, isValidTarget } = require('../alarms/validTargets');
const { evaluateRules, processEvaluation, invalidateRuleCache } = require('../alarms/evaluator');

// ── Fixtures ─────────────────────────────────────────────────────────────────

const CANVAS = {
  nodes: [
    { id: 'n_in',   type: 'unitOp', data: { opType: 'inlet',            label: 'Inlet',        params: {} } },
    { id: 'n_scr',  type: 'unitOp', data: { opType: 'screening',        label: 'Bar Screen',   params: {} } },
    { id: 'n_grit', type: 'unitOp', data: { opType: 'grit_removal',     label: 'Grit Chamber', params: {} } },
    { id: 'n_as',   type: 'unitOp', data: { opType: 'activated_sludge', label: 'Aeration',     params: {} } },
    { id: 'n_out',  type: 'unitOp', data: { opType: 'outlet',           label: 'Outlet',       params: {} } },
  ],
  edges: [
    { id: 'e1', source: 'n_in',   target: 'n_scr',  data: { streamType: 'stream' } },
    { id: 'e2', source: 'n_scr',  target: 'n_grit', data: { streamType: 'stream' } },
    { id: 'e3', source: 'n_grit', target: 'n_as',   data: { streamType: 'stream' } },
    { id: 'e4', source: 'n_as',   target: 'n_out',  data: { streamType: 'stream' } },
  ],
};

const PW = 'AlarmPass123!';

// ── reportlab availability gate (loud skip) ──────────────────────────────────

function reportlabAvailable() {
  try {
    const res = spawnSync(PYTHON_BIN, ['-c', 'import reportlab'], {
      timeout: 30000, windowsHide: true,
    });
    return !res.error && res.status === 0;
  } catch {
    return false;
  }
}

const REPORTLAB_OK = reportlabAvailable();
if (!REPORTLAB_OK) {
  console.warn(
    `\n[alarms.test] ⚠️  SKIPPING the alarm PDF test — reportlab is not importable via '${PYTHON_BIN}'.\n` +
    '[alarms.test]     GET /alarms/report/pdf was NOT exercised; install reportlab (or set PYTHON_BIN) to cover it.\n'
  );
}
const pdfTest = REPORTLAB_OK ? test : test.skip;

// ── Shared setup: one org, one project, three flowsheets, four roles ─────────

let adminAgent, engineerAgent, operatorAgent, viewerAgent;
let orgSlug, organisationId, projectId;
let fsRules, fsMachine, fsRun;

const base   = (fsId) => `/api/v1/projects/${projectId}/flowsheets/${fsId}`;
const uniq   = (p) => `${p}.${Date.now()}.${Math.floor(Math.random() * 1e6)}@test.example`;
const sleep  = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll `fn` until it returns something truthy, or give up (returns null). */
async function waitFor(fn, timeout = 10000, interval = 100) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) return null;
    await sleep(interval);
  }
}

/** Invite a member with `role` into the shared org and return an authed agent. */
async function addMember(role) {
  const email = uniq(`alarm.${role}`);
  const res = await adminAgent.post('/api/v1/admin/members')
    .send({ email, firstName: 'Test', lastName: role, role, password: PW });
  if (res.status !== 201) throw new Error(`invite ${role} failed (${res.status}): ${JSON.stringify(res.body)}`);
  return loginAs({ email, password: PW, orgSlug });
}

/** Create a flowsheet carrying CANVAS (POST always starts empty; PATCH loads it). */
async function makeCanvasFlowsheet(name) {
  const fs = await makeFlowsheet(adminAgent, projectId, name);
  const patched = await adminAgent.patch(`${base(fs.id)}`).send({ canvasData: CANVAS });
  expect(patched.status).toBe(200);
  return fs;
}

beforeAll(async () => {
  const admin = await createTestUser('alarm.admin@test.example', PW, 'admin');
  adminAgent = await loginAs(admin);
  orgSlug = admin.orgSlug;

  [engineerAgent, operatorAgent, viewerAgent] = await Promise.all([
    addMember('engineer'), addMember('operator'), addMember('viewer'),
  ]);

  const project = await makeProject(adminAgent, 'Alarm Project');
  projectId = project.id;
  organisationId = (await query(
    'SELECT organisation_id FROM projects WHERE id = $1', [projectId]
  )).rows[0].organisation_id;

  fsRules   = await makeCanvasFlowsheet('Alarm Rules Flowsheet');
  fsMachine = await makeCanvasFlowsheet('Alarm State Machine Flowsheet');
  fsRun     = await makeCanvasFlowsheet('Alarm Run Flowsheet');
}, 60000);

// ── Valid targets ────────────────────────────────────────────────────────────

describe('Alarm targets derived from the canvas', () => {
  test('listValidTargets covers param, node_output and effluent — enums excluded', () => {
    const targets = listValidTargets(CANVAS);
    const has = (targetType, nodeId, paramKey) =>
      targets.some((t) => t.targetType === targetType && t.nodeId === nodeId && t.paramKey === paramKey);

    // 'param' — a numeric model parameter of a canvas node
    expect(has('param', 'n_grit', 'HRT_min')).toBe(true);
    expect(has('param', 'n_in',   'Q')).toBe(true);

    // 'node_output' — Stream quality leaving a node
    expect(has('node_output', 'n_as', 'TN')).toBe(true);
    expect(has('node_output', 'n_as', 'TSS')).toBe(true);

    // 'effluent' — plant discharge (node_id NULL)
    expect(has('effluent', null, 'TN')).toBe(true);
    expect(targets.filter((t) => t.targetType === 'effluent').every((t) => t.nodeId === null)).toBe(true);

    // String-enum settings are NOT thresholdable targets
    expect(has('param', 'n_grit', 'chamberType')).toBe(false);
    expect(has('param', 'n_scr',  'screenType')).toBe(false);
    expect(targets.some((t) => t.paramKey === 'chamberType' || t.paramKey === 'screenType')).toBe(false);

    // Every target carries a display label
    expect(targets.every((t) => typeof t.label === 'string' && t.label.length > 0)).toBe(true);
  });

  test('isValidTarget agrees with the listing (including the enum exclusions)', () => {
    expect(isValidTarget(CANVAS, { targetType: 'param',       nodeId: 'n_grit', paramKey: 'HRT_min' })).toBe(true);
    expect(isValidTarget(CANVAS, { targetType: 'node_output', nodeId: 'n_as',   paramKey: 'TN' })).toBe(true);
    expect(isValidTarget(CANVAS, { targetType: 'effluent',    nodeId: null,     paramKey: 'TN' })).toBe(true);

    expect(isValidTarget(CANVAS, { targetType: 'param',  nodeId: 'n_grit', paramKey: 'chamberType' })).toBe(false);
    expect(isValidTarget(CANVAS, { targetType: 'param',  nodeId: 'n9',     paramKey: 'HRT_min' })).toBe(false);
    expect(isValidTarget(CANVAS, { targetType: 'effluent', nodeId: null,   paramKey: 'nonsense' })).toBe(false);
  });

  test('GET /alarm-targets serves the same set (viewer+); other orgs get 404', async () => {
    const res = await viewerAgent.get(`${base(fsRules.id)}/alarm-targets`);
    expect(res.status).toBe(200);
    expect(res.body.length).toBe(listValidTargets(CANVAS).length);
    expect(res.body.some((t) => t.paramKey === 'chamberType')).toBe(false);

    const anon = await request(app).get(`${base(fsRules.id)}/alarm-targets`);
    expect(anon.status).toBe(401);

    const other = await loginAs(await createTestUser('alarm.otherorg@test.example', PW, 'engineer'));
    expect((await other.get(`${base(fsRules.id)}/alarm-targets`)).status).toBe(404);
  });
});

// ── Rule validation + RBAC ───────────────────────────────────────────────────

describe('POST /alarms — rule validation', () => {
  const post = (agent, body) => agent.post(`${base(fsRules.id)}/alarms`).send(body);

  const good = {
    name: 'Effluent TN high', targetType: 'effluent', nodeId: null,
    paramKey: 'TN', minValue: null, maxValue: 10, severity: 'critical', enabled: true,
  };

  test('422 when the node is not on this flowsheet', async () => {
    const res = await post(adminAgent, {
      ...good, name: 'Ghost node', targetType: 'param', nodeId: 'n9', paramKey: 'HRT_min',
    });
    expect(res.status).toBe(422);
    expect(JSON.stringify(res.body)).toMatch(/node 'n9' is not on this flowsheet/);
  });

  test('422 when the parameter is not numeric (string enum) or unknown', async () => {
    const enumRule = await post(adminAgent, {
      ...good, name: 'Enum param', targetType: 'param', nodeId: 'n_grit', paramKey: 'chamberType',
    });
    expect(enumRule.status).toBe(422);
    expect(JSON.stringify(enumRule.body)).toMatch(/'chamberType' is not a numeric parameter of a Grit Chamber/);

    const unknown = await post(adminAgent, {
      ...good, name: 'Unknown param', targetType: 'param', nodeId: 'n_grit', paramKey: 'notAParam',
    });
    expect(unknown.status).toBe(422);
    expect(JSON.stringify(unknown.body)).toMatch(/'notAParam' is not a numeric parameter/);

    const badField = await post(adminAgent, {
      ...good, name: 'Bad stream field', targetType: 'node_output', nodeId: 'n_as', paramKey: 'notAField',
    });
    expect(badField.status).toBe(422);
  });

  test('422 when both limits are missing, and when min >= max', async () => {
    const noLimits = await post(adminAgent, { ...good, name: 'No limits', minValue: null, maxValue: null });
    expect(noLimits.status).toBe(422);
    expect(JSON.stringify(noLimits.body)).toMatch(/At least one of minValue \/ maxValue/);

    const omitted = await post(adminAgent, {
      name: 'Omitted limits', targetType: 'effluent', paramKey: 'TP', severity: 'info',
    });
    expect(omitted.status).toBe(422);

    const inverted = await post(adminAgent, { ...good, name: 'Inverted', minValue: 20, maxValue: 5 });
    expect(inverted.status).toBe(422);
    expect(JSON.stringify(inverted.body)).toMatch(/minValue must be less than maxValue/);

    const equal = await post(adminAgent, { ...good, name: 'Equal', minValue: 5, maxValue: 5 });
    expect(equal.status).toBe(422);
  });

  test('422 on a malformed body (name, severity, non-numeric limit)', async () => {
    expect((await post(adminAgent, { ...good, name: '' })).status).toBe(422);
    expect((await post(adminAgent, { ...good, name: 'x'.repeat(121) })).status).toBe(422);
    expect((await post(adminAgent, { ...good, severity: 'apocalyptic' })).status).toBe(422);
    expect((await post(adminAgent, { ...good, maxValue: 'ten' })).status).toBe(422);
    expect((await post(adminAgent, { ...good, targetType: 'vibes' })).status).toBe(422);
  });

  test('201 for a good rule; viewer 403, engineer 201', async () => {
    const denied = await post(viewerAgent, { ...good, name: 'Viewer rule' });
    expect(denied.status).toBe(403);

    const created = await post(engineerAgent, good);
    expect(created.status).toBe(201);
    expect(created.body.target_type).toBe('effluent');
    expect(created.body.node_id).toBeNull();
    expect(created.body.severity).toBe('critical');
    expect(Number(created.body.max_value)).toBe(10);
    expect(created.body.enabled).toBe(true);

    // Duplicate target → 409, not a second row
    const dup = await post(engineerAgent, { ...good, name: 'Same target again' });
    expect(dup.status).toBe(409);

    // Visible through GET /alarms (viewer+)
    const list = await viewerAgent.get(`${base(fsRules.id)}/alarms`);
    expect(list.status).toBe(200);
    expect(list.body.some((r) => r.id === created.body.id)).toBe(true);
  });

  test('PATCH re-validates the target and the merged limits; DELETE removes it', async () => {
    const created = await engineerAgent.post(`${base(fsRules.id)}/alarms`).send({
      name: 'Grit HRT', targetType: 'param', nodeId: 'n_grit', paramKey: 'HRT_min', minValue: 2, maxValue: 8,
    });
    expect(created.status).toBe(201);
    const id = created.body.id;

    // Target moves to a node that isn't there → 422
    const ghost = await engineerAgent.patch(`${base(fsRules.id)}/alarms/${id}`).send({ nodeId: 'n9' });
    expect(ghost.status).toBe(422);
    expect(JSON.stringify(ghost.body)).toMatch(/node 'n9' is not on this flowsheet/);

    // Target moves to a string enum → 422
    const enumSwap = await engineerAgent.patch(`${base(fsRules.id)}/alarms/${id}`).send({ paramKey: 'chamberType' });
    expect(enumSwap.status).toBe(422);

    // Clearing BOTH limits by merge → 422 (min was 2, max 8; clear both)
    const cleared = await engineerAgent.patch(`${base(fsRules.id)}/alarms/${id}`)
      .send({ minValue: null, maxValue: null });
    expect(cleared.status).toBe(422);

    // Merged min (2) >= new max (1) → 422
    const inverted = await engineerAgent.patch(`${base(fsRules.id)}/alarms/${id}`).send({ maxValue: 1 });
    expect(inverted.status).toBe(422);

    // A legal partial update lands
    const ok = await engineerAgent.patch(`${base(fsRules.id)}/alarms/${id}`)
      .send({ name: 'Grit HRT (tuned)', maxValue: 12, severity: 'info', enabled: false });
    expect(ok.status).toBe(200);
    expect(ok.body.name).toBe('Grit HRT (tuned)');
    expect(Number(ok.body.max_value)).toBe(12);
    expect(Number(ok.body.min_value)).toBe(2);
    expect(ok.body.enabled).toBe(false);

    // RBAC + org scoping on mutations
    expect((await viewerAgent.patch(`${base(fsRules.id)}/alarms/${id}`).send({ name: 'nope' })).status).toBe(403);
    expect((await viewerAgent.delete(`${base(fsRules.id)}/alarms/${id}`)).status).toBe(403);

    const other = await loginAs(await createTestUser('alarm.deliso@test.example', PW, 'engineer'));
    expect((await other.delete(`${base(fsRules.id)}/alarms/${id}`)).status).toBe(404);

    const del = await engineerAgent.delete(`${base(fsRules.id)}/alarms/${id}`);
    expect(del.status).toBe(200);
    expect((await engineerAgent.delete(`${base(fsRules.id)}/alarms/${id}`)).status).toBe(404);
  });
});

// ── Pure evaluator ───────────────────────────────────────────────────────────

describe('evaluateRules (pure)', () => {
  const rule = (over = {}) => ({
    id: 'r1', name: 'r', severity: 'warning',
    target_type: 'effluent', node_id: null, param_key: 'TN',
    min_value: null, max_value: null, ...over,
  });

  test('max breach is reported with the offending value', () => {
    const r = rule({ max_value: 10 });
    const out = evaluateRules([r], { summary: { effluent: { TN: 52.1 } } });
    expect(out).toHaveLength(1);
    expect(out[0].value).toBe(52.1);
    expect(out[0].rule.id).toBe('r1');

    // At the limit is NOT a breach
    expect(evaluateRules([r], { summary: { effluent: { TN: 10 } } })).toHaveLength(0);
  });

  test('min breach is reported', () => {
    const r = rule({ min_value: 2, param_key: 'DO' });
    expect(evaluateRules([r], { summary: { effluent: { DO: 0.5 } } })).toHaveLength(1);
    expect(evaluateRules([r], { summary: { effluent: { DO: 4 } } })).toHaveLength(0);
  });

  test('non-finite / missing / non-numeric values are skipped silently', () => {
    const r = rule({ max_value: 10 });
    for (const TN of [NaN, Infinity, -Infinity, null, undefined, 'not a number', {}]) {
      expect(evaluateRules([r], { summary: { effluent: { TN } } })).toHaveLength(0);
    }
    expect(evaluateRules([r], {})).toHaveLength(0);
    expect(evaluateRules([r], null)).toHaveLength(0);
  });

  test('a rule whose node vanished from the canvas is skipped', () => {
    const gone = rule({ target_type: 'param', node_id: 'n_deleted', param_key: 'HRT_min', max_value: 1 });
    const ctx  = { nodeParams: { n_grit: { HRT_min: 99 } }, unitResults: { n_grit: {} } };
    expect(evaluateRules([gone], ctx)).toHaveLength(0);

    const outputGone = rule({ target_type: 'node_output', node_id: 'n_deleted', param_key: 'TN', max_value: 1 });
    expect(evaluateRules([outputGone], { unitResults: { n_as: { outputs: { effluent: { TN: 99 } } } } }))
      .toHaveLength(0);

    // …while the rule that still points at a live node does fire.
    const live = rule({ target_type: 'param', node_id: 'n_grit', param_key: 'HRT_min', max_value: 1 });
    expect(evaluateRules([live], ctx)).toHaveLength(1);
  });
});

// ── Event state machine ──────────────────────────────────────────────────────

describe('processEvaluation — event state machine', () => {
  let ruleRow;

  const eventsForRule = async () => (await query(
    `SELECT * FROM alarm_events WHERE rule_id = $1 ORDER BY triggered_at ASC, id ASC`,
    [ruleRow.id]
  )).rows;

  const run = (breaches) => processEvaluation(
    fsMachine.id, organisationId, breaches, [ruleRow.id],
    { source: 'simulation', runId: null, nodeLabels: {}, rulesById: { [ruleRow.id]: ruleRow } }
  );

  beforeAll(async () => {
    const res = await engineerAgent.post(`${base(fsMachine.id)}/alarms`).send({
      name: 'Machine TN', targetType: 'effluent', paramKey: 'TN', maxValue: 10, severity: 'warning',
    });
    expect(res.status).toBe(201);
    ruleRow = res.body;
  });

  test('first breach inserts exactly one active event', async () => {
    await run([{ rule: ruleRow, value: 52.1 }]);
    const events = await eventsForRule();
    expect(events).toHaveLength(1);
    expect(events[0].state).toBe('active');
    expect(events[0].severity).toBe('warning');
    expect(Number(events[0].value)).toBeCloseTo(52.1, 5);
    expect(Number(events[0].limit_max)).toBe(10);
    expect(events[0].message).toMatch(/Effluent TN 52\.1 exceeded max 10/);
    expect(events[0].cleared_at).toBeNull();
  });

  test('a repeat breach refreshes the same event instead of duplicating', async () => {
    await run([{ rule: ruleRow, value: 61 }]);
    const events = await eventsForRule();
    expect(events).toHaveLength(1);            // still one row
    expect(events[0].state).toBe('active');
    expect(Number(events[0].value)).toBe(61);  // refreshed
  });

  test('an evaluated-clean pass clears the active event', async () => {
    await run([]);                              // rule evaluated, no breach
    const events = await eventsForRule();
    expect(events).toHaveLength(1);
    expect(events[0].state).toBe('cleared');
    expect(events[0].cleared_at).toBeTruthy();
  });

  test('a later re-breach opens a NEW event', async () => {
    await run([{ rule: ruleRow, value: 77 }]);
    const events = await eventsForRule();
    expect(events).toHaveLength(2);
    expect(events[0].state).toBe('cleared');
    expect(events[1].state).toBe('active');
    expect(Number(events[1].value)).toBe(77);
    expect(events[1].id).not.toBe(events[0].id);
  });
});

// ── Simulation hooks ─────────────────────────────────────────────────────────

describe('Simulation hooks', () => {
  let ruleId;
  const simUrl = () => `${base(fsRun.id)}/simulate`;

  const runRowCount = async () => (await query(
    'SELECT COUNT(*)::int AS n FROM simulation_runs WHERE flowsheet_id = $1', [fsRun.id]
  )).rows[0].n;

  const eventCount = async () => (await query(
    'SELECT COUNT(*)::int AS n FROM alarm_events WHERE flowsheet_id = $1', [fsRun.id]
  )).rows[0].n;

  beforeAll(async () => {
    // Guaranteed to breach: municipal influent TN is 45 mg/L, nothing on this
    // train takes the effluent below 1 mg/L.
    const res = await engineerAgent.post(`${base(fsRun.id)}/alarms`).send({
      name: 'Effluent TN limit', targetType: 'effluent', paramKey: 'TN',
      maxValue: 1, severity: 'critical',
    });
    expect(res.status).toBe(201);
    ruleId = res.body.id;
    invalidateRuleCache(fsRun.id);
  });

  test('preview returns alarms[] and writes NOTHING', async () => {
    const runsBefore   = await runRowCount();
    const eventsBefore = await eventCount();

    const res = await adminAgent.post(simUrl()).send({ mode: 'steady_state', preview: true });
    expect(res.status).toBe(201);
    expect(res.body.run_id).toBeNull();
    expect(res.body.preview).toBe(true);

    expect(Array.isArray(res.body.alarms)).toBe(true);
    const breach = res.body.alarms.find((a) => a.ruleId === ruleId);
    expect(breach).toBeDefined();
    expect(breach.severity).toBe('critical');
    expect(breach.paramKey).toBe('TN');
    expect(breach.value).toBeGreaterThan(1);
    expect(breach.message).toMatch(/exceeded max 1/);

    // The existing response shape is untouched
    expect(res.body.results).toHaveProperty('summary');
    expect(res.body.quality).toBeDefined();

    // Give any (wrongly) scheduled background write time to land, then prove
    // nothing was persisted.
    await sleep(500);
    expect(await runRowCount()).toBe(runsBefore);
    expect(await eventCount()).toBe(eventsBefore);
  }, 30000);

  test('a non-preview run raises an alarm_event linked to that run', async () => {
    const res = await adminAgent.post(simUrl()).send({ mode: 'steady_state' });
    expect(res.status).toBe(201);
    expect(res.body.run_id).toBeTruthy();
    const runId = res.body.run_id;

    const event = await waitFor(async () => (await query(
      `SELECT * FROM alarm_events WHERE rule_id = $1 AND run_id = $2`, [ruleId, runId]
    )).rows[0]);

    expect(event).toBeTruthy();
    expect(event.state).toBe('active');
    expect(event.source).toBe('simulation');
    expect(event.severity).toBe('critical');
    expect(event.flowsheet_id).toBe(fsRun.id);
    expect(event.organisation_id).toBe(organisationId);
    expect(Number(event.value)).toBeGreaterThan(1);

    // Non-preview responses keep their original shape (no alarms key)
    expect(res.body.alarms).toBeUndefined();
  }, 45000);

  test('GET /alarm-events serves the flowsheet history with filters (viewer+)', async () => {
    const all = await viewerAgent.get(`${base(fsRun.id)}/alarm-events`);
    expect(all.status).toBe(200);
    expect(all.body.length).toBeGreaterThan(0);
    expect(all.body[0].rule_name).toBe('Effluent TN limit');

    const active = await viewerAgent.get(`${base(fsRun.id)}/alarm-events?state=active&limit=5`);
    expect(active.status).toBe(200);
    expect(active.body.every((e) => e.state === 'active')).toBe(true);
    expect(active.body.length).toBeLessThanOrEqual(5);

    const info = await viewerAgent.get(`${base(fsRun.id)}/alarm-events?severity=info`);
    expect(info.status).toBe(200);
    expect(info.body).toHaveLength(0);

    expect((await viewerAgent.get(`${base(fsRun.id)}/alarm-events?limit=500`)).status).toBe(422);
    expect((await viewerAgent.get(`${base(fsRun.id)}/alarm-events?state=melting`)).status).toBe(422);
  });
});

// ── Org-wide API ─────────────────────────────────────────────────────────────

describe('Org-wide alarm API', () => {
  let eventId;

  beforeAll(async () => {
    const row = await waitFor(async () => (await query(
      `SELECT id FROM alarm_events WHERE flowsheet_id = $1 ORDER BY triggered_at DESC LIMIT 1`,
      [fsRun.id]
    )).rows[0]);
    expect(row).toBeTruthy();
    eventId = row.id;
  }, 30000);

  test('GET /alarms/events returns { total, events } with joined names', async () => {
    const res = await viewerAgent.get('/api/v1/alarms/events');
    expect(res.status).toBe(200);
    expect(typeof res.body.total).toBe('number');
    expect(Array.isArray(res.body.events)).toBe(true);

    const ev = res.body.events.find((e) => e.id === eventId);
    expect(ev).toBeDefined();
    expect(ev.ruleName).toBe('Effluent TN limit');
    expect(ev.flowsheetName).toBe('Alarm Run Flowsheet');
    expect(ev.projectName).toBe('Alarm Project');
    expect(ev.severity).toBe('critical');

    // Newest first
    const times = res.body.events.map((e) => new Date(e.triggeredAt).getTime());
    expect([...times].sort((a, b) => b - a)).toEqual(times);
  });

  test('filters narrow the result set; bad filters are 422', async () => {
    const byFlowsheet = await viewerAgent.get(`/api/v1/alarms/events?flowsheetId=${fsRun.id}`);
    expect(byFlowsheet.status).toBe(200);
    expect(byFlowsheet.body.events.every((e) => e.flowsheetId === fsRun.id)).toBe(true);
    expect(byFlowsheet.body.events.some((e) => e.id === eventId)).toBe(true);

    const critical = await viewerAgent.get('/api/v1/alarms/events?severity=critical&state=active');
    expect(critical.status).toBe(200);
    expect(critical.body.events.every((e) => e.severity === 'critical' && e.state === 'active')).toBe(true);

    const infoOnly = await viewerAgent.get('/api/v1/alarms/events?severity=info');
    expect(infoOnly.body.events.some((e) => e.id === eventId)).toBe(false);

    const future = await viewerAgent.get('/api/v1/alarms/events?from=2999-01-01T00:00:00Z');
    expect(future.status).toBe(200);
    expect(future.body.total).toBe(0);

    const paged = await viewerAgent.get('/api/v1/alarms/events?limit=1&offset=0');
    expect(paged.status).toBe(200);
    expect(paged.body.events).toHaveLength(1);

    expect((await viewerAgent.get('/api/v1/alarms/events?limit=201')).status).toBe(422);
    expect((await viewerAgent.get('/api/v1/alarms/events?state=nope')).status).toBe(422);
    expect((await viewerAgent.get('/api/v1/alarms/events?from=yesterday')).status).toBe(422);
  });

  test('another org sees none of these events', async () => {
    const other = await loginAs(await createTestUser('alarm.orgiso@test.example', PW, 'engineer'));
    const res = await other.get('/api/v1/alarms/events');
    expect(res.status).toBe(200);
    expect(res.body.events.some((e) => e.id === eventId)).toBe(false);
  });

  test('POST /alarms/events/:id/ack — operator 200, idempotent; viewer 403; cross-org 404', async () => {
    expect((await viewerAgent.post(`/api/v1/alarms/events/${eventId}/ack`).send({})).status).toBe(403);

    const acked = await operatorAgent.post(`/api/v1/alarms/events/${eventId}/ack`).send({});
    expect(acked.status).toBe(200);
    expect(acked.body.acknowledged).toBe(true);
    expect(acked.body.acknowledged_by).toBeTruthy();
    expect(acked.body.acknowledged_at).toBeTruthy();

    // Idempotent: repeating keeps the first acknowledger and still returns 200
    const again = await operatorAgent.post(`/api/v1/alarms/events/${eventId}/ack`).send({});
    expect(again.status).toBe(200);
    expect(again.body.acknowledged_by).toBe(acked.body.acknowledged_by);
    expect(again.body.acknowledged_at).toBe(acked.body.acknowledged_at);

    const other = await loginAs(await createTestUser('alarm.ackiso@test.example', PW, 'operator'));
    expect((await other.post(`/api/v1/alarms/events/${eventId}/ack`).send({})).status).toBe(404);

    const ackedList = await viewerAgent.get('/api/v1/alarms/events?acknowledged=true');
    expect(ackedList.status).toBe(200);
    expect(ackedList.body.events.every((e) => e.acknowledged === true)).toBe(true);
    expect(ackedList.body.events.some((e) => e.id === eventId)).toBe(true);
  });

  test('GET /alarms/events/export.csv returns escaped text/csv with a header row', async () => {
    const res = await viewerAgent.get('/api/v1/alarms/events/export.csv');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.headers['content-disposition']).toMatch(/attachment; filename=".*\.csv"/);

    const lines = res.text.split('\r\n');
    expect(lines[0]).toBe(
      'triggered_at,cleared_at,state,severity,rule,flowsheet,project,message,value,min,max,' +
      'source,acknowledged,acknowledged_by,acknowledged_at'
    );
    expect(lines.length).toBeGreaterThan(1);
    // Messages contain no bare commas/newlines that could break the row count:
    // every data row must carry at least the header's field count.
    const headerFields = lines[0].split(',').length;
    for (const line of lines.slice(1).filter(Boolean)) {
      const outsideQuotes = line.replace(/"(?:[^"]|"")*"/g, '');
      expect(outsideQuotes.split(',').length).toBe(headerFields);
    }

    const filtered = await viewerAgent.get('/api/v1/alarms/events/export.csv?severity=info');
    expect(filtered.status).toBe(200);
    expect(filtered.text.split('\r\n').filter(Boolean)).toHaveLength(1); // header only
  });

  pdfTest('GET /alarms/report/pdf returns a reportlab PDF', async () => {
    const res = await viewerAgent.get('/api/v1/alarms/report/pdf').buffer(true).parse((r, cb) => {
      const chunks = [];
      r.on('data', (c) => chunks.push(c));
      r.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/pdf/);
    expect(res.headers['content-disposition']).toMatch(/attachment; filename=".*\.pdf"/);
    expect(res.body.length).toBeGreaterThan(1000);
    expect(res.body.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  }, 60000);
});
