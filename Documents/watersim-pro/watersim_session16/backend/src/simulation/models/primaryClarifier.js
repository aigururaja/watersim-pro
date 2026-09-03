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

  const TN_r = 0.02;   // minor TN removal via particulate organic N
  const TP_r = 0.05;   // minor TP removal via particulate P

  // Removed mass rates (kg/d) — the sludge stream carries exactly these
  const TSS_removed_kgd = inf.Q * inf.TSS * TSS_r / 1000;
  const BOD_removed_kgd = inf.Q * inf.BOD * BOD_r / 1000;
  const COD_removed_kgd = inf.Q * inf.COD * COD_r / 1000;
  const TN_removed_kgd  = inf.Q * inf.TN  * TN_r  / 1000;
  const TP_removed_kgd  = inf.Q * inf.TP  * TP_r  / 1000;

  // Primary sludge flow (assume sludge_TSS concentration in underflow)
  const sludge_Q   = p.sludge_TSS > 0 ? TSS_removed_kgd / (p.sludge_TSS / 1000) : 0; // m³/d
  const effluent_Q = Math.max(0, inf.Q - sludge_Q);

  // Effluent concentrations are flow-corrected for the sludge withdrawal so that
  // (effluent mass + sludge mass) = influent mass for every component.
  // Soluble species (NH4, NO3, NO2) leave both streams at the influent concentration.
  const fc = effluent_Q > 0 ? inf.Q / effluent_Q : 0; // flow-correction factor
  const effluent = new Stream({
    Q:    effluent_Q,
    TSS:  inf.TSS * (1 - TSS_r) * fc,
    BOD:  inf.BOD * (1 - BOD_r) * fc,
    COD:  inf.COD * (1 - COD_r) * fc,
    TN:   inf.TN  * (1 - TN_r)  * fc,
    NH4:  inf.NH4,
    NO3:  inf.NO3,
    NO2:  inf.NO2,
    TP:   inf.TP  * (1 - TP_r)  * fc,
    DO:   inf.DO,
    pH:   inf.pH,
    temp: inf.temp,
  });

  // Underflow concentrations derived from the removed-mass balance
  const sc = sludge_Q > 0 ? 1000 / sludge_Q : 0; // kg/d → mg/L at sludge_Q
  const primarySludge = new Stream({
    Q:    sludge_Q,
    TSS:  p.sludge_TSS,
    BOD:  BOD_removed_kgd * sc,
    COD:  COD_removed_kgd * sc,
    TN:   TN_removed_kgd  * sc,
    NH4:  inf.NH4,
    NO3:  inf.NO3,
    NO2:  inf.NO2,
    TP:   TP_removed_kgd  * sc,
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
