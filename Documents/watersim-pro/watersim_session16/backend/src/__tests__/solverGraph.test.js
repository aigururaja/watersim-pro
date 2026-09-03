/**
 * WaterSim Pro — Solver Graph-Ordering & Honesty Tests  (Session 16)
 *
 * Regression coverage for:
 *   - false-recycle misclassification of feed-forward branch-and-merge DAGs
 *     (BFS-position pseudo-topo ordering + 'RAS' role guessing)
 *   - genuine recycle loops: torn, iterated, converged flag exposed
 *   - unmarked true cycles: detected structurally and torn with a warning
 *   - recycle edges from units without a recycle output: no invented mass
 *   - split-ratio validation and defaulting warnings
 *   - NaN inputs: swept to null, warned, run marked degraded
 *
 * Pure engine tests — no DB required.
 */

'use strict';

const { runSteadyState } = require('../simulation/solver');

const INFLUENT = { Q: 10000, TSS: 250, BOD: 200, COD: 400, TN: 45, NH4: 35, TP: 8 };

// ── False-recycle regression: feed-forward branch-and-merge DAG ───────────────

describe('Graph ordering — feed-forward branch-and-merge DAG', () => {
  // inlet splits into a direct edge to the merge node and a two-unit branch;
  // the branch's merge edge (eC) is exactly what the old BFS ordering tore as
  // a fake recycle and mis-routed into a phantom RAS port.
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
    n_d1:  { chemical_type: 'polymer' },
    n_d2:  { chemical_type: 'polymer' },
    n_mrg: { chemical_type: 'polymer' },
  };

  let result;
  beforeAll(() => {
    result = runSteadyState(flowsheet, { nodeParams });
  });

  test('produces zero recycle edges and zero recycle warnings', () => {
    expect(result.summary.recycleEdges).toBe(0);
    expect(result.warnings.filter(w => /recycle|cycle/i.test(w))).toHaveLength(0);
  });

  test('solves in a single pass with converged flag set', () => {
    expect(result.iterations).toBe(1);
    expect(result.converged).toBe(true);
    expect(result.maxResidual).toBe(0);
    expect(result.degraded).toBe(false);
  });

  test('routes the merge edge forward — full flow reaches the outlet', () => {
    expect(result.streamResults.eC.Q).toBeCloseTo(6000, 0);
    expect(result.streamResults.eD.Q).toBeCloseTo(10000, 0);
    expect(result.summary.effluent.Q).toBeCloseTo(10000, 0);
  });
});

// ── Genuine RAS loop ──────────────────────────────────────────────────────────

describe('Graph ordering — genuine RAS loop', () => {
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
        n_in: { ...INFLUENT },
        n_as: { SRT_d: 10, MLSS_mg_L: 3000 },
        n_sc: { RAS_ratio: 0.5 },
      },
    });
  });

  test('tears exactly the marked RAS edge and iterates to convergence', () => {
    expect(result.summary.recycleEdges).toBe(1);
    expect(result.iterations).toBeGreaterThan(1);
    expect(result.converged).toBe(true);
    expect(result.maxResidual).toBeLessThanOrEqual(0.0001);
    expect(result.warnings.some(w => w.includes('Detected 1 recycle'))).toBe(true);
    expect(result.warnings.some(w => w.includes('converged in'))).toBe(true);
  });

  test('RAS stream is thickened return sludge routed to the RAS port', () => {
    const ras = result.streamResults.e_ras;
    expect(ras.TSS).toBeGreaterThan(result.streamResults.e2.TSS); // thickened vs mixed liquor
    // RAS inflow raises the basin feed above the plant influent:
    expect(result.streamResults.e2.Q).toBeGreaterThan(INFLUENT.Q);
  });
});

// ── Unmarked true cycle ───────────────────────────────────────────────────────

describe('Graph ordering — unmarked true cycle', () => {
  const flowsheet = {
    nodes: [
      { id: 'n_in',  type: 'unitOp', data: { opType: 'inlet' } },
      { id: 'n_a',   type: 'unitOp', data: { opType: 'chemical_dosing' } },
      { id: 'n_b',   type: 'unitOp', data: { opType: 'chemical_dosing' } },
      { id: 'n_out', type: 'unitOp', data: { opType: 'outlet' } },
    ],
    edges: [
      { id: 'e1',     source: 'n_in', target: 'n_a',   data: { streamType: 'stream' } },
      { id: 'e2',     source: 'n_a',  target: 'n_b',   data: { streamType: 'stream' } },
      { id: 'e_loop', source: 'n_b',  target: 'n_a',   data: { streamType: 'stream' } }, // unmarked!
      { id: 'e3',     source: 'n_b',  target: 'n_out', data: { streamType: 'stream' } },
    ],
  };

  let result;
  beforeAll(() => {
    result = runSteadyState(flowsheet, {
      nodeParams: {
        n_in: { ...INFLUENT },
        n_a:  { chemical_type: 'polymer' },
        n_b:  { chemical_type: 'polymer', splitRatios: [0.5, 0.5] },
      },
    });
  });

  test('detects and tears the unmarked cycle with a warning', () => {
    expect(result.summary.recycleEdges).toBe(1);
    expect(result.warnings.some(w => w.includes('Cycle detected on edge e_loop'))).toBe(true);
  });

  test('iterates the torn loop to convergence', () => {
    expect(result.converged).toBe(true);
    expect(result.iterations).toBeGreaterThan(1);
    // Fixed point of a 50/50 internal loop: outlet flow equals plant influent
    expect(result.streamResults.e3.Q).toBeCloseTo(INFLUENT.Q, -1);
  });
});

// ── Recycle edge from a unit with no recycle output ───────────────────────────

describe('Recycle edge without a recycle output', () => {
  const makeFlowsheet = () => ({
    nodes: [
      { id: 'n_in',  type: 'unitOp', data: { opType: 'inlet' } },
      { id: 'n_a',   type: 'unitOp', data: { opType: 'uv_disinfection' } },
      { id: 'n_b',   type: 'unitOp', data: { opType: 'uv_disinfection' } },
      { id: 'n_out', type: 'unitOp', data: { opType: 'outlet' } },
    ],
    edges: [
      { id: 'e1',    source: 'n_in', target: 'n_a',   data: { streamType: 'stream' } },
      { id: 'e2',    source: 'n_a',  target: 'n_b',   data: { streamType: 'stream' } },
      { id: 'e_rec', source: 'n_b',  target: 'n_a',   data: { streamType: 'recycle', isRecycle: true } },
      { id: 'e3',    source: 'n_b',  target: 'n_out', data: { streamType: 'stream' } },
    ],
  });

  test('without an explicit flow param: warns and uses zero flow (no invented mass)', () => {
    const result = runSteadyState(makeFlowsheet(), { nodeParams: { n_in: { ...INFLUENT } } });
    expect(result.streamResults.e_rec.Q).toBe(0);
    expect(result.warnings.some(w =>
      w.includes('e_rec') && w.includes("'recycle'") && w.includes('zero flow'))).toBe(true);
    expect(result.converged).toBe(true);
    // The plant boundary still balances: everything leaves via the outlet
    expect(result.streamResults.e3.Q).toBeCloseTo(INFLUENT.Q, 0);
  });

  test('with an explicit recycleFlow_m3d: carves the recycle from the effluent', () => {
    const result = runSteadyState(makeFlowsheet(), {
      nodeParams: { n_in: { ...INFLUENT }, n_b: { recycleFlow_m3d: 2000 } },
    });
    expect(result.converged).toBe(true);
    expect(result.streamResults.e_rec.Q).toBeCloseTo(2000, 0);
    // Forward + recycle must not exceed the unit's inflow (mass conserved)
    const fwd = result.streamResults.e3.Q;
    const rec = result.streamResults.e_rec.Q;
    const inflow = result.streamResults.e2.Q;
    expect(fwd + rec).toBeLessThanOrEqual(inflow + 1);
  });
});

// ── Split-ratio validation ────────────────────────────────────────────────────

describe('Multi-outlet splits', () => {
  const makeSplit = () => ({
    nodes: [
      { id: 'n_in',   type: 'unitOp', data: { opType: 'inlet' } },
      { id: 'n_out1', type: 'unitOp', data: { opType: 'outlet' } },
      { id: 'n_out2', type: 'unitOp', data: { opType: 'outlet' } },
    ],
    edges: [
      { id: 'eL', source: 'n_in', target: 'n_out1', data: { streamType: 'stream' } },
      { id: 'eR', source: 'n_in', target: 'n_out2', data: { streamType: 'stream' } },
    ],
  });

  test('non-normalized ratios are normalized with a warning', () => {
    const result = runSteadyState(makeSplit(), {
      nodeParams: { n_in: { ...INFLUENT, splitRatios: [3, 1] } },
    });
    expect(result.streamResults.eL.Q).toBeCloseTo(7500, 0);
    expect(result.streamResults.eR.Q).toBeCloseTo(2500, 0);
    expect(result.warnings.some(w => w.includes('splitRatios') && w.includes('normalized'))).toBe(true);
  });

  test('missing ratios default to an equal split with an explicit warning', () => {
    const result = runSteadyState(makeSplit(), { nodeParams: { n_in: { ...INFLUENT } } });
    expect(result.streamResults.eL.Q).toBeCloseTo(5000, 0);
    expect(result.streamResults.eR.Q).toBeCloseTo(5000, 0);
    expect(result.warnings.some(w => w.includes('No splitRatios') && w.includes('equal split'))).toBe(true);
  });
});

// ── NaN inputs: fail loudly, never persist silently ───────────────────────────

describe('Non-finite value handling', () => {
  const linear = () => ({
    nodes: [
      { id: 'n_in',  type: 'unitOp', data: { opType: 'inlet' } },
      { id: 'n_as',  type: 'unitOp', data: { opType: 'activated_sludge' } },
      { id: 'n_out', type: 'unitOp', data: { opType: 'outlet' } },
    ],
    edges: [
      { id: 'e1', source: 'n_in', target: 'n_as',  data: { streamType: 'stream' } },
      { id: 'e2', source: 'n_as', target: 'n_out', data: { streamType: 'stream' } },
    ],
  });

  test('NaN inputs mark the run degraded with a warning; NaN never survives', () => {
    const result = runSteadyState(linear(), {
      nodeParams: { n_in: { Q: NaN, BOD: 250, TSS: 200, TN: 45, NH4: 35, TP: 8 } },
    });
    expect(result.degraded).toBe(true);
    expect(result.warnings.some(w => /non-finite/i.test(w))).toBe(true);
    // Every numeric value in the results is finite or null — never NaN/Infinity
    const check = (v) => {
      if (typeof v === 'number') expect(Number.isFinite(v)).toBe(true);
      else if (Array.isArray(v)) v.forEach(check);
      else if (v && typeof v === 'object') Object.values(v).forEach(check);
    };
    check(result.streamResults);
    check(result.unitResults);
    check(result.summary);
  });

  test('clean inputs leave the run non-degraded', () => {
    const result = runSteadyState(linear(), { nodeParams: { n_in: { ...INFLUENT } } });
    expect(result.degraded).toBe(false);
    expect(result.converged).toBe(true);
  });
});
