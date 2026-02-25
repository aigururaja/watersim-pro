/**
 * Primary Clarifier — Sedimentation Tank unit operation
 *
 * Settles settleable solids via gravity.
 * Produces clarified primary effluent and primary sludge underflow.
 *
 * Model type: Surface overflow rate (SOR) based empirical model.
 *
 * Parameters:
 *   SOR_m3_m2_d    surface overflow rate (m³/m²/d)  default 40
 *   depth_m        side water depth (m)               default 3.5
 *   TSS_removal    fraction 0–1                       override
 *   BOD_removal    fraction 0–1                       override
 *   sludge_TSS     underflow TSS concentration (g/L)  default 25
 */

const { Stream } = require('../stream');

const DEFAULTS = {
  SOR_m3_m2_d: 40,    // m³/m²/d  (typical: 30–50)
  depth_m:     3.5,   // m
  sludge_TSS:  25000, // mg/L (25 g/L)
  // Removals are estimated from SOR if not given:
  //   WEF Manual of Practice No. 8, Table 4-1
};

/**
 * TSS removal efficiency as a function of SOR (empirical curve).
 * Reference: Metcalf & Eddy, Wastewater Engineering 5th ed., Fig 7-17.
 *
 * @param {number} SOR  m³/m²/d
 * @returns {number} TSS removal fraction
 */
function tssRemovalFromSOR(SOR) {
  // Simple hyperbolic fit: η = a / (b + SOR)
  // Calibrated to ~65% at SOR=30, 60% at SOR=40, 50% at SOR=60
  return Math.min(0.70, Math.max(0.30, 65 / (40 + SOR) + 0.25));
}

/**
 * @param {{ influent: Stream }} inputs
 * @param {object} params
 * @returns {{ effluent: Stream, primarySludge: Stream, metrics: object }}
 */
function solve(inputs, params = {}) {
  const p   = { ...DEFAULTS, ...params };
  const inf = inputs.influent || new Stream();

  // Surface area & volume
  const area_m2   = inf.Q / p.SOR_m3_m2_d;
  const volume_m3 = area_m2 * p.depth_m;
  const HRT_h     = volume_m3 / inf.Q * 24;

  const TSS_r = p.TSS_removal ?? tssRemovalFromSOR(p.SOR_m3_m2_d);
  const BOD_r = p.BOD_removal ?? TSS_r * 0.55;  // BOD removal ≈ 55% of TSS removal
  const COD_r = BOD_r * 0.90;

  // Mass of TSS removed (kg/d)
  const TSS_removed_kgd = inf.Q * inf.TSS * TSS_r / 1000;

  // Primary sludge flow (assume sludge_TSS concentration in underflow)
  const sludge_Q = TSS_removed_kgd / (p.sludge_TSS / 1000); // m³/d
  const effluent_Q = inf.Q - sludge_Q;

  const effluent = new Stream({
    Q:    effluent_Q,
    TSS:  inf.TSS * (1 - TSS_r) * inf.Q / effluent_Q,
    BOD:  inf.BOD * (1 - BOD_r),
    COD:  inf.COD * (1 - COD_r),
    TN:   inf.TN  * 0.98,   // minor TN removal via particulate organic N
    NH4:  inf.NH4,
    TP:   inf.TP  * 0.95,   // minor TP removal via particulate P
    DO:   inf.DO,
    pH:   inf.pH,
    temp: inf.temp,
  });

  const primarySludge = new Stream({
    Q:    sludge_Q,
    TSS:  p.sludge_TSS,
    BOD:  p.sludge_TSS * 0.5, // rough volatile fraction
    COD:  p.sludge_TSS * 0.9,
    TN:   inf.TN * 0.03 * inf.Q / sludge_Q || 0,
    NH4:  inf.NH4 * 0.01,
    TP:   inf.TP  * 0.05 * inf.Q / sludge_Q || 0,
    pH:   inf.pH,
    temp: inf.temp,
  });

  return {
    effluent,
    primarySludge,
    metrics: {
      area_m2:           +area_m2.toFixed(1),
      volume_m3:         +volume_m3.toFixed(0),
      HRT_h:             +HRT_h.toFixed(2),
      SOR_m3_m2_d:       p.SOR_m3_m2_d,
      TSS_removal_pct:   +(TSS_r * 100).toFixed(1),
      BOD_removal_pct:   +(BOD_r * 100).toFixed(1),
      sludge_Q_m3_d:     +sludge_Q.toFixed(1),
      sludge_TSS_mg_L:   p.sludge_TSS,
    },
  };
}

module.exports = { solve, DEFAULTS };
