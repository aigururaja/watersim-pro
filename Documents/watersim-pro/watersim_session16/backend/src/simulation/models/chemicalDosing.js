/**
 * Chemical Dosing — Unit Operation  (Session 6 — Step 31)
 *
 * Models the addition of chemicals to a process stream for:
 *   1. Coagulation/flocculation (alum, ferric chloride) → TP removal, TSS removal
 *   2. Polymer dosing            → enhanced dewatering / floc formation (no bulk change)
 *   3. pH adjustment             → NaOH (pH raise) or H₂SO₄ (pH lower)
 *   4. Disinfection              → sodium hypochlorite or UV (TSS/BOD pass-through)
 *
 * Chemical dose is specified in mg/L of the treated stream.
 *
 * Removal efficiencies per chemical type (simplified empirical relationships):
 *
 *  COAGULANT (alum / FeCl3)
 *    TP removal: Molar precipitation — stoichiometric
 *      Alum:  Al₂(SO₄)₃ → AlPO₄ — ~27 mg Al removes ~31 mg P (ratio ≈ 0.87 mol/mol)
 *             simplified: 1 mg/L alum removes ~0.23 mg/L TP at typical pH
 *      FeCl3: ~1 mg/L FeCl3 removes ~0.17 mg/L TP
 *    TSS increase: sludge floc production
 *      Alum:  +0.26 mg/L TSS per mg/L alum (Al(OH)₃ floc + AlPO₄)
 *      FeCl3: +0.40 mg/L TSS per mg/L FeCl3 (Fe(OH)₃ floc)
 *
 *  POLYMER — no bulk stream change; used for floc conditioning
 *
 *  NAOH (pH adjustment up)
 *    pH += dose_mg_L / (buffer_factor_mg_per_unit * 1000)   (rough approximation)
 *
 *  H2SO4 (pH adjustment down)
 *    pH -= dose_mg_L / (buffer_factor_mg_per_unit * 1000)
 *
 *  NaOCl (chlorination / disinfection)
 *    BOD reduction: ~5–15% if significant chlorine demand
 *    CT-based pathogen removal — modelled as simple BOD/TSS trim
 */

'use strict';

const { Stream } = require('../stream');

// Chemical-specific removal coefficients
const CHEMICAL_COEFFICIENTS = {
  alum: {
    TP_removal_per_mg_L:  0.23,   // mg/L TP removed per mg/L alum
    TSS_increase_per_mg_L: 0.26,  // mg/L TSS added per mg/L alum
  },
  ferric_chloride: {
    TP_removal_per_mg_L:  0.17,
    TSS_increase_per_mg_L: 0.40,
  },
  fecl3: {
    TP_removal_per_mg_L:  0.17,
    TSS_increase_per_mg_L: 0.40,
  },
  polymer: {
    TP_removal_per_mg_L:   0,
    TSS_increase_per_mg_L: 0,
  },
  naoh: {
    pH_change_per_mg_L:    0.01,  // approx +0.01 pH per mg/L NaOH (weakly buffered)
  },
  h2so4: {
    pH_change_per_mg_L:   -0.008, // approx -0.008 pH per mg/L H₂SO₄
  },
  naocl: {
    BOD_removal_fraction:  0.08,  // ~8% BOD reduction
    TSS_removal_fraction:  0.02,  // minor TSS reduction
  },
  hypochlorite: {
    BOD_removal_fraction:  0.08,
    TSS_removal_fraction:  0.02,
  },
};

const DEFAULTS = {
  chemical_type: 'alum',          // alum | ferric_chloride | polymer | naoh | h2so4 | naocl
  dose_mg_L:     30,              // mg/L applied to influent stream
  target_pH:     null,            // if set, overrides dose-based pH calculation
};

/**
 * @param {{ influent: Stream }} inputs
 * @param {object} params
 * @returns {{ effluent: Stream, metrics: object }}
 */
function solve(inputs, params = {}) {
  const p   = { ...DEFAULTS, ...params };
  const inf = inputs.influent || new Stream();

  const chemType = (p.chemical_type || 'alum').toLowerCase().replace(/[- ]/g, '_');
  const coeff    = CHEMICAL_COEFFICIENTS[chemType] || CHEMICAL_COEFFICIENTS.alum;
  const dose     = Math.max(0, p.dose_mg_L);

  // Start with influent values
  let Q    = inf.Q;
  let TSS  = inf.TSS;
  let BOD  = inf.BOD;
  let COD  = inf.COD;
  let TN   = inf.TN;
  let NH4  = inf.NH4;
  let NO3  = inf.NO3;
  let NO2  = inf.NO2;
  let TP   = inf.TP;
  let DO   = inf.DO;
  let pH   = inf.pH;
  let temp = inf.temp;

  // Chemical-specific stream modifications
  let dose_kg_d    = Q * dose / 1000;           // kg/d of chemical
  let sludge_kg_d  = 0;                          // chemical sludge produced (for metrics)

  if (coeff.TP_removal_per_mg_L) {
    const TP_removed = Math.min(TP, dose * coeff.TP_removal_per_mg_L);
    TP = Math.max(0, TP - TP_removed);
    sludge_kg_d += Q * (dose * (coeff.TSS_increase_per_mg_L || 0)) / 1000;
    TSS += dose * (coeff.TSS_increase_per_mg_L || 0); // floc increases TSS momentarily
    // Note: TSS increase before clarification — downstream clarifier will remove
  }

  if (coeff.pH_change_per_mg_L) {
    if (p.target_pH != null) {
      // Direct pH target override
      pH = Math.max(0, Math.min(14, p.target_pH));
    } else {
      pH = Math.max(0, Math.min(14, pH + dose * coeff.pH_change_per_mg_L));
    }
  }

  if (coeff.BOD_removal_fraction) {
    BOD = Math.max(0, BOD * (1 - coeff.BOD_removal_fraction));
    COD = Math.max(0, COD * (1 - coeff.BOD_removal_fraction * 0.8));
  }

  if (coeff.TSS_removal_fraction) {
    const tss_removed = TSS * coeff.TSS_removal_fraction;
    sludge_kg_d += Q * tss_removed / 1000;
    TSS = Math.max(0, TSS - tss_removed);
  }

  const effluent = new Stream({ Q, TSS, BOD, COD, TN, NH4, NO3, NO2, TP, DO, pH, temp });

  const metrics = {
    chemical_type:    p.chemical_type,
    dose_mg_L:        +dose.toFixed(2),
    dose_kg_d:        +dose_kg_d.toFixed(1),
    sludge_kg_d:      +sludge_kg_d.toFixed(1),
    TP_in_mg_L:       +inf.TP.toFixed(2),
    TP_out_mg_L:      +TP.toFixed(2),
    TP_removal_pct:   inf.TP > 0 ? +((1 - TP / inf.TP) * 100).toFixed(1) : 0,
    pH_in:            +inf.pH.toFixed(2),
    pH_out:           +pH.toFixed(2),
  };

  return { effluent, metrics };
}

module.exports = { solve, DEFAULTS, CHEMICAL_COEFFICIENTS };
