/**
 * WaterSim Pro — Cost Estimation Module  (Session 6 — Step 29; honesty pass Session 16;
 *                                         per-unit CAPEX model Session 16)
 *
 * Estimates annual operating costs AND installed capital cost for a wastewater
 * treatment process train based on simulation results and configurable unit
 * cost parameters.
 *
 * Operating cost categories:
 *   1. Energy        — aeration (from unit O2 demand), unit-reported energy
 *                      (UV lamps, RO feed pumps), flat pumping allowance,
 *                      digester biogas generation as a negative credit line
 *   2. Chemicals     — aggregated from actual chemical dosing units when present;
 *                      flat allowances only as an explicitly-named fallback
 *   3. Sludge disposal — thickened/dewatered biosolids, tipping fee
 *   4. Labour        — staffing (parametric by plant capacity)
 *   5. Maintenance   — % of model-estimated installed capital (parametric)
 *
 * Capital cost model (per unit operation):
 *   Each unit type present in unitResults is priced from its computed size via
 *   a power-law correlation (the "six-tenths rule"):
 *
 *       direct cost = C0 × (S / S0)^n        (n ≈ 0.6–0.8)
 *
 *   where S is the sizing metric the unit model actually reported (clarifier
 *   surface area, basin volume + blower capacity, membrane permeate capacity,
 *   UV lamp count, digester volume, filter area, thickener area, screen/grit
 *   design flow, dosing capacity). Direct costs are order-of-magnitude 2026-USD
 *   engineering values; each correlation documents its source reasoning inline.
 *   An installation/indirects (Lang-type) factor converts direct → installed.
 *   Units with no size-based correlation fall back to a flow-based allowance
 *   (uc.capex_per_m3_daily_capacity, treated as already-installed) and are
 *   named in assumptions[].
 *
 * Financials:
 *   Annualized capital uses the capital recovery factor
 *       CRF = r(1+r)^n / ((1+r)^n − 1)
 *   Total annual cost = annualized CAPEX + OPEX; LCOW = total annual cost /
 *   annual treated volume (influent basis), reported as `lcow_per_m3` alongside
 *   the existing opex-only `cost_per_m3_treated_USD` (all pre-existing field
 *   names are preserved — new fields are additive).
 *
 * Every default/fallback applied is named in the returned `assumptions[]` array.
 * With no real flow data the estimator returns zero costs plus an explanatory
 * assumption instead of fabricating a plant.
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

  // Maintenance — % of model-estimated installed capital (parametric)
  maintenance_pct_of_capex:    0.02,    // 2 % p.a.
  // Flow-based CAPEX allowance ($/m³·d, installed) applied ONLY to units with
  // no size-based correlation (pumps, tanks, unknown ops). Was formerly the
  // whole-plant parametric CAPEX rate; retained under the same key so existing
  // configs/UI overrides keep working.
  capex_per_m3_daily_capacity: 1200,

  // Capital installation/indirects — Lang-type factor: piping, electrical,
  // instrumentation, sitework, engineering & contingency on top of direct
  // equipment + construction cost. 1.4–2.0 typical for water infrastructure.
  lang_factor:                 1.6,

  // Financial parameters
  currency:                    'USD',
  baseYear:                    2026,
  costIndexFactor:             1.0,     // escalation multiplier on correlation base costs
  discountRate:                0.05,    // real discount rate (fraction/yr)
  plantLifeYears:              20,      // amortization period for CRF
};

// Map dosing-unit chemical types to the unit-cost price coefficient
const CHEMICAL_PRICE_KEY = {
  alum:             'coagulant_USD_per_kg',
  ferric_chloride:  'coagulant_USD_per_kg',
  fecl3:            'coagulant_USD_per_kg',
  polymer:          'polymer_USD_per_kg',
  naocl:            'disinfectant_USD_per_kg',
  hypochlorite:     'disinfectant_USD_per_kg',
};

// ── Capital cost correlations ───────────────────────────────────────────────
//
// Each entry prices one solver unit type from the sizing metric(s) its model
// reports. `components(unit, Q_unit, uc)` returns power-law components
// { C0, S, S0, n }; components with S <= 0 are skipped (e.g. a blower with
// zero O2 demand). All C0 are DIRECT (equipment + construction) costs in
// ~2026 USD at the reference size S0; the Lang factor is applied afterwards.
// Exponents follow the six-tenths rule (n ≈ 0.6–0.8): lower n for civil-works-
// dominated units with strong economies of scale, higher n (→ 1) for modular
// technologies (membranes, UV banks) that scale by adding parallel units.
const CAPEX_CORRELATIONS = {

  // Mechanical bar screen + washer/compactor + channel civil works.
  // ~$120k direct for a 10,000 m³/d channel is a typical order of magnitude;
  // strong economies of scale for the channel/mechanism (n = 0.6).
  screen: {
    basis:     'design flow',
    size_unit: 'm³/d',
    size:      (u, Q) => Q,
    components: (u, Q) => [{ C0: 120000, S: Q, S0: 10000, n: 0.60 }],
  },

  // Vortex/aerated grit chamber + grit classifier/washer.
  // ~$150k direct at 10,000 m³/d; mostly civil + one mechanism (n = 0.65).
  grit: {
    basis:     'design flow',
    size_unit: 'm³/d',
    size:      (u, Q) => Q,
    components: (u, Q) => [{ C0: 150000, S: Q, S0: 10000, n: 0.65 }],
  },

  // Circular primary clarifier: concrete tank + rotating mechanism + launders.
  // ≈ $1.4k/m² direct at the 250 m² reference (a 10,000 m³/d plant at
  // SOR 40 m³/m²/d); circular basins scale at n ≈ 0.7.
  prim_clarifier: {
    basis:     'surface area',
    size_unit: 'm²',
    size:      (u) => u.metrics?.area_m2 || 0,
    components: (u) => [{ C0: 350000, S: u.metrics?.area_m2 || 0, S0: 250, n: 0.70 }],
  },

  // Secondary clarifier: as primary but larger/deeper with flocculating
  // centre-well; ≈ $0.75k/m² direct at the 600 m² reference (≈10,000 m³/d
  // + RAS at SOR 16 m³/m²/d), n ≈ 0.7.
  sec_clarifier: {
    basis:     'surface area',
    size_unit: 'm²',
    size:      (u) => u.metrics?.area_m2 || 0,
    components: (u) => [{ C0: 450000, S: u.metrics?.area_m2 || 0, S0: 600, n: 0.70 }],
  },

  // Activated sludge: two components —
  //  (a) basin civil works ≈ $360/m³ direct at the 2,500 m³ reference
  //      (reinforced concrete, n = 0.75 — large-basin economies are modest);
  //  (b) blowers + diffuser grid sized from the model's O2 demand:
  //      blower kW = O2 kg/d × kWh/kgO2 ÷ 24 h; ≈ $2k/kW direct at 100 kW
  //      reference (n = 0.7).
  aeration: {
    basis:     'basin volume + blower capacity from O2 demand',
    size_unit: 'm³',
    size:      (u) => u.metrics?.volume_m3 || 0,
    components: (u, Q, uc) => {
      const V         = u.metrics?.volume_m3 || 0;
      const blower_kW = (u.metrics?.O2_demand_kg_d || 0) * uc.aeration_kWh_per_kgO2 / 24;
      return [
        { C0: 900000, S: V,         S0: 2500, n: 0.75 },
        { C0: 200000, S: blower_kW, S0: 100,  n: 0.70 },
      ];
    },
  },

  // Granular media filter: media, underdrains, backwash pumps/blowers,
  // concrete boxes ≈ $14k/m² direct at the 50 m² reference (≈10,000 m³/d at
  // HLR 8 m/h); n ≈ 0.7 (cells added in parallel but share backwash system).
  granular_filter: {
    basis:     'filter area',
    size_unit: 'm²',
    size:      (u) => u.metrics?.area_m2 || 0,
    components: (u) => [{ C0: 700000, S: u.metrics?.area_m2 || 0, S0: 50, n: 0.70 }],
  },

  // UV disinfection: modular lamp banks + channel + power/control panels,
  // ≈ $18k/lamp at the 10-lamp reference. Capacity is added in modules, so
  // scaling is close to linear (n = 0.8).
  uv_disinfection: {
    basis:     'lamp count',
    size_unit: 'lamps',
    size:      (u) => u.metrics?.lamp_count || 0,
    components: (u) => [{ C0: 180000, S: u.metrics?.lamp_count || 0, S0: 10, n: 0.80 }],
  },

  // Reverse osmosis: membranes + racks + high-pressure pumps + energy
  // recovery + CIP, ≈ $800/(m³/d) permeate direct at the 7,500 m³/d
  // reference (10,000 m³/d feed at 75% recovery). Trains are modular
  // (n = 0.8) — deliberately the costliest correlation per unit of flow.
  ro: {
    basis:     'permeate capacity',
    size_unit: 'm³/d',
    size:      (u) => u.metrics?.perm_Q_m3_d || 0,
    components: (u) => [{ C0: 6000000, S: u.metrics?.perm_Q_m3_d || 0, S0: 7500, n: 0.80 }],
  },

  // Gravity/DAF thickener: small tank + mechanism, ≈ $150k direct at the
  // 30 m² reference; small mechanical units keep n = 0.6.
  thickener: {
    basis:     'surface area',
    size_unit: 'm²',
    size:      (u) => u.metrics?.area_m2 || 0,
    components: (u) => [{ C0: 150000, S: u.metrics?.area_m2 || 0, S0: 30, n: 0.60 }],
  },

  // Anaerobic digester: heated/mixed tank + gas holder + heat exchange
  // ≈ $900/m³ direct at the 2,000 m³ reference (feed Q × HRT); large
  // concrete/steel tanks scale at n ≈ 0.7. Volume = feed flow × HRT_d
  // (the model reports HRT, not volume, so the volume is reconstructed).
  anaerobic_digest: {
    basis:     'digester volume (feed flow × HRT)',
    size_unit: 'm³',
    size:      (u, Q) => Q * (u.metrics?.HRT_d || 0),
    components: (u, Q) => [{ C0: 1800000, S: Q * (u.metrics?.HRT_d || 0), S0: 2000, n: 0.70 }],
  },

  // Chemical dosing: storage tank + metering pump skid + containment,
  // ≈ $70k direct at the 300 kg/d reference dose capacity; n = 0.6.
  chemical_dosing: {
    basis:     'dosing capacity',
    size_unit: 'kg/d',
    size:      (u) => u.metrics?.dose_kg_d || 0,
    components: (u) => [{ C0: 70000, S: u.metrics?.dose_kg_d || 0, S0: 300, n: 0.60 }],
  },
};

// Hydraulic control elements are priced as equipment, never with the
// whole-plant flow allowance (a valve on a 10,000 m³/d line is a pipe
// fitting, not $12M of treatment capacity).

// Installed pump package (pump + motor + VFD + small civils), priced from
// hydraulic power. ~$40k direct for a 10 kW duty; modular scaling n = 0.7.
CAPEX_CORRELATIONS.pump = {
  basis:     'pump power',
  size_unit: 'kW',
  size:      (u) => u.metrics?.power_kW || 0,
  components: (u) => [{ C0: 40000, S: u.metrics?.power_kW || 0, S0: 10, n: 0.70 }],
};

// Motorized/control valve + actuator + wiring: near-flat with line size —
// ~$8k direct at a 5,000 m³/d line, heavy economies of scale (n = 0.3).
CAPEX_CORRELATIONS.valve = {
  basis:     'line flow',
  size_unit: 'm³/d',
  size:      (u, Q) => Q,
  components: (u, Q) => [{ C0: 8000, S: Q, S0: 5000, n: 0.30 }],
};

// Boundary pseudo-units carry no capital.
const NO_CAPEX_TYPES = new Set(['inlet', 'outlet']);

/**
 * Capital recovery factor: CRF = r(1+r)^n / ((1+r)^n − 1).
 * r = 0 degenerates to straight-line 1/n; n <= 0 returns 0.
 */
function capitalRecoveryFactor(r, n) {
  if (!(n > 0)) return 0;
  if (!(r > 0)) return 1 / n;
  const f = Math.pow(1 + r, n);
  return (r * f) / (f - 1);
}

/** Hydraulic throughput of a unit ≈ sum of its output stream flows (m³/d). */
function unitThroughput(unit) {
  let q = 0;
  for (const s of Object.values(unit.outputs || {})) q += (s && s.Q) || 0;
  return q;
}

/**
 * Per-unit installed CAPEX from power-law correlations.
 * Returns { byUnit, totalInstalled } and appends to assumptions[].
 */
function estimateCapex(unitResults, uc, assumptions) {
  const byUnit = {};
  let totalInstalled = 0;
  let anyCorrelated  = false;
  const indexFactor  = Number(uc.costIndexFactor) > 0 ? Number(uc.costIndexFactor) : 1.0;
  const lang         = Number(uc.lang_factor) > 0 ? Number(uc.lang_factor) : 1.6;

  for (const [nodeId, unit] of Object.entries(unitResults)) {
    const type = unit.type;
    if (NO_CAPEX_TYPES.has(type)) continue;

    const Q_unit = unitThroughput(unit);
    const corr   = CAPEX_CORRELATIONS[type];
    let installed, basis, size, size_unit;

    if (!(Q_unit > 0)) {
      // Disconnected / zero-flow unit — never charge capital for phantom duty.
      installed = 0; basis = 'no throughput — zero capital'; size = 0; size_unit = 'm³/d';
    } else if (corr) {
      const comps  = corr.components(unit, Q_unit, uc).filter(c => c.S > 0);
      size         = corr.size(unit, Q_unit) || 0;
      size_unit    = corr.size_unit;
      if (comps.length === 0) {
        installed = 0;
        basis     = `${corr.basis} = 0 — zero capital`;
      } else {
        const direct = comps.reduce((sum, c) => sum + c.C0 * Math.pow(c.S / c.S0, c.n), 0);
        installed    = direct * indexFactor * lang;
        basis        = corr.basis;
        anyCorrelated = true;
      }
    } else {
      // No size-based correlation (pumps, tanks, unknown ops) — flow allowance.
      installed = Q_unit * uc.capex_per_m3_daily_capacity * indexFactor;
      basis     = `flow-based allowance ($${uc.capex_per_m3_daily_capacity}/m³·d installed)`;
      size      = Q_unit;
      size_unit = 'm³/d';
      assumptions.push(
        `Unit '${nodeId}' (${type}) has no size-based cost correlation — flow-based capital allowance of ` +
        `$${uc.capex_per_m3_daily_capacity}/m³·d (installed) applied to its ${Q_unit.toFixed(0)} m³/d throughput`);
    }

    byUnit[nodeId] = {
      label:     unit.paletteType || type,
      type,
      size:      +Number(size).toFixed(2),
      size_unit,
      basis,
      cost:      +installed.toFixed(0),
    };
    totalInstalled += installed;
  }

  if (anyCorrelated) {
    assumptions.push(
      `Capital costs from per-unit power-law correlations (six-tenths rule), order-of-magnitude ` +
      `${uc.baseYear} ${uc.currency} direct costs × cost index ${indexFactor} × Lang installation/indirects factor ${lang}`);
  }

  return { byUnit, totalInstalled };
}

/**
 * Estimate annual operating cost + installed capital from steady-state
 * simulation results.
 *
 * @param {object} simResults  — output from runSteadyState()
 * @param {object} unitCosts   — optional overrides for DEFAULT_UNIT_COSTS
 * @returns {object} cost breakdown; see fields below. Includes `assumptions[]`
 *                   naming every default/fallback applied.
 */
function estimateCosts(simResults, unitCosts = {}) {
  const uc = { ...DEFAULT_UNIT_COSTS, ...unitCosts };
  const assumptions = [];

  const summary       = simResults?.summary       || {};
  const unitResults   = simResults?.unitResults   || {};
  const streamResults = simResults?.streamResults || {};

  const Q_m3_d = summary.influent?.Q ?? 0;

  const financial = {
    currency:        uc.currency,
    baseYear:        uc.baseYear,
    costIndexFactor: uc.costIndexFactor,
    discountRate:    uc.discountRate,
    plantLifeYears:  uc.plantLifeYears,
    langFactor:      uc.lang_factor,
  };

  // No real flow data → no cost fabrication.
  if (!(Q_m3_d > 0)) {
    assumptions.push('No influent flow data in simulation results — all costs reported as zero');
    const zeroCat = { cost_USD_yr: 0 };
    return {
      energy: {
        aeration_kWh_yr: 0, pumping_kWh_yr: 0, other_kWh_yr: 0, total_kWh_yr: 0,
        biogas_credit_kWh_yr: 0, biogas_credit_USD_yr: 0, cost_USD_yr: 0,
      },
      chemicals: { coagulant_USD_yr: 0, polymer_USD_yr: 0, disinfectant_USD_yr: 0, total_USD_yr: 0 },
      sludge:    { wet_tonnes_yr: 0, dry_tonnes_yr: 0, ...zeroCat },
      labour:    { staff_count: 0, ...zeroCat },
      maintenance: { capex_estimate_USD: 0, ...zeroCat },
      capex: { byUnit: {}, totalInstalled: 0, annualized: 0, crf: 0, financial },
      total_USD_yr: 0,
      total_annual_cost_USD_yr: 0,
      cost_per_m3_treated_USD: null,
      lcow_per_m3: null,
      unitCostsUsed: uc,
      assumptions,
    };
  }

  const Q_m3_yr = Q_m3_d * 365;

  // ── 1. Energy ──────────────────────────────────────────────────────────────
  // Aeration: from O2 demand reported by aeration units
  let total_O2_kg_d = 0;
  // Other unit-reported energy (UV lamps, RO feed pumps, …)
  let other_kWh_d = 0;
  // Digester biogas generation → credit
  let biogas_kWh_d = 0;
  // Modelled pump units report their own energy — counted as pumping energy
  // INSTEAD of the flat allowance, never on top of it.
  let pump_kWh_d = 0;
  let pumpUnitCount = 0;
  for (const unit of Object.values(unitResults)) {
    if (unit.metrics?.O2_demand_kg_d) total_O2_kg_d += unit.metrics.O2_demand_kg_d;
    if (unit.metrics?.energy_kWh_d) {
      if (unit.type === 'pump') { pump_kWh_d += unit.metrics.energy_kWh_d; pumpUnitCount++; }
      else                      { other_kWh_d += unit.metrics.energy_kWh_d; }
    }
    if (unit.biogas?.energy_kWh_d)    biogas_kWh_d  += unit.biogas.energy_kWh_d;
  }

  const aeration_kWh_d  = total_O2_kg_d * uc.aeration_kWh_per_kgO2;
  let pumping_kWh_d;
  if (pumpUnitCount > 0) {
    pumping_kWh_d = pump_kWh_d;
    assumptions.push(
      `Pumping energy from ${pumpUnitCount} modelled pump unit(s) ` +
      `(${pump_kWh_d.toFixed(1)} kWh/d) — the flat per-m³ allowance is not applied`);
  } else {
    pumping_kWh_d = Q_m3_d * uc.pumping_kWh_per_m3;
    assumptions.push(`Pumping energy uses a flat allowance of ${uc.pumping_kWh_per_m3} kWh/m³ treated (no pump units modelled)`);
  }

  const total_kWh_d     = aeration_kWh_d + pumping_kWh_d + other_kWh_d;
  const total_kWh_yr    = total_kWh_d * 365;
  const biogas_credit_kWh_yr = biogas_kWh_d * 365;
  const biogas_credit_USD_yr = biogas_credit_kWh_yr * uc.electricity_USD_per_kWh;
  const energy_cost_yr  = total_kWh_yr * uc.electricity_USD_per_kWh - biogas_credit_USD_yr;
  if (biogas_kWh_d > 0) {
    assumptions.push('Digester biogas generation credited at the electricity purchase price');
  }

  // ── 2. Chemicals ──────────────────────────────────────────────────────────
  // Aggregate from actual chemical dosing units when the flowsheet has them.
  const dosingUnits = Object.values(unitResults).filter(
    u => u.type === 'chemical_dosing' && u.metrics && u.metrics.dose_kg_d != null);

  let coagulant_USD_yr = 0, polymer_USD_yr = 0, disinfectant_USD_yr = 0;

  if (dosingUnits.length > 0) {
    for (const u of dosingUnits) {
      const chem = String(u.metrics.chemical_type || 'alum').toLowerCase().replace(/[- ]/g, '_');
      const priceKey = CHEMICAL_PRICE_KEY[chem];
      const price = uc[priceKey ?? 'coagulant_USD_per_kg'];
      if (!priceKey) {
        assumptions.push(`No unit price defined for dosing chemical '${chem}' — priced as coagulant (${uc.coagulant_USD_per_kg} $/kg)`);
      }
      const usd_yr = (u.metrics.dose_kg_d || 0) * 365 * price;
      if (priceKey === 'polymer_USD_per_kg') polymer_USD_yr += usd_yr;
      else if (priceKey === 'disinfectant_USD_per_kg') disinfectant_USD_yr += usd_yr;
      else coagulant_USD_yr += usd_yr;
    }
  } else {
    // Fallback flat allowances — named explicitly.
    const coagulant_kg_d = Q_m3_d * uc.coagulant_dose_mg_per_L / 1000; // mg/L → kg/m3 → kg/d
    coagulant_USD_yr = coagulant_kg_d * 365 * uc.coagulant_USD_per_kg;
    assumptions.push(`No chemical dosing units in flowsheet — coagulant charged as a flat allowance of ${uc.coagulant_dose_mg_per_L} mg/L on the full influent flow`);

    // Polymer applied to WAS/thickened sludge flows (identified heuristically)
    let WAS_flow_m3_d = 0;
    for (const stream of Object.values(streamResults)) {
      // Identify WAS/sludge streams by low Q, high TSS
      if (stream && stream.TSS > 5000 && stream.Q > 0 && stream.Q < Q_m3_d * 0.1) {
        WAS_flow_m3_d += stream.Q;
      }
    }
    if (WAS_flow_m3_d === 0) {
      WAS_flow_m3_d = Q_m3_d * 0.01;
      assumptions.push('No sludge-like streams found — polymer demand estimated on an assumed sludge flow of 1% of influent');
    }
    const polymer_kg_d = WAS_flow_m3_d * uc.polymer_dose_mg_per_L / 1000;
    polymer_USD_yr = polymer_kg_d * 365 * uc.polymer_USD_per_kg;
    assumptions.push(`Polymer charged as a flat allowance of ${uc.polymer_dose_mg_per_L} mg/L on identified sludge flows`);

    const disinfectant_kg_d = Q_m3_d * uc.disinfectant_dose_mg_per_L / 1000;
    disinfectant_USD_yr = disinfectant_kg_d * 365 * uc.disinfectant_USD_per_kg;
    assumptions.push(`Disinfectant charged as a flat allowance of ${uc.disinfectant_dose_mg_per_L} mg/L on the full influent flow`);
  }

  const chemicals_total_yr = coagulant_USD_yr + polymer_USD_yr + disinfectant_USD_yr;

  // ── 3. Sludge disposal ────────────────────────────────────────────────────
  // Total WAS production from unit metrics
  let WAS_kg_d = 0;
  for (const unit of Object.values(unitResults)) {
    if (unit.metrics?.biomass_kg_d) WAS_kg_d += unit.metrics.biomass_kg_d;
  }
  if (WAS_kg_d === 0) {
    // Fallback: 0.15 kg TSS per m3 treated
    WAS_kg_d = Q_m3_d * 0.15;
    assumptions.push('No biological units reporting sludge production — biosolids estimated at 0.15 kg dry solids per m³ treated');
  }

  const wet_tonnes_d   = WAS_kg_d / (uc.biosolids_dry_fraction * 1000); // wet tonnes/d
  const dry_tonnes_d   = WAS_kg_d / 1000; // dry tonnes/d
  const sludge_USD_yr  = dry_tonnes_d * 365 * uc.biosolids_USD_per_tonne_dry;

  // ── 4. Labour ─────────────────────────────────────────────────────────────
  const Q_MLD         = Q_m3_d / 1000;
  const staff_count   = Math.max(2, Math.round(Q_MLD / 5));
  const labour_USD_yr = staff_count * uc.operator_salary_USD_yr;
  assumptions.push(`Labour is parametric: max(2, round(Q_MLD/5)) operators at $${uc.operator_salary_USD_yr}/yr`);

  // ── 5. Capital (per-unit power-law CAPEX model) ───────────────────────────
  const { byUnit, totalInstalled } = estimateCapex(unitResults, uc, assumptions);

  const r   = Number(uc.discountRate);
  const yrs = Number(uc.plantLifeYears);
  const crf = capitalRecoveryFactor(r, yrs);
  const annualized_capex = totalInstalled * crf;
  if (totalInstalled > 0) {
    assumptions.push(
      `Capital annualized over ${yrs} years at ${(r * 100).toFixed(1)}% discount rate ` +
      `(CRF = ${crf.toFixed(4)}); LCOW uses influent volume as annual treated volume`);
  }

  // ── 6. Maintenance ────────────────────────────────────────────────────────
  const maint_USD_yr  = totalInstalled * uc.maintenance_pct_of_capex;
  assumptions.push(
    `Maintenance is parametric: ${(uc.maintenance_pct_of_capex * 100).toFixed(1)}% of the model-estimated installed capital`);

  // ── Summary ───────────────────────────────────────────────────────────────
  const total_USD_yr = energy_cost_yr + chemicals_total_yr + sludge_USD_yr
                     + labour_USD_yr + maint_USD_yr;

  const cost_per_m3  = Q_m3_yr > 0 ? total_USD_yr / Q_m3_yr : 0;
  const total_annual = total_USD_yr + annualized_capex;
  const lcow_per_m3  = Q_m3_yr > 0 ? total_annual / Q_m3_yr : 0;

  return {
    energy: {
      aeration_kWh_yr:       +(aeration_kWh_d * 365).toFixed(0),
      pumping_kWh_yr:        +(pumping_kWh_d * 365).toFixed(0),
      other_kWh_yr:          +(other_kWh_d * 365).toFixed(0),
      total_kWh_yr:          +total_kWh_yr.toFixed(0),
      biogas_credit_kWh_yr:  +biogas_credit_kWh_yr.toFixed(0),
      biogas_credit_USD_yr:  -+biogas_credit_USD_yr.toFixed(0),  // negative cost line
      cost_USD_yr:           +energy_cost_yr.toFixed(0),
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
      capex_estimate_USD: +totalInstalled.toFixed(0),
      cost_USD_yr:        +maint_USD_yr.toFixed(0),
    },
    capex: {
      byUnit,
      totalInstalled: +totalInstalled.toFixed(0),
      annualized:     +annualized_capex.toFixed(0),
      crf:            +crf.toFixed(6),
      financial,
    },
    total_USD_yr:              +total_USD_yr.toFixed(0),
    total_annual_cost_USD_yr:  +total_annual.toFixed(0),
    cost_per_m3_treated_USD:   +cost_per_m3.toFixed(4),
    lcow_per_m3:               +lcow_per_m3.toFixed(4),
    unitCostsUsed:             uc,
    assumptions,
  };
}

module.exports = { estimateCosts, DEFAULT_UNIT_COSTS, capitalRecoveryFactor, CAPEX_CORRELATIONS };
