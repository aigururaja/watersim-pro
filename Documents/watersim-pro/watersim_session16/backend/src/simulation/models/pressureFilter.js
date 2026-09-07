/**
 * Pressure filter — the ITC plant's ACF, MGF and micron filter.
 *
 * All three are pressure vessels on the same 80 mm CPVC frontal header, and
 * they differ only in media and in what that media takes out:
 *
 *   MGF   multigrade (graded sand + gravel) — bulk turbidity and TSS polish
 *   ACF   activated carbon — residual chlorine, colour, odour, some organics
 *   MICRON cartridge — a final barrier ahead of the UF membranes
 *
 * ── WHAT IS COMPUTED ────────────────────────────────────────────────────────
 * Removal is a media-specific fraction of TSS, BOD and COD, degraded by
 * hydraulic loading: a vessel run above its rated surface loading has less
 * contact time, so removal falls off. The derating is linear in the ratio of
 * actual to rated loading and is floored at 40 % of clean-bed performance,
 * which keeps a badly overloaded filter honest rather than reporting zero.
 *
 *   HLR_m_h    = Q / 24 / area,  area = π D² / 4 from `diameter_mm`
 *   derate     = clamp(rated_HLR / HLR, 0.4, 1)
 *   removal    = media_removal × derate
 *
 * Activated carbon additionally dechlorinates: `chlorine_removal_pct` of any
 * residual is destroyed across the bed. That matters here because the plant
 * doses chlorine into INT-WT upstream and then feeds UF membranes downstream —
 * carbon is what protects the membranes from the chlorine the plant just added.
 *
 * Backwash is a real water loss, not a footnote: `backwash_m3_per_wash` at
 * `backwash_interval_h` returns to EQT and is reported as a `backwash` stream
 * so the solver can route it and the plant balance closes.
 *
 * Parameters:
 *   media                 'multigrade' | 'carbon' | 'micron'   default 'multigrade'
 *   diameter_mm           vessel diameter (mm)                 default 1500
 *   rated_flow_m3_h       vessel rating (m³/hr)                default 25
 *   backwash_interval_h   hours between backwashes             default 24
 *   backwash_m3_per_wash  water used per backwash (m³)         default 4
 *   chlorine_in_ppm       residual entering the vessel (ppm)   default 0
 */
'use strict';

const { Stream } = require('../stream');

const MEDIA = {
  multigrade: {
    label: 'Multigrade (graded sand + gravel)',
    TSS: 0.80, BOD: 0.25, COD: 0.20,
    rated_HLR_m_h: 12,
    chlorine_removal_pct: 0,
  },
  carbon: {
    label: 'Granular activated carbon',
    TSS: 0.55, BOD: 0.45, COD: 0.50,
    rated_HLR_m_h: 10,
    chlorine_removal_pct: 95,
  },
  micron: {
    label: 'Micron cartridge',
    TSS: 0.90, BOD: 0.10, COD: 0.08,
    rated_HLR_m_h: 20,
    chlorine_removal_pct: 0,
  },
};

const DEFAULTS = {
  media: 'multigrade',
  diameter_mm: 1500,
  rated_flow_m3_h: 25,
  backwash_interval_h: 24,
  backwash_m3_per_wash: 4,
  chlorine_in_ppm: 0,
};

const num = (v, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

/**
 * @param {{ influent: Stream, RAS?: Stream }} inputs
 * @param {object} params
 * @returns {{ effluent: Stream, backwash: Stream, metrics: object }}
 */
function solve(inputs, params = {}) {
  const p = { ...DEFAULTS, ...params };

  let feed = inputs.influent || new Stream();
  if (inputs.RAS && inputs.RAS.Q > 0) {
    feed = feed.Q > 0 ? Stream.mix([feed, inputs.RAS]) : inputs.RAS;
  }

  const mediaKey = MEDIA[p.media] ? p.media : DEFAULTS.media;
  const media = MEDIA[mediaKey];

  const Q = Math.max(0, num(feed.Q, 0));
  const diameter_m = Math.max(0.01, num(p.diameter_mm, DEFAULTS.diameter_mm) / 1000);
  const area = (Math.PI * diameter_m * diameter_m) / 4;
  const HLR = area > 0 ? Q / 24 / area : 0;

  const derate = HLR > media.rated_HLR_m_h
    ? Math.max(0.4, media.rated_HLR_m_h / HLR)
    : 1;

  const rTSS = media.TSS * derate;
  const rBOD = media.BOD * derate;
  const rCOD = media.COD * derate;

  // ── Backwash water: a real loss off the top of the throughput ────────────
  const interval = Math.max(0.1, num(p.backwash_interval_h, DEFAULTS.backwash_interval_h));
  const perWash = Math.max(0, num(p.backwash_m3_per_wash, DEFAULTS.backwash_m3_per_wash));
  const washesPerDay = 24 / interval;
  const backwashQ = Math.min(Q, perWash * washesPerDay);
  const forwardQ = Math.max(0, Q - backwashQ);

  // Solids captured on the bed leave with the backwash, so the mass balance
  // closes: what the forward stream loses, the backwash stream carries.
  const solidsRemoved_kg_d = (Q * feed.TSS * rTSS) / 1000;
  const backwashTSS = backwashQ > 0 ? (solidsRemoved_kg_d * 1000) / backwashQ : 0;

  const effluent = feed.clone({
    Q: forwardQ,
    TSS: feed.TSS * (1 - rTSS),
    BOD: feed.BOD * (1 - rBOD),
    COD: feed.COD * (1 - rCOD),
  });

  const backwash = new Stream({
    Q: backwashQ,
    TSS: backwashTSS,
    BOD: feed.BOD,
    COD: feed.COD,
    TN: feed.TN, NH4: feed.NH4, NO3: feed.NO3, TP: feed.TP,
    pH: feed.pH, temp: feed.temp,
  });

  const chlorineIn = Math.max(0, num(p.chlorine_in_ppm, 0));
  const chlorineOut = chlorineIn * (1 - media.chlorine_removal_pct / 100);

  const rated = Math.max(0, num(p.rated_flow_m3_h, DEFAULTS.rated_flow_m3_h));
  const warnings = [];
  if (rated > 0 && Q / 24 > rated) {
    warnings.push(
      `Filter is passing ${(Q / 24).toFixed(1)} m³/hr against a ${rated} m³/hr rating — removal derated to ${(derate * 100).toFixed(0)} % of clean-bed`
    );
  }
  if (backwashQ >= Q && Q > 0) {
    warnings.push('Backwash demand equals or exceeds the forward flow — nothing is being produced');
  }

  const metrics = {
    media: mediaKey,
    media_label: media.label,
    diameter_mm: num(p.diameter_mm, DEFAULTS.diameter_mm),
    area_m2: +area.toFixed(2),
    HLR_m_h: +HLR.toFixed(2),
    rated_HLR_m_h: media.rated_HLR_m_h,
    derate_pct: +(derate * 100).toFixed(0),
    TSS_removal_pct: +(rTSS * 100).toFixed(1),
    BOD_removal_pct: +(rBOD * 100).toFixed(1),
    solids_removed_kg_d: +solidsRemoved_kg_d.toFixed(2),
    backwash_m3_d: +backwashQ.toFixed(2),
    backwashes_per_day: +washesPerDay.toFixed(2),
    Q_out_m3_d: +forwardQ.toFixed(1),
    chlorine_in_ppm: +chlorineIn.toFixed(2),
    chlorine_out_ppm: +chlorineOut.toFixed(3),
    dechlorination_pct: media.chlorine_removal_pct,
  };
  if (warnings.length) metrics.warnings = warnings;

  return { effluent, backwash, metrics };
}

module.exports = { solve, DEFAULTS, MEDIA };
