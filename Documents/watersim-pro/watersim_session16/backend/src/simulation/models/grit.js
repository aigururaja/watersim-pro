/**
 * Grit Removal — Grit Chamber unit operation
 *
 * Settles dense inorganic grit particles (sand, gravel, coffee grounds).
 * Removes a portion of TSS with negligible BOD/COD effect.
 *
 * Parameters:
 *   chamberType    'vortex' | 'aerated' | 'horizontal'  (default: 'vortex')
 *   TSS_removal    fraction 0–1  (override auto lookup)
 *   HRT_min        hydraulic retention time (minutes)  (default: 3)
 */

const { Stream } = require('../stream');

const REMOVAL_BY_TYPE = {
  horizontal: { TSS: 0.10, BOD: 0.02, COD: 0.02 },
  aerated:    { TSS: 0.15, BOD: 0.03, COD: 0.03 },
  vortex:     { TSS: 0.12, BOD: 0.02, COD: 0.02 },
};

const DEFAULTS = {
  chamberType: 'vortex',
  HRT_min:     3,
};

/**
 * @param {{ influent: Stream }} inputs
 * @param {object} params
 * @returns {{ effluent: Stream, metrics: object }}
 */
function solve(inputs, params = {}) {
  const p   = { ...DEFAULTS, ...params };
  const inf = inputs.influent || new Stream();

  const removal = REMOVAL_BY_TYPE[p.chamberType] || REMOVAL_BY_TYPE.vortex;
  const TSS_r   = p.TSS_removal ?? removal.TSS;
  const BOD_r   = removal.BOD;
  const COD_r   = removal.COD;

  const grit_kgd = inf.Q * inf.TSS * TSS_r / 1000;

  // Volume of chamber (m³)
  const Q_m3_min = inf.Q / 1440;
  const volume_m3 = Q_m3_min * p.HRT_min;

  const effluent = inf.clone({
    TSS: inf.TSS * (1 - TSS_r),
    BOD: inf.BOD * (1 - BOD_r),
    COD: inf.COD * (1 - COD_r),
  });

  return {
    effluent,
    metrics: {
      chamberType:      p.chamberType,
      TSS_removal_pct:  (TSS_r * 100).toFixed(1),
      grit_removed_kg_d:+grit_kgd.toFixed(1),
      HRT_min:          p.HRT_min,
      chamber_volume_m3:+volume_m3.toFixed(1),
    },
  };
}

module.exports = { solve, DEFAULTS };
