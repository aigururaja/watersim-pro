/**
 * Screen — Bar Screen / Fine Screen unit operation
 *
 * Removes gross solids from the influent stream.
 * Physical removal only — flow is conserved, slight TSS/BOD reduction.
 *
 * Parameters:
 *   screenType     'coarse' | 'fine' | 'micro'  (default: 'coarse')
 *   TSS_removal    fraction 0–1  (default: 0.05 coarse, 0.15 fine, 0.30 micro)
 *   headloss_m     hydraulic head loss in metres (default: 0.15)
 */

const { Stream } = require('../stream');

const REMOVAL_BY_TYPE = {
  coarse: { TSS: 0.05, BOD: 0.03, COD: 0.03 },
  fine:   { TSS: 0.15, BOD: 0.10, COD: 0.08 },
  micro:  { TSS: 0.30, BOD: 0.20, COD: 0.15 },
};

const DEFAULTS = {
  screenType: 'coarse',
  headloss_m: 0.15,
};

/**
 * @param {{ influent: Stream }} inputs
 * @param {object} params
 * @returns {{ effluent: Stream, screenings: Stream, metrics: object }}
 */
function solve(inputs, params = {}) {
  const p   = { ...DEFAULTS, ...params };
  const inf = inputs.influent || new Stream();

  const removal = REMOVAL_BY_TYPE[p.screenType] || REMOVAL_BY_TYPE.coarse;
  const TSS_r   = p.TSS_removal ?? removal.TSS;
  const BOD_r   = removal.BOD;
  const COD_r   = removal.COD;

  // Screened mass rates (kg/d) — the primary reporting quantity
  const screenings_kgd = inf.Q * inf.TSS * TSS_r / 1000;  // m³/d × mg/L ÷ 1000 = kg/d
  const BOD_removed_kgd = inf.Q * inf.BOD * BOD_r / 1000;
  const COD_removed_kgd = inf.Q * inf.COD * COD_r / 1000;

  // Screenings side stream: dewatered screenings at ~20% dry solids
  // (200,000 mg/L ≈ 200 kg/m³), so Q = mass / 200. Physically plausible small flow.
  const SCREENINGS_TSS_MG_L = 200000;
  const screenings_Q = screenings_kgd > 0 ? screenings_kgd * 1000 / SCREENINGS_TSS_MG_L : 0;
  const eff_Q = Math.max(0, inf.Q - screenings_Q);

  // Flow-corrected effluent so removed mass = screenings mass exactly
  const effluent = inf.clone({
    Q:   eff_Q,
    TSS: eff_Q > 0 ? inf.TSS * (1 - TSS_r) * inf.Q / eff_Q : 0,
    BOD: eff_Q > 0 ? inf.BOD * (1 - BOD_r) * inf.Q / eff_Q : 0,
    COD: eff_Q > 0 ? inf.COD * (1 - COD_r) * inf.Q / eff_Q : 0,
  });

  const screenings = new Stream({
    Q:    screenings_Q,
    TSS:  screenings_Q > 0 ? SCREENINGS_TSS_MG_L : 0,
    BOD:  screenings_Q > 0 ? BOD_removed_kgd * 1000 / screenings_Q : 0,
    COD:  screenings_Q > 0 ? COD_removed_kgd * 1000 / screenings_Q : 0,
    pH:   inf.pH,
    temp: inf.temp,
  });

  return {
    effluent,
    screenings,
    metrics: {
      screenType:         p.screenType,
      TSS_removal_pct:    (TSS_r * 100).toFixed(1),
      screenings_kg_d:    +screenings_kgd.toFixed(1),
      BOD_removed_kg_d:   +BOD_removed_kgd.toFixed(1),
      COD_removed_kg_d:   +COD_removed_kgd.toFixed(1),
      screenings_Q_m3_d:  +screenings_Q.toFixed(3),
      headloss_m:         p.headloss_m,
    },
  };
}

module.exports = { solve, DEFAULTS };
