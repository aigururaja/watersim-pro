/**
 * Aeration Basin — Activated Sludge unit operation
 *
 * Modes:
 *   1. Conventional aerobic   (denitrification: false, ebpr_config: 'none')
 *   2. Pre-Anoxic + Aerobic   (denitrification: true)
 *   3. EBPR — Simple          (ebpr_config: 'simple')  anaerobic selector + aerobic luxury uptake
 *   4. EBPR — UCT             (ebpr_config: 'uct')     Anaerobic → Anoxic → Aerobic
 *                             RAS → anoxic; MLR anoxic → anaerobic
 *                             Prevents NO₃ entry to anaerobic zone (key UCT innovation)
 *   5. EBPR — JHB             (ebpr_config: 'jhb')     Pre-anoxic → Anaerobic → Anoxic → Aerobic
 *                             RAS denitrified in pre-anoxic before anaerobic zone
 *
 * References:
 *   Barnard (1975) — original UCT concept
 *   Ekama & Wentzel (2008) — Biological Nutrient Removal
 *   WRC Report TT261 (2002) — General Activated Sludge-Digestion Model
 *
 * Session 9 — Step 40: Advanced EBPR (UCT/JHB)
 */
'use strict';

const { Stream } = require('../stream');

const DEFAULTS = {
  SRT_d:               10,
  DO_set_mg_L:          2.0,
  MLSS_mg_L:         3000,
  volume_m3:            0,
  Y:                    0.60,
  kd:                   0.06,
  mu_max_BOD:           6.0,
  Ks_BOD:              60,
  mu_max_NH4:           0.75,
  Ks_NH4:               0.74,
  DO_Ks:                0.2,
  theta_T:              1.07,
  denitrification:      false,
  anoxic_fraction:      0.30,
  mu_max_denit:         0.40,
  Ks_NO3:               0.10,
  bOD_NO3_ratio:        3.5,
  // EBPR
  ebpr:                 false,
  ebpr_config:          'none',     // 'none' | 'simple' | 'uct' | 'jhb'
  ebpr_uptake_rate:     0.15,
  Y_PAO:                0.65,
  PAO_fraction:         0.30,
  VFA_COD_fraction:     0.15,
  anaerobic_fraction:   0.15,       // anaerobic zone fraction (UCT/JHB/simple)
  uct_anoxic_fraction:  0.25,       // main anoxic zone fraction (UCT/JHB)
  MLR_ratio:            3.0,        // Mixed Liquor Recycle (aerobic→anoxic)
  jhb_preanoxic_fraction: 0.08,     // pre-anoxic zone fraction (JHB only)
  temp:                 20,
};

function tempCorrect(rate, T, theta) {
  return rate * Math.pow(theta, T - 20);
}

function solveAnoxic({ NO3_in, BOD_in, Q_in, mu_denit, Ks_NO3, kd, SRT_d, bOD_NO3_ratio }) {
  if (NO3_in < 0.1) return { NO3_eff: NO3_in, TN_removed: 0, BOD_consumed: 0 };
  const max_NO3_from_BOD = BOD_in / bOD_NO3_ratio;
  const kinetic_floor = Math.max(0,
    Ks_NO3 * (1 + kd * SRT_d) / (SRT_d * (mu_denit - kd) - 1 + 1e-9)
  );
  const NO3_eff = Math.max(kinetic_floor, NO3_in - max_NO3_from_BOD, 0);
  const TN_removed  = Math.max(0, NO3_in - NO3_eff);
  const BOD_consumed = TN_removed * bOD_NO3_ratio;
  return { NO3_eff, TN_removed, BOD_consumed };
}

function solveAerobic({ feed, p, mu_BOD, mu_NH4, ebprActive, X_PAO, ebpr_P_uptake_capacity }) {
  const BOD_e = Math.max(0,
    p.Ks_BOD * (1 + p.kd * p.SRT_d) /
    (p.SRT_d * (p.Y * mu_BOD - p.kd) - 1 + 1e-9)
  );
  const min_SRT_nit = 1 / (mu_NH4 + 1e-9);
  let NH4_e;
  if (p.SRT_d > min_SRT_nit * 1.5) {
    NH4_e = Math.max(0,
      p.Ks_NH4 * (1 + p.kd * p.SRT_d) / (p.SRT_d * (mu_NH4 - p.kd) - 1 + 1e-9)
    );
  } else {
    const nit_eff = Math.max(0, p.SRT_d / (min_SRT_nit * 1.5));
    NH4_e = feed.NH4 * (1 - nit_eff * 0.90);
  }
  const NH4_nit = Math.max(0, feed.NH4 - NH4_e);
  const NO3_e   = (feed.NO3 ?? 0) + NH4_nit;
  const dBOD    = Math.max(0, feed.BOD - BOD_e);
  const P_x_kgd = feed.Q * dBOD * (p.Y / (1 + p.kd * p.SRT_d)) / 1000;

  let volume = p.volume_m3;
  if (volume <= 0) {
    const MLVSS = p.MLSS_mg_L * 0.80;
    volume = Math.max(50, (P_x_kgd * 1000 * p.SRT_d) / MLVSS);
    const aerobic_frac = 1 - (p.anoxic_fraction||0) - (p.anaerobic_fraction||0) -
                         (p.uct_anoxic_fraction||0) - (p.jhb_preanoxic_fraction||0);
    if (aerobic_frac > 0.05 && aerobic_frac < 0.99) volume /= aerobic_frac;
  }
  const HRT_h = volume / feed.Q * 24;
  const O2_demand = feed.Q / 1000 * (1.5 * dBOD - 1.42 * P_x_kgd * 1000 / feed.Q + 4.33 * NH4_nit);
  const TN_e = Math.max(0, feed.TN - NH4_nit * 0.1 - feed.TN * 0.08);
  let TP_e;
  if (ebprActive) {
    const uptake = Math.min(ebpr_P_uptake_capacity ?? 0, Math.max(0, feed.TP - feed.TP * 0.05));
    TP_e = Math.max(0.2, feed.TP - uptake);
  } else {
    TP_e = feed.TP * 0.92;
  }
  return { BOD_e, NH4_e, NO3_e: Math.max(0, NO3_e), TP_e, O2_demand, dBOD, NH4_nit, P_x_kgd, volume, HRT_h, TN_e };
}

// ── UCT Process ───────────────────────────────────────────────────────────────
function solveUCT({ inf, RAS, p, temp, mu_BOD, mu_NH4, mu_denit, MLVSS, X_PAO }) {
  const Qin      = inf.Q;
  const MLR_ratio = p.MLR_ratio ?? 3.0;
  const Qras     = RAS ? RAS.Q : Qin * 0.5;
  const Qmlr     = Qin * MLR_ratio;
  const ras_stream = RAS || new Stream({ Q: Qras, NO3: 20, TSS: 6000, BOD: 200, TN: 40, TP: 15, NH4: 5, temp });
  const anox_feed  = Stream.mix([inf, ras_stream]);

  const r_anox = solveAnoxic({
    NO3_in: ras_stream.NO3 ?? 20, BOD_in: inf.BOD, Q_in: anox_feed.Q,
    mu_denit, Ks_NO3: p.Ks_NO3, kd: p.kd, SRT_d: p.SRT_d, bOD_NO3_ratio: p.bOD_NO3_ratio,
  });

  const NO3_to_anaerobic = r_anox.NO3_eff;
  const NO3_suppress = NO3_to_anaerobic > 1 ? Math.max(0.2, 1 - (NO3_to_anaerobic - 1) / 20) : 1.0;
  const VFA_avail    = inf.COD * p.VFA_COD_fraction * NO3_suppress;
  const P_released   = VFA_avail * 0.5;

  const anaerobic_out = inf.clone({
    COD: Math.max(0, inf.COD - VFA_avail),
    BOD: Math.max(0, inf.BOD - VFA_avail * 0.6),
    TP:  inf.TP + P_released,
    NO3: Math.max(0, NO3_to_anaerobic - VFA_avail / 8),
    DO: 0,
  });

  const aerobic_feed = anaerobic_out.clone({ Q: Qin });
  // Volume sizing: compute from original influent (all zones together), then distribute
  const aer_vol_dry = solveAerobic({ feed: inf.clone({ Q: Qin }), p: { ...p, anoxic_fraction: 0 }, mu_BOD, mu_NH4, ebprActive: false, X_PAO, ebpr_P_uptake_capacity: 0 });
  const uct_total_vol = p.volume_m3 > 0 ? p.volume_m3 : aer_vol_dry.volume;
  const uct_aer_frac  = Math.max(0.05, 1 - p.anaerobic_fraction - p.uct_anoxic_fraction);
  const uct_aer_vol   = uct_total_vol * uct_aer_frac;
  const cap = X_PAO * p.ebpr_uptake_rate * (uct_aer_vol / Qin);
  const p_uct = { ...p, anoxic_fraction: 0, volume_m3: uct_total_vol };
  const aer = solveAerobic({ feed: aerobic_feed, p: p_uct, mu_BOD, mu_NH4, ebprActive: true, X_PAO, ebpr_P_uptake_capacity: cap });

  const total_vol  = aer.volume;
  const anaer_vol  = total_vol * p.anaerobic_fraction;
  const anox_vol   = total_vol * p.uct_anoxic_fraction;
  const aer_vol    = total_vol * (1 - p.anaerobic_fraction - p.uct_anoxic_fraction);
  const MLR_NO3_ok = (Qmlr * aer.NO3_e / 1000) <= (anox_feed.Q * inf.BOD / p.bOD_NO3_ratio / 1000);
  const WAS_Q      = aer.P_x_kgd * 1000 / p.MLSS_mg_L;
  // Water balance: effluent = influent + actual RAS inflow − WAS wasted here.
  const eff_Q      = Math.max(0, Qin + (RAS ? RAS.Q : 0) - WAS_Q);

  const effluent = new Stream({
    Q: eff_Q, TSS: p.MLSS_mg_L, BOD: aer.BOD_e, COD: aer.BOD_e * 1.7,
    TN: Math.max(0, aer.TN_e), NH4: Math.max(0, aer.NH4_e), NO3: aer.NO3_e, NO2: 0,
    TP: Math.max(0, aer.TP_e), DO: p.DO_set_mg_L, pH: inf.pH - 0.15, temp,
  });
  const WAS = new Stream({
    Q: WAS_Q, TSS: p.MLSS_mg_L, BOD: p.MLSS_mg_L * 0.5, COD: p.MLSS_mg_L * 0.8,
    TN: 40, NH4: 5, NO3: aer.NO3_e, TP: 15, pH: inf.pH, temp,
  });

  return {
    effluent, WAS,
    metrics: {
      config: 'uct', SRT_d: p.SRT_d, HRT_h: +aer.HRT_h.toFixed(2), volume_m3: +total_vol.toFixed(0),
      MLSS_mg_L: p.MLSS_mg_L, BOD_effluent: +aer.BOD_e.toFixed(2), NH4_effluent: +aer.NH4_e.toFixed(2),
      NO3_effluent: +aer.NO3_e.toFixed(2), TP_effluent: +aer.TP_e.toFixed(2),
      nitrification: true, denitrification: true,
      O2_demand_kg_d: +aer.O2_demand.toFixed(1), biomass_kg_d: +aer.P_x_kgd.toFixed(1),
      WAS_m3_d: +WAS_Q.toFixed(2), temp_C: temp,
      ebpr: {
        config: 'uct', MLR_ratio, MLR_flow_m3_d: +Qmlr.toFixed(0),
        anaerobic_fraction: p.anaerobic_fraction, anoxic_fraction: p.uct_anoxic_fraction,
        VFA_consumed_mg_L: +VFA_avail.toFixed(2), P_released_mg_L: +P_released.toFixed(2),
        NO3_in_anaerobic_mg_L: +NO3_to_anaerobic.toFixed(2),
        NO3_suppression_factor: +NO3_suppress.toFixed(3),
        NO3_suppression_warning: NO3_to_anaerobic > 2.0,
        P_removal_mg_L: +Math.max(0, inf.TP - aer.TP_e).toFixed(2),
        N_removed_total_mg_L: +Math.max(0, inf.TN - aer.TN_e).toFixed(2),
        mlr_denitrification_ok: MLR_NO3_ok,
        PAO_fraction: p.PAO_fraction, X_PAO_mg_L: +X_PAO.toFixed(0),
        TP_effluent_mg_L: +aer.TP_e.toFixed(2),
      },
      zone_volumes_m3: { anaerobic: +anaer_vol.toFixed(0), anoxic: +anox_vol.toFixed(0), aerobic: +aer_vol.toFixed(0) },
      zone_HRT_h: {
        anaerobic: +(anaer_vol/Qin*24).toFixed(2), anoxic: +(anox_vol/Qin*24).toFixed(2), aerobic: +(aer_vol/Qin*24).toFixed(2),
      },
      anoxic: {
        NO3_in_mg_L: +(ras_stream.NO3??20).toFixed(2), NO3_eff_mg_L: +r_anox.NO3_eff.toFixed(2),
        TN_removed_mg_L: +r_anox.TN_removed.toFixed(2), BOD_consumed_mg_L: +r_anox.BOD_consumed.toFixed(2),
      },
    },
  };
}

// ── JHB Process ───────────────────────────────────────────────────────────────
function solveJHB({ inf, RAS, p, temp, mu_BOD, mu_NH4, mu_denit, MLVSS, X_PAO }) {
  const Qin      = inf.Q;
  const MLR_ratio = p.MLR_ratio ?? 2.0;
  const Qras     = RAS ? RAS.Q : Qin * 0.5;
  const Qmlr     = Qin * MLR_ratio;
  const ras_stream  = RAS || new Stream({ Q: Qras, NO3: 20, TSS: 6000, BOD: 200, TN: 40, TP: 15, NH4: 5, temp });
  const preanox_BOD = inf.BOD * p.jhb_preanoxic_fraction * 5;

  const r_preanox = solveAnoxic({
    NO3_in: ras_stream.NO3 ?? 20, BOD_in: preanox_BOD, Q_in: Qras,
    mu_denit, Ks_NO3: p.Ks_NO3, kd: p.kd, SRT_d: p.SRT_d, bOD_NO3_ratio: p.bOD_NO3_ratio,
  });
  const NO3_after_preanox = r_preanox.NO3_eff;

  const NO3_suppress = NO3_after_preanox > 1 ? Math.max(0.3, 1 - (NO3_after_preanox - 1) / 15) : 1.0;
  const VFA_avail    = inf.COD * p.VFA_COD_fraction * NO3_suppress * 1.15;
  const P_released   = VFA_avail * 0.5;

  const anaerobic_out = inf.clone({
    COD: Math.max(0, inf.COD - VFA_avail),
    BOD: Math.max(0, inf.BOD - VFA_avail * 0.6),
    TP:  inf.TP + P_released,
    NO3: Math.max(0, NO3_after_preanox * 0.1),
    DO: 0,
  });

  const aer_est = solveAerobic({
    feed: anaerobic_out.clone({ Q: Qin }), p, mu_BOD, mu_NH4,
    ebprActive: true, X_PAO, ebpr_P_uptake_capacity: X_PAO * p.ebpr_uptake_rate * 0.3,
  });
  const r_main_anox = solveAnoxic({
    NO3_in: aer_est.NO3_e, BOD_in: anaerobic_out.BOD, Q_in: Qin,
    mu_denit, Ks_NO3: p.Ks_NO3, kd: p.kd, SRT_d: p.SRT_d, bOD_NO3_ratio: p.bOD_NO3_ratio,
  });
  const main_anox_out = anaerobic_out.clone({
    BOD: Math.max(0, anaerobic_out.BOD - r_main_anox.BOD_consumed),
    NO3: r_main_anox.NO3_eff,
    TN:  Math.max(0, anaerobic_out.TN - r_main_anox.TN_removed),
    DO: 0, Q: Qin,
  });

  // Estimate total volume via solveAerobic first pass (dry run), then use for P uptake cap
  // Volume sizing: use total influent BOD (all zones together) for biomass-based auto-sizing.
  // We pass the original influent (not the depleted main_anox_out) for volume calc only.
  const aer_dry = solveAerobic({ feed: inf.clone({ Q: Qin }), p: { ...p, anoxic_fraction: 0 }, mu_BOD, mu_NH4, ebprActive: false, X_PAO, ebpr_P_uptake_capacity: 0 });
  const est_total_vol = aer_dry.volume;
  const aer_frac = Math.max(0.05, 1 - p.anaerobic_fraction - p.uct_anoxic_fraction - p.jhb_preanoxic_fraction);
  const est_aer_vol = est_total_vol * aer_frac;
  const P_uptake_cap = X_PAO * p.ebpr_uptake_rate * (est_aer_vol / Qin);
  const p_jhb = { ...p, anoxic_fraction: 0, volume_m3: est_total_vol };
  const aer = solveAerobic({ feed: main_anox_out, p: p_jhb, mu_BOD, mu_NH4, ebprActive: true, X_PAO, ebpr_P_uptake_capacity: P_uptake_cap });

  const total_vol     = aer.volume;
  const preanox_vol   = total_vol * p.jhb_preanoxic_fraction;
  const anaer_vol     = total_vol * p.anaerobic_fraction;
  const main_anox_vol = total_vol * p.uct_anoxic_fraction;
  const aer_vol       = total_vol - preanox_vol - anaer_vol - main_anox_vol;
  const WAS_Q         = aer.P_x_kgd * 1000 / p.MLSS_mg_L;
  const HRT_h         = total_vol / Qin * 24;
  // Water balance: effluent = influent + actual RAS inflow − WAS wasted here.
  const eff_Q         = Math.max(0, Qin + (RAS ? RAS.Q : 0) - WAS_Q);

  const effluent = new Stream({
    Q: eff_Q, TSS: p.MLSS_mg_L, BOD: aer.BOD_e, COD: aer.BOD_e * 1.7,
    TN: Math.max(0, aer.TN_e), NH4: Math.max(0, aer.NH4_e), NO3: aer.NO3_e, NO2: 0,
    TP: Math.max(0, aer.TP_e), DO: p.DO_set_mg_L, pH: inf.pH - 0.15, temp,
  });
  const WAS = new Stream({
    Q: WAS_Q, TSS: p.MLSS_mg_L, BOD: p.MLSS_mg_L * 0.5, COD: p.MLSS_mg_L * 0.8,
    TN: 40, NH4: 5, NO3: aer.NO3_e, TP: 15, pH: inf.pH, temp,
  });

  return {
    effluent, WAS,
    metrics: {
      config: 'jhb', SRT_d: p.SRT_d, HRT_h: +HRT_h.toFixed(2), volume_m3: +total_vol.toFixed(0),
      MLSS_mg_L: p.MLSS_mg_L, BOD_effluent: +aer.BOD_e.toFixed(2), NH4_effluent: +aer.NH4_e.toFixed(2),
      NO3_effluent: +aer.NO3_e.toFixed(2), TP_effluent: +aer.TP_e.toFixed(2),
      nitrification: true, denitrification: true,
      O2_demand_kg_d: +aer.O2_demand.toFixed(1), biomass_kg_d: +aer.P_x_kgd.toFixed(1),
      WAS_m3_d: +WAS_Q.toFixed(2), temp_C: temp,
      ebpr: {
        config: 'jhb', MLR_ratio, MLR_flow_m3_d: +Qmlr.toFixed(0),
        anaerobic_fraction: p.anaerobic_fraction, preanoxic_fraction: p.jhb_preanoxic_fraction,
        main_anoxic_fraction: p.uct_anoxic_fraction,
        VFA_consumed_mg_L: +VFA_avail.toFixed(2), P_released_mg_L: +P_released.toFixed(2),
        NO3_after_preanox_mg_L: +NO3_after_preanox.toFixed(2),
        NO3_in_anaerobic_mg_L: +NO3_after_preanox.toFixed(2),
        NO3_suppression_factor: +NO3_suppress.toFixed(3),
        NO3_suppression_warning: NO3_after_preanox > 1.5,
        P_removal_mg_L: +Math.max(0, inf.TP - aer.TP_e).toFixed(2),
        N_removed_total_mg_L: +Math.max(0, inf.TN - aer.TN_e).toFixed(2),
        PAO_fraction: p.PAO_fraction, X_PAO_mg_L: +X_PAO.toFixed(0),
        TP_effluent_mg_L: +aer.TP_e.toFixed(2),
      },
      zone_volumes_m3: {
        pre_anoxic: +preanox_vol.toFixed(0), anaerobic: +anaer_vol.toFixed(0),
        main_anoxic: +main_anox_vol.toFixed(0), aerobic: +aer_vol.toFixed(0),
      },
      zone_HRT_h: {
        pre_anoxic: +(preanox_vol/Qin*24).toFixed(2), anaerobic: +(anaer_vol/Qin*24).toFixed(2),
        main_anoxic: +(main_anox_vol/Qin*24).toFixed(2), aerobic: +(aer_vol/Qin*24).toFixed(2),
      },
      pre_anoxic: {
        NO3_in_mg_L: +(ras_stream.NO3??20).toFixed(2), NO3_eff_mg_L: +r_preanox.NO3_eff.toFixed(2),
        TN_removed_mg_L: +r_preanox.TN_removed.toFixed(2), BOD_consumed_mg_L: +r_preanox.BOD_consumed.toFixed(2),
      },
      main_anoxic: {
        NO3_in_mg_L: +aer_est.NO3_e.toFixed(2), NO3_eff_mg_L: +r_main_anox.NO3_eff.toFixed(2),
        TN_removed_mg_L: +r_main_anox.TN_removed.toFixed(2), BOD_consumed_mg_L: +r_main_anox.BOD_consumed.toFixed(2),
      },
    },
  };
}

// ── Main entry point ──────────────────────────────────────────────────────────
function solve(inputs, params = {}) {
  const p   = { ...DEFAULTS, ...params };
  const inf = inputs.influent || new Stream();
  const RAS = inputs.RAS;

  // Resolve ebpr_config from legacy boolean
  let ebprConfig = p.ebpr_config;
  if (!ebprConfig || ebprConfig === 'none') {
    if (p.ebpr === true || p.ebpr === 'true') ebprConfig = 'simple';
    else ebprConfig = 'none';
  }

  const temp     = p.temp ?? inf.temp ?? 20;
  const mu_BOD   = tempCorrect(p.mu_max_BOD,   temp, p.theta_T);
  const mu_NH4   = tempCorrect(p.mu_max_NH4,   temp, p.theta_T);
  const mu_denit = tempCorrect(p.mu_max_denit, temp, p.theta_T);
  const MLVSS    = p.MLSS_mg_L * 0.80;
  const X_PAO    = MLVSS * p.PAO_fraction;

  if (ebprConfig === 'uct') return solveUCT({ inf, RAS, p, temp, mu_BOD, mu_NH4, mu_denit, MLVSS, X_PAO });
  if (ebprConfig === 'jhb') return solveJHB({ inf, RAS, p, temp, mu_BOD, mu_NH4, mu_denit, MLVSS, X_PAO });

  // ── Simple / conventional ─────────────────────────────────────────────────
  const feed = RAS ? Stream.mix([inf, RAS]) : inf;
  let basin_feed = feed;
  let ebpr_metrics = null;
  let anoxic_metrics = null;

  if (ebprConfig === 'simple') {
    const VFA_avail = feed.COD * p.VFA_COD_fraction;
    const P_released = VFA_avail * 0.5;
    basin_feed = feed.clone({
      COD: Math.max(0, feed.COD - VFA_avail), BOD: Math.max(0, feed.BOD - VFA_avail * 0.6),
      TP: feed.TP + P_released, DO: 0,
    });
    ebpr_metrics = { config: 'simple', VFA_consumed_mg_L: +VFA_avail.toFixed(2), P_released_mg_L: +P_released.toFixed(2) };
  }

  if (p.denitrification && ebprConfig !== 'simple') {
    const r = solveAnoxic({
      NO3_in: feed.NO3 ?? 0, BOD_in: feed.BOD, Q_in: feed.Q,
      mu_denit, Ks_NO3: p.Ks_NO3, kd: p.kd, SRT_d: p.SRT_d, bOD_NO3_ratio: p.bOD_NO3_ratio,
    });
    basin_feed = feed.clone({ BOD: Math.max(0, feed.BOD - r.BOD_consumed), NO3: r.NO3_eff, TN: Math.max(0, feed.TN - r.TN_removed), DO: 0 });
    anoxic_metrics = { ...r, NO3_in_mg_L: +(feed.NO3??0).toFixed(2) };
  }

  const cap_est = X_PAO * p.ebpr_uptake_rate * 0.3;
  const aer = solveAerobic({ feed: basin_feed, p, mu_BOD, mu_NH4, ebprActive: ebprConfig === 'simple', X_PAO, ebpr_P_uptake_capacity: cap_est });

  if (ebpr_metrics) {
    ebpr_metrics.P_uptake_mg_L    = +(basin_feed.TP - aer.TP_e).toFixed(2);
    ebpr_metrics.TP_effluent_mg_L = +aer.TP_e.toFixed(2);
    ebpr_metrics.PAO_fraction     = p.PAO_fraction;
    ebpr_metrics.X_PAO_mg_L       = +X_PAO.toFixed(0);
  }

  const WAS_Q = aer.P_x_kgd * 1000 / p.MLSS_mg_L;
  // Water balance: WAS is wasted from the basin, so the mixed-liquor effluent
  // flow excludes it — unrouted WAS is then an explicit boundary loss, not
  // invented water on top of the feed.
  const eff_Q = Math.max(0, basin_feed.Q - WAS_Q);
  const effluent = new Stream({
    Q: eff_Q, TSS: p.MLSS_mg_L, BOD: aer.BOD_e, COD: aer.BOD_e * 1.7,
    TN: Math.max(0, aer.TN_e), NH4: Math.max(0, aer.NH4_e), NO3: aer.NO3_e, NO2: 0,
    TP: Math.max(0, aer.TP_e), DO: p.DO_set_mg_L, pH: basin_feed.pH - 0.1, temp,
  });
  const WAS = new Stream({
    Q: WAS_Q, TSS: p.MLSS_mg_L, BOD: p.MLSS_mg_L * 0.5, COD: p.MLSS_mg_L * 0.8,
    TN: 40, NH4: 5, NO3: aer.NO3_e, TP: 15, pH: basin_feed.pH, temp,
  });

  const min_SRT_nit = 1 / (mu_NH4 + 1e-9);
  const metrics = {
    config: ebprConfig, SRT_d: p.SRT_d, HRT_h: +aer.HRT_h.toFixed(2), volume_m3: +aer.volume.toFixed(0),
    MLSS_mg_L: p.MLSS_mg_L, BOD_effluent: +aer.BOD_e.toFixed(2), NH4_effluent: +aer.NH4_e.toFixed(2),
    NO3_effluent: +aer.NO3_e.toFixed(2), TP_effluent: +aer.TP_e.toFixed(2),
    nitrification: p.SRT_d > min_SRT_nit * 1.5, denitrification: p.denitrification,
    O2_demand_kg_d: +aer.O2_demand.toFixed(1), biomass_kg_d: +aer.P_x_kgd.toFixed(1),
    WAS_m3_d: +WAS_Q.toFixed(2), temp_C: temp,
  };
  if (anoxic_metrics) { metrics.anoxic = anoxic_metrics; metrics.anoxic_fraction = p.anoxic_fraction; }
  if (ebpr_metrics)   { metrics.ebpr   = ebpr_metrics;   metrics.anaerobic_fraction = p.anaerobic_fraction; }
  return { effluent, WAS, metrics };
}

module.exports = { solve, DEFAULTS };
