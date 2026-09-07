/**
 * Oil & grease trap — the ITC plant's OGT on the kitchen influent.
 *
 * Kitchen wastewater is the one stream on this plant that arrives loaded with
 * fats, oil and grease. Left in, FOG coats the SBR's diffusers, blinds the
 * filters and floats on the reactor as scum, so a 400 × 500 mm trap sits on the
 * 100 KLD kitchen line before anything else touches it.
 *
 * ── HOW IT WORKS AND WHAT IS COMPUTED ───────────────────────────────────────
 * A trap is a baffled box: flow slows, grease floats to the surface behind the
 * baffle and is skimmed, settleable grit drops to the floor. Separation is
 * gravity-driven and therefore governed by retention time — a trap sized for
 * 20 minutes at design flow does very little at three times that flow.
 *
 *   HRT_min      = volume_m3 / (Q / 1440)
 *   derate       = clamp(HRT_min / rated_HRT_min, 0.3, 1)
 *   FOG removed  = fog_removal_pct × derate
 *
 * FOG is not a `Stream` field, so it is carried as the `fog_in_mg_L` parameter
 * and reported as a metric — the same honest treatment `waterSoftener.js` gives
 * hardness. What DOES move on the stream is the share of BOD and COD that the
 * grease was carrying (FOG is roughly 2.5 g COD per gram), plus the TSS that
 * settles out with it.
 *
 * The skimmed grease leaves as a `screenings` stream — the solver already knows
 * that role — so the trap's collection duty appears on the canvas instead of
 * vanishing. A trap that is never emptied re-entrains everything it caught,
 * which is why `days_between_cleanout` is reported and warned on.
 *
 * Parameters:
 *   volume_m3        working volume of the trap (m³)          default 0.1
 *   rated_HRT_min    retention time the trap is sized for      default 20
 *   fog_in_mg_L      FOG in the incoming stream (mg/L)         default 150
 *   fog_removal_pct  clean-trap FOG capture (%)                default 85
 *   TSS_removal_pct  clean-trap settleable solids capture (%)  default 30
 *   grease_capacity_m3  volume the trap holds before cleanout  default 0.03
 */
'use strict';

const { Stream } = require('../stream');

const DEFAULTS = {
  volume_m3: 0.1,
  rated_HRT_min: 20,
  fog_in_mg_L: 150,
  fog_removal_pct: 85,
  TSS_removal_pct: 30,
  grease_capacity_m3: 0.03,
};

/** COD carried per gram of FOG — fats are ~2.5 g COD/g, BOD roughly half that. */
const COD_PER_FOG = 2.5;
const BOD_PER_FOG = 1.2;
/** Skimmed grease leaves at roughly 15 % dry matter. */
const GREASE_TSS_mg_L = 150000;

const num = (v, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

/**
 * @param {{ influent: Stream, RAS?: Stream }} inputs
 * @param {object} params
 * @returns {{ effluent: Stream, screenings: Stream, metrics: object }}
 */
function solve(inputs, params = {}) {
  const p = { ...DEFAULTS, ...params };

  let feed = inputs.influent || new Stream();
  if (inputs.RAS && inputs.RAS.Q > 0) {
    feed = feed.Q > 0 ? Stream.mix([feed, inputs.RAS]) : inputs.RAS;
  }

  const Q = Math.max(0, num(feed.Q, 0));
  const volume = Math.max(0, num(p.volume_m3, DEFAULTS.volume_m3));
  const ratedHRT = Math.max(0.1, num(p.rated_HRT_min, DEFAULTS.rated_HRT_min));

  const HRT_min = Q > 0 ? volume / (Q / 1440) : null;
  const derate = HRT_min == null ? 1 : Math.min(1, Math.max(0.3, HRT_min / ratedHRT));

  const fogIn = Math.max(0, num(p.fog_in_mg_L, DEFAULTS.fog_in_mg_L));
  const fogRemoval = Math.min(1, Math.max(0, num(p.fog_removal_pct, DEFAULTS.fog_removal_pct) / 100)) * derate;
  const tssRemoval = Math.min(1, Math.max(0, num(p.TSS_removal_pct, DEFAULTS.TSS_removal_pct) / 100)) * derate;

  const fogOut = fogIn * (1 - fogRemoval);
  const fogRemoved_kg_d = (Q * fogIn * fogRemoval) / 1000;

  // The grease that leaves takes its own oxygen demand with it, capped at what
  // the stream actually carries so the trap can never remove more than exists.
  const codFromFog = Math.min(feed.COD, fogIn * fogRemoval * COD_PER_FOG);
  const bodFromFog = Math.min(feed.BOD, fogIn * fogRemoval * BOD_PER_FOG);

  const solidsRemoved_kg_d = (Q * feed.TSS * tssRemoval) / 1000;
  const greaseQ = GREASE_TSS_mg_L > 0
    ? ((fogRemoved_kg_d + solidsRemoved_kg_d) * 1000) / GREASE_TSS_mg_L
    : 0;
  const forwardQ = Math.max(0, Q - greaseQ);

  const effluent = feed.clone({
    Q: forwardQ,
    TSS: feed.TSS * (1 - tssRemoval),
    COD: Math.max(0, feed.COD - codFromFog),
    BOD: Math.max(0, feed.BOD - bodFromFog),
  });

  const screenings = new Stream({
    Q: greaseQ,
    TSS: GREASE_TSS_mg_L,
    BOD: feed.BOD * 4,
    COD: feed.COD * 4,
    TN: feed.TN, NH4: feed.NH4, TP: feed.TP,
    pH: feed.pH, temp: feed.temp,
  });

  const capacity = Math.max(0, num(p.grease_capacity_m3, DEFAULTS.grease_capacity_m3));
  const daysBetweenCleanout = greaseQ > 0 && capacity > 0 ? capacity / greaseQ : null;

  const warnings = [];
  if (HRT_min != null && HRT_min < ratedHRT) {
    warnings.push(
      `Retention time is ${HRT_min.toFixed(1)} min against a ${ratedHRT} min design — FOG capture derated to ${(derate * 100).toFixed(0)} %`
    );
  }
  if (daysBetweenCleanout != null && daysBetweenCleanout < 7) {
    warnings.push(
      `Trap fills in ${daysBetweenCleanout.toFixed(1)} day(s); if it is not emptied on that cycle the captured grease passes straight through`
    );
  }
  if (volume <= 0) {
    warnings.push('Trap volume is zero — no separation can be computed');
  }

  const metrics = {
    volume_m3: +volume.toFixed(3),
    HRT_min: HRT_min == null ? null : +HRT_min.toFixed(1),
    rated_HRT_min: ratedHRT,
    derate_pct: +(derate * 100).toFixed(0),
    fog_in_mg_L: +fogIn.toFixed(1),
    fog_out_mg_L: +fogOut.toFixed(1),
    fog_removal_pct: +(fogRemoval * 100).toFixed(1),
    fog_removed_kg_d: +fogRemoved_kg_d.toFixed(2),
    TSS_removal_pct: +(tssRemoval * 100).toFixed(1),
    solids_removed_kg_d: +solidsRemoved_kg_d.toFixed(2),
    grease_m3_d: +greaseQ.toFixed(4),
    days_between_cleanout: daysBetweenCleanout == null ? null : +daysBetweenCleanout.toFixed(1),
    Q_out_m3_d: +forwardQ.toFixed(1),
  };
  if (warnings.length) metrics.warnings = warnings;

  return { effluent, screenings, metrics };
}

module.exports = { solve, DEFAULTS };
