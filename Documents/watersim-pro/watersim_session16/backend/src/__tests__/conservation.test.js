/**
 * WaterSim Pro — Conservation Invariant Tests  (Session 16)
 *
 * Generic invariant harness: for several flowsheets, water and component mass
 * balances must close at the plant boundary:
 *
 *   influent (+ any additions) = effluent + all sludge/side streams
 *                              + documented losses (summary.unroutedLosses)
 *
 * These tests fail against the pre-fix engine (phantom RAS solids, doubled RAS
 * ratio, discarded WAS, fabricated sludge organics, false-recycle mis-routing)
 * and pass against the corrected one. Pure engine tests — no DB required.
 */

'use strict';

const { runSteadyState } = require('../simulation/solver');

const COMPONENTS = ['TSS', 'BOD', 'COD', 'TN', 'TP'];

/** kg/d load of one component in a stream JSON ({Q m³/d, conc mg/L}). */
const loadKgd = (stream, comp) => ((stream?.Q || 0) * (stream?.[comp] || 0)) / 1000;

/** Sum boundary loads: named streams plus documented unrouted losses. */
function boundaryTotals(result, boundaryEdgeIds) {
  const totals = { Q: 0 };
  for (const c of COMPONENTS) totals[c] = 0;
  for (const id of boundaryEdgeIds) {
    const s = result.streamResults[id];
    expect(s).toBeDefined();
    totals.Q += s.Q || 0;
    for (const c of COMPONENTS) totals[c] += loadKgd(s, c);
  }
  for (const loss of result.summary.unroutedLosses || []) {
    totals.Q += loss.Q_m3_d || 0;
    for (const c of COMPONENTS) totals[c] += loss[`${c}_kg_d`] || 0;
  }
  return totals;
}

function expectClose(actual, expected, relTol, label) {
  const ref = Math.max(Math.abs(expected), 1e-9);
  const relErr = Math.abs(actual - expected) / ref;
  if (relErr > relTol) {
    throw new Error(
      `${label}: expected ${expected.toFixed(3)}, got ${actual.toFixed(3)} ` +
      `(rel. error ${(relErr * 100).toFixed(3)}% > ${(relTol * 100).toFixed(3)}%)`);
  }
}

const INFLUENT = { Q: 10000, TSS: 250, BOD: 200, COD: 400, TN: 45, NH4: 35, TP: 8 };

// ── 1. Linear separation train ────────────────────────────────────────────────
// inlet → screen → primary clarifier → outlet, with primary sludge routed to a
// dedicated sludge outlet. Screenings remain an (intentionally) unrouted side
// stream that must appear as a documented loss.

describe('Conservation — linear separation train', () => {
  const flowsheet = {
    nodes: [
      { id: 'n_in',  type: 'unitOp', data: { opType: 'inlet' } },
      { id: 'n_sr',  type: 'unitOp', data: { opType: 'screening' } },
      { id: 'n_pc',  type: 'unitOp', data: { opType: 'primary_clarifier' } },
      { id: 'n_out', type: 'unitOp', data: { opType: 'outlet' } },
      { id: 'n_sl',  type: 'unitOp', data: { opType: 'outlet' } },
    ],
    edges: [
      { id: 'e1', source: 'n_in', target: 'n_sr',  data: { streamType: 'stream' } },
      { id: 'e2', source: 'n_sr', target: 'n_pc',  data: { streamType: 'stream' } },
      { id: 'e3', source: 'n_pc', target: 'n_out', data: { streamType: 'stream' } },
      { id: 'e4', source: 'n_pc', target: 'n_sl',  data: { role: 'sludge' } },
    ],
  };

  let result;
  beforeAll(() => {
    result = runSteadyState(flowsheet, { nodeParams: { n_in: { ...INFLUENT } } });
  });

  test('solves cleanly in one pass', () => {
    expect(result.converged).toBe(true);
    expect(result.degraded).toBe(false);
    expect(result.iterations).toBe(1);
    expect(result.summary.recycleEdges).toBe(0);
  });

  test('sludge edge carries the primary sludge, not a split of the effluent', () => {
    const sludge = result.streamResults.e4;
    expect(sludge.TSS).toBeGreaterThan(20000); // underflow at ~25 g/L
    expect(sludge.Q).toBeLessThan(200);        // small underflow, not half the plant flow
  });

  test('screenings are documented as an unrouted loss', () => {
    const losses = result.summary.unroutedLosses;
    expect(losses.some(l => l.node === 'n_sr' && l.stream === 'screenings')).toBe(true);
    expect(result.warnings.some(w => w.includes('n_sr') && w.includes('screenings'))).toBe(true);
  });

  test('water balance closes at the plant boundary', () => {
    const totals = boundaryTotals(result, ['e3', 'e4']);
    expectClose(totals.Q, INFLUENT.Q, 0.001, 'water balance');
  });

  test.each(COMPONENTS)('%s mass balance closes at the plant boundary', (comp) => {
    const totals = boundaryTotals(result, ['e3', 'e4']);
    const inKgd = INFLUENT.Q * INFLUENT[comp] / 1000;
    expectClose(totals[comp], inKgd, 0.005, `${comp} balance`);
  });
});

// ── 2. Activated sludge train with RAS recycle ────────────────────────────────
// inlet → aeration → secondary clarifier → outlet, RAS back to aeration.
// WAS is deliberately unrouted and must show up as a documented loss.

describe('Conservation — RAS recycle train', () => {
  const flowsheet = {
    nodes: [
      { id: 'n_in',  type: 'unitOp', data: { opType: 'inlet' } },
      { id: 'n_as',  type: 'unitOp', data: { opType: 'activated_sludge' } },
      { id: 'n_sc',  type: 'unitOp', data: { opType: 'secondary_clarifier' } },
      { id: 'n_out', type: 'unitOp', data: { opType: 'outlet' } },
    ],
    edges: [
      { id: 'e1',    source: 'n_in', target: 'n_as',  data: { streamType: 'stream' } },
      { id: 'e2',    source: 'n_as', target: 'n_sc',  data: { streamType: 'stream' } },
      { id: 'e3',    source: 'n_sc', target: 'n_out', data: { streamType: 'stream' } },
      { id: 'e_ras', source: 'n_sc', target: 'n_as',  data: { streamType: 'ras', isRecycle: true } },
    ],
  };

  let result;
  beforeAll(() => {
    result = runSteadyState(flowsheet, {
      nodeParams: {
        n_in: { ...INFLUENT, TSS: 200, BOD: 250, COD: 450 },
        n_as: { SRT_d: 10, MLSS_mg_L: 3000 },
        n_sc: { RAS_ratio: 0.5 },
      },
    });
  });

  test('converges and reports the flag', () => {
    expect(result.converged).toBe(true);
    expect(result.iterations).toBeGreaterThan(1);
    expect(result.maxResidual).toBeLessThanOrEqual(0.0001);
  });

  test('unrouted WAS is warned about and documented as a loss', () => {
    const losses = result.summary.unroutedLosses;
    const was = losses.find(l => l.node === 'n_as' && l.stream === 'WAS');
    expect(was).toBeDefined();
    expect(was.Q_m3_d).toBeGreaterThan(100);
    expect(result.warnings.some(w => w.includes('n_as') && w.includes("'WAS'"))).toBe(true);
  });

  test('water balance closes at the plant boundary including WAS loss', () => {
    const totals = boundaryTotals(result, ['e3']);
    expectClose(totals.Q, 10000, 0.001, 'water balance');
  });

  test('converged RAS ratio honors the user R relative to plant influent', () => {
    const rasQ = result.streamResults.e_ras.Q;
    const wasQ = result.summary.unroutedLosses.find(l => l.stream === 'WAS')?.Q_m3_d || 0;
    // Exact algebra: RAS_Q = R × (Q_plant − WAS_Q); the pre-fix solver converged to R≈1.0
    const ratio = rasQ / (10000 - wasQ);
    expect(ratio).toBeGreaterThan(0.49);
    expect(ratio).toBeLessThan(0.51);
  });

  test('TSS mass balance closes across the secondary clarifier (no phantom solids)', () => {
    const inKgd  = loadKgd(result.streamResults.e2, 'TSS');
    const outKgd = loadKgd(result.streamResults.e3, 'TSS') + loadKgd(result.streamResults.e_ras, 'TSS');
    expectClose(outKgd, inKgd, 0.005, 'clarifier TSS balance');
  });

  test.each(['BOD', 'COD', 'TN', 'TP'])('%s mass balance closes across the secondary clarifier', (comp) => {
    const inKgd  = loadKgd(result.streamResults.e2, comp);
    const outKgd = loadKgd(result.streamResults.e3, comp) + loadKgd(result.streamResults.e_ras, comp);
    expectClose(outKgd, inKgd, 0.005, `clarifier ${comp} balance`);
  });

  test('RAS TSS is mass-balance derived, not forced to the 8000 mg/L default', () => {
    const rasTSS = result.streamResults.e_ras.TSS;
    const mlss   = result.streamResults.e2.TSS;
    // Thickened relative to mixed liquor, and consistent with the solids split:
    expect(rasTSS).toBeGreaterThan(mlss);
    const expected =
      (loadKgd(result.streamResults.e2, 'TSS') - loadKgd(result.streamResults.e3, 'TSS')) * 1000 /
      result.streamResults.e_ras.Q;
    expectClose(rasTSS, expected, 0.005, 'RAS TSS mass-balance value');
  });
});

// ── 3. Feed-forward branch-and-merge DAG ──────────────────────────────────────
// inlet splits 40/60: a direct edge to the merge unit and a two-unit branch.
// Every unit here is a pass-through (polymer dosing), so all components must be
// conserved exactly. The pre-fix BFS ordering misclassified the branch's merge
// edge as a recycle, routed it into a phantom RAS port, and lost 60% of the flow.

describe('Conservation — branch-and-merge DAG', () => {
  const flowsheet = {
    nodes: [
      { id: 'n_in',  type: 'unitOp', data: { opType: 'inlet' } },
      { id: 'n_d1',  type: 'unitOp', data: { opType: 'chemical_dosing' } },
      { id: 'n_d2',  type: 'unitOp', data: { opType: 'chemical_dosing' } },
      { id: 'n_mrg', type: 'unitOp', data: { opType: 'chemical_dosing' } },
      { id: 'n_out', type: 'unitOp', data: { opType: 'outlet' } },
    ],
    edges: [
      { id: 'eDirect', source: 'n_in',  target: 'n_mrg', data: { streamType: 'stream' } },
      { id: 'eA',      source: 'n_in',  target: 'n_d1',  data: { streamType: 'stream' } },
      { id: 'eB',      source: 'n_d1',  target: 'n_d2',  data: { streamType: 'stream' } },
      { id: 'eC',      source: 'n_d2',  target: 'n_mrg', data: { streamType: 'stream' } },
      { id: 'eD',      source: 'n_mrg', target: 'n_out', data: { streamType: 'stream' } },
    ],
  };
  const nodeParams = {
    n_in:  { ...INFLUENT, splitRatios: [0.4, 0.6] },
    n_d1:  { chemical_type: 'polymer', dose_mg_L: 2 },
    n_d2:  { chemical_type: 'polymer', dose_mg_L: 2 },
    n_mrg: { chemical_type: 'polymer', dose_mg_L: 2 },
  };

  let result;
  beforeAll(() => {
    result = runSteadyState(flowsheet, { nodeParams });
  });

  test('is recognized as a pure DAG (no recycles, single pass)', () => {
    expect(result.summary.recycleEdges).toBe(0);
    expect(result.iterations).toBe(1);
    expect(result.converged).toBe(true);
  });

  test('split honors the provided ratios', () => {
    expectClose(result.streamResults.eDirect.Q, 4000, 0.001, 'direct branch flow');
    expectClose(result.streamResults.eA.Q, 6000, 0.001, 'long branch flow');
  });

  test('water balance closes at the plant boundary', () => {
    const totals = boundaryTotals(result, ['eD']);
    expectClose(totals.Q, INFLUENT.Q, 0.001, 'water balance');
  });

  test.each(COMPONENTS)('%s mass balance closes at the plant boundary', (comp) => {
    const totals = boundaryTotals(result, ['eD']);
    const inKgd = INFLUENT.Q * INFLUENT[comp] / 1000;
    expectClose(totals[comp], inKgd, 0.005, `${comp} balance`);
  });
});
