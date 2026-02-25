/**
 * WaterSim Pro — ADM1-lite Anaerobic Digestion Model  (Session 8 — Step 39)
 *
 * Implements a steady-state simplification of the IWA Anaerobic Digestion
 * Model No. 1 (ADM1), retaining the four-stage biochemical pathway but
 * collapsing the ODE system into algebraic steady-state expressions.
 *
 * ────────────────────────────────────────────────────────────────────────────
 *  Four-stage pathway:
 *    Stage 1 — Hydrolysis
 *      Particulate organics (COD_part, TSS) → soluble monomers (VFAs, sugars)
 *      First-order kinetics: rate = k_hyd × X_part
 *
 *    Stage 2 — Acidogenesis
 *      Sugars + amino acids → short-chain VFAs (acetate, propionate, butyrate)
 *      + CO₂ + H₂
 *
 *    Stage 3 — Acetogenesis
 *      Propionate + butyrate → acetate + CO₂ + H₂
 *
 *    Stage 4 — Methanogenesis
 *      Acetate → CH₄ + CO₂   (acetoclastic)
 *      CO₂ + H₂ → CH₄        (hydrogenotrophic)
 *
 *  Steady-state COD balance:
 *    COD_in = COD_out(digestate) + COD_biogas(CH4)
 *    Methane yield: 0.35 m³ CH₄ (STP) per g COD destroyed
 *
 * ────────────────────────────────────────────────────────────────────────────
 *  Parameters:
 *    HRT_d           hydraulic retention time (days)      default 20
 *    SRT_d           sludge retention time (days)         default 20 (= HRT, no recycle)
 *    temp_C          digester temperature (°C)            default 35 (mesophilic)
 *    COD_removal_pct target VS/COD destruction (%)        default 55
 *    k_hyd_d         hydrolysis rate constant (1/d)       default 0.3
 *    pH_setpoint     digester pH                          default 7.2
 *    VS_to_COD       volatile solids to COD conversion    default 1.42 (g COD/g VS)
 *    biogas_CH4_frac methane fraction of biogas           default 0.65
 *
 *  Temperature corrections:
 *    Mesophilic (30–40 °C): k_hyd at 35 °C; Arrhenius θ = 1.08 per °C from 35
 *    Thermophilic (50–60 °C): k_hyd × 1.8 multiplier, θ = 1.06 per °C from 55
 *
 * ────────────────────────────────────────────────────────────────────────────
 *  Outputs:
 *    digestate     — stabilised sludge stream
 *    filtrate      — reject water (dewatering liquor if dewatering = true)
 *    biogas        — { volume_m3_d, CH4_m3_d, CO2_m3_d, energy_kWh_d }
 *    metrics       — full process performance summary
 */

'use strict';

const { Stream } = require('../stream');

const DEFAULTS = {
  HRT_d:            20,
  SRT_d:            20,
  temp_C:           35,    // mesophilic
  COD_removal_pct:  55,    // VS destruction at 35°C, HRT 20d
  k_hyd_d:          0.3,   // hydrolysis rate (1/d) at 35°C
  pH_setpoint:      7.2,
  VS_to_COD:        1.42,  // g COD / g VS
  biogas_CH4_frac:  0.65,  // 65% CH4 in raw biogas
  dewatering:       false, // if true, separate digestate into cake + filtrate
  cake_DS_pct:      22,    // dewatered cake dry solids (%) if dewatering = true
};

// ── Temperature correction ────────────────────────────────────────────────────
function tempCorrection(temp_C) {
  // Mesophilic range 25–45°C: Arrhenius with θ = 1.08, reference 35°C
  // Thermophilic range 45–60°C: boost × 1.7 from mesophilic, θ = 1.06, ref 55°C
  const T = temp_C;
  if (T < 15) return 0.15; // severe inhibition below 15°C
  if (T <= 45) {
    return Math.pow(1.08, T - 35); // mesophilic Arrhenius
  } else if (T <= 65) {
    return 1.7 * Math.pow(1.06, T - 55); // thermophilic
  }
  return 0.1; // above 65°C — failure
}

// ── Effective VS/COD destruction at given HRT + k_hyd ────────────────────────
// Steady-state batch model: destruction fraction = 1 - exp(-k_hyd * HRT)
// but capped by the user-specified COD_removal_pct for calibration.
function calcCODDestruction(p) {
  const k_eff   = p.k_hyd_d * tempCorrection(p.temp_C);
  const kinetic = 1 - Math.exp(-k_eff * p.HRT_d);   // kinetic fraction
  const limit   = p.COD_removal_pct / 100;           // calibration cap
  return Math.min(kinetic, limit);
}

/**
 * @param {{ influent: Stream }} inputs   — thickened sludge feed
 * @param {object} params
 * @returns {{
 *   digestate: Stream,
 *   filtrate:  Stream | null,
 *   biogas:    { volume_m3_d, CH4_m3_d, CO2_m3_d, energy_kWh_d },
 *   metrics:   object
 * }}
 */
function solve(inputs, params = {}) {
  const p   = { ...DEFAULTS, ...params };
  const inf = inputs.influent || new Stream();

  const Q_in    = inf.Q;        // m³/d  — feed sludge
  const COD_in  = inf.COD;     // mg/L
  const TSS_in  = inf.TSS;     // mg/L (volatile + inert)
  const TN_in   = inf.TN;
  const TP_in   = inf.TP;
  const NH4_in  = inf.NH4;

  // ── Stage 1: Hydrolysis ────────────────────────────────────────────────────
  const cod_destruction  = calcCODDestruction(p);   // fraction of COD destroyed
  const k_eff            = p.k_hyd_d * tempCorrection(p.temp_C);

  // Particulate COD destroyed (hydrolysed fraction)
  // Assumption: 80% of influent COD is particulate/colloidal (typical WAS/PS blend)
  const COD_part_frac    = 0.80;
  const COD_part_in      = COD_in * COD_part_frac;  // mg/L
  const COD_soluble_in   = COD_in * (1 - COD_part_frac);

  const COD_hydrolysed   = COD_part_in * cod_destruction;  // mg/L destroyed

  // ── Stage 2+3: Acidogenesis + Acetogenesis ────────────────────────────────
  // VFAs formed = 0.85 × hydrolysed COD (rest → CO₂ + H₂)
  const VFA_formed       = COD_hydrolysed * 0.85;

  // ── Stage 4: Methanogenesis ────────────────────────────────────────────────
  // Acetoclastic: 70% of VFA COD → CH₄
  // Hydrogenotrophic: remaining H₂ + CO₂ → CH₄
  const CH4_COD_frac     = 0.70;  // VFA→CH₄ conversion
  const COD_to_CH4       = VFA_formed * CH4_COD_frac;  // mg/L COD equivalent

  // Methane yield: 0.35 m³ CH₄ (STP) per kg COD destroyed
  const CH4_yield_m3_kg  = 0.35;
  const COD_destroyed_kg_d = (COD_to_CH4 / 1000) * Q_in;  // kg COD/d → CH₄

  const CH4_m3_d         = COD_destroyed_kg_d * CH4_yield_m3_kg;
  const biogas_m3_d      = CH4_m3_d / p.biogas_CH4_frac;
  const CO2_m3_d         = biogas_m3_d * (1 - p.biogas_CH4_frac) * 0.9; // 90% of non-CH₄ is CO₂
  const H2S_m3_d         = biogas_m3_d * 0.005; // ~0.5% H₂S typical
  // Biogas energy: CH₄ HHV = 10 kWh/m³; generator efficiency ~35%
  const energy_kWh_d     = CH4_m3_d * 10 * 0.35;

  // ── Digestate quality ──────────────────────────────────────────────────────
  // COD remaining in digestate
  const COD_out          = COD_in - COD_hydrolysed;   // mg/L remaining

  // TSS: VS destroyed = cod_destruction × (TSS / VS_to_COD); inert TSS persists
  const VS_destruction   = cod_destruction * 0.90; // VS destruction ≈ slightly < COD destruction
  const VSS_in           = TSS_in * 0.75;          // assume 75% volatile
  const ISS_in           = TSS_in * 0.25;          // inorganic (fixed)
  const VSS_out          = VSS_in * (1 - VS_destruction);
  const TSS_out          = VSS_out + ISS_in;        // mg/L

  // Nitrogen: organically-bound N is mineralised → NH₄-N during digestion
  // ~40–60% of organic N → NH₄ depending on extent of hydrolysis
  const org_N_mineralised_frac = cod_destruction * 0.70;
  const org_N_in         = (TN_in - NH4_in) * 0.9; // approx organic N
  const NH4_released     = org_N_in * org_N_mineralised_frac;
  const NH4_out          = NH4_in + NH4_released;
  const TN_out           = TN_in; // N conserved (leaves as NH₄ in filtrate)

  // Phosphorus: modest release from cell lysis (~30% of bound P solubilised)
  const TP_out           = TP_in;
  const ort_P_released   = TP_in * 0.30 * cod_destruction;

  // Digestate pH — increases due to NH₃ + VFA consumption
  const pH_out           = Math.min(p.pH_setpoint, inf.pH + 0.4 * cod_destruction);

  // Digestate temperature: near digester setpoint (some cooling in transfer)
  const temp_out         = p.temp_C - 1.5;

  // ── Dewatering (optional) ──────────────────────────────────────────────────
  let digestate, filtrate;

  if (!p.dewatering) {
    // No dewatering — full digestate as single output
    digestate = new Stream({
      Q:    Q_in,
      TSS:  TSS_out,
      BOD:  COD_out * 0.4,   // BOD ≈ 40% of stabilised COD
      COD:  COD_out,
      TN:   TN_out,
      NH4:  NH4_out,
      NO3:  0.5,
      NO2:  0,
      TP:   TP_out,
      DO:   0,
      pH:   +pH_out.toFixed(1),
      temp: +temp_out.toFixed(1),
    });
    filtrate = null;
  } else {
    // Gravity belt thickening / centrifuge dewatering
    const DS_frac          = p.cake_DS_pct / 100;
    const solids_kg_d      = (TSS_out / 1000) * Q_in;  // kg/d
    const cake_Q_m3_d      = solids_kg_d / (DS_frac * 1000); // m³/d cake volume
    const filtrate_Q_m3_d  = Q_in - cake_Q_m3_d;

    digestate = new Stream({
      Q:    Math.max(0, cake_Q_m3_d),
      TSS:  DS_frac * 1e6,       // mg/L at DS% (e.g. 220,000 mg/L at 22%)
      BOD:  COD_out * 0.3,
      COD:  COD_out * 0.6,
      TN:   TN_out * 0.3,        // most N goes to filtrate
      NH4:  NH4_out * 0.1,
      NO3:  0,
      NO2:  0,
      TP:   TP_out * 0.4,
      DO:   0,
      pH:   +pH_out.toFixed(1),
      temp: +(temp_out).toFixed(1),
    });

    filtrate = new Stream({
      Q:    Math.max(0, filtrate_Q_m3_d),
      TSS:  500,                  // ~500 mg/L centrate TSS
      BOD:  COD_out * 0.5,
      COD:  COD_out * 0.8,
      TN:   TN_out * 0.95,       // most N in reject water
      NH4:  NH4_out * 1.05,      // NH4-N concentrated in centrate (high-strength return stream)
      NO3:  1,
      NO2:  0,
      TP:   TP_out * 0.8,
      DO:   0,
      pH:   +(pH_out - 0.3).toFixed(1),
      temp: +(temp_out - 1).toFixed(1),
    });
  }

  // ── Stability check ────────────────────────────────────────────────────────
  const FVA_ratio        = 0.15 * (1 - cod_destruction); // VFA/ALK approximation
  const stable           = p.pH_setpoint >= 6.8 && FVA_ratio < 0.3 && p.temp_C >= 25;
  const warnings         = [];
  if (p.temp_C < 25) warnings.push('Digester temperature below 25°C — methanogenesis severely inhibited');
  if (p.pH_setpoint < 6.8) warnings.push('pH < 6.8 — risk of methanogenic inhibition / process failure');
  if (p.HRT_d < 10) warnings.push('HRT < 10 days — risk of biomass washout');
  if (p.HRT_d < 15) warnings.push('HRT < 15 days — reduced VS destruction; monitor VFA/alkalinity ratio');
  if (COD_in < 10000) warnings.push('Influent COD < 10,000 mg/L — verify this is a sludge feed, not a liquid stream');

  return {
    digestate,
    filtrate,
    biogas: {
      volume_m3_d:  +biogas_m3_d.toFixed(1),
      CH4_m3_d:     +CH4_m3_d.toFixed(1),
      CO2_m3_d:     +CO2_m3_d.toFixed(1),
      H2S_m3_d:     +H2S_m3_d.toFixed(2),
      CH4_pct:      +(p.biogas_CH4_frac * 100).toFixed(1),
      energy_kWh_d: +energy_kWh_d.toFixed(1),
      energy_MWh_yr:+(energy_kWh_d * 365 / 1000).toFixed(1),
    },
    metrics: {
      // Process performance
      HRT_d:                    p.HRT_d,
      SRT_d:                    p.SRT_d,
      temp_C:                   p.temp_C,
      temp_correction_factor:   +tempCorrection(p.temp_C).toFixed(3),
      k_hyd_effective_d:        +k_eff.toFixed(4),
      COD_destruction_pct:      +(cod_destruction * 100).toFixed(1),
      VS_destruction_pct:       +(VS_destruction * 100).toFixed(1),
      pH_out:                   +pH_out.toFixed(2),
      // Mass flows
      COD_in_mg_L:              +COD_in.toFixed(0),
      COD_out_mg_L:             +COD_out.toFixed(0),
      TSS_in_mg_L:              +TSS_in.toFixed(0),
      TSS_out_mg_L:             +TSS_out.toFixed(0),
      NH4_released_mg_L:        +NH4_released.toFixed(1),
      NH4_out_mg_L:             +NH4_out.toFixed(1),
      // Nitrogen recycle note
      centrate_NH4_concern:     NH4_out > 500 && p.dewatering,
      // Biogas
      specific_biogas_m3_per_kgVS: Q_in > 0
        ? +(biogas_m3_d / ((VSS_in / 1000) * Q_in * VS_destruction)).toFixed(3)
        : 0,
      // Stability
      stable,
      warnings,
      dewatering: p.dewatering,
    },
  };
}

module.exports = { solve, DEFAULTS, calcCODDestruction, tempCorrection };
