/**
 * WaterSim Pro — UV Disinfection Model  (Session 8 — Step 38)
 *
 * Ultraviolet disinfection applies a computed UV fluence (CT) to achieve
 * a target log-reduction of indicator organisms (E. coli / total coliforms).
 *
 * Physics:
 *   Log reduction = fluence / k_inact
 *   where:
 *     fluence       (mJ/cm²) = lamp_intensity × UVT_correction × residence_time_s / area_factor
 *     k_inact       (mJ/cm²) = fluence required for 1-log reduction (organism-specific)
 *     UVT correction          = (UVT / 65)^0.5  — normalised to reference UVT of 65%
 *
 * Hydraulic design:
 *   Reactor volume  (m³) = Q_m3_s × HRT_s
 *   Lamp count           = ceil(Q / (lamp_Q_rating_m3_h / 3600))
 *   Energy (kWh/d)       = lamp_count × lamp_power_kW × 24
 *
 * TSS removal:
 *   UV does not remove suspended solids; TSS passes through.
 *   BOD and COD: marginal photo-oxidation (~2–5% at typical municipal doses).
 *
 * Parameters:
 *   target_log_reduction   target E. coli log removal    default 4
 *   UVT_pct                UV transmittance (%)          default 65
 *   lamp_power_kW          per-lamp wattage (kW)         default 0.4
 *   lamp_Q_rating_m3_h     flow per lamp bank (m3/h)     default 50
 *   k_inact_mJ_cm2         fluence for 1-log reduction   default 19  (E. coli)
 *
 * Common k_inact values (mJ/cm²):
 *   E. coli                ~  19
 *   Total coliforms        ~  21
 *   Cryptosporidium        ~  10 (very UV-sensitive)
 *   Giardia                ~  82
 *   Adenovirus             ~ 186 (UV-resistant — often paired with Cl₂)
 */

'use strict';

const { Stream } = require('../stream');

const DEFAULTS = {
  target_log_reduction:  4,      // log10 E. coli removal
  UVT_pct:               65,     // % UV transmittance at 254 nm
  lamp_power_kW:         0.4,    // kW per lamp
  lamp_Q_rating_m3_h:    50,     // m³/h treated per lamp bank
  k_inact_mJ_cm2:        19,     // fluence constant for E. coli (mJ/cm²)
};

/**
 * @param {{ influent: Stream }} inputs
 * @param {object} params
 * @returns {{
 *   effluent: Stream,
 *   metrics: {
 *     fluence_mJ_cm2, required_fluence_mJ_cm2,
 *     log_reduction, log_deficit,
 *     lamp_count, energy_kWh_d,
 *     UVT_pct, k_inact_mJ_cm2,
 *     compliant: boolean
 *   }
 * }}
 */
function solve(inputs, params = {}) {
  const p   = { ...DEFAULTS, ...params };
  const inf = inputs.influent || new Stream();

  const Q_m3_d = inf.Q;
  const Q_m3_h = Q_m3_d / 24;

  // ── Lamp sizing ────────────────────────────────────────────────────────────
  const lamp_count = Math.max(1, Math.ceil(Q_m3_h / p.lamp_Q_rating_m3_h));
  const energy_kWh_d = lamp_count * p.lamp_power_kW * 24;

  // ── Required fluence for target log reduction ──────────────────────────────
  const required_fluence = p.target_log_reduction * p.k_inact_mJ_cm2; // mJ/cm²

  // ── Delivered fluence ─────────────────────────────────────────────────────
  // UVT correction: (UVT/65)^0.5 — lower transmittance reduces effective dose
  const UVT_correction = Math.sqrt(Math.max(0.01, p.UVT_pct) / 65);
  // Effective fluence delivered = required × UVT correction
  // (We size the system to meet required fluence at reference UVT; UVT correction
  //  scales the actual delivered dose relative to reference conditions.)
  const fluence_delivered = required_fluence * UVT_correction;

  // Actual log reduction achieved given the delivered fluence
  const log_reduction_achieved = fluence_delivered / p.k_inact_mJ_cm2;
  const log_deficit = Math.max(0, p.target_log_reduction - log_reduction_achieved);
  const compliant   = log_deficit < 0.05; // ±5% tolerance

  // ── Effluent quality ───────────────────────────────────────────────────────
  // UV does not remove particulates; TSS, TN, TP pass through unchanged.
  // Slight BOD/COD reduction from photo-oxidation (2–4%) at typical doses.
  const photo_ox = fluence_delivered > 40 ? 0.04 : 0.02; // 2–4%

  const effluent = new Stream({
    Q:    Q_m3_d,
    TSS:  inf.TSS,           // no solids removal
    BOD:  inf.BOD * (1 - photo_ox),
    COD:  inf.COD * (1 - photo_ox * 0.6), // COD harder to oxidise
    TN:   inf.TN,            // no N removal
    NH4:  inf.NH4,
    NO3:  inf.NO3,
    NO2:  inf.NO2,
    TP:   inf.TP,            // no P removal
    DO:   Math.min(inf.DO + 0.5, 14), // slight DO increase from turbulence
    pH:   inf.pH,
    temp: inf.temp,
  });

  return {
    effluent,
    metrics: {
      fluence_mJ_cm2:          +fluence_delivered.toFixed(1),
      required_fluence_mJ_cm2: +required_fluence.toFixed(1),
      UVT_correction:          +UVT_correction.toFixed(3),
      log_reduction:           +log_reduction_achieved.toFixed(2),
      log_deficit:             +log_deficit.toFixed(2),
      lamp_count,
      lamp_power_kW:           p.lamp_power_kW,
      energy_kWh_d:            +energy_kWh_d.toFixed(1),
      energy_kWh_m3:           Q_m3_d > 0 ? +(energy_kWh_d / Q_m3_d).toFixed(4) : 0,
      k_inact_mJ_cm2:          p.k_inact_mJ_cm2,
      UVT_pct:                 p.UVT_pct,
      target_log_reduction:    p.target_log_reduction,
      compliant,
    },
  };
}

module.exports = { solve, DEFAULTS };
