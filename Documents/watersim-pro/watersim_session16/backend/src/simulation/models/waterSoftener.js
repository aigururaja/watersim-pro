/**
 * Ion-exchange water softener — the ITC plant's SOF vessel.
 *
 * Hard water is passed through a strong-acid cation resin in the sodium form.
 * Calcium and magnesium swap onto the resin and sodium comes off, so the water
 * leaving is soft. The resin saturates, and is regenerated with brine from the
 * 1000 L Sintex tank stirred by the agitator; the spent brine goes to reject.
 *
 * ── WHAT IS COMPUTED ────────────────────────────────────────────────────────
 * Hardness is not a `Stream` field in this simulator, so it is carried as a
 * PARAMETER (`feed_hardness_ppm`) and reported as a metric. This is deliberate
 * and is stated in the node's ⓘ: the model does not pretend to track hardness
 * through the rest of the flowsheet, because nothing downstream of the softener
 * in this plant reads it.
 *
 * The service cycle is real arithmetic, and it is what sizes the salt bill:
 *
 *   resin capacity (g CaCO₃) = resin_litres × capacity_g_per_L
 *   hardness load  (g/m³)    = feed_hardness_ppm − product_hardness_ppm
 *   throughput per run (m³)  = capacity ÷ load
 *   runs per day             = Q ÷ throughput per run
 *   salt per regeneration    = resin_litres × salt_g_per_L ÷ 1000  (kg)
 *
 * Regeneration water — brine draw plus rinse — leaves on a `concentrate`
 * stream so the plant balance closes and the reject line is visible on the
 * canvas rather than implied.
 *
 * Parameters:
 *   resin_litres          resin bed volume (L)                default 500
 *   capacity_g_per_L      exchange capacity (g CaCO₃/L resin) default 50
 *   feed_hardness_ppm     inlet hardness as CaCO₃ (ppm)       default 250
 *   product_hardness_ppm  target outlet hardness (ppm)        default 5
 *   salt_g_per_L          salt dose per litre of resin (g/L)  default 150
 *   regen_water_m3        water used per regeneration (m³)    default 3
 *   rated_flow_m3_h       vessel rating (m³/hr)               default 20
 */
'use strict';

const { Stream } = require('../stream');

const DEFAULTS = {
  resin_litres: 500,
  capacity_g_per_L: 50,
  feed_hardness_ppm: 250,
  product_hardness_ppm: 5,
  salt_g_per_L: 150,
  regen_water_m3: 3,
  rated_flow_m3_h: 20,
};

const num = (v, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

/**
 * @param {{ influent: Stream, RAS?: Stream }} inputs
 * @param {object} params
 * @returns {{ effluent: Stream, concentrate: Stream, metrics: object }}
 */
function solve(inputs, params = {}) {
  const p = { ...DEFAULTS, ...params };

  let feed = inputs.influent || new Stream();
  if (inputs.RAS && inputs.RAS.Q > 0) {
    feed = feed.Q > 0 ? Stream.mix([feed, inputs.RAS]) : inputs.RAS;
  }

  const Q = Math.max(0, num(feed.Q, 0));
  const resin = Math.max(0, num(p.resin_litres, DEFAULTS.resin_litres));
  const capacityPerL = Math.max(0, num(p.capacity_g_per_L, DEFAULTS.capacity_g_per_L));
  const feedHardness = Math.max(0, num(p.feed_hardness_ppm, DEFAULTS.feed_hardness_ppm));
  const productHardness = Math.max(0, num(p.product_hardness_ppm, DEFAULTS.product_hardness_ppm));

  const load = Math.max(0, feedHardness - productHardness); // g CaCO3 per m³
  const bedCapacity_g = resin * capacityPerL;
  const throughputPerRun = load > 0 ? bedCapacity_g / load : Infinity;
  const runsPerDay = Number.isFinite(throughputPerRun) && throughputPerRun > 0 ? Q / throughputPerRun : 0;

  const saltPerRegen_kg = (resin * Math.max(0, num(p.salt_g_per_L, DEFAULTS.salt_g_per_L))) / 1000;
  const saltPerDay_kg = saltPerRegen_kg * runsPerDay;
  const regenWater = Math.max(0, num(p.regen_water_m3, DEFAULTS.regen_water_m3));
  const regenWaterPerDay = regenWater * runsPerDay;

  const rejectQ = Math.min(Q, regenWaterPerDay);
  const productQ = Math.max(0, Q - rejectQ);

  // Softening does not remove organics or solids; only the hardness ions move.
  // Sodium replaces calcium mole-for-charge, so TDS is roughly unchanged and pH
  // shifts a touch alkaline — reported, not applied to downstream chemistry.
  const effluent = feed.clone({ Q: productQ });

  // Spent regenerant: the hardness the bed collected, plus the salt used.
  const hardnessRemoved_kg_d = (productQ * load) / 1000 / 1000; // kg CaCO3/d
  const concentrate = new Stream({
    Q: rejectQ,
    TSS: feed.TSS,
    BOD: feed.BOD,
    COD: feed.COD,
    TN: feed.TN, NH4: feed.NH4, NO3: feed.NO3, TP: feed.TP,
    pH: feed.pH, temp: feed.temp,
  });

  const rated = Math.max(0, num(p.rated_flow_m3_h, DEFAULTS.rated_flow_m3_h));
  const warnings = [];
  if (rated > 0 && Q / 24 > rated) {
    warnings.push(`Softener is passing ${(Q / 24).toFixed(1)} m³/hr against a ${rated} m³/hr rating — expect early hardness breakthrough`);
  }
  if (runsPerDay > 2) {
    warnings.push(`${runsPerDay.toFixed(1)} regenerations per day — the resin bed is undersized for this hardness load`);
  }
  if (load === 0) {
    warnings.push('Feed hardness is at or below the product target — the softener has nothing to remove');
  }

  const metrics = {
    feed_hardness_ppm: +feedHardness.toFixed(1),
    product_hardness_ppm: +productHardness.toFixed(1),
    hardness_removed_ppm: +load.toFixed(1),
    hardness_removed_kg_d: +hardnessRemoved_kg_d.toFixed(3),
    resin_litres: resin,
    bed_capacity_g: +bedCapacity_g.toFixed(0),
    throughput_per_run_m3: Number.isFinite(throughputPerRun) ? +throughputPerRun.toFixed(1) : null,
    regenerations_per_day: +runsPerDay.toFixed(2),
    hours_between_regen: runsPerDay > 0 ? +(24 / runsPerDay).toFixed(2) : null,
    salt_per_regen_kg: +saltPerRegen_kg.toFixed(1),
    salt_kg_d: +saltPerDay_kg.toFixed(2),
    regen_water_m3_d: +regenWaterPerDay.toFixed(2),
    reject_m3_d: +rejectQ.toFixed(2),
    Q_out_m3_d: +productQ.toFixed(1),
    recovery_pct: Q > 0 ? +((productQ / Q) * 100).toFixed(1) : null,
  };
  if (warnings.length) metrics.warnings = warnings;

  return { effluent, concentrate, metrics };
}

module.exports = { solve, DEFAULTS };
