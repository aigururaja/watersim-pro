/**
 * Equalisation / buffer tank — EQT, INT-WT, SHT, Sintex, IRR-WT, FWT, SWT.
 *
 * These tanks make up most of the ITC plant's vessel list, and their job is
 * hydraulic, not chemical: they absorb the difference between an intermittent
 * upstream (three hotel influents on their own schedules, an SBR that decants
 * in batches) and a downstream that wants a steady feed.
 *
 * ── WHAT THIS MODEL DOES AND DOES NOT CLAIM ────────────────────────────────
 * In steady state a buffer tank changes NOTHING about the water: what goes in
 * comes out, at the same composition. This model says so plainly rather than
 * inventing removal. What it computes is the tank's hydraulic duty:
 *
 *   HRT_h            = volume_m3 / (Q / 24)          — hours of holdup
 *   turnovers_per_d  = Q / volume_m3                  — fills per day
 *   buffer_hours     = usable volume ÷ average hourly flow, where usable volume
 *                      is between the low- and high-level setpoints
 *   peak_absorbed_h  = how long the tank can accept `peak_factor` × average
 *                      inflow before the high-level switch trips
 *
 * `peak_absorbed_h` is the number that matters operationally: it is how long
 * the plant survives a lunchtime kitchen surge before the tank overflows. It
 * falls out of the level setpoints, which are exactly what the plant's level
 * transmitters are wired to report.
 *
 * Mixing IS modelled where it is real: several inflows arriving on one tank are
 * mixed flow-weighted by the solver before they reach this model, which is what
 * a common equalisation tank physically does to them.
 *
 * Parameters:
 *   volume_m3        working volume of the tank (m³)               default 100
 *   low_level_pct    pump-stop / low-level setpoint (%)            default 20
 *   high_level_pct   high-level switch setpoint (%)                default 90
 *   peak_factor      peak inflow as a multiple of the average      default 2.0
 *   has_level_switch true when only a switch is fitted, not a transmitter
 */
'use strict';

const { Stream } = require('../stream');

const DEFAULTS = {
  volume_m3: 100,
  low_level_pct: 20,
  high_level_pct: 90,
  peak_factor: 2.0,
  has_level_switch: 0,
};

const num = (v, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

const clampPct = (v, fallback) => Math.min(100, Math.max(0, num(v, fallback)));

/**
 * @param {{ influent: Stream, RAS?: Stream }} inputs
 * @param {object} params
 * @returns {{ effluent: Stream, metrics: object }}
 */
function solve(inputs, params = {}) {
  const p = { ...DEFAULTS, ...params };

  let feed = inputs.influent || new Stream();
  if (inputs.RAS && inputs.RAS.Q > 0) {
    feed = feed.Q > 0 ? Stream.mix([feed, inputs.RAS]) : inputs.RAS;
  }

  const Q = Math.max(0, num(feed.Q, 0));
  const volume = Math.max(0, num(p.volume_m3, DEFAULTS.volume_m3));
  const low = clampPct(p.low_level_pct, DEFAULTS.low_level_pct);
  const high = clampPct(p.high_level_pct, DEFAULTS.high_level_pct);
  const peak = Math.max(1, num(p.peak_factor, DEFAULTS.peak_factor));

  const hourly = Q / 24;
  const usable = volume * Math.max(0, high - low) / 100;

  // A surge at `peak × average` fills the usable band at (peak − 1) × average.
  const surplusPerHour = hourly * (peak - 1);
  const peakAbsorbed = surplusPerHour > 0 ? usable / surplusPerHour : null;

  const warnings = [];
  if (volume <= 0) {
    warnings.push('Tank volume is zero — no buffering is available and no retention time can be reported');
  }
  if (high <= low) {
    warnings.push(`High-level setpoint (${high} %) is not above the low-level setpoint (${low} %) — the usable band is empty`);
  }
  if (peakAbsorbed != null && peakAbsorbed < 1 && volume > 0) {
    warnings.push(
      `Only ${peakAbsorbed.toFixed(1)} h of surge capacity at a peak factor of ${peak} — the high-level switch trips within the hour`
    );
  }

  const metrics = {
    Q_m3_d: +Q.toFixed(1),
    volume_m3: +volume.toFixed(1),
    usable_volume_m3: +usable.toFixed(1),
    HRT_h: Q > 0 ? +(volume / hourly).toFixed(2) : null,
    turnovers_per_day: volume > 0 ? +(Q / volume).toFixed(2) : null,
    buffer_hours: hourly > 0 ? +(usable / hourly).toFixed(2) : null,
    peak_factor: +peak.toFixed(2),
    peak_absorbed_h: peakAbsorbed == null ? null : +peakAbsorbed.toFixed(2),
    low_level_pct: low,
    high_level_pct: high,
    level_instrument: num(p.has_level_switch, 0) ? 'Level switch (high only)' : 'Level transmitter (continuous)',
  };
  if (warnings.length) metrics.warnings = warnings;

  // Composition is untouched — a buffer tank equalises time, not chemistry.
  return { effluent: feed.clone({ Q }), metrics };
}

module.exports = { solve, DEFAULTS };
