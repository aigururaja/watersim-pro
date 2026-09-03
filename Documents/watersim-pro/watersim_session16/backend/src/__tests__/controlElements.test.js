/**
 * WaterSim Pro — Flow-Control Elements (pump / valve) Tests  (Session 17)
 *
 * Coverage:
 *   - pump model: passthrough when ON, zero flow when OFF, VFD speed scaling,
 *     capacity capping, finite power, empty-influent safety
 *   - valve model: passthrough when open, zero flow when closed, proportional
 *     throttling, blocked-flow accounting
 *   - integration: inlet → pump → valve → outlet chains through runSteadyState
 *     (params via config.nodeParams), including robust on/off coercion
 *   - resilience: an activated_sludge train downstream of an OFF pump completes
 *     without throwing (degraded results / warnings are acceptable)
 *
 * Pure engine tests — no DB required.
 */

'use strict';

const { runSteadyState } = require('../simulation/solver');
const { estimateCosts } = require('../simulation/costEstimator');
const pump  = require('../simulation/models/pump');
const valve = require('../simulation/models/valve');
const { Stream } = require('../simulation/stream');

const INFLUENT = { Q: 5000, TSS: 250, BOD: 200, COD: 400, TN: 45, NH4: 35, TP: 8 };

// ── Pump model unit tests ─────────────────────────────────────────────────────

describe('Pump model', () => {
  const influent = () => new Stream({ Q: 5000, TSS: 250, BOD: 200 });

  test('ON with defaults passes the full flow through at unchanged quality', () => {
    const { effluent, metrics } = pump.solve({ influent: influent() }, {});
    expect(effluent.Q).toBeCloseTo(5000, 6);
    expect(effluent.TSS).toBeCloseTo(250, 6);
    expect(effluent.BOD).toBeCloseTo(200, 6);
    expect(metrics.status).toBe('ON');
    expect(metrics.blocked_Q_m3_d).toBe(0);
    expect(metrics.warnings).toBeUndefined();
  });

  test('OFF zeroes the delivered flow and warns about backed-up flow', () => {
    const { effluent, metrics } = pump.solve({ influent: influent() }, { running: 0 });
    expect(effluent.Q).toBe(0);
    expect(metrics.status).toBe('OFF');
    expect(metrics.Q_delivered_m3_d).toBe(0);
    expect(metrics.blocked_Q_m3_d).toBeCloseTo(5000, 1);
    expect(metrics.warnings).toEqual(
      expect.arrayContaining([expect.stringMatching(/Pump OFF/)]));
    expect(metrics.power_kW).toBe(0);
    expect(metrics.energy_kWh_d).toBe(0);
  });

  test('speed 50 % halves the delivered flow (unlimited capacity)', () => {
    const { effluent, metrics } = pump.solve({ influent: influent() }, { speed_pct: 50 });
    expect(effluent.Q).toBeCloseTo(2500, 6);
    expect(metrics.blocked_Q_m3_d).toBeCloseTo(2500, 1);
    expect(metrics.warnings).toEqual(
      expect.arrayContaining([expect.stringMatching(/limiting flow/)]));
  });

  test('capacity caps the delivered flow below the incoming flow', () => {
    const { effluent, metrics } = pump.solve({ influent: influent() }, { capacity_m3_d: 3000 });
    expect(effluent.Q).toBeCloseTo(3000, 6);
    expect(metrics.blocked_Q_m3_d).toBeCloseTo(2000, 1);
  });

  test('capacity above the incoming flow does not inflate it', () => {
    const { effluent } = pump.solve({ influent: influent() }, { capacity_m3_d: 999999 });
    expect(effluent.Q).toBeCloseTo(5000, 6);
  });

  test('speed_pct is clamped to 0–100 and non-finite falls back to 100', () => {
    expect(pump.solve({ influent: influent() }, { speed_pct: 150 }).effluent.Q).toBeCloseTo(5000, 6);
    expect(pump.solve({ influent: influent() }, { speed_pct: -10 }).effluent.Q).toBe(0);
    expect(pump.solve({ influent: influent() }, { speed_pct: 'abc' }).effluent.Q).toBeCloseTo(5000, 6);
  });

  test('power is finite and physically sensible', () => {
    const { metrics } = pump.solve({ influent: influent() },
      { head_m: 20, pump_efficiency: 0.7 });
    // 9.81 · (5000/86400) · 20 / 0.7 ≈ 16.22 kW
    expect(metrics.power_kW).toBeCloseTo(16.22, 1);
    expect(metrics.energy_kWh_d).toBeCloseTo(metrics.power_kW * 24, 0);
    expect(Number.isFinite(metrics.power_kW)).toBe(true);
  });

  test('empty influent (new Stream(), Q=0) produces no NaN anywhere', () => {
    const { effluent, metrics } = pump.solve({ influent: new Stream() }, {});
    expect(effluent.Q).toBe(0);
    for (const v of Object.values(metrics)) {
      if (typeof v === 'number') expect(Number.isFinite(v)).toBe(true);
    }
    expect(metrics.power_kW).toBe(0);
  });

  test('missing influent input is safe', () => {
    const { effluent } = pump.solve({}, {});
    expect(effluent.Q).toBe(0);
  });

  test('on/off coercion: 0, "0", false, "false", "off" are OFF; else ON', () => {
    for (const off of [0, '0', false, 'false', 'off', 'OFF', ' False ']) {
      expect(pump.solve({ influent: influent() }, { running: off }).metrics.status).toBe('OFF');
    }
    for (const on of [1, '1', true, 'true', 'on', undefined, null, 2, 'yes']) {
      expect(pump.solve({ influent: influent() }, { running: on }).metrics.status).toBe('ON');
    }
  });
});

// ── Valve model unit tests ────────────────────────────────────────────────────

describe('Valve model', () => {
  const influent = () => new Stream({ Q: 5000, TSS: 250, BOD: 200 });

  test('open with defaults passes the full flow through at unchanged quality', () => {
    const { effluent, metrics } = valve.solve({ influent: influent() }, {});
    expect(effluent.Q).toBeCloseTo(5000, 6);
    expect(effluent.TSS).toBeCloseTo(250, 6);
    expect(metrics.status).toBe('OPEN');
    expect(metrics.blocked_Q_m3_d).toBe(0);
    expect(metrics.warnings).toBeUndefined();
  });

  test('closed zeroes the flow and warns about backed-up flow', () => {
    const { effluent, metrics } = valve.solve({ influent: influent() }, { open: 0 });
    expect(effluent.Q).toBe(0);
    expect(metrics.status).toBe('CLOSED');
    expect(metrics.blocked_Q_m3_d).toBeCloseTo(5000, 1);
    expect(metrics.warnings).toEqual(
      expect.arrayContaining([expect.stringMatching(/Valve CLOSED/)]));
  });

  test('40 % opening gives 0.4×Q with the remainder accounted as blocked', () => {
    const { effluent, metrics } = valve.solve({ influent: influent() }, { opening_pct: 40 });
    expect(effluent.Q).toBeCloseTo(2000, 6);
    expect(metrics.status).toBe('THROTTLED');
    expect(metrics.Q_out_m3_d).toBeCloseTo(2000, 1);
    expect(metrics.blocked_Q_m3_d).toBeCloseTo(3000, 1);
    expect(metrics.warnings).toEqual(
      expect.arrayContaining([expect.stringMatching(/throttling/)]));
  });

  test('opening_pct is clamped and non-finite falls back to 100', () => {
    expect(valve.solve({ influent: influent() }, { opening_pct: 130 }).effluent.Q).toBeCloseTo(5000, 6);
    expect(valve.solve({ influent: influent() }, { opening_pct: -5 }).effluent.Q).toBe(0);
    expect(valve.solve({ influent: influent() }, { opening_pct: NaN }).effluent.Q).toBeCloseTo(5000, 6);
  });

  test('empty influent produces no NaN anywhere', () => {
    const { effluent, metrics } = valve.solve({ influent: new Stream() }, { opening_pct: 50 });
    expect(effluent.Q).toBe(0);
    for (const v of Object.values(metrics)) {
      if (typeof v === 'number') expect(Number.isFinite(v)).toBe(true);
    }
  });

  test('open/closed coercion mirrors the pump', () => {
    for (const closed of [0, '0', false, 'false', 'off']) {
      expect(valve.solve({ influent: influent() }, { open: closed }).metrics.status).toBe('CLOSED');
    }
    for (const open of [1, true, 'true', undefined, null]) {
      expect(valve.solve({ influent: influent() }, { open }).metrics.status).toBe('OPEN');
    }
  });
});

// ── Integration: inlet → pump → valve → outlet ────────────────────────────────

describe('Flow-control integration — inlet → pump → valve → outlet', () => {
  const flowsheet = {
    nodes: [
      { id: 'n_in',    type: 'unitOp', data: { opType: 'inlet',  label: 'Inlet' } },
      { id: 'n_pump',  type: 'unitOp', data: { opType: 'pump',   label: 'Pump' } },
      { id: 'n_valve', type: 'unitOp', data: { opType: 'valve',  label: 'Valve' } },
      { id: 'n_out',   type: 'unitOp', data: { opType: 'outlet', label: 'Outlet' } },
    ],
    edges: [
      { id: 'e1', source: 'n_in',    target: 'n_pump',  data: { streamType: 'stream' } },
      { id: 'e2', source: 'n_pump',  target: 'n_valve', data: { streamType: 'stream' } },
      { id: 'e3', source: 'n_valve', target: 'n_out',   data: { streamType: 'stream' } },
    ],
  };

  const run = (pumpParams = {}, valveParams = {}) => runSteadyState(flowsheet, {
    nodeParams: {
      n_in:    { ...INFLUENT },
      n_pump:  pumpParams,
      n_valve: valveParams,
    },
  });

  test('all on: full 5000 m³/d reaches the outlet', () => {
    const result = run();
    expect(result.converged).toBe(true);
    expect(result.streamResults.e2.Q).toBeCloseTo(5000, 0);
    expect(result.streamResults.e3.Q).toBeCloseTo(5000, 0);
    expect(result.summary.effluent.Q).toBeCloseTo(5000, 0);
    expect(result.unitResults.n_pump.metrics.status).toBe('ON');
    expect(result.unitResults.n_valve.metrics.status).toBe('OPEN');
  });

  test('pump OFF: outlet Q = 0 and the run completes converged', () => {
    const result = run({ running: 0 });
    expect(result.converged).toBe(true);
    expect(result.degraded).toBe(false);
    expect(result.streamResults.e2.Q).toBe(0);
    expect(result.summary.effluent.Q).toBe(0);
    expect(result.unitResults.n_pump.metrics.status).toBe('OFF');
    // The model warning is hoisted to run level.
    expect(result.warnings).toEqual(
      expect.arrayContaining([expect.stringMatching(/n_pump: Pump OFF/)]));
  });

  test('valve 50 % opening: outlet receives 2500 m³/d', () => {
    const result = run({}, { opening_pct: 50 });
    expect(result.converged).toBe(true);
    expect(result.streamResults.e3.Q).toBeCloseTo(2500, 0);
    expect(result.summary.effluent.Q).toBeCloseTo(2500, 0);
    expect(result.unitResults.n_valve.metrics.status).toBe('THROTTLED');
  });

  test('coercion through the solver: running="false" behaves as OFF', () => {
    const result = run({ running: 'false' });
    expect(result.converged).toBe(true);
    expect(result.summary.effluent.Q).toBe(0);
    expect(result.unitResults.n_pump.metrics.status).toBe('OFF');
  });

  test('valve closed: outlet Q = 0', () => {
    const result = run({}, { open: 0 });
    expect(result.summary.effluent.Q).toBe(0);
    expect(result.unitResults.n_valve.metrics.status).toBe('CLOSED');
  });
});

// ── Resilience: biological train downstream of an OFF pump ────────────────────

describe('Flow-control resilience — activated sludge downstream of an OFF pump', () => {
  const flowsheet = {
    nodes: [
      { id: 'n_in',   type: 'unitOp', data: { opType: 'inlet',               label: 'Inlet' } },
      { id: 'n_pump', type: 'unitOp', data: { opType: 'pump',                label: 'Feed Pump' } },
      { id: 'n_as',   type: 'unitOp', data: { opType: 'activated_sludge',    label: 'Aeration' } },
      { id: 'n_sc',   type: 'unitOp', data: { opType: 'secondary_clarifier', label: 'Clarifier' } },
      { id: 'n_out',  type: 'unitOp', data: { opType: 'outlet',              label: 'Outlet' } },
    ],
    edges: [
      { id: 'e1', source: 'n_in',   target: 'n_pump', data: { streamType: 'stream' } },
      { id: 'e2', source: 'n_pump', target: 'n_as',   data: { streamType: 'stream' } },
      { id: 'e3', source: 'n_as',   target: 'n_sc',   data: { streamType: 'stream' } },
      { id: 'e4', source: 'n_sc',   target: 'n_out',  data: { streamType: 'stream' } },
      { id: 'eR', source: 'n_sc',   target: 'n_as',   data: { streamType: 'ras', isRecycle: true } },
    ],
  };

  test('run completes without throwing when the feed pump is OFF', () => {
    let result;
    expect(() => {
      result = runSteadyState(flowsheet, {
        nodeParams: {
          n_in:   { ...INFLUENT },
          n_pump: { running: 0 },
          n_as:   { SRT_d: 10, MLSS_mg_L: 3000 },
        },
      });
    }).not.toThrow();
    expect(result).toBeDefined();
    expect(typeof result.converged).toBe('boolean');
    expect(result.unitResults.n_pump.metrics.status).toBe('OFF');
    // Degraded results / warnings are acceptable — the call just must return.
  });
});

// ── RAS-line pump: recycle flow must never silently vanish ────────────────────

describe('Flow-control on a RAS return line', () => {
  // clarifier —(ras)→ pump → aeration: the archetypal RAS pump.
  const makeFlowsheet = (pumpToBasinRole) => ({
    nodes: [
      { id: 'n_in',   type: 'unitOp', data: { opType: 'inlet',               label: 'Inlet' } },
      { id: 'n_as',   type: 'unitOp', data: { opType: 'activated_sludge',    label: 'Aeration' } },
      { id: 'n_sc',   type: 'unitOp', data: { opType: 'secondary_clarifier', label: 'Clarifier' } },
      { id: 'n_rp',   type: 'unitOp', data: { opType: 'pump',                label: 'RAS Pump' } },
      { id: 'n_out',  type: 'unitOp', data: { opType: 'outlet',              label: 'Outlet' } },
    ],
    edges: [
      { id: 'e1', source: 'n_in', target: 'n_as',  data: { streamType: 'stream' } },
      { id: 'e2', source: 'n_as', target: 'n_sc',  data: { streamType: 'stream' } },
      { id: 'e3', source: 'n_sc', target: 'n_out', data: { streamType: 'stream' } },
      { id: 'eR1', source: 'n_sc', target: 'n_rp', data: { streamType: 'ras', isRecycle: true } },
      { id: 'eR2', source: 'n_rp', target: 'n_as', data: { streamType: pumpToBasinRole } },
    ],
  });

  const nodeParams = {
    n_in: { Q: 10000, TSS: 250, BOD: 200, COD: 400, TN: 45, NH4: 35, TP: 8 },
    n_as: { SRT_d: 10, MLSS_mg_L: 3000 },
    n_sc: { RAS_ratio: 0.5 },
  };

  test.each(['stream', 'ras'])(
    'pump on the RAS line passes the recycle through (pump→basin edge role: %s)',
    (role) => {
      const result = runSteadyState(makeFlowsheet(role), { nodeParams });
      const rasIn  = result.streamResults.eR1?.Q ?? 0;
      const rasOut = result.streamResults.eR2?.Q ?? 0;
      expect(rasIn).toBeGreaterThan(100);            // clarifier actually returns sludge
      expect(rasOut).toBeCloseTo(rasIn, 0);          // the pump passes ALL of it — nothing vanishes
      expect(result.unitResults.n_rp.metrics.Q_delivered_m3_d).toBeCloseTo(rasIn, 0);
      // Water balance: effluent + boundary losses must not silently lose the RAS.
      expect(result.summary.effluent.Q).toBeGreaterThan(9000);
    });

  test('valve on the RAS line also passes the recycle through', () => {
    const fs = makeFlowsheet('stream');
    fs.nodes = fs.nodes.map(n => n.id === 'n_rp'
      ? { ...n, data: { ...n.data, opType: 'valve', label: 'RAS Valve' } } : n);
    const result = runSteadyState(fs, { nodeParams });
    const rasIn  = result.streamResults.eR1?.Q ?? 0;
    const rasOut = result.streamResults.eR2?.Q ?? 0;
    expect(rasIn).toBeGreaterThan(100);
    expect(rasOut).toBeCloseTo(rasIn, 0);
  });
});

// ── Cost integration: control elements must not distort plant economics ───────

describe('Flow-control cost integration', () => {
  const flowsheet = {
    nodes: [
      { id: 'n_in',    type: 'unitOp', data: { opType: 'inlet',  label: 'Inlet' } },
      { id: 'n_pump',  type: 'unitOp', data: { opType: 'pump',   label: 'Pump' } },
      { id: 'n_valve', type: 'unitOp', data: { opType: 'valve',  label: 'Valve' } },
      { id: 'n_out',   type: 'unitOp', data: { opType: 'outlet', label: 'Outlet' } },
    ],
    edges: [
      { id: 'e1', source: 'n_in',    target: 'n_pump',  data: { streamType: 'stream' } },
      { id: 'e2', source: 'n_pump',  target: 'n_valve', data: { streamType: 'stream' } },
      { id: 'e3', source: 'n_valve', target: 'n_out',   data: { streamType: 'stream' } },
    ],
  };
  const sim = runSteadyState(flowsheet, {
    nodeParams: { n_in: { Q: 10000, TSS: 250, BOD: 200 }, n_pump: {}, n_valve: {} },
  });
  const costs = estimateCosts(sim);

  test('pump energy replaces the flat pumping allowance — never both', () => {
    const pumpEnergy_yr = sim.unitResults.n_pump.metrics.energy_kWh_d * 365;
    expect(costs.energy.pumping_kWh_yr).toBeCloseTo(pumpEnergy_yr, -2);
    // The old bug charged allowance (0.04 × 10000 × 365 = 146,000) + pump energy on top.
    expect(costs.energy.pumping_kWh_yr).toBeLessThan(pumpEnergy_yr * 1.5);
    expect(costs.assumptions.join(' ')).toMatch(/modelled pump unit/);
    expect(costs.assumptions.join(' ')).not.toMatch(/no pump units modelled/);
  });

  test('valve capital is equipment-scale, not a $12M flow allowance', () => {
    const valveCapex = costs.capex.byUnit.n_valve?.cost ?? 0;
    expect(valveCapex).toBeGreaterThan(0);
    expect(valveCapex).toBeLessThan(100000); // a fitting, not a treatment plant
  });

  test('pump capital is priced from its power, not plant throughput', () => {
    const pumpCapex = costs.capex.byUnit.n_pump?.cost ?? 0;
    expect(pumpCapex).toBeGreaterThan(0);
    expect(pumpCapex).toBeLessThan(500000);
    expect(costs.capex.byUnit.n_pump.size_unit).toBe('kW');
  });

  test('flat allowance (with its assumption) still applies with no pump units', () => {
    const noPump = runSteadyState({
      nodes: [
        { id: 'a', type: 'unitOp', data: { opType: 'inlet',  label: 'In' } },
        { id: 'b', type: 'unitOp', data: { opType: 'outlet', label: 'Out' } },
      ],
      edges: [{ id: 'e', source: 'a', target: 'b', data: { streamType: 'stream' } }],
    }, { nodeParams: { a: { Q: 10000, TSS: 100, BOD: 100 } } });
    const c = estimateCosts(noPump);
    expect(c.energy.pumping_kWh_yr).toBeCloseTo(10000 * 0.04 * 365, -2);
    expect(c.assumptions.join(' ')).toMatch(/no pump units modelled/);
  });
});

// ── Unset percentage params must mean "default", never 0 % ────────────────────

describe('Unset percentage params', () => {
  const influent = () => new Stream({ Q: 5000, TSS: 250 });

  test("pump speed_pct '' / null deliver full flow (ON at 100 %), matching the UI", () => {
    expect(pump.solve({ influent: influent() }, { speed_pct: '' }).effluent.Q).toBeCloseTo(5000, 6);
    expect(pump.solve({ influent: influent() }, { speed_pct: null }).effluent.Q).toBeCloseTo(5000, 6);
  });

  test("valve opening_pct '' / null pass full flow (OPEN at 100 %)", () => {
    expect(valve.solve({ influent: influent() }, { opening_pct: '' }).effluent.Q).toBeCloseTo(5000, 6);
    expect(valve.solve({ influent: influent() }, { opening_pct: null }).effluent.Q).toBeCloseTo(5000, 6);
    expect(valve.solve({ influent: influent() }, { opening_pct: '' }).metrics.status).toBe('OPEN');
  });
});
