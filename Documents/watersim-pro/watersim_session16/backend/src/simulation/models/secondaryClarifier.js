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
 *   RAS_ratio      RAS flow / influent flow               default 0.5
 *   RAS_TSS        RAS TSS concentration (mg/L)           default 8000
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
  level_m:     2.0,   // sludge blanket level (dynamic — from a blanket sensor)
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
  const HRT_h     = volume_m3 / inf.Q * 24;

  // Solids flux
  const MLSS     = inf.TSS;
  const RAS_Q    = inf.Q * p.RAS_ratio;
  const eff_Q    = inf.Q - RAS_Q;

  // Sludge blanket level (dynamic) → effluent solids carry-over.
  // Below ~70% of the tank depth the blanket is safely contained; as it rises
  // toward the surface / overflow weirs, solids escape and effluent TSS climbs.
  const blanket = Number(p.level_m);
  const depth   = p.depth_m || 4;
  let eff_TSS   = p.TSS_effluent;
  let carryover = 1;
  if (!Number.isNaN(blanket) && depth > 0) {
    const ratio = Math.max(0, Math.min(1, blanket / depth));
    if (ratio > 0.7) {
      carryover = 1 + 9 * ((ratio - 0.7) / 0.3);       // up to 10× as blanket nears the surface
      eff_TSS   = +(p.TSS_effluent * carryover).toFixed(1);
    }
  }

  // Mass balance: all solids settled and split between RAS and effluent carry-over
  const solids_in_kgd  = inf.Q * MLSS / 1000;
  const solids_eff     = eff_Q * eff_TSS / 1000;
  const solids_RAS     = solids_in_kgd - solids_eff;
  const RAS_TSS        = solids_RAS * 1000 / RAS_Q;  // mg/L

  // State point check — simplified
  const SLR = solids_in_kgd / area_m2;   // kg TSS / m²/d

  const effluent = inf.clone({
    Q:   eff_Q,
    TSS: eff_TSS,
    BOD: inf.BOD * (eff_Q / inf.Q) * 0.95,
    COD: inf.COD * (eff_Q / inf.Q) * 0.97,
    TN:  inf.TN,
    NH4: inf.NH4,
    NO3: inf.NO3,
    NO2: inf.NO2,
    TP:  inf.TP  * 0.90,
    DO:  inf.DO  * 0.85,
    pH:  inf.pH,
    temp:inf.temp,
  });

  const RAS = inf.clone({
    Q:   RAS_Q,
    TSS: Math.max(p.RAS_TSS, RAS_TSS),
    BOD: inf.BOD * 0.1,
    COD: inf.COD * 0.1,
    NO3: inf.NO3,  // RAS carries nitrified NO3 back to anoxic zone
    NO2: inf.NO2,
    DO:  0.5,
    pH:  inf.pH,
    temp:inf.temp,
  });

  // Warning flags
  const warnings = [];
  if (SLR > 6.0)  warnings.push(`High solids loading rate (${SLR.toFixed(1)} kg/m²/d)`);
  if (p.SOR_m3_m2_d > 24) warnings.push('SOR exceeds typical design limit (24 m³/m²/d)');
  if (RAS_TSS > 12000) warnings.push('RAS TSS very high — risk of poor settleability');
  if (carryover > 1) warnings.push(`Sludge blanket high (${blanket.toFixed(2)} m of ${depth} m) — solids carry-over`);

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
      RAS_TSS_mg_L:  +RAS_TSS.toFixed(0),
      eff_TSS_mg_L:  eff_TSS,
      blanket_level_m: Number.isNaN(blanket) ? null : +blanket.toFixed(2),
      freeboard_m:     Number.isNaN(blanket) ? null : +(depth - blanket).toFixed(2),
      carryover_factor: +carryover.toFixed(2),
      warnings,
    },
  };
}

module.exports = { solve, DEFAULTS };
