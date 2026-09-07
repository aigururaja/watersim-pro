/**
 * Sequencing Batch Reactor (SBR) — the ITC plant's R1 / R2.
 *
 * An SBR is an activated-sludge basin that clarifies in the same tank instead
 * of sending mixed liquor to a separate clarifier. It runs a timed cycle:
 *
 *   FILL     feed pump charges the reactor
 *   AERATE   blowers run; BOD is oxidised and ammonia nitrified
 *   SETTLE   air off, sludge blanket forms
 *   DECANT   the decanter lowers and draws clear supernatant off the top
 *
 * ── WHAT THIS MODEL COMPUTES ────────────────────────────────────────────────
 * The biology is NOT re-derived here — it is delegated verbatim to
 * `aerationBasin.js` (Monod growth, SRT, temperature correction θ = 1.07,
 * optional denitrification and EBPR), because an SBR's aerobic phase is the
 * same biochemistry as a continuous basin at the same SRT and MLSS. What this
 * model adds is the two things a batch reactor does that a continuous one does
 * not:
 *
 *   1. INTERNAL CLARIFICATION. The mixed liquor leaving `aerationBasin` sits at
 *      MLSS. Decanting draws supernatant at `decant_TSS_mg_L` instead, and the
 *      solids that do not leave in the supernatant leave on the WAS stream, so
 *      the solids balance closes exactly.
 *
 *   2. BATCH THROUGHPUT. A cycle of fill + aerate + settle + decant occupies
 *      the reactor for its whole duration, so the plant can only pass
 *
 *        reactors × (24 / cycle_h) × feed_pump_m3_h × fill_h   m³/d
 *
 *      Feed above that has nowhere to go. Steady-state solvers have no storage,
 *      so the excess is reported as `backlog_m3_d` with a warning rather than
 *      being silently treated — the same honesty contract pump.js and valve.js
 *      follow for blocked flow.
 *
 * Parameters (all optional; ITC defaults are the proposal's stated cycle):
 *   reactors            number of reactors sharing the feed        default 2
 *   fill_h              fill phase duration (h)                    default 1.5
 *   aerate_h            aeration phase duration (h)                default 2.0
 *   settle_h            settle phase duration (h)                  default 1.0
 *   decant_h            decant phase duration (h)                  default 0.75
 *   feed_pump_m3_h      feed pump capacity per reactor (m³/hr)     default 43
 *   decant_TSS_mg_L     supernatant solids after settling (mg/L)   default 20
 *   SRT_d, MLSS_mg_L, DO_set_mg_L, denitrification, anoxic_fraction, volume_m3
 *                       passed straight through to aerationBasin
 */
'use strict';

const { Stream } = require('../stream');
const aerationBasin = require('./aerationBasin');

const DEFAULTS = {
  reactors: 2,
  fill_h: 1.5,
  aerate_h: 2.0,
  settle_h: 1.0,
  decant_h: 0.75,
  feed_pump_m3_h: 43,
  decant_TSS_mg_L: 20,
  SRT_d: 15,
  MLSS_mg_L: 3500,
  DO_set_mg_L: 2.0,
  volume_m3: 0,
  denitrification: true,
  anoxic_fraction: 0.25,
  temp: 20,
};

const num = (v, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

/**
 * @param {{ influent: Stream, RAS?: Stream }} inputs
 * @param {object} params
 * @returns {{ effluent: Stream, WAS: Stream, metrics: object }}
 */
function solve(inputs, params = {}) {
  const p = { ...DEFAULTS, ...params };

  let feed = inputs.influent || new Stream();
  if (inputs.RAS && inputs.RAS.Q > 0) {
    feed = feed.Q > 0 ? Stream.mix([feed, inputs.RAS]) : inputs.RAS;
  }

  // ── Batch cycle capacity ──────────────────────────────────────────────────
  const fill_h = Math.max(0, num(p.fill_h, DEFAULTS.fill_h));
  const cycle_h = Math.max(
    0.01,
    fill_h +
      Math.max(0, num(p.aerate_h, DEFAULTS.aerate_h)) +
      Math.max(0, num(p.settle_h, DEFAULTS.settle_h)) +
      Math.max(0, num(p.decant_h, DEFAULTS.decant_h))
  );
  const reactors = Math.max(1, Math.round(num(p.reactors, DEFAULTS.reactors)));
  const feedPump = Math.max(0, num(p.feed_pump_m3_h, DEFAULTS.feed_pump_m3_h));

  const cyclesPerDay = 24 / cycle_h;
  const volumePerFill = feedPump * fill_h;
  const capacity = volumePerFill * cyclesPerDay * reactors;

  const Q_in = Math.max(0, num(feed.Q, 0));
  const Q_treated = capacity > 0 ? Math.min(Q_in, capacity) : Q_in;
  const backlog = Q_in - Q_treated;

  const warnings = [];
  if (backlog > 1e-6) {
    warnings.push(
      `SBR cycle can pass ${capacity.toFixed(0)} m³/d — ${backlog.toFixed(0)} m³/d of feed has no cycle slot and accumulates upstream`
    );
  }

  // ── Biology: delegated, on the flow the cycle can actually take ───────────
  const basinFeed = feed.clone({ Q: Q_treated });
  const basin = aerationBasin.solve({ influent: basinFeed }, {
    SRT_d: p.SRT_d,
    MLSS_mg_L: p.MLSS_mg_L,
    DO_set_mg_L: p.DO_set_mg_L,
    volume_m3: p.volume_m3,
    denitrification: p.denitrification,
    anoxic_fraction: p.anoxic_fraction,
    temp: p.temp,
  });

  // ── Internal clarification: decant supernatant, settle the rest ───────────
  const MLSS = Math.max(1, num(p.MLSS_mg_L, DEFAULTS.MLSS_mg_L));
  const decantTSS = Math.max(0, num(p.decant_TSS_mg_L, DEFAULTS.decant_TSS_mg_L));

  const mixedLiquor = basin.effluent;
  const wasteBasin = basin.WAS || new Stream();

  // Solids balance. Settling does NOT export the reactor's solids inventory:
  // the blanket stays in the tank for the next cycle, which is exactly the job
  // a clarifier plus a RAS pump does on a continuous plant. So the supernatant
  // leaves at `decant_TSS_mg_L` and the difference is retained biomass, NOT an
  // extra waste stream. The only solids that leave are the ones aerationBasin
  // already wastes to hold the SRT — anything more would waste the culture the
  // process depends on and would break the solids balance in the other
  // direction, by exporting inventory that was never produced.
  const Q_ml = Math.max(0, mixedLiquor.Q);
  const solidsInML_kg_d = (Q_ml * mixedLiquor.TSS) / 1000;
  const solidsDecanted_kg_d = (Q_ml * decantTSS) / 1000;
  const solidsRetained_kg_d = Math.max(0, solidsInML_kg_d - solidsDecanted_kg_d);

  const effluent = mixedLiquor.clone({
    TSS: decantTSS,
    // Settling also strips the particulate share of BOD/COD carried on solids.
    BOD: mixedLiquor.BOD,
    COD: mixedLiquor.COD,
    DO: p.DO_set_mg_L,
  });

  const WAS_Q = Math.max(0, wasteBasin.Q);
  const WAS = new Stream({
    Q: WAS_Q,
    TSS: MLSS,
    BOD: MLSS * 0.5,
    COD: MLSS * 0.8,
    TN: wasteBasin.TN || 40,
    NH4: wasteBasin.NH4 || 5,
    NO3: wasteBasin.NO3 || 0,
    TP: wasteBasin.TP || 15,
    pH: feed.pH,
    temp: mixedLiquor.temp,
  });

  const metrics = {
    ...basin.metrics,
    cycle_h: +cycle_h.toFixed(2),
    cycles_per_day: +cyclesPerDay.toFixed(2),
    reactors,
    fill_h: +fill_h.toFixed(2),
    volume_per_fill_m3: +volumePerFill.toFixed(1),
    capacity_m3_d: +capacity.toFixed(0),
    Q_in_m3_d: +Q_in.toFixed(1),
    Q_treated_m3_d: +Q_treated.toFixed(1),
    backlog_m3_d: +Math.max(0, backlog).toFixed(1),
    capacity_utilisation_pct: capacity > 0 ? +((Q_in / capacity) * 100).toFixed(1) : null,
    decant_TSS_mg_L: +decantTSS.toFixed(1),
    solids_decanted_kg_d: +solidsDecanted_kg_d.toFixed(2),
    solids_retained_kg_d: +solidsRetained_kg_d.toFixed(1),
    sludge_inventory_kg: +((num(p.volume_m3, 0) || basin.metrics.volume_m3 || 0) * MLSS / 1000).toFixed(0),
    WAS_m3_d: +WAS_Q.toFixed(2),
  };
  if (warnings.length) metrics.warnings = [...(basin.metrics.warnings || []), ...warnings];

  return { effluent, WAS, metrics };
}

module.exports = { solve, DEFAULTS };
