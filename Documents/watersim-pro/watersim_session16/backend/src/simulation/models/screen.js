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

  // Screened solids (kg/d) — for reporting; flow contribution negligible
  const screenings_kgd = inf.Q * inf.TSS * TSS_r / 1000;  // m³/d × mg/L ÷ 1000 = kg/d

  const effluent = inf.clone({
    TSS: inf.TSS * (1 - TSS_r),
    BOD: inf.BOD * (1 - BOD_r),
    COD: inf.COD * (1 - COD_r),
  });

  // Screenings stream (mass removed, modelled as zero-flow waste)
  const screenings = new Stream({
    Q:   0,
    TSS: inf.TSS * TSS_r * inf.Q / 1e-6 || 0, // conceptual — not a liquid stream
  });

  return {
    effluent,
    screenings,
    metrics: {
      screenType:        p.screenType,
      TSS_removal_pct:   (TSS_r * 100).toFixed(1),
      screenings_kg_d:   +screenings_kgd.toFixed(1),
      headloss_m:        p.headloss_m,
    },
  };
}

module.exports = { solve, DEFAULTS };
