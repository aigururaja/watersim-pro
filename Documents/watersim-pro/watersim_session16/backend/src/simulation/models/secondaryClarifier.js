/**
 * Secondary Clarifier — Final Sedimentation Tank
 *
 * Separates biological sludge from mixed liquor.
 * Produces clarified effluent and return activated sludge (RAS).
 *
 * Model: State Point Analysis (Solids Flux Theory) — simplified.
 *
 * Parameters:
 *   SOR_m3_m2_d    surface overflow rate (m³/m²/d)       default 16
 *   depth_m        side water depth (m)                   default 4.0
 *   RAS_ratio      RAS flow / plant influent flow         default 0.5
 *   RAS_TSS        target RAS thickening (mg/L)           default 8000
 *                  (informational — actual RAS TSS is mass-balance derived;
 *                   a warning is emitted when it falls below this target)
 *   TSS_effluent   effluent TSS target (mg/L)             default 12
 *   thickening     thickening factor (MLSS → RAS)         auto from RAS_ratio
 */

const { Stream } = require('../stream');

const DEFAULTS = {
  SOR_m3_m2_d: 16,
  depth_m:     4.0,
  RAS_ratio:   0.5,
  RAS_TSS:     8000,
  TSS_effluent: 12,
};

/**
 * @param {{ influent: Stream }} inputs   — mixed liquor from aeration basin
 * @param {object} params
 * @returns {{ effluent: Stream, RAS: Stream, metrics: object }}
 */
function solve(inputs, params = {}) {
  const p   = { ...DEFAULTS, ...params };
  const inf = inputs.influent || new Stream();

  const area_m2   = inf.Q / p.SOR_m3_m2_d;
  const volume_m3 = area_m2 * p.depth_m;
  const HRT_h     = inf.Q > 0 ? volume_m3 / inf.Q * 24 : 0;

  // Solids flux
  const MLSS = inf.TSS;
  // RAS draw: the clarifier inflow already contains the recycle it feeds
  // (inf.Q = Q_plant·(1+R) at convergence), so drawing RAS_Q = inf.Q·R/(1+R)
  // returns exactly Q_plant·R and the converged recycle ratio relative to the
  // plant influent equals the user's R. (RAS_Q = inf.Q·R would double it.)
  const R     = p.RAS_ratio;
  const RAS_Q = inf.Q * R / (1 + R);
  const eff_Q = inf.Q - RAS_Q;

  // Mass balance: all solids settled and split between RAS and effluent carry-over
  const solids_in_kgd  = inf.Q * MLSS / 1000;
  const eff_TSS        = Math.min(p.TSS_effluent, MLSS);
  const solids_eff     = eff_Q * eff_TSS / 1000;
  const solids_RAS     = Math.max(0, solids_in_kgd - solids_eff);
  const RAS_TSS        = RAS_Q > 0 ? solids_RAS * 1000 / RAS_Q : 0;  // mg/L — mass-balance derived

  // State point check — simplified
  const SLR = area_m2 > 0 ? solids_in_kgd / area_m2 : 0;   // kg TSS / m²/d

  // Soluble constituents (BOD, COD, N species, P, pH) leave in both streams at
  // the mixed-liquor concentration — conserved by construction. TSS is the
  // separated component and comes from the solids mass balance above.
  const effluent = inf.clone({
    Q:   eff_Q,
    TSS: eff_TSS,
  });

  const RAS = inf.clone({
    Q:   RAS_Q,
    TSS: RAS_TSS,
    DO:  0.5,
  });

  // Warning flags
  const warnings = [];
  if (SLR > 6.0)  warnings.push(`High solids loading rate (${SLR.toFixed(1)} kg/m²/d)`);
  if (p.SOR_m3_m2_d > 24) warnings.push('SOR exceeds typical design limit (24 m³/m²/d)');
  if (RAS_TSS > 12000) warnings.push('RAS TSS very high — risk of poor settleability');
  if (RAS_Q > 0 && RAS_TSS < p.RAS_TSS) {
    warnings.push(
      `RAS TSS from mass balance (${RAS_TSS.toFixed(0)} mg/L) is below the target thickening of ${p.RAS_TSS} mg/L — ` +
      `check MLSS, RAS ratio, or clarifier loading`);
  }

  return {
    effluent,
    RAS,
    metrics: {
      area_m2:       +area_m2.toFixed(1),
      volume_m3:     +volume_m3.toFixed(0),
      HRT_h:         +HRT_h.toFixed(2),
      SOR_m3_m2_d:   p.SOR_m3_m2_d,
      SLR_kg_m2_d:   +SLR.toFixed(2),
      RAS_ratio:     p.RAS_ratio,
      RAS_Q_m3_d:    +RAS_Q.toFixed(1),
      RAS_TSS_mg_L:  +RAS_TSS.toFixed(0),
      eff_TSS_mg_L:  eff_TSS,
      warnings,
    },
  };
}

module.exports = { solve, DEFAULTS };
