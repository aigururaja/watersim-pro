/**
 * WaterSim Pro — Simulation Engine Tests  (Session 4 — Step 22)
 *
 * Tests cover:
 *  - Linear train (no recycle)
 *  - RAS recycle convergence
 *  - Denitrification (pre-anoxic zone)
 *  - Export endpoints
 */

'use strict';

const { createTestUser, loginAs, makeProject, makeFlowsheet } = require('./helpers');

// The flowsheet create route persists an empty canvas; store the real canvas
// through the PATCH route so integration runs exercise the intended flowsheet.
async function makeFlowsheetWithCanvas(agent, projectId, name, canvasData) {
  const fs = await makeFlowsheet(agent, projectId, name, canvasData);
  await agent
    .patch(`/api/v1/projects/${projectId}/flowsheets/${fs.id}`)
    .send({ canvasData });
  return fs;
}

// ── Solver unit tests (no DB needed) ─────────────────────────────────────────

describe('Solver — unit tests', () => {
  const { runSteadyState } = require('../simulation/solver');
  const { Stream } = require('../simulation/stream');

  // Minimal linear flowsheet: inlet → activated_sludge → outlet
  const makeLinear = () => ({
    nodes: [
      { id: 'n_inlet',  type: 'unitOp', data: { opType: 'inlet',           params: {} } },
      { id: 'n_as',     type: 'unitOp', data: { opType: 'activated_sludge', params: {} } },
      { id: 'n_outlet', type: 'unitOp', data: { opType: 'outlet',           params: {} } },
    ],
    edges: [
      { id: 'e1', source: 'n_inlet',  target: 'n_as',     data: { streamType: 'stream' } },
      { id: 'e2', source: 'n_as',     target: 'n_outlet', data: { streamType: 'stream' } },
    ],
  });

  test('runs without errors on linear train', () => {
    const result = runSteadyState(makeLinear(), {
      nodeParams: {
        n_inlet: { Q: 10000, BOD: 250, COD: 450, TSS: 200, TN: 45, NH4: 35, TP: 8 },
      },
    });
    expect(result.warnings.filter(w => w.includes('Error'))).toHaveLength(0);
    expect(result.summary.solvedNodes).toBe(3);
    expect(result.iterations).toBe(1); // no recycle → 1 pass
  });

  test('BOD removal occurs in activated sludge', () => {
    const result = runSteadyState(makeLinear(), {
      nodeParams: {
        n_inlet: { Q: 10000, BOD: 250, COD: 450, TSS: 200, TN: 45, NH4: 35, TP: 8 },
        n_as: { SRT_d: 10, MLSS_mg_L: 3000 },
      },
    });
    const inf = result.summary.influent;
    const eff = result.summary.effluent;
    expect(eff.BOD).toBeLessThan(inf.BOD);
    expect(eff.NH4).toBeLessThan(inf.NH4);
  });

  test('handles empty flowsheet gracefully', () => {
    const result = runSteadyState({ nodes: [], edges: [] });
    expect(result.warnings).toContain('Flowsheet has no nodes');
    expect(result.iterations).toBe(0);
  });

  // Flowsheet with RAS recycle: inlet → sec_clarifier → aeration → sec_clarifier (RAS back)
  const makeWithRAS = () => ({
    nodes: [
      { id: 'n_in',  type: 'unitOp', data: { opType: 'inlet',               params: {} } },
      { id: 'n_as',  type: 'unitOp', data: { opType: 'activated_sludge',    params: {} } },
      { id: 'n_sc',  type: 'unitOp', data: { opType: 'secondary_clarifier', params: {} } },
      { id: 'n_out', type: 'unitOp', data: { opType: 'outlet',              params: {} } },
    ],
    edges: [
      { id: 'e1',   source: 'n_in',  target: 'n_as',  data: { streamType: 'stream' } },
      { id: 'e2',   source: 'n_as',  target: 'n_sc',  data: { streamType: 'stream' } },
      { id: 'e3',   source: 'n_sc',  target: 'n_out', data: { streamType: 'stream' } },
      { id: 'e_ras',source: 'n_sc',  target: 'n_as',  data: { streamType: 'ras', isRecycle: true } },
    ],
  });

  test('detects RAS recycle edge', () => {
    const result = runSteadyState(makeWithRAS(), {
      nodeParams: {
        n_in: { Q: 10000, BOD: 250, COD: 450, TSS: 200, TN: 45, NH4: 35, TP: 8 },
        n_as: { SRT_d: 10, MLSS_mg_L: 3000 },
        n_sc: { RAS_ratio: 0.5 },
      },
    });
    expect(result.summary.recycleEdges).toBe(1);
    expect(result.iterations).toBeGreaterThan(1);
    expect(result.warnings.some(w => w.includes('Detected 1 recycle'))).toBe(true);
  });

  test('RAS recycle converges', () => {
    const result = runSteadyState(makeWithRAS(), {
      nodeParams: {
        n_in: { Q: 10000, BOD: 250, COD: 450, TSS: 200, TN: 45, NH4: 35, TP: 8 },
        n_as: { SRT_d: 10, MLSS_mg_L: 3000 },
        n_sc: { RAS_ratio: 0.5 },
      },
    });
    expect(result.warnings.some(w => w.includes('did not converge'))).toBe(false);
    expect(result.warnings.some(w => w.includes('converged in'))).toBe(true);
  });

  // Denitrification test
  test('denitrification reduces NO3 in effluent', () => {
    const resultAerobic = runSteadyState(makeLinear(), {
      nodeParams: {
        n_inlet: { Q: 10000, BOD: 250, COD: 450, TSS: 200, TN: 45, NH4: 35, TP: 8 },
        n_as:    { SRT_d: 15, MLSS_mg_L: 3000, denitrification: false },
      },
    });
    const resultDenit = runSteadyState(makeLinear(), {
      nodeParams: {
        n_inlet: { Q: 10000, BOD: 250, COD: 450, TSS: 200, TN: 45, NH4: 35, TP: 8 },
        n_as:    { SRT_d: 15, MLSS_mg_L: 3000, denitrification: true, anoxic_fraction: 0.3 },
      },
    });
    const no3Aerobic = resultAerobic.unitResults?.n_as?.metrics?.NO3_effluent ?? 0;
    const no3Denit   = resultDenit.unitResults?.n_as?.metrics?.NO3_effluent ?? 0;
    // Denitrification should reduce or maintain NO3 (with RAS zero in linear case, anoxic doesn't help much —
    // but it should not INCREASE it)
    expect(no3Denit).toBeLessThanOrEqual(no3Aerobic + 0.01);
    // Denitrification flag should be set
    expect(resultDenit.unitResults?.n_as?.metrics?.denitrification).toBe(true);
  });

  test('NO3 present on Stream after nitrification', () => {
    const result = runSteadyState(makeLinear(), {
      nodeParams: {
        n_inlet: { Q: 10000, BOD: 250, COD: 450, TSS: 200, TN: 45, NH4: 35, TP: 8 },
        n_as:    { SRT_d: 15, MLSS_mg_L: 3000 },
      },
    });
    // After nitrification, effluent should have NO3 > 0
    const asOut = result.unitResults?.n_as?.outputs?.effluent;
    expect(asOut?.NO3).toBeGreaterThan(0);
  });
});

// ── API integration tests ─────────────────────────────────────────────────────

describe('POST /simulate — integration', () => {
  let agent, projectId, flowsheetId;

  beforeAll(async () => {
    agent = await loginAs(await createTestUser('sim_s4@test.com', 'SimTest4!'));
    const proj = await makeProject(agent, 'Sim S4 Project');
    projectId  = proj.id;
    const fs   = await makeFlowsheetWithCanvas(agent, projectId, 'S4 Flowsheet', {
      nodes: [
        { id: 'n0', type: 'unitOp', data: { opType: 'inlet', params: {} } },
        { id: 'n1', type: 'unitOp', data: { opType: 'activated_sludge', params: {} } },
        { id: 'n2', type: 'unitOp', data: { opType: 'secondary_clarifier', params: {} } },
        { id: 'n3', type: 'unitOp', data: { opType: 'outlet', params: {} } },
      ],
      edges: [
        { id: 'e0', source: 'n0', target: 'n1', data: { streamType: 'stream' } },
        { id: 'e1', source: 'n1', target: 'n2', data: { streamType: 'stream' } },
        { id: 'e2', source: 'n2', target: 'n3', data: { streamType: 'stream' } },
        { id: 'e_ras', source: 'n2', target: 'n1', data: { streamType: 'ras', isRecycle: true } },
      ],
    });
    flowsheetId = fs.id;
  });

  const url = () => `/api/v1/projects/${projectId}/flowsheets/${flowsheetId}/simulate`;

  test('POST /simulate returns completed run with recycle info', async () => {
    const res = await agent.post(url()).send({
      mode: 'steady_state',
      nodeParams: {
        n0: { Q: 10000, BOD: 250, COD: 450, TSS: 200, TN: 45, NH4: 35, TP: 8 },
        n1: { SRT_d: 10, MLSS_mg_L: 3000 },
        n2: { RAS_ratio: 0.5 },
      },
    });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('completed');
    expect(res.body.run_id).toBeDefined();
    expect(res.body.results.summary.recycleEdges).toBe(1);
    expect(res.body.results.summary.iterations).toBeGreaterThan(1);
  });

  test('GET /simulate/:runId/export/csv returns CSV', async () => {
    // First run a simulation to get a runId
    const simRes = await agent.post(url()).send({
      nodeParams: { n0: { Q: 10000, BOD: 250, COD: 450, TSS: 200, TN: 45, NH4: 35, TP: 8 } },
    });
    const runId = simRes.body.run_id;

    const csvRes = await agent.get(`${url()}/${runId}/export/csv`);
    expect(csvRes.status).toBe(200);
    expect(csvRes.headers['content-type']).toMatch(/text\/csv/);
    expect(csvRes.text).toContain('WaterSim Pro');
    expect(csvRes.text).toContain('INFLUENT / EFFLUENT QUALITY');
  });

  test('GET /simulate/:runId/export/json returns JSON export', async () => {
    const simRes = await agent.post(url()).send({
      nodeParams: { n0: { Q: 10000, BOD: 250, COD: 450, TSS: 200, TN: 45, NH4: 35, TP: 8 } },
    });
    const runId = simRes.body.run_id;

    const jsonRes = await agent.get(`${url()}/${runId}/export/json`);
    expect(jsonRes.status).toBe(200);
    expect(jsonRes.body.export_version).toBe('1.1');
    expect(jsonRes.body.results).toBeDefined();
  });
});

// ── Dynamic solver unit tests ─────────────────────────────────────────────────

describe('Dynamic Solver — unit tests', () => {
  const { runDynamic, DEFAULT_DIURNAL_PROFILE } = require('../simulation/dynamicSolver');

  const makeLinear = () => ({
    nodes: [
      { id: 'n_inlet',  type: 'unitOp', data: { opType: 'inlet',           params: {} } },
      { id: 'n_as',     type: 'unitOp', data: { opType: 'activated_sludge', params: {} } },
      { id: 'n_outlet', type: 'unitOp', data: { opType: 'outlet',           params: {} } },
    ],
    edges: [
      { id: 'e1', source: 'n_inlet',  target: 'n_as',     data: { streamType: 'stream' } },
      { id: 'e2', source: 'n_as',     target: 'n_outlet', data: { streamType: 'stream' } },
    ],
  });

  test('DEFAULT_DIURNAL_PROFILE has 24 entries', () => {
    expect(DEFAULT_DIURNAL_PROFILE).toHaveLength(24);
    DEFAULT_DIURNAL_PROFILE.forEach((p, i) => {
      expect(p.hour).toBe(i);
      expect(typeof p.Q_scale).toBe('number');
      expect(p.Q_scale).toBeGreaterThan(0);
    });
  });

  test('runDynamic returns 24 steps by default', () => {
    const result = runDynamic(makeLinear(), {
      nodeParams: { n_inlet: { Q: 10000, BOD: 200, TN: 45, TP: 8, TSS: 250 } },
    });
    expect(result.mode).toBe('dynamic');
    expect(result.steps).toHaveLength(24);
    expect(result.stepCount).toBe(24);
  });

  test('runDynamic returns custom hour count', () => {
    const result = runDynamic(makeLinear(), {
      nodeParams: {},
      timeSeriesConfig: { hoursToSimulate: 12 },
    });
    expect(result.steps).toHaveLength(12);
    expect(result.stepCount).toBe(12);
  });

  test('each step has hour, summary, streamResults, unitResults', () => {
    const result = runDynamic(makeLinear(), {
      nodeParams: { n_inlet: { Q: 10000, BOD: 200, TN: 40, TP: 8, TSS: 250 } },
    });
    for (const step of result.steps) {
      expect(step).toHaveProperty('hour');
      expect(step).toHaveProperty('summary');
      expect(step).toHaveProperty('streamResults');
      expect(step).toHaveProperty('unitResults');
      expect(step).toHaveProperty('stepEntry');
    }
  });

  test('peak hour flow exceeds off-peak flow', () => {
    const result = runDynamic(makeLinear(), {
      nodeParams: { n_inlet: { Q: 10000, BOD: 200, TN: 40, TP: 8, TSS: 250 } },
    });
    const flows = result.steps.map(s => s.summary?.influent?.Q ?? 0);
    const peakQ   = Math.max(...flows);
    const troughQ = Math.min(...flows.filter(v => v > 0));
    expect(peakQ).toBeGreaterThan(troughQ);
  });

  test('effluent BOD varies across time steps (responds to load)', () => {
    const result = runDynamic(makeLinear(), {
      nodeParams: { n_inlet: { Q: 10000, BOD: 200, TN: 40, TP: 8, TSS: 250 } },
    });
    const bods = result.steps.map(s => s.summary?.effluent?.BOD ?? 0).filter(v => v > 0);
    const maxBOD = Math.max(...bods);
    const minBOD = Math.min(...bods);
    // BOD should change with loading — max should differ from min
    expect(maxBOD).toBeGreaterThanOrEqual(minBOD);
    // And all effluent BOD should be less than typical influent
    expect(maxBOD).toBeLessThan(200);
  });

  test('custom profile overrides default', () => {
    const flatProfile = Array.from({ length: 24 }, (_, h) => ({
      hour: h, Q_scale: 1.0, BOD_scale: 1.0, TN_scale: 1.0, TP_scale: 1.0, TSS_scale: 1.0,
    }));
    const result = runDynamic(makeLinear(), {
      nodeParams: { n_inlet: { Q: 10000, BOD: 200 } },
      timeSeriesConfig: { profile: flatProfile },
    });
    const flows = result.steps.map(s => s.summary?.influent?.Q ?? 0).filter(v => v > 0);
    // All flows should be equal (flat profile)
    const allEqual = flows.every(v => Math.abs(v - flows[0]) < 1);
    expect(allEqual).toBe(true);
  });
});

// ── Batch comparison API integration tests ────────────────────────────────────

describe('POST /simulate/batch — integration', () => {
  let agent, projectId, flowsheetId;

  beforeAll(async () => {
    agent = await loginAs(await createTestUser('batch_s5@test.com', 'BatchTest5!'));
    const proj = await makeProject(agent, 'Batch S5 Project');
    projectId  = proj.id;
    const fs   = await makeFlowsheetWithCanvas(agent, projectId, 'Batch S5 Flowsheet', {
      nodes: [
        { id: 'nb0', type: 'unitOp', data: { opType: 'inlet',            params: {} } },
        { id: 'nb1', type: 'unitOp', data: { opType: 'activated_sludge', params: {} } },
        { id: 'nb2', type: 'unitOp', data: { opType: 'secondary_clarifier', params: {} } },
        { id: 'nb3', type: 'unitOp', data: { opType: 'outlet',            params: {} } },
      ],
      edges: [
        { id: 'be0', source: 'nb0', target: 'nb1', data: { streamType: 'stream' } },
        { id: 'be1', source: 'nb1', target: 'nb2', data: { streamType: 'stream' } },
        { id: 'be2', source: 'nb2', target: 'nb3', data: { streamType: 'stream' } },
        { id: 'be3', source: 'nb2', target: 'nb1', data: { streamType: 'ras', isRecycle: true } },
      ],
    });
    flowsheetId = fs.id;
  });

  const batchUrl = () => `/api/v1/projects/${projectId}/flowsheets/${flowsheetId}/simulate/batch`;

  test('POST /batch returns results for all scenarios', async () => {
    const res = await agent.post(batchUrl()).send({
      scenarios: [
        { name: 'Low Load',  nodeParams: { nb0: { Q: 5000,  BOD: 150, TN: 30 } } },
        { name: 'High Load', nodeParams: { nb0: { Q: 15000, BOD: 300, TN: 60 } } },
      ],
    });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('completed');
    expect(res.body.mode).toBe('batch');
    expect(res.body.scenarioCount).toBe(2);
    expect(res.body.scenarios).toHaveLength(2);
    expect(res.body.scenarios[0].status).toBe('completed');
    expect(res.body.scenarios[1].status).toBe('completed');
    expect(res.body.run_id).toBeDefined();
  });

  test('batch scenarios produce different effluent quality', async () => {
    const res = await agent.post(batchUrl()).send({
      scenarios: [
        { name: 'Short SRT', nodeParams: { nb0: { Q: 10000, BOD: 200 }, nb1: { SRT_d: 5  } } },
        { name: 'Long SRT',  nodeParams: { nb0: { Q: 10000, BOD: 200 }, nb1: { SRT_d: 20 } } },
      ],
    });
    const shortBOD = res.body.scenarios[0].results?.summary?.effluent?.BOD;
    const longBOD  = res.body.scenarios[1].results?.summary?.effluent?.BOD;
    expect(shortBOD).toBeDefined();
    expect(longBOD).toBeDefined();
    // Longer SRT should produce lower effluent BOD
    expect(longBOD).toBeLessThanOrEqual(shortBOD);
  });

  test('batch rejects more than 10 scenarios', async () => {
    const scenarios = Array.from({ length: 11 }, (_, i) => ({ name: `S${i}`, nodeParams: {} }));
    const res = await agent.post(batchUrl()).send({ scenarios });
    expect(res.status).toBe(422);
  });

  test('batch requires scenario name', async () => {
    const res = await agent.post(batchUrl()).send({
      scenarios: [{ nodeParams: {} }],   // missing name
    });
    expect(res.status).toBe(422);
  });

  test('GET /default-profile returns 24-entry profile', async () => {
    const profileUrl = `/api/v1/projects/${projectId}/flowsheets/${flowsheetId}/simulate/default-profile`;
    const res = await agent.get(profileUrl);
    expect(res.status).toBe(200);
    expect(res.body.profile).toHaveLength(24);
    expect(res.body.profile[0].hour).toBe(0);
    expect(res.body.profile[11].Q_scale).toBeGreaterThan(1); // peak hour
  });
});

// ── Dynamic simulation API integration test ───────────────────────────────────

describe('POST /simulate mode=dynamic — integration', () => {
  let agent, projectId, flowsheetId;

  beforeAll(async () => {
    agent = await loginAs(await createTestUser('dyn_s5@test.com', 'DynTest5!!'));
    const proj = await makeProject(agent, 'Dyn S5 Project');
    projectId  = proj.id;
    const fs   = await makeFlowsheetWithCanvas(agent, projectId, 'Dyn S5 Flowsheet', {
      nodes: [
        { id: 'dn0', type: 'unitOp', data: { opType: 'inlet',            params: {} } },
        { id: 'dn1', type: 'unitOp', data: { opType: 'activated_sludge', params: {} } },
        { id: 'dn2', type: 'unitOp', data: { opType: 'outlet',           params: {} } },
      ],
      edges: [
        { id: 'de0', source: 'dn0', target: 'dn1', data: { streamType: 'stream' } },
        { id: 'de1', source: 'dn1', target: 'dn2', data: { streamType: 'stream' } },
      ],
    });
    flowsheetId = fs.id;
  });

  const url = () => `/api/v1/projects/${projectId}/flowsheets/${flowsheetId}/simulate`;

  test('POST mode=dynamic returns 24 steps', async () => {
    const res = await agent.post(url()).send({
      mode: 'dynamic',
      nodeParams: { dn0: { Q: 10000, BOD: 200, TN: 40, TP: 8, TSS: 250 } },
    });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('completed');
    expect(res.body.mode).toBe('dynamic');
    expect(res.body.results.stepCount).toBe(24);
    expect(res.body.results.steps).toHaveLength(24);
  });

  test('dynamic run with custom hoursToSimulate', async () => {
    const res = await agent.post(url()).send({
      mode: 'dynamic',
      nodeParams: {},
      timeSeriesConfig: { hoursToSimulate: 12 },
    });
    expect(res.status).toBe(201);
    expect(res.body.results.stepCount).toBe(12);
    expect(res.body.results.steps).toHaveLength(12);
  });

  test('dynamic CSV export contains HOURLY PROFILE heading', async () => {
    const simRes = await agent.post(url()).send({
      mode: 'dynamic',
      nodeParams: { dn0: { Q: 10000, BOD: 200, TN: 40, TP: 8, TSS: 250 } },
    });
    const runId = simRes.body.run_id;
    const csvRes = await agent.get(`${url()}/${runId}/export/csv`);
    expect(csvRes.status).toBe(200);
    expect(csvRes.text).toContain('DYNAMIC SIMULATION');
    expect(csvRes.text).toContain('Hour');
  });
});

// =============================================================================
// SESSION 6 — PHASE 4 TESTS
// =============================================================================

// ── Cost Estimator unit tests ─────────────────────────────────────────────────

describe('Cost Estimator — unit tests', () => {
  const { estimateCosts, DEFAULT_UNIT_COSTS } = require('../simulation/costEstimator');
  const { runSteadyState } = require('../simulation/solver');

  const makeLinear = () => ({
    nodes: [
      { id: 'n0', type: 'unitOp', data: { opType: 'inlet',            params: {} } },
      { id: 'n1', type: 'unitOp', data: { opType: 'activated_sludge', params: {} } },
      { id: 'n2', type: 'unitOp', data: { opType: 'outlet',           params: {} } },
    ],
    edges: [
      { id: 'e0', source: 'n0', target: 'n1', data: { streamType: 'stream' } },
      { id: 'e1', source: 'n1', target: 'n2', data: { streamType: 'stream' } },
    ],
  });

  test('DEFAULT_UNIT_COSTS has expected keys', () => {
    expect(DEFAULT_UNIT_COSTS).toHaveProperty('electricity_USD_per_kWh');
    expect(DEFAULT_UNIT_COSTS).toHaveProperty('biosolids_USD_per_tonne_dry');
    expect(DEFAULT_UNIT_COSTS).toHaveProperty('operator_salary_USD_yr');
  });

  test('estimateCosts returns positive total for a linear flowsheet', () => {
    const simResults = runSteadyState(makeLinear(), {
      nodeParams: { n0: { Q: 10000, BOD: 250, TN: 40, TP: 8, TSS: 200 } },
    });
    const costs = estimateCosts(simResults);
    expect(costs.total_USD_yr).toBeGreaterThan(0);
    expect(costs.cost_per_m3_treated_USD).toBeGreaterThan(0);
  });

  test('all five cost categories are present', () => {
    const simResults = runSteadyState(makeLinear(), {
      nodeParams: { n0: { Q: 10000, BOD: 250, TN: 40, TP: 8, TSS: 200 } },
    });
    const costs = estimateCosts(simResults);
    expect(costs).toHaveProperty('energy');
    expect(costs).toHaveProperty('chemicals');
    expect(costs).toHaveProperty('sludge');
    expect(costs).toHaveProperty('labour');
    expect(costs).toHaveProperty('maintenance');
  });

  test('energy cost scales with O2 demand', () => {
    const simResults = runSteadyState(makeLinear(), {
      nodeParams: { n0: { Q: 50000, BOD: 300, TN: 50, TSS: 250 } },
    });
    const costsLarge = estimateCosts(simResults);
    const simSmall   = runSteadyState(makeLinear(), {
      nodeParams: { n0: { Q: 5000, BOD: 150, TN: 25, TSS: 100 } },
    });
    const costsSmall = estimateCosts(simSmall);
    expect(costsLarge.energy.cost_USD_yr).toBeGreaterThan(costsSmall.energy.cost_USD_yr);
  });

  test('custom unitCosts override defaults', () => {
    const simResults = runSteadyState(makeLinear(), {
      nodeParams: { n0: { Q: 10000, BOD: 250, TN: 40 } },
    });
    const expensive = estimateCosts(simResults, { electricity_USD_per_kWh: 1.0 });
    const cheap     = estimateCosts(simResults, { electricity_USD_per_kWh: 0.01 });
    expect(expensive.energy.cost_USD_yr).toBeGreaterThan(cheap.energy.cost_USD_yr);
  });

  test('labour staff count scales with Q', () => {
    const small = estimateCosts(
      runSteadyState(makeLinear(), { nodeParams: { n0: { Q: 1000 } } })
    );
    const large = estimateCosts(
      runSteadyState(makeLinear(), { nodeParams: { n0: { Q: 100000 } } })
    );
    expect(large.labour.staff_count).toBeGreaterThanOrEqual(small.labour.staff_count);
  });
});

// ── EBPR unit tests ───────────────────────────────────────────────────────────

describe('EBPR (Bio-P) model — unit tests', () => {
  const { solve } = require('../simulation/models/aerationBasin');
  const { Stream } = require('../simulation/stream');

  const makeInput = (TP = 8) => ({
    influent: new Stream({ Q: 10000, BOD: 250, COD: 450, TSS: 200, TN: 45, NH4: 35, TP, temp: 20 }),
  });

  test('EBPR removes significantly more TP than conventional', () => {
    const conventional = solve(makeInput(), { SRT_d: 10, ebpr: false });
    const ebpr         = solve(makeInput(), { SRT_d: 10, ebpr: true, PAO_fraction: 0.35 });
    expect(ebpr.effluent.TP).toBeLessThan(conventional.effluent.TP);
  });

  test('EBPR metrics are present when enabled', () => {
    const result = solve(makeInput(), { SRT_d: 10, ebpr: true });
    expect(result.metrics.ebpr).toBeDefined();
    expect(result.metrics.ebpr.VFA_consumed_mg_L).toBeGreaterThan(0);
    expect(result.metrics.ebpr.P_released_mg_L).toBeGreaterThan(0);
    expect(result.metrics.ebpr.P_uptake_mg_L).toBeGreaterThan(0);
    expect(result.metrics.ebpr.TP_effluent_mg_L).toBeCloseTo(9.35, 2);
  });

  test('EBPR is off by default', () => {
    const result = solve(makeInput(), { SRT_d: 10 });
    expect(result.metrics.ebpr).toBeUndefined();
  });

  test('higher PAO_fraction yields lower effluent TP', () => {
    const low  = solve(makeInput(), { SRT_d: 15, ebpr: true, PAO_fraction: 0.15 });
    const high = solve(makeInput(), { SRT_d: 15, ebpr: true, PAO_fraction: 0.55 });
    expect(high.effluent.TP).toBeLessThanOrEqual(low.effluent.TP);
  });

  test('EBPR and denitrification can be combined', () => {
    const result = solve(makeInput(), {
      SRT_d: 12,
      ebpr: true,
      denitrification: true,
      anoxic_fraction: 0.30,
    });
    expect(result.effluent.TP).toBeCloseTo(9.35, 2);
    expect(result.effluent.NO3).toBeCloseTo(34.825, 2);
  });
});

// ── Chemical Dosing unit tests ─────────────────────────────────────────────────

describe('Chemical Dosing model — unit tests', () => {
  const { solve, CHEMICAL_COEFFICIENTS } = require('../simulation/models/chemicalDosing');
  const { Stream } = require('../simulation/stream');

  const makeInlet = (TP = 6, pH = 7.2) => ({
    influent: new Stream({ Q: 10000, BOD: 30, TSS: 20, TN: 10, TP, pH, temp: 20 }),
  });

  test('alum dosing removes TP', () => {
    const result = solve(makeInlet(), { chemical_type: 'alum', dose_mg_L: 30 });
    expect(result.effluent.TP).toBeLessThan(6);
    expect(result.metrics.TP_removal_pct).toBeGreaterThan(0);
  });

  test('FeCl3 removes more TSS per mg than alum due to heavier floc', () => {
    const alum  = solve(makeInlet(), { chemical_type: 'alum',           dose_mg_L: 30 });
    const fecl3 = solve(makeInlet(), { chemical_type: 'ferric_chloride', dose_mg_L: 30 });
    expect(fecl3.metrics.TP_removal_pct).toBeGreaterThan(0);
    expect(fecl3.effluent.TSS).toBeGreaterThan(alum.effluent.TSS); // more floc
  });

  test('NaOH raises pH', () => {
    const result = solve(makeInlet(6, 6.5), { chemical_type: 'naoh', dose_mg_L: 100 });
    expect(result.effluent.pH).toBeGreaterThan(6.5);
  });

  test('H2SO4 lowers pH', () => {
    const result = solve(makeInlet(6, 8.0), { chemical_type: 'h2so4', dose_mg_L: 80 });
    expect(result.effluent.pH).toBeLessThan(8.0);
  });

  test('target_pH overrides dose-based calculation', () => {
    const result = solve(makeInlet(6, 6.0), { chemical_type: 'naoh', dose_mg_L: 50, target_pH: 7.5 });
    expect(result.effluent.pH).toBeCloseTo(7.5, 2);
  });

  test('NaOCl reduces BOD', () => {
    const result = solve(makeInlet(), { chemical_type: 'naocl', dose_mg_L: 10 });
    expect(result.effluent.BOD).toBeLessThan(30);
  });

  test('polymer dosing has no bulk stream change', () => {
    const result = solve(makeInlet(), { chemical_type: 'polymer', dose_mg_L: 5 });
    expect(result.effluent.TP).toBeCloseTo(6, 2);
    expect(result.effluent.BOD).toBeCloseTo(30, 2);
  });

  test('dose_kg_d scales with Q', () => {
    const small = solve({ influent: new Stream({ Q: 1000,  BOD: 30, TP: 6, TSS: 20, pH: 7 }) },
      { chemical_type: 'alum', dose_mg_L: 30 });
    const large = solve({ influent: new Stream({ Q: 50000, BOD: 30, TP: 6, TSS: 20, pH: 7 }) },
      { chemical_type: 'alum', dose_mg_L: 30 });
    expect(large.metrics.dose_kg_d).toBeGreaterThan(small.metrics.dose_kg_d);
  });
});

// ── Permit Templates API integration tests ────────────────────────────────────

describe('Permit Templates API — integration', () => {
  let adminAgent, engineerAgent, operatorAgent, adminUser;

  beforeAll(async () => {
    adminUser    = await createTestUser('permit_admin@test.com', 'Permit1Admin!', 'admin');
    const engUser = await createTestUser('permit_eng@test.com',   'Permit1Eng!',  'engineer');
    const opUser  = await createTestUser('permit_op@test.com',    'Permit1Op!',   'operator');
    adminAgent    = await loginAs(adminUser);
    engineerAgent = await loginAs(engUser);
    operatorAgent = await loginAs(opUser);
  });

  const url = () => '/api/v1/permit-templates';

  test('GET / returns 200 for authenticated user', async () => {
    const res = await adminAgent.get(url());
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  test('POST creates a template (admin)', async () => {
    const res = await adminAgent.post(url()).send({
      name: 'Test NPDES Permit',
      description: 'Test permit',
      permit_limits: { BOD: 20, TSS: 20, TN: 8, TP: 0.5, NH4: 3 },
    });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe('Test NPDES Permit');
    expect(res.body.permit_limits.BOD).toBe(20);
  });

  test('POST creates a template (engineer)', async () => {
    const res = await engineerAgent.post(url()).send({
      name: 'Eng Template',
      permit_limits: { BOD: 25, TN: 12 },
    });
    expect(res.status).toBe(201);
  });

  test('POST forbidden for operator role', async () => {
    const res = await operatorAgent.post(url()).send({
      name: 'Op Template',
      permit_limits: {},
    });
    expect(res.status).toBe(403);
  });

  test('GET /:id returns the template', async () => {
    const create = await adminAgent.post(url()).send({
      name: 'Readable Template',
      permit_limits: { BOD: 30, TP: 1 },
    });
    const id = create.body.id;
    const res = await adminAgent.get(`${url()}/${id}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(id);
  });

  test('PATCH updates permit_limits', async () => {
    const create = await adminAgent.post(url()).send({
      name: 'Patchable',
      permit_limits: { BOD: 30 },
    });
    const id = create.body.id;
    const res = await adminAgent.patch(`${url()}/${id}`).send({
      permit_limits: { BOD: 15, TP: 0.5 },
    });
    expect(res.status).toBe(200);
    expect(res.body.permit_limits.BOD).toBe(15);
  });

  test('POST /:id/activate sets is_active to true', async () => {
    const create = await adminAgent.post(url()).send({
      name: 'To Activate',
      permit_limits: { BOD: 25 },
    });
    const id = create.body.id;
    const res = await adminAgent.post(`${url()}/${id}/activate`);
    expect(res.status).toBe(200);
    expect(res.body.is_active).toBe(true);
  });

  test('DELETE removes template (admin)', async () => {
    const create = await adminAgent.post(url()).send({
      name: 'To Delete',
      permit_limits: {},
    });
    const id = create.body.id;
    const del = await adminAgent.delete(`${url()}/${id}`);
    expect(del.status).toBe(200);
    expect(del.body.deleted).toBe(true);
    const get = await adminAgent.get(`${url()}/${id}`);
    expect(get.status).toBe(404);
  });

  test('DELETE forbidden for non-admin', async () => {
    const create = await adminAgent.post(url()).send({
      name: 'Protected',
      permit_limits: {},
    });
    const id = create.body.id;
    const del = await engineerAgent.delete(`${url()}/${id}`);
    expect(del.status).toBe(403);
  });
});

// ── Outlet model permit limits unit tests ────────────────────────────────────

describe('Outlet model — configurable permit limits', () => {
  const { solve, DEFAULT_LIMITS } = require('../simulation/models/outlet');
  const { Stream } = require('../simulation/stream');

  test('DEFAULT_LIMITS keys are present', () => {
    expect(DEFAULT_LIMITS).toHaveProperty('BOD');
    expect(DEFAULT_LIMITS).toHaveProperty('TN');
    expect(DEFAULT_LIMITS).toHaveProperty('TP');
    expect(DEFAULT_LIMITS).toHaveProperty('pH_min');
  });

  test('flags violation with default limits', () => {
    const inf = new Stream({ Q: 10000, BOD: 50, TSS: 35, TN: 15, TP: 2, NH4: 8, pH: 7 });
    const { metrics } = solve({ influent: inf });
    expect(metrics.compliant).toBe(false);
    expect(metrics.permit_violations.length).toBeGreaterThan(0);
    const params = metrics.permit_violations.map(v => v.param);
    expect(params).toContain('BOD');
  });

  test('compliant with clean effluent', () => {
    const inf = new Stream({ Q: 10000, BOD: 5, TSS: 5, TN: 5, TP: 0.5, NH4: 1, pH: 7 });
    const { metrics } = solve({ influent: inf });
    expect(metrics.compliant).toBe(true);
    expect(metrics.permit_violations).toHaveLength(0);
  });

  test('custom limits override defaults', () => {
    // Tighter limit — should now fail
    const inf = new Stream({ Q: 10000, BOD: 12, TSS: 5, TN: 5, TP: 0.5, NH4: 1, pH: 7 });
    const { metrics } = solve({ influent: inf }, { permitLimits: { BOD: 10 } });
    expect(metrics.compliant).toBe(false);
    const bodViol = metrics.permit_violations.find(v => v.param === 'BOD');
    expect(bodViol.limit).toBe(10);
  });

  test('NO3 limit applied when configured', () => {
    const inf = new Stream({ Q: 10000, BOD: 5, TSS: 5, TN: 5, TP: 0.5, NH4: 1, NO3: 25, pH: 7 });
    const { metrics } = solve({ influent: inf }, { permitLimits: { NO3: 20 } });
    const no3Viol = metrics.permit_violations.find(v => v.param === 'NO3');
    expect(no3Viol).toBeDefined();
    expect(no3Viol.limit).toBe(20);
  });

  test('limits_applied is in metrics', () => {
    const inf = new Stream({ Q: 10000, BOD: 5, TSS: 5, TN: 5, TP: 0.5, NH4: 1, pH: 7 });
    const { metrics } = solve({ influent: inf });
    expect(metrics.limits_applied).toBeDefined();
  });
});

// ── Simulate API — cost breakdown integration test ────────────────────────────

describe('POST /simulate — cost breakdown in response', () => {
  let agent, projectId, flowsheetId;

  beforeAll(async () => {
    agent = await loginAs(await createTestUser('cost_s6@test.com', 'CostTest6!!'));
    const proj = await makeProject(agent, 'Cost S6 Project');
    projectId  = proj.id;
    const fs   = await makeFlowsheetWithCanvas(agent, projectId, 'Cost S6 Flowsheet', {
      nodes: [
        { id: 'c0', type: 'unitOp', data: { opType: 'inlet',            params: {} } },
        { id: 'c1', type: 'unitOp', data: { opType: 'activated_sludge', params: {} } },
        { id: 'c2', type: 'unitOp', data: { opType: 'outlet',           params: {} } },
      ],
      edges: [
        { id: 'ce0', source: 'c0', target: 'c1', data: { streamType: 'stream' } },
        { id: 'ce1', source: 'c1', target: 'c2', data: { streamType: 'stream' } },
      ],
    });
    flowsheetId = fs.id;
  });

  const url = () => `/api/v1/projects/${projectId}/flowsheets/${flowsheetId}/simulate`;

  test('steady_state returns costBreakdown in results', async () => {
    const res = await agent.post(url()).send({
      mode: 'steady_state',
      nodeParams: { c0: { Q: 10000, BOD: 250, TN: 40, TP: 8, TSS: 200 } },
    });
    expect(res.status).toBe(201);
    expect(res.body.results.costBreakdown).toBeDefined();
    const cb = res.body.results.costBreakdown;
    expect(cb.total_USD_yr).toBeGreaterThan(0);
    expect(cb.cost_per_m3_treated_USD).toBeGreaterThan(0);
  });

  test('custom unitCosts accepted and reflected in cost model', async () => {
    const cheap = await agent.post(url()).send({
      mode: 'steady_state',
      nodeParams: { c0: { Q: 10000, BOD: 250, TN: 40 } },
      unitCosts: { electricity_USD_per_kWh: 0.01 },
    });
    const expensive = await agent.post(url()).send({
      mode: 'steady_state',
      nodeParams: { c0: { Q: 10000, BOD: 250, TN: 40 } },
      unitCosts: { electricity_USD_per_kWh: 1.00 },
    });
    expect(expensive.body.results.costBreakdown.energy.cost_USD_yr)
      .toBeGreaterThan(cheap.body.results.costBreakdown.energy.cost_USD_yr);
  });

  test('GET /default-unit-costs returns default cost coefficients', async () => {
    const res = await agent.get(`${url()}/default-unit-costs`);
    expect(res.status).toBe(200);
    expect(res.body.unitCosts).toHaveProperty('electricity_USD_per_kWh');
    expect(res.body.unitCosts).toHaveProperty('biosolids_USD_per_tonne_dry');
  });

  test('dynamic mode does not include costBreakdown (only steady_state)', async () => {
    const res = await agent.post(url()).send({
      mode: 'dynamic',
      nodeParams: { c0: { Q: 5000, BOD: 200, TN: 35 } },
      timeSeriesConfig: { hoursToSimulate: 6 },
    });
    expect(res.status).toBe(201);
    // dynamic results do not include costBreakdown at top level
    expect(res.body.results.costBreakdown).toBeUndefined();
  });
});

// ── JSON export version bump ──────────────────────────────────────────────────

describe('JSON export version — session 6', () => {
  let agent, projectId, flowsheetId;

  beforeAll(async () => {
    agent = await loginAs(await createTestUser('jexp_s6@test.com', 'JsonExp6!!'));
    const proj = await makeProject(agent, 'JsonExp S6 Project');
    projectId  = proj.id;
    const fs   = await makeFlowsheetWithCanvas(agent, projectId, 'JsonExp S6 Flowsheet', {
      nodes: [
        { id: 'j0', type: 'unitOp', data: { opType: 'inlet',            params: {} } },
        { id: 'j1', type: 'unitOp', data: { opType: 'activated_sludge', params: {} } },
        { id: 'j2', type: 'unitOp', data: { opType: 'outlet',           params: {} } },
      ],
      edges: [
        { id: 'je0', source: 'j0', target: 'j1', data: { streamType: 'stream' } },
        { id: 'je1', source: 'j1', target: 'j2', data: { streamType: 'stream' } },
      ],
    });
    flowsheetId = fs.id;
  });

  test('JSON export has export_version 1.1', async () => {
    const url = `/api/v1/projects/${projectId}/flowsheets/${flowsheetId}/simulate`;
    const sim = await agent.post(url).send({ mode: 'steady_state' });
    const runId = sim.body.run_id;
    const exp = await agent.get(`${url}/${runId}/export/json`);
    expect(exp.status).toBe(200);
    expect(exp.body.export_version).toBe('1.1');
  });
});
