/**
 * WaterSim Pro — Granular Media Filter  (Session 8 — Step 38)
 *
 * Models a dual-media (anthracite + sand) or mono-media sand filter
 * for tertiary TSS / turbidity polishing prior to disinfection.
 *
 * Hydraulics:
 *   Clean-bed head loss (m) — Kozeny-Carman equation per layer:
 *     h_L = (f_k × L × v_f) / (g × d_e²)
 *   where:
 *     f_k  = Kozeny constant = 180(1−ε)²/ε³  (dimensionless)
 *     L    = bed depth (m)
 *     v_f  = filtration velocity (m/s) = HLR (m/h) / 3600
 *     g    = 9.81 m/s²
 *     d_e  = effective grain diameter (m)
 *     ε    = bed porosity
 *
 *   Clogged head loss (m):
 *     h_clogged = h_clean × (1 + clogging_factor × TSS_load_kg_m2)
 *   Backwash triggered when h_clogged > h_limit_m (typically 2.5–3 m)
 *
 * TSS removal:
 *   Removal efficiency function of filter run time, HLR, and TSS loading.
 *   At start of run (clean bed): ~95–98%.
 *   Breakthrough modelled as logistic function of TSS load.
 *
 * Parameters:
 *   filter_type        'dual_media' | 'sand'            default 'dual_media'
 *   HLR_m_h            hydraulic loading rate (m/h)     default 8
 *   TSS_removal_pct    target TSS removal (%)            default 90
 *   anthracite_depth_m anthracite layer depth (m)        default 0.45 (dual only)
 *   sand_depth_m       sand layer depth (m)              default 0.30
 *   d50_anthracite_mm  anthracite d50 grain size (mm)    default 1.4
 *   d50_sand_mm        sand d50 grain size (mm)          default 0.5
 *   porosity_anthracite bed porosity (-)                 default 0.50
 *   porosity_sand      bed porosity (-)                  default 0.42
 *   temp_C             water temperature (°C)            default 15
 *   backwash_interval_h run time before backwash (h)     default 24
 */

'use strict';

const { Stream } = require('../stream');

// Kinematic viscosity of water (m²/s) as a function of temp (°C)
// ν ≈ 1e-6 × (1 + 0.0337T + 0.000221T²)⁻¹  simplified polynomial
function kinViscosity(T) {
  return 1e-6 / (1 + 0.0337 * T + 0.000221 * T * T);
}

const TYPE_DEFAULTS = {
  dual_media: {
    anthracite_depth_m:     0.45,
    d50_anthracite_mm:      1.4,
    porosity_anthracite:    0.50,
    sand_depth_m:           0.30,
    d50_sand_mm:            0.5,
    porosity_sand:          0.42,
  },
  sand: {
    anthracite_depth_m:     0,
    d50_anthracite_mm:      0,
    porosity_anthracite:    0,
    sand_depth_m:           0.60,
    d50_sand_mm:            0.5,
    porosity_sand:          0.42,
  },
};

const DEFAULTS = {
  filter_type:           'dual_media',
  HLR_m_h:               8,      // m/h — typical range 5–15 m/h
  TSS_removal_pct:       90,     // design target
  temp_C:                15,     // °C
  backwash_interval_h:   24,
  h_limit_m:             2.5,   // maximum allowable head loss before backwash
};

/**
 * Kozeny-Carman clean-bed head loss for one layer.
 * @param {object} layer  { depth_m, d_m, porosity }
 * @param {number} v_m_s  filtration velocity (m/s)
 * @param {number} nu     kinematic viscosity (m²/s)
 * @returns {number} head loss (m)
 */
function kozenyCarman(layer, v_m_s, nu) {
  const { depth_m, d_m, porosity: eps } = layer;
  if (depth_m === 0 || d_m === 0) return 0;
  const kozeny_k = 180 * Math.pow(1 - eps, 2) / Math.pow(eps, 3);
  // h_L = kozeny_k × nu × v / (g × d²)  — simplified form
  return (kozeny_k * nu * v_m_s * depth_m) / (9.81 * d_m * d_m);
}

/**
 * @param {{ influent: Stream }} inputs
 * @param {object} params
 * @returns {{
 *   filtrate:  Stream,
 *   backwash:  Stream,
 *   metrics: { ... }
 * }}
 */
function solve(inputs, params = {}) {
  const td = TYPE_DEFAULTS[params.filter_type || DEFAULTS.filter_type];
  const p  = { ...DEFAULTS, ...td, ...params };

  const inf    = inputs.influent || new Stream();
  const Q_m3_d = inf.Q;
  const T      = p.temp_C ?? inf.temp ?? 15;
  const nu     = kinViscosity(T);

  // ── Filter area ─────────────────────────────────────────────────────────
  const Q_m3_h = Q_m3_d / 24;
  const area_m2 = Q_m3_h / p.HLR_m_h;         // total filter area
  const v_m_s   = p.HLR_m_h / 3600;           // filtration velocity (m/s)

  // ── Clean-bed head loss (Kozeny-Carman) ────────────────────────────────
  const anthracite_layer = {
    depth_m:  p.anthracite_depth_m,
    d_m:      p.d50_anthracite_mm / 1000,
    porosity: p.porosity_anthracite,
  };
  const sand_layer = {
    depth_m:  p.sand_depth_m,
    d_m:      p.d50_sand_mm / 1000,
    porosity: p.porosity_sand,
  };

  const h_anthracite = kozenyCarman(anthracite_layer, v_m_s, nu);
  const h_sand       = kozenyCarman(sand_layer, v_m_s, nu);
  const h_clean      = h_anthracite + h_sand;

  // ── TSS loading & clogging factor ────────────────────────────────────
  // TSS load on filter per run = influent TSS × flow × run time
  const TSS_load_kg_m2 = (inf.TSS / 1000) * Q_m3_h * p.backwash_interval_h / area_m2;
  // Empirical clogging factor: 0.4 m head per kg/m² TSS deposited
  const clogging_factor = 0.4; // m per kg/m²
  const h_clogged = h_clean + clogging_factor * TSS_load_kg_m2;
  const backwash_needed = h_clogged > p.h_limit_m;

  // ── TSS removal ────────────────────────────────────────────────────────
  // Breakthrough correction: if TSS load is high relative to filter capacity,
  // efficiency degrades slightly
  const TSS_capacity_kg_m2 = 0.8 * (p.filter_type === 'dual_media' ? 1.4 : 1.0);
  const breakthrough = Math.min(1, TSS_load_kg_m2 / TSS_capacity_kg_m2);
  const effective_TSS_removal = (p.TSS_removal_pct / 100) * (1 - 0.15 * breakthrough);

  const filtrate_TSS   = inf.TSS * (1 - effective_TSS_removal);
  // BOD co-removal: attached to particles, ~40–60% of BOD removal follows TSS
  const BOD_particle_fraction = 0.45;
  const filtrate_BOD   = inf.BOD * (1 - effective_TSS_removal * BOD_particle_fraction);

  // Backwash flow: ~5% of total throughput, high TSS
  const backwash_Q     = Q_m3_d * 0.05;
  const filtrate_Q     = Q_m3_d - backwash_Q;

  const filtrate_COD   = inf.COD * (1 - effective_TSS_removal * 0.3);
  const filtrate_TP    = inf.TP * (1 - effective_TSS_removal * 0.2); // slight particulate-P removal

  // Backwash concentrations derived from the captured-mass balance (like TSS):
  // whatever the filtrate does not carry ends up in the backwash — no mass created.
  const bw = (in_mg_L, filt_mg_L) =>
    backwash_Q > 0 ? Math.max(0, (in_mg_L * Q_m3_d - filt_mg_L * filtrate_Q) / backwash_Q) : 0;

  const filtrate = new Stream({
    Q:    filtrate_Q,
    TSS:  Math.max(0, filtrate_TSS),
    BOD:  Math.max(0, filtrate_BOD),
    COD:  filtrate_COD,
    TN:   inf.TN,
    NH4:  inf.NH4,
    NO3:  inf.NO3,
    NO2:  inf.NO2,
    TP:   filtrate_TP,
    DO:   inf.DO,
    pH:   inf.pH,
    temp: inf.temp,
  });

  const backwash = new Stream({
    Q:    backwash_Q,
    TSS:  bw(inf.TSS, Math.max(0, filtrate_TSS)),
    BOD:  bw(inf.BOD, Math.max(0, filtrate_BOD)),
    COD:  bw(inf.COD, filtrate_COD),
    TN:   inf.TN,
    NH4:  inf.NH4,
    NO3:  inf.NO3,
    NO2:  inf.NO2,
    TP:   bw(inf.TP, filtrate_TP),
    DO:   0.5,
    pH:   inf.pH,
    temp: inf.temp,
  });

  const total_bed_depth = p.anthracite_depth_m + p.sand_depth_m;

  return {
    filtrate,
    backwash,
    metrics: {
      filter_type:              p.filter_type,
      area_m2:                  +area_m2.toFixed(1),
      HLR_m_h:                  p.HLR_m_h,
      filtration_velocity_m_s:  +v_m_s.toFixed(5),
      total_bed_depth_m:        +total_bed_depth.toFixed(2),
      h_clean_bed_m:            +h_clean.toFixed(3),
      h_clogged_m:              +h_clogged.toFixed(3),
      h_limit_m:                p.h_limit_m,
      TSS_load_kg_m2:           +TSS_load_kg_m2.toFixed(3),
      backwash_needed,
      backwash_interval_h:      p.backwash_interval_h,
      effective_TSS_removal_pct:+(effective_TSS_removal * 100).toFixed(1),
      breakthrough_fraction:    +breakthrough.toFixed(3),
      filtrate_Q_m3_d:          +filtrate_Q.toFixed(1),
      backwash_Q_m3_d:          +backwash_Q.toFixed(1),
    },
  };
}

module.exports = { solve, DEFAULTS, kozenyCarman };
