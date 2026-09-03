/**
 * WaterSim Pro — Per-Unit CAPEX Model Tests  (Session 16)
 *
 * Coverage for the power-law capital cost model in costEstimator.js:
 *   - process configuration drives capital: an RO-heavy flowsheet costs
 *     materially more than a same-flow simple gravity train
 *   - capital scales sublinearly with flow (six-tenths rule)
 *   - empty simulations still report ~$0 with an explanatory assumption
 *   - CRF math spot-check and annualization consistency
 *   - LCOW present and positive for a standard train
 *   - all pre-existing opex-only field names preserved
 *   - unsized units fall back to a named flow-based allowance
 *
 * Pure engine tests — no DB required.
 */

'use strict';

const { runSteadyState } = require('../simulation/solver');
const {
  estimateCosts,
  DEFAULT_UNIT_COSTS,
  capitalRecoveryFactor,
} = require('../simulation/costEstimator');

const INFLUENT = { Q: 10000, TSS: 250, BOD: 250, COD: 450, TN: 40, NH4: 30, TP: 8 };

/** Build a linear flowsheet from an ordered list of palette op types. */
function linearFlowsheet(opTypes) {
  const nodes = opTypes.map((op, i) => ({
    id: `n${i}`, type: 'unitOp', data: { opType: op, params: {} },
  }));
  const edges = opTypes.slice(1).map((_, i) => ({
    id: `e${i}`, source: `n${i}`, target: `n${i + 1}`, data: { streamType: 'stream' },
  }));
  return { nodes, edges };
}

function runAndCost(opTypes, influent = INFLUENT, unitCosts = undefined) {
  const sim = runSteadyState(linearFlowsheet(opTypes), { nodeParams: { n0: { ...influent } } });
  return estimateCosts(sim, unitCosts);
}

const GRAVITY_TRAIN  = ['inlet', 'screening', 'grit_removal', 'primary_clarifier', 'outlet'];
const RO_TRAIN       = ['inlet', 'screening', 'ro_membrane', 'outlet'];
const STANDARD_TRAIN = ['inlet', 'screening', 'grit_removal', 'primary_clarifier', 'activated_sludge', 'outlet'];

// ── Configuration-sensitive capital ───────────────────────────────────────────

describe('CAPEX — process configuration drives capital cost', () => {
  test('RO-heavy flowsheet costs materially more capital than a same-flow gravity train', () => {
    const gravity = runAndCost(GRAVITY_TRAIN);
    const ro      = runAndCost(RO_TRAIN);

    expect(gravity.capex.totalInstalled).toBeGreaterThan(0);
    expect(ro.capex.totalInstalled).toBeGreaterThan(0);
    // "Materially" — at least double; with defaults the ratio is far larger.
    expect(ro.capex.totalInstalled).toBeGreaterThan(2 * gravity.capex.totalInstalled);
  });

  test('byUnit entries carry label, size, basis and cost; boundary nodes excluded', () => {
    const costs = runAndCost(STANDARD_TRAIN);
    const byUnit = costs.capex.byUnit;

    // inlet (n0) and outlet (n5) are boundaries — no capital entries
    expect(byUnit.n0).toBeUndefined();
    expect(byUnit.n5).toBeUndefined();

    // every process unit is present with a fully-described entry
    for (const id of ['n1', 'n2', 'n3', 'n4']) {
      expect(byUnit[id]).toBeDefined();
      expect(typeof byUnit[id].label).toBe('string');
      expect(typeof byUnit[id].basis).toBe('string');
      expect(byUnit[id].size).toBeGreaterThan(0);
      expect(byUnit[id].cost).toBeGreaterThan(0);
    }

    // aeration is sized on basin volume + blower capacity, not flow alone
    expect(byUnit.n4.basis).toMatch(/volume/i);
    expect(byUnit.n4.basis).toMatch(/blower/i);

    // totals are consistent with the per-unit entries (within rounding)
    const sum = Object.values(byUnit).reduce((s, u) => s + u.cost, 0);
    expect(Math.abs(sum - costs.capex.totalInstalled)).toBeLessThanOrEqual(Object.keys(byUnit).length);
  });
});

// ── Six-tenths-rule scaling ───────────────────────────────────────────────────

describe('CAPEX — economies of scale', () => {
  test('doubling flow less than doubles installed capital for sized units', () => {
    const base    = runAndCost(STANDARD_TRAIN, { ...INFLUENT, Q: 10000 });
    const doubled = runAndCost(STANDARD_TRAIN, { ...INFLUENT, Q: 20000 });

    expect(doubled.capex.totalInstalled).toBeGreaterThan(base.capex.totalInstalled);
    expect(doubled.capex.totalInstalled).toBeLessThan(2 * base.capex.totalInstalled);
  });
});

// ── Empty simulation honesty ──────────────────────────────────────────────────

describe('CAPEX — empty simulation', () => {
  test('no flow data → zero capital, zero totals, explanatory assumption', () => {
    const costs = estimateCosts({});
    expect(costs.total_USD_yr).toBe(0);
    expect(costs.total_annual_cost_USD_yr).toBe(0);
    expect(costs.capex.totalInstalled).toBe(0);
    expect(costs.capex.annualized).toBe(0);
    expect(costs.capex.byUnit).toEqual({});
    expect(costs.lcow_per_m3).toBeNull();
    expect(costs.cost_per_m3_treated_USD).toBeNull();
    expect(costs.assumptions.length).toBeGreaterThan(0);
    expect(costs.assumptions.join(' ')).toMatch(/no influent flow/i);
  });
});

// ── Financial math ────────────────────────────────────────────────────────────

describe('CAPEX — capital recovery factor and annualization', () => {
  test('CRF spot-check: r=5%, n=20 → 0.080243', () => {
    expect(capitalRecoveryFactor(0.05, 20)).toBeCloseTo(0.0802426, 5);
  });

  test('CRF degenerates to straight-line 1/n at r=0', () => {
    expect(capitalRecoveryFactor(0, 20)).toBeCloseTo(0.05, 10);
  });

  test('annualized capital = totalInstalled × CRF (default financials)', () => {
    const costs = runAndCost(STANDARD_TRAIN);
    const expectedCrf = capitalRecoveryFactor(
      DEFAULT_UNIT_COSTS.discountRate, DEFAULT_UNIT_COSTS.plantLifeYears);
    expect(costs.capex.crf).toBeCloseTo(expectedCrf, 5);
    expect(costs.capex.annualized)
      .toBeCloseTo(costs.capex.totalInstalled * expectedCrf, -1); // within rounding
  });

  test('financial parameters overridable via unitCosts; discount rate changes annualized only', () => {
    const base  = runAndCost(STANDARD_TRAIN);
    const highR = runAndCost(STANDARD_TRAIN, INFLUENT, { discountRate: 0.10 });
    expect(highR.capex.totalInstalled).toBeCloseTo(base.capex.totalInstalled, 0);
    expect(highR.capex.annualized).toBeGreaterThan(base.capex.annualized);
    expect(highR.capex.financial.discountRate).toBe(0.10);
  });

  test('Lang factor override scales installed capital proportionally (all-sized train)', () => {
    const base   = runAndCost(STANDARD_TRAIN);
    const heavier = runAndCost(STANDARD_TRAIN, INFLUENT, { lang_factor: 2.0 });
    expect(heavier.capex.totalInstalled / base.capex.totalInstalled)
      .toBeCloseTo(2.0 / DEFAULT_UNIT_COSTS.lang_factor, 2);
  });
});

// ── LCOW ──────────────────────────────────────────────────────────────────────

describe('CAPEX — levelized cost of water', () => {
  test('LCOW present, positive, and consistent for the standard train', () => {
    const costs = runAndCost(STANDARD_TRAIN);
    expect(costs.lcow_per_m3).toBeGreaterThan(0);
    // LCOW includes annualized capital on top of opex-only unit cost
    expect(costs.lcow_per_m3).toBeGreaterThan(costs.cost_per_m3_treated_USD);
    const Q_yr = INFLUENT.Q * 365;
    expect(costs.lcow_per_m3)
      .toBeCloseTo((costs.total_USD_yr + costs.capex.annualized) / Q_yr, 3);
    expect(costs.total_annual_cost_USD_yr)
      .toBeCloseTo(costs.total_USD_yr + costs.capex.annualized, 0);
  });
});

// ── Backward compatibility ────────────────────────────────────────────────────

describe('CAPEX — existing opex field names preserved', () => {
  test('all pre-existing breakdown fields still present under their old names', () => {
    const costs = runAndCost(STANDARD_TRAIN);

    expect(costs.energy).toHaveProperty('aeration_kWh_yr');
    expect(costs.energy).toHaveProperty('total_kWh_yr');
    expect(costs.energy).toHaveProperty('cost_USD_yr');
    expect(costs.chemicals).toHaveProperty('total_USD_yr');
    expect(costs.sludge).toHaveProperty('cost_USD_yr');
    expect(costs.labour).toHaveProperty('staff_count');
    expect(costs.labour).toHaveProperty('cost_USD_yr');
    expect(costs.maintenance).toHaveProperty('capex_estimate_USD');
    expect(costs.maintenance).toHaveProperty('cost_USD_yr');
    expect(costs.total_USD_yr).toBeGreaterThan(0);
    expect(costs.cost_per_m3_treated_USD).toBeGreaterThan(0);
    expect(costs.unitCostsUsed).toBeDefined();
    expect(Array.isArray(costs.assumptions)).toBe(true);
  });

  test('maintenance capex_estimate_USD now reflects the model-estimated installed capital', () => {
    const costs = runAndCost(STANDARD_TRAIN);
    expect(costs.maintenance.capex_estimate_USD).toBe(costs.capex.totalInstalled);
    expect(costs.maintenance.cost_USD_yr)
      .toBeCloseTo(costs.capex.totalInstalled * DEFAULT_UNIT_COSTS.maintenance_pct_of_capex, -1);
  });
});

// ── Fallback allowance ────────────────────────────────────────────────────────

describe('CAPEX — unsized units fall back to a named flow-based allowance', () => {
  test('a passthrough unit (tank) is charged a flow allowance and named in assumptions', () => {
    const costs = runAndCost(['inlet', 'tank', 'outlet']);
    const entry = costs.capex.byUnit.n1;
    expect(entry).toBeDefined();
    expect(entry.basis).toMatch(/allowance/i);
    expect(entry.cost).toBeGreaterThan(0);
    expect(costs.assumptions.some(a => /allowance/i.test(a) && a.includes("'n1'"))).toBe(true);
  });
});
