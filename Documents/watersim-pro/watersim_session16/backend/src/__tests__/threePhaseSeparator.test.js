/**
 * Three-phase separator: the flow split on its own, and the three outlets
 * routed through the solver by the role on each line.
 */
'use strict';

const { Stream } = require('../simulation/stream');
const { solve } = require('../simulation/models/threePhaseSeparator');
const { runSteadyState, resolveNodeType } = require('../simulation/solver');

const feed = (Q) => new Stream({ Q, TSS: 120, COD: 900, pH: 6.8, temp: 45 });

describe('threePhaseSeparator model', () => {
  test('splits the feed into gas, oil and water and conserves volume', () => {
    const r = solve({ influent: feed(1000) }, { gas_fraction_pct: 10, oil_fraction_pct: 30 });
    expect(r.gas.Q).toBeCloseTo(100, 6);
    expect(r.oil.Q + r.effluent.Q + r.gas.Q).toBeCloseTo(1000, 6);
    // BS&W: 2 % of the oil outlet is water.
    expect(r.oil.Q).toBeGreaterThan(300 - 1);
    expect(r.metrics.water_in_oil_pct).toBe(2);
    expect(r.metrics.oil_recovery_pct).toBeGreaterThan(99);
    expect(r.metrics.warnings).toBeUndefined();
  });

  test('water keeps the feed quality; oil and gas carry flow only', () => {
    const r = solve({ influent: feed(1000) }, {});
    expect(r.effluent.COD).toBe(900);
    expect(r.effluent.temp).toBe(45);
    expect(r.oil.COD).toBe(0);
    expect(r.gas.TSS).toBe(0);
    expect(r.gas.temp).toBe(45);
  });

  test('short retention raises oil carry-over and warns', () => {
    const ok = solve({ influent: feed(1000) }, { liquid_volume_m3: 10, rated_retention_min: 5 });
    const short = solve({ influent: feed(1000) }, { liquid_volume_m3: 1, rated_retention_min: 5 });
    expect(ok.metrics.retention_min).toBeGreaterThan(5);
    expect(short.metrics.retention_min).toBeLessThan(5);
    expect(short.metrics.oil_in_water_mg_L).toBeGreaterThan(ok.metrics.oil_in_water_mg_L);
    expect(short.metrics.warnings.join(' ')).toMatch(/retention/i);
    expect(short.oil.Q + short.effluent.Q + short.gas.Q).toBeCloseTo(1000, 6);
  });

  test('fractions over 100 % are scaled down with a warning', () => {
    const r = solve({ influent: feed(100) }, { gas_fraction_pct: 80, oil_fraction_pct: 80 });
    expect(r.gas.Q + r.oil.Q).toBeCloseTo(100, 6);
    expect(r.effluent.Q).toBeCloseTo(0, 6);
    expect(r.metrics.warnings.join(' ')).toMatch(/scaled down/);
  });

  test('no feed gives zero flows, not NaN', () => {
    const r = solve({}, {});
    expect(r.effluent.Q).toBe(0);
    expect(r.metrics.retention_min).toBeNull();
    expect(r.metrics.oil_recovery_pct).toBeNull();
  });
});

describe('three_phase_separator in the solver', () => {
  test('palette type resolves to the model', () => {
    expect(resolveNodeType({ id: 'x', data: { opType: 'three_phase_separator' } })).toBe('three_phase_sep');
  });

  test('vapour, oil and water lines each get their own outlet', () => {
    const flowsheet = {
      nodes: [
        { id: 'in', data: { opType: 'inlet' } },
        { id: 'sep', data: { opType: 'three_phase_separator' } },
        { id: 'gas', data: { opType: 'outlet' } },
        { id: 'oil', data: { opType: 'outlet' } },
        { id: 'wat', data: { opType: 'outlet' } },
      ],
      edges: [
        { id: 'e0', source: 'in', target: 'sep', data: { streamType: 'stream' } },
        { id: 'eG', source: 'sep', target: 'gas', data: { streamType: 'stream', role: 'vapour' } },
        { id: 'eO', source: 'sep', target: 'oil', data: { streamType: 'stream', role: 'oil' } },
        { id: 'eW', source: 'sep', target: 'wat', data: { streamType: 'stream', role: 'water' } },
      ],
    };
    const r = runSteadyState(flowsheet, {
      nodeParams: { in: { Q: 1000 }, sep: { gas_fraction_pct: 10, oil_fraction_pct: 30 } },
    });
    const s = r.streamResults;
    expect(s.eG.Q).toBeCloseTo(100, 1);
    expect(s.eO.Q).toBeGreaterThan(290);
    expect(s.eW.Q).toBeGreaterThan(580);
    expect(s.eG.Q + s.eO.Q + s.eW.Q).toBeCloseTo(1000, 0);
    expect(r.summary.unroutedLosses).toEqual([]);
    expect(r.warnings.filter((w) => /sep/.test(w))).toEqual([]);
  });

  test('an unrouted oil or gas outlet is reported as a boundary loss', () => {
    const flowsheet = {
      nodes: [
        { id: 'in', data: { opType: 'inlet' } },
        { id: 'sep', data: { opType: 'three_phase_separator' } },
        { id: 'wat', data: { opType: 'outlet' } },
      ],
      edges: [
        { id: 'e0', source: 'in', target: 'sep', data: { streamType: 'stream' } },
        { id: 'eW', source: 'sep', target: 'wat', data: { streamType: 'stream' } },
      ],
    };
    const r = runSteadyState(flowsheet, { nodeParams: { in: { Q: 1000 } } });
    const lost = r.summary.unroutedLosses.map((l) => l.stream).sort();
    expect(lost).toEqual(['gas', 'oil']);
  });
});
