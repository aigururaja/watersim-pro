/**
 * Sludge Thickener — Gravity or Dissolved Air Flotation (DAF) Thickener
 *
 * Increases sludge solids concentration for downstream dewatering/digestion.
 *
 * Parameters:
 *   type            'gravity' | 'DAF'             default 'gravity'
 *   target_TSS_g_L  target underflow TSS (g/L)    default 60 gravity, 45 DAF
 *   SLR_kg_m2_d     solids loading rate            default 80 gravity, 120 DAF
 *   capture_pct     solids capture efficiency (%)  default 95
 */

const { Stream } = require('../stream');

const TYPE_DEFAULTS = {
  gravity: { target_TSS_mg_L: 60000, SLR_kg_m2_d: 80,  capture_pct: 95 },
  DAF:     { target_TSS_mg_L: 45000, SLR_kg_m2_d: 120, capture_pct: 98 },
};

const DEFAULTS = {
  type:           'gravity',
  target_TSS_mg_L: null,
  SLR_kg_m2_d:    null,
  capture_pct:    null,
};

/**
 * @param {{ influent: Stream }} inputs   — thin sludge feed
 * @param {object} params
 * @returns {{ thickened: Stream, filtrate: Stream, metrics: object }}
 */
function solve(inputs, params = {}) {
  const p     = { ...DEFAULTS, ...params };
  const inf   = inputs.influent || new Stream();
  const td    = TYPE_DEFAULTS[p.type] || TYPE_DEFAULTS.gravity;

  const target_TSS  = p.target_TSS_mg_L ?? td.target_TSS_mg_L;
  const SLR         = p.SLR_kg_m2_d    ?? td.SLR_kg_m2_d;
  const capture     = (p.capture_pct   ?? td.capture_pct) / 100;

  // Required area
  const solids_in = inf.Q * inf.TSS / 1000;   // kg TSS/d
  const area_m2   = solids_in / SLR;

  // Captured solids → thickened sludge
  const solids_captured = solids_in * capture;
  const thickened_Q     = solids_captured * 1000 / target_TSS;  // m³/d
  const filtrate_Q      = inf.Q - thickened_Q;

  const thickened = new Stream({
    Q:    thickened_Q,
    TSS:  target_TSS,
    BOD:  inf.BOD * 1.2,
    COD:  inf.COD * 1.5,
    TN:   inf.TN  * (thickened_Q / inf.Q),
    NH4:  inf.NH4 * 0.2,
    TP:   inf.TP  * (thickened_Q / inf.Q),
    pH:   inf.pH  - 0.2,
    temp: inf.temp,
  });

  const filtrate = new Stream({
    Q:    Math.max(0, filtrate_Q),
    TSS:  inf.TSS * (1 - capture) * inf.Q / Math.max(1, filtrate_Q),
    BOD:  inf.BOD * 0.4,
    COD:  inf.COD * 0.4,
    TN:   inf.TN  * 0.8,
    NH4:  inf.NH4 * 0.9,
    TP:   inf.TP  * 0.7,
    pH:   inf.pH,
    temp: inf.temp,
  });

  return {
    thickened,
    filtrate,
    metrics: {
      type:            p.type,
      area_m2:         +area_m2.toFixed(1),
      SLR_kg_m2_d:     SLR,
      solids_in_kg_d:  +solids_in.toFixed(1),
      capture_pct:     +(capture * 100).toFixed(1),
      thickened_Q_m3_d:+thickened_Q.toFixed(2),
      thickened_TSS_g_L:+(target_TSS / 1000).toFixed(1),
    },
  };
}

module.exports = { solve, DEFAULTS };
