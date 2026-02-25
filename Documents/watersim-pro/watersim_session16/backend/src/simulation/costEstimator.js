/**
 * WaterSim Pro — Cost Estimation Module  (Session 6 — Step 29)
 *
 * Estimates annual operating costs for a wastewater treatment process train
 * based on simulation results and configurable unit cost parameters.
 *
 * Cost categories:
 *   1. Energy        — aeration, pumping (blowers + recycle pumps)
 *   2. Chemicals     — coagulant, polymer, disinfectant, pH adjustment
 *   3. Sludge disposal — thickened/dewatered biosolids, tipping fee
 *   4. Labour        — staffing (parametric by plant capacity)
 *   5. Maintenance   — % of capital (parametric)
 *
 * Returns a `costBreakdown` object and `totalAnnualCost_USD` suitable for
 * display in the SummaryPanel cost overlay.
 */

'use strict';

// ── Default unit cost coefficients ──────────────────────────────────────────
const DEFAULT_UNIT_COSTS = {
  // Energy
  electricity_USD_per_kWh:     0.12,    // $/kWh
  aeration_kWh_per_kgO2:       1.0,     // typical 1.0–2.0 kWh/kgO2 transferred
  pumping_kWh_per_m3:          0.04,    // general pumping allowance

  // Chemicals — per kg of chemical used (not per m3)
  coagulant_USD_per_kg:        0.30,    // e.g. alum / FeCl3
  coagulant_dose_mg_per_L:     30,      // default alum dose
  polymer_USD_per_kg:          3.50,    // flocculant polymer
  polymer_dose_mg_per_L:       2,       // mg/L WAS flow
  disinfectant_USD_per_kg:     0.25,    // sodium hypochlorite
  disinfectant_dose_mg_per_L:  5,       // mg/L treated Q

  // Sludge disposal
  biosolids_USD_per_tonne_dry: 80,      // $/tonne dry solids — landfill/land application
  biosolids_dry_fraction:      0.25,    // 25 % DS in dewatered cake

  // Labour (simplified — based on plant capacity)
  // staff_count = max(2, round(Q_avg_MLD / 5))
  operator_salary_USD_yr:      60000,

  // Maintenance — % of estimated capital cost (parametric)
  maintenance_pct_of_capex:    0.02,    // 2 % p.a.
  capex_per_m3_daily_capacity: 1200,    // $/m3·d design capacity (typical municipal)
};

/**
 * Estimate annual operating cost from steady-state simulation results.
 *
 * @param {object} simResults  — output from runSteadyState()
 * @param {object} unitCosts   — optional overrides for DEFAULT_UNIT_COSTS
 * @returns {{
 *   energy: { aeration_kWh_yr, pumping_kWh_yr, total_kWh_yr, cost_USD_yr },
 *   chemicals: { coagulant_USD_yr, polymer_USD_yr, disinfectant_USD_yr, total_USD_yr },
 *   sludge: { wet_tonnes_yr, dry_tonnes_yr, cost_USD_yr },
 *   labour: { staff_count, cost_USD_yr },
 *   maintenance: { capex_estimate_USD, cost_USD_yr },
 *   total_USD_yr: number,
 *   cost_per_m3_treated_USD: number,
 *   unitCostsUsed: object,
 * }}
 */
function estimateCosts(simResults, unitCosts = {}) {
  const uc = { ...DEFAULT_UNIT_COSTS, ...unitCosts };

  const summary       = simResults?.summary    || {};
  const unitResults   = simResults?.unitResults || {};
  const streamResults = simResults?.streamResults || {};

  const Q_m3_d        = summary.influent?.Q   || 10000; // m3/d
  const Q_m3_yr       = Q_m3_d * 365;

  // ── 1. Energy ──────────────────────────────────────────────────────────────
  // Sum O2 demand from all aeration basins
  let total_O2_kg_d = 0;
  for (const [nodeId, unit] of Object.entries(unitResults)) {
    if (unit.metrics?.O2_demand_kg_d) {
      total_O2_kg_d += unit.metrics.O2_demand_kg_d;
    }
  }

  const aeration_kWh_d  = total_O2_kg_d * uc.aeration_kWh_per_kgO2;
  const pumping_kWh_d   = Q_m3_d * uc.pumping_kWh_per_m3;
  const total_kWh_d     = aeration_kWh_d + pumping_kWh_d;
  const total_kWh_yr    = total_kWh_d * 365;
  const energy_cost_yr  = total_kWh_yr * uc.electricity_USD_per_kWh;

  // ── 2. Chemicals ──────────────────────────────────────────────────────────
  // Coagulant applied to full influent flow
  const coagulant_kg_d     = Q_m3_d * uc.coagulant_dose_mg_per_L / 1000; // mg/L → kg/m3 → kg/d
  const coagulant_USD_yr   = coagulant_kg_d * 365 * uc.coagulant_USD_per_kg;

  // Polymer applied to WAS/thickened sludge flows
  let WAS_flow_m3_d = 0;
  for (const [sid, stream] of Object.entries(streamResults)) {
    // Identify WAS/sludge streams by low Q, high TSS
    if (stream.TSS > 5000 && stream.Q > 0 && stream.Q < Q_m3_d * 0.1) {
      WAS_flow_m3_d += stream.Q;
    }
  }
  if (WAS_flow_m3_d === 0) WAS_flow_m3_d = Q_m3_d * 0.01; // fallback ~1%

  const polymer_kg_d       = WAS_flow_m3_d * uc.polymer_dose_mg_per_L / 1000;
  const polymer_USD_yr     = polymer_kg_d * 365 * uc.polymer_USD_per_kg;

  const disinfectant_kg_d  = Q_m3_d * uc.disinfectant_dose_mg_per_L / 1000;
  const disinfectant_USD_yr = disinfectant_kg_d * 365 * uc.disinfectant_USD_per_kg;

  const chemicals_total_yr = coagulant_USD_yr + polymer_USD_yr + disinfectant_USD_yr;

  // ── 3. Sludge disposal ────────────────────────────────────────────────────
  // Total WAS production from unit metrics
  let WAS_kg_d = 0;
  for (const [nodeId, unit] of Object.entries(unitResults)) {
    if (unit.metrics?.biomass_kg_d) {
      WAS_kg_d += unit.metrics.biomass_kg_d;
    }
  }
  if (WAS_kg_d === 0) {
    // Fallback: 0.15 kg TSS per m3 treated
    WAS_kg_d = Q_m3_d * 0.15;
  }

  const wet_tonnes_d   = WAS_kg_d / (uc.biosolids_dry_fraction * 1000); // wet tonnes/d
  const dry_tonnes_d   = WAS_kg_d / 1000; // dry tonnes/d
  const sludge_USD_yr  = dry_tonnes_d * 365 * uc.biosolids_USD_per_tonne_dry;

  // ── 4. Labour ─────────────────────────────────────────────────────────────
  const Q_MLD         = Q_m3_d / 1000;
  const staff_count   = Math.max(2, Math.round(Q_MLD / 5));
  const labour_USD_yr = staff_count * uc.operator_salary_USD_yr;

  // ── 5. Maintenance ────────────────────────────────────────────────────────
  const capex_est     = Q_m3_d * uc.capex_per_m3_daily_capacity;
  const maint_USD_yr  = capex_est * uc.maintenance_pct_of_capex;

  // ── Summary ───────────────────────────────────────────────────────────────
  const total_USD_yr = energy_cost_yr + chemicals_total_yr + sludge_USD_yr
                     + labour_USD_yr + maint_USD_yr;

  const cost_per_m3  = Q_m3_yr > 0 ? total_USD_yr / Q_m3_yr : 0;

  return {
    energy: {
      aeration_kWh_yr:   +aeration_kWh_d.toFixed(0) * 365,
      pumping_kWh_yr:    +(pumping_kWh_d * 365).toFixed(0),
      total_kWh_yr:      +total_kWh_yr.toFixed(0),
      cost_USD_yr:       +energy_cost_yr.toFixed(0),
    },
    chemicals: {
      coagulant_USD_yr:    +coagulant_USD_yr.toFixed(0),
      polymer_USD_yr:      +polymer_USD_yr.toFixed(0),
      disinfectant_USD_yr: +disinfectant_USD_yr.toFixed(0),
      total_USD_yr:        +chemicals_total_yr.toFixed(0),
    },
    sludge: {
      wet_tonnes_yr:  +(wet_tonnes_d * 365).toFixed(0),
      dry_tonnes_yr:  +(dry_tonnes_d * 365).toFixed(0),
      cost_USD_yr:    +sludge_USD_yr.toFixed(0),
    },
    labour: {
      staff_count,
      cost_USD_yr: +labour_USD_yr.toFixed(0),
    },
    maintenance: {
      capex_estimate_USD: +capex_est.toFixed(0),
      cost_USD_yr:        +maint_USD_yr.toFixed(0),
    },
    total_USD_yr:              +total_USD_yr.toFixed(0),
    cost_per_m3_treated_USD:   +cost_per_m3.toFixed(4),
    unitCostsUsed:             uc,
  };
}

module.exports = { estimateCosts, DEFAULT_UNIT_COSTS };
