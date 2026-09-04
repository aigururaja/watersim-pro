/**
 * Lane E — the eight "treatment" equipment symbols.
 *
 * These tests pin the three things that would otherwise rot silently:
 *
 *  1. HONESTY. `tank` must never grow a water level or an animation, at any
 *     input, because the engine has no tank level model at any timescale. The
 *     refusal is the feature; a regression here would ship a lie shaped exactly
 *     like a measurement.
 *  2. THE ONE REAL LEVEL. `sand_filter`'s freeboard is the only genuinely
 *     simulated rising level in the simulator (acceptance check #3), so the
 *     transform must actually move with `h_clogged_m` and pin at the limit.
 *  3. THE GATE. Loops mount only when `live` is true and the model has not
 *     errored; every STATIC encoder must survive `live: false` (§6.1 —
 *     "values always, motion only live").
 */
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';

import SymbolDefs from '../components/canvas/symbols/defs';
import { FRAME } from '../components/canvas/symbols/primitives';
import { getSymbol, hasSymbol } from '../components/canvas/symbols';

import { SandFilterSymbol } from '../components/canvas/symbols/sand_filter';
import { UvDisinfectionSymbol } from '../components/canvas/symbols/uv_disinfection';
import { RoMembraneSymbol, needleAngle } from '../components/canvas/symbols/ro_membrane';
import { UfMembraneSymbol } from '../components/canvas/symbols/uf_membrane';
import { ChlorinationSymbol } from '../components/canvas/symbols/chlorination';
import { CoagulationSymbol } from '../components/canvas/symbols/coagulation';
import { GacAdsorptionSymbol } from '../components/canvas/symbols/gac_adsorption';
import { TankSymbol, tankTurnoversPerDay, TANK_REFUSAL_COPY } from '../components/canvas/symbols/tank';

// ═══════════════════════════════════════════════════════════════════════════
// Harness
// ═══════════════════════════════════════════════════════════════════════════

const REFS = Object.freeze({
  Qref: 2000, O2ref: 1, screenRef: 1, doseRef: 100, gasRef: 1, sludgeRef: 1, powerRef: 1,
});

/** A NodeSnapshot exactly as `liveStore.getNodeSnapshot` shapes one. */
const snap = (over = {}) => ({
  id: 'n1',
  live: true,
  seq: 1,
  changedSeq: 1,
  hasResults: true,
  type: null,
  opType: null,
  metrics: {},
  biogas: null,
  outputs: {},
  derived: {},
  refs: REFS,
  ...over,
});

const draw = (Sym, props = {}) => render(
  <div className="ws-sheet ws-live">
    <SymbolDefs />
    <svg viewBox={`0 0 ${FRAME.w} ${FRAME.h}`}>
      <Sym nodeId="n1" {...props} />
    </svg>
  </div>
);

/** Pull the px out of a `translateY(...)`, so formatting cannot break the test. */
const translateY = (el) => {
  const m = /translateY\(\s*(-?[\d.]+)px\s*\)/.exec(el?.style?.transform || '');
  return m ? parseFloat(m[1]) : null;
};

// ── Representative full-metric sets, taken from what each model returns ──────
const FULL = {
  sand_filter: {
    filter_type: 'dual_media', area_m2: 52.1, HLR_m_h: 8,
    filtration_velocity_m_s: 0.00222, total_bed_depth_m: 0.75,
    h_clean_bed_m: 0.42, h_clogged_m: 1.6, h_limit_m: 2.5,
    TSS_load_kg_m2: 2.95, backwash_needed: false, backwash_interval_h: 24,
    effective_TSS_removal_pct: 86.4, breakthrough_fraction: 0.72,
    filtrate_Q_m3_d: 9500, backwash_Q_m3_d: 500,
  },
  uv_disinfection: {
    fluence_mJ_cm2: 76, required_fluence_mJ_cm2: 76, UVT_correction: 1,
    log_reduction: 4, log_deficit: 0, lamp_count: 4, lamp_power_kW: 0.4,
    energy_kWh_d: 38.4, energy_kWh_m3: 0.0038, k_inact_mJ_cm2: 19,
    UVT_pct: 65, target_log_reduction: 4, compliant: true,
  },
  ro_membrane: {
    recovery_pct: 75, pressure_bar: 15, perm_Q_m3_d: 7500, conc_Q_m3_d: 2500,
    concentration_factor: 4, energy_kWh_d: 3750,
    BOD_permeate_mg_L: 0.1, TN_permeate_mg_L: 1.5,
  },
  uf_membrane: {
    screenType: 'micro', TSS_removal_pct: '30.0', screenings_kg_d: 60,
    BOD_removed_kg_d: 30, COD_removed_kg_d: 45, screenings_Q_m3_d: 0.3,
    headloss_m: 0.15,
  },
  chlorination: {
    chemical_type: 'naocl', dose_mg_L: 5, dose_kg_d: 50, sludge_kg_d: 2,
    TP_in_mg_L: 1, TP_out_mg_L: 1, TP_removal_pct: 0, pH_in: 7.2, pH_out: 7.2,
  },
  coagulation: {
    chemical_type: 'alum', dose_mg_L: 30, dose_kg_d: 300, sludge_kg_d: 78,
    TP_in_mg_L: 6, TP_out_mg_L: 1.2, TP_removal_pct: 80, pH_in: 7.2, pH_out: 7.2,
  },
  gac_adsorption: {
    screenType: 'micro', TSS_removal_pct: '30.0', screenings_kg_d: 60,
    BOD_removed_kg_d: 30, COD_removed_kg_d: 45, screenings_Q_m3_d: 0.3,
    headloss_m: 0.15,
  },
  // `PALETTE_TYPE_MAP.tank = null` -> passthrough -> metrics is LITERALLY {}.
  tank: {},
};

/** Every non-finite / hostile shape `sweepNonFinite` and a model throw can produce. */
const NULLED = {
  h_clean_bed_m: null, h_clogged_m: null, h_limit_m: null, TSS_load_kg_m2: NaN,
  backwash_needed: null, filter_type: null,
  lamp_count: null, fluence_mJ_cm2: NaN, required_fluence_mJ_cm2: 0,
  log_deficit: null, compliant: null,
  recovery_pct: null, pressure_bar: NaN,
  dose_kg_d: null, dose_mg_L: null, TP_removal_pct: NaN, chemical_type: null,
  TSS_removal_pct: null, headloss_m: NaN,
};

const LANE = [
  ['sand_filter', SandFilterSymbol],
  ['chlorination', ChlorinationSymbol],
  ['coagulation', CoagulationSymbol],
  ['uv_disinfection', UvDisinfectionSymbol],
  ['ro_membrane', RoMembraneSymbol],
  ['uf_membrane', UfMembraneSymbol],
  ['gac_adsorption', GacAdsorptionSymbol],
  ['tank', TankSymbol],
];

const FILES = [
  'sand_filter', 'chlorination', 'coagulation', 'uv_disinfection',
  'ro_membrane', 'uf_membrane', 'gac_adsorption', 'tank',
];

// ═══════════════════════════════════════════════════════════════════════════
// 1. Registration + total robustness
// ═══════════════════════════════════════════════════════════════════════════

describe('lane E — registration and robustness', () => {
  it('registers all eight types, plus the granular_filter legacy alias', () => {
    for (const [type, Sym] of LANE) {
      expect(hasSymbol(type)).toBe(true);
      expect(getSymbol(type)).toBe(Sym);
    }
    expect(getSymbol('granular_filter')).toBe(SandFilterSymbol);
  });

  it.each(LANE)('%s renders for full metrics, {}, {error} and nulled values', (type, Sym) => {
    const cases = [
      snap({ metrics: FULL[type], opType: type, outputs: { effluent: { Q: 1000 } } }),
      snap({ metrics: {} }),
      snap({ metrics: { error: 'boom' } }),
      snap({ metrics: NULLED }),
      snap({ hasResults: false, live: false }),
      undefined,                                   // no snapshot at all (palette chip)
    ];
    for (const s of cases) {
      const { container, unmount } = draw(Sym, { snap: s });
      expect(container.querySelector('svg')).toBeTruthy();
      expect(container.querySelector('[data-symbol]')).toBeTruthy();
      unmount();
    }
  });

  it.each(LANE)('%s suppresses all motion on a model error', (type, Sym) => {
    const { container } = draw(Sym, {
      snap: snap({ metrics: { ...FULL[type], error: 'model threw' }, outputs: { effluent: { Q: 1000 } } }),
    });
    expect(container.querySelectorAll('.ws-anim').length).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. #11 sand_filter — THE genuinely simulated rising level (acceptance #3)
// ═══════════════════════════════════════════════════════════════════════════

describe('#11 sand_filter — the one real level', () => {
  const filt = (over) => draw(SandFilterSymbol, {
    snap: snap({ metrics: { ...FULL.sand_filter, ...over } }),
  }).container.querySelector('.ws-freeboard');

  it('the freeboard transform moves as h_clogged_m rises between clean and limit', () => {
    // h_clean 0.42, h_limit 2.5 -> clog = (h_clogged - 0.42) / 2.08
    const clean = translateY(filt({ h_clogged_m: 0.42 }));
    const quarter = translateY(filt({ h_clogged_m: 0.94 }));
    const half = translateY(filt({ h_clogged_m: 1.46 }));
    const high = translateY(filt({ h_clogged_m: 2.0 }));

    for (const v of [clean, quarter, half, high]) expect(v).not.toBeNull();

    // A rising head loss lifts the surface, i.e. translateY strictly DECREASES.
    expect(quarter).toBeLessThan(clean);
    expect(half).toBeLessThan(quarter);
    expect(high).toBeLessThan(half);
    // and the clean-bed pose is the bottom of the travel
    expect(clean).toBeGreaterThan(0);
  });

  it('pins to the top at the limit and stays pinned beyond it', () => {
    const at = translateY(filt({ h_clogged_m: 2.5 }));
    const over = translateY(filt({ h_clogged_m: 9.9 }));
    expect(at).toBe(0);
    expect(over).toBe(0);
    // and never overshoots past the limit hairline
    expect(over).toBeGreaterThanOrEqual(0);
  });

  it('is a transform on an anchored group, never a geometry attribute', () => {
    const g = filt({ h_clogged_m: 1.6 });
    expect(g.style.transformBox).toBe('fill-box');
    expect(g.style.transformOrigin).toBe('50% 100%');
    expect(g.getAttribute('height')).toBeNull();
    expect(g.getAttribute('y')).toBeNull();
  });

  it('draws no liquid at all when the engine produced no level', () => {
    const { container } = draw(SandFilterSymbol, { snap: snap({ metrics: {} }) });
    expect(container.querySelector('.ws-freeboard')).toBeNull();
    // ...but the vessel and its media bed are still drawn
    expect(container.querySelector('.ws-shell')).toBeTruthy();
    expect(container.querySelector('.ws-media')).toBeTruthy();
  });

  it('backwash_needed adds the amber ring AND the reversed upward pulses', () => {
    const { container } = draw(SandFilterSymbol, {
      snap: snap({ metrics: { ...FULL.sand_filter, h_clogged_m: 2.9, backwash_needed: true } }),
    });
    expect(container.querySelector('[data-ring="watch"]')).toBeTruthy();

    const pulses = container.querySelectorAll('.ws-pulse--rev');
    expect(pulses.length).toBeGreaterThan(0);
    for (const p of pulses) {
      expect(p.classList.contains('ws-pulse')).toBe(true);   // the ws-flow shorthand
      expect(p.classList.contains('ws-anim')).toBe(true);    // and the live gate
      expect(p.style.getPropertyValue('--ws-flow')).toBe('1.60s');
    }
  });

  it('has neither ring nor pulses when backwash is not needed', () => {
    const { container } = draw(SandFilterSymbol, {
      snap: snap({ metrics: { ...FULL.sand_filter, backwash_needed: false } }),
    });
    expect(container.querySelector('[data-ring="watch"]')).toBeNull();
    expect(container.querySelectorAll('.ws-pulse--rev').length).toBe(0);
  });

  it('keeps the ring but drops the pulses when live is off', () => {
    const { container } = draw(SandFilterSymbol, {
      snap: snap({ live: false, metrics: { ...FULL.sand_filter, backwash_needed: true } }),
    });
    expect(container.querySelector('[data-ring="watch"]')).toBeTruthy();
    expect(container.querySelectorAll('.ws-pulse--rev').length).toBe(0);
    expect(container.querySelector('.ws-freeboard')).toBeTruthy();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. #13 uv_disinfection — count is Class A, glow is a setpoint
// ═══════════════════════════════════════════════════════════════════════════

describe('#13 uv_disinfection', () => {
  const uv = (over, extra = {}) => draw(UvDisinfectionSymbol, {
    snap: snap({ metrics: { ...FULL.uv_disinfection, ...over }, ...extra }),
  }).container;

  it('sleeve count follows lamp_count and is clamped to 2..6', () => {
    expect(uv({ lamp_count: 2 }).querySelectorAll('.ws-sleeve').length).toBe(2);
    expect(uv({ lamp_count: 6 }).querySelectorAll('.ws-sleeve').length).toBe(6);
    expect(uv({ lamp_count: 4 }).querySelectorAll('.ws-sleeve').length).toBe(4);
    expect(uv({ lamp_count: 1 }).querySelectorAll('.ws-sleeve').length).toBe(2);
    expect(uv({ lamp_count: 99 }).querySelectorAll('.ws-sleeve').length).toBe(6);
    expect(uv({ lamp_count: null }).querySelectorAll('.ws-sleeve').length).toBe(2);
  });

  it('glow opacity follows the fluence ratio and is STATIC when not live', () => {
    const full = uv({ fluence_mJ_cm2: 76, required_fluence_mJ_cm2: 76 }, { live: false });
    const half = uv({ fluence_mJ_cm2: 38, required_fluence_mJ_cm2: 76 }, { live: false });
    const a = parseFloat(full.querySelector('[data-glow="uv"]').getAttribute('opacity'));
    const b = parseFloat(half.querySelector('[data-glow="uv"]').getAttribute('opacity'));
    expect(a).toBeCloseTo(1.0, 5);
    expect(b).toBeCloseTo(0.5, 5);
    expect(b).toBeLessThan(a);
    // static means static: no loop class at all with live off
    expect(full.querySelector('.ws-breathe')).toBeNull();
  });

  it('breathes at the fixed 1.8s indicator period, quickened only by a deficit', () => {
    const ok = uv({ log_deficit: 0 }).querySelector('[data-glow="uv"]');
    expect(ok.classList.contains('ws-breathe')).toBe(true);
    expect(ok.classList.contains('ws-anim')).toBe(true);
    expect(ok.style.getPropertyValue('--ws-breathe')).toBe('1.80s');

    const short = uv({ log_deficit: 0.03, compliant: true });
    expect(short.querySelector('[data-glow="uv"]').style.getPropertyValue('--ws-breathe')).toBe('0.90s');
    expect(short.querySelector('[data-ring="watch"]')).toBeTruthy();

    // amplitude straddles the static ratio
    const lo = parseFloat(ok.style.getPropertyValue('--ws-glow-lo'));
    const hi = parseFloat(ok.style.getPropertyValue('--ws-glow-hi'));
    expect(hi).toBeGreaterThan(lo);
  });

  it('compliant === false turns it RED and STOPS the breathe', () => {
    const c = uv({ compliant: false, log_deficit: 1.4 });
    expect(c.querySelector('.ws-breathe')).toBeNull();
    expect(c.querySelectorAll('.ws-anim').length).toBe(0);
    expect(c.querySelector('[data-ring="alarm"]')).toBeTruthy();
    // the glow itself is still drawn — the reactor is dark, not missing
    expect(c.querySelector('[data-glow="uv"]')).toBeTruthy();
  });

  it('draws sleeves as empty outlines with no glow when idle', () => {
    const bare = draw(UvDisinfectionSymbol, {
      snap: snap({ metrics: {}, hasResults: false, live: false }),
    }).container;
    expect(bare.querySelector('[data-glow="uv"]')).toBeNull();
    expect(bare.querySelectorAll('.ws-sleeve').length).toBe(2);
    expect(bare.querySelector('.ws-sleeve').getAttribute('fill')).toBe('none');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. #14 ro_membrane / uf_membrane
// ═══════════════════════════════════════════════════════════════════════════

describe('#14 ro_membrane / uf_membrane', () => {
  const ro = (over, extra = {}) => draw(RoMembraneSymbol, {
    snap: snap({ metrics: { ...FULL.ro_membrane, ...over }, ...extra }),
  }).container;

  it('the needle angle differs for 20 bar and 70 bar, on the spec mapping', () => {
    expect(needleAngle(0)).toBe(-120);
    expect(needleAngle(20)).toBeCloseTo(-60, 6);
    expect(needleAngle(70)).toBeCloseTo(90, 6);
    expect(needleAngle(null)).toBe(-120);      // rest pose == the zero mark
    expect(needleAngle(NaN)).toBe(-120);
    expect(needleAngle(500)).toBe(120);        // clamped

    const a = ro({ pressure_bar: 20 }).querySelector('.ws-needle');
    const b = ro({ pressure_bar: 70 }).querySelector('.ws-needle');
    expect(a.getAttribute('data-angle')).not.toBe(b.getAttribute('data-angle'));
    expect(parseFloat(a.getAttribute('data-angle'))).toBeCloseTo(-60, 3);
    expect(parseFloat(b.getAttribute('data-angle'))).toBeCloseTo(90, 3);
    // a TRANSITION, never a loop: no animation class, no duration variable
    expect(a.classList.contains('ws-anim')).toBe(false);
    expect(a.getAttribute('style')).not.toContain('--ws-spin');
  });

  it('goes amber above the recovery / pressure thresholds and not below', () => {
    expect(ro({ recovery_pct: 90 }).querySelector('[data-ring="watch"]')).toBeTruthy();
    expect(ro({ pressure_bar: 75 }).querySelector('[data-ring="watch"]')).toBeTruthy();
    expect(ro({ recovery_pct: 75, pressure_bar: 15 }).querySelector('[data-ring="watch"]')).toBeNull();
  });

  it('permeate and concentrate stubs are distinguishable', () => {
    const c = ro({});
    const perm = c.querySelector('[data-port="permeate"] line');
    const conc = c.querySelector('[data-port="concentrate"] line');
    expect(perm).toBeTruthy();
    expect(conc).toBeTruthy();
    // different service colour...
    expect(perm.getAttribute('stroke')).not.toBe(conc.getAttribute('stroke'));
    expect(perm.getAttribute('stroke')).toContain('permeate');
    expect(conc.getAttribute('stroke')).toContain('recycle');
    // ...and a different exit: permeate on the centreline, concentrate below it
    expect(Number(conc.getAttribute('y1'))).toBeGreaterThan(Number(perm.getAttribute('y1')));
  });

  it('shimmers at a FIXED 3s whose opacity — not period — carries recovery', () => {
    const lowRec = ro({ recovery_pct: 40 }).querySelector('[data-shimmer]');
    const highRec = ro({ recovery_pct: 90 }).querySelector('[data-shimmer]');
    expect(lowRec.style.getPropertyValue('--ws-drift')).toBe('3.00s');
    expect(highRec.style.getPropertyValue('--ws-drift')).toBe('3.00s');
    expect(parseFloat(highRec.getAttribute('opacity')))
      .toBeGreaterThan(parseFloat(lowRec.getAttribute('opacity')));
  });

  it('idles with the needle at zero and no shimmer', () => {
    const idle = ro({}, { live: false });
    expect(idle.querySelector('[data-shimmer]')).toBeNull();
    const none = draw(RoMembraneSymbol, { snap: snap({ metrics: {}, hasResults: false, live: false }) }).container;
    expect(parseFloat(none.querySelector('.ws-needle').getAttribute('data-angle'))).toBe(-120);
    expect(none.querySelector('[data-shimmer]')).toBeNull();
  });

  it('uf_membrane has no gauge and no shimmer, because the screen model returns neither', () => {
    const uf = draw(UfMembraneSymbol, { snap: snap({ metrics: FULL.uf_membrane }) }).container;
    expect(uf.querySelector('[data-gauge]')).toBeNull();
    expect(uf.querySelector('.ws-needle')).toBeNull();
    expect(uf.querySelector('[data-shimmer]')).toBeNull();
    expect(uf.querySelectorAll('.ws-anim').length).toBe(0);
    expect(uf.querySelector('[data-symbol="uf_membrane"]')).toBeTruthy();
    // it still carries the two distinguishable ports
    expect(uf.querySelector('[data-port="permeate"]')).toBeTruthy();
    expect(uf.querySelector('[data-port="concentrate"]')).toBeTruthy();
    // and its one legal static encoder
    const fouled = draw(UfMembraneSymbol, {
      snap: snap({ metrics: { ...FULL.uf_membrane, headloss_m: 0.9 } }),
    }).container;
    expect(fouled.querySelector('[data-ring="watch"]')).toBeTruthy();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. #17 tank — the refusal. This is the most important test in the file.
// ═══════════════════════════════════════════════════════════════════════════

describe('#17 tank — the deliberate non-animation', () => {
  const INPUTS = [
    snap({ metrics: {} }),
    snap({ metrics: {}, live: true, outputs: { effluent: { Q: 5000 } } }),
    snap({ metrics: {}, live: false, outputs: { effluent: { Q: 5000 } } }),
    snap({ metrics: { error: 'boom' } }),
    snap({ metrics: NULLED }),
    snap({ hasResults: false }),
    snap({ outputs: { effluent: { Q: Number.POSITIVE_INFINITY } } }),
    undefined,
  ];

  it('renders with metrics {} and shows the hatch + a DASHED op-level line', () => {
    const { container } = draw(TankSymbol, { snap: snap({ metrics: {} }) });
    expect(container.querySelector('[data-symbol="tank"]')).toBeTruthy();
    expect(container.querySelector('.ws-hatch')).toBeTruthy();
    const op = container.querySelector('[data-oplevel="dashed"]');
    expect(op).toBeTruthy();
    expect(op.getAttribute('stroke-dasharray')).toBe('3 3');
  });

  it('never draws a water level, at ANY input', () => {
    for (const s of INPUTS) {
      const { container, unmount } = draw(TankSymbol, { snap: s, data: { params: { volume_m3: 500 } } });
      expect(container.querySelector('.ws-fill')).toBeNull();
      expect(container.querySelector('.ws-freeboard')).toBeNull();
      expect(container.querySelector('.ws-blanket')).toBeNull();
      expect(container.querySelector('.ws-surface')).toBeNull();
      unmount();
    }
  });

  it('never mounts an animation or a duration variable, at ANY input', () => {
    const LOOP_CLASSES = [
      'ws-anim', 'ws-prime', 'ws-stamp', 'ws-tick', 'ws-rotor', 'ws-rake',
      'ws-rake-travel', 'ws-bubble', 'ws-wave', 'ws-pulse', 'ws-breathe',
      'ws-throb', 'ws-droplet', 'ws-alarm', 'ws-needle',
    ];
    for (const s of INPUTS) {
      const { container, unmount } = draw(TankSymbol, { snap: s, data: { params: { volume_m3: 500 } } });
      for (const cls of LOOP_CLASSES) {
        expect(container.querySelectorAll(`.${cls}`).length).toBe(0);
      }
      for (const el of container.querySelectorAll('[style]')) {
        expect(el.getAttribute('style')).not.toMatch(/--ws-|animation|transition/);
      }
      unmount();
    }
  });

  it('turnovers/day are computed only when params.volume_m3 is set', () => {
    const withQ = snap({ outputs: { effluent: { Q: 2400 } } });
    expect(tankTurnoversPerDay(withQ, { volume_m3: 200 })).toBeCloseTo(12, 9);
    expect(tankTurnoversPerDay(withQ, {})).toBeNull();
    expect(tankTurnoversPerDay(withQ, undefined)).toBeNull();
    expect(tankTurnoversPerDay(withQ, { volume_m3: 0 })).toBeNull();
    expect(tankTurnoversPerDay(withQ, { volume_m3: null })).toBeNull();
    // no flow figure -> print NOTHING, never 0
    expect(tankTurnoversPerDay(snap({ outputs: {} }), { volume_m3: 200 })).toBeNull();
    expect(tankTurnoversPerDay(snap({ outputs: { effluent: { Q: NaN } } }), { volume_m3: 200 })).toBeNull();
  });

  it('prints turnovers only when a volume exists — and never as a level', () => {
    const withVol = draw(TankSymbol, {
      snap: snap({ outputs: { effluent: { Q: 2400 } } }),
      data: { params: { volume_m3: 200 } },
    }).container;
    expect(withVol.querySelector('title').textContent).toContain('turnovers/d');

    const noVol = draw(TankSymbol, {
      snap: snap({ outputs: { effluent: { Q: 2400 } } }),
      data: { params: {} },
    }).container;
    expect(noVol.querySelector('title').textContent).not.toContain('turnovers/d');
    expect(noVol.querySelector('title').textContent).toContain('no tank level model');
    expect(TANK_REFUSAL_COPY).toContain('nothing inside this vessel is simulated');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. The two chemical-dosing basins
// ═══════════════════════════════════════════════════════════════════════════

describe('chlorination / coagulation — basins, not injection points', () => {
  it('both draw a vessel with a fixed liquid level and a dosing quill', () => {
    for (const [type, Sym] of [['chlorination', ChlorinationSymbol], ['coagulation', CoagulationSymbol]]) {
      const { container } = draw(Sym, {
        snap: snap({ metrics: FULL[type], outputs: { effluent: { Q: 1200 } } }),
      });
      expect(container.querySelector('.ws-shell')).toBeTruthy();
      const fill = container.querySelector('.ws-fill');
      expect(fill).toBeTruthy();
      expect(fill.style.transform).toBe('scaleY(0.88)');       // fixed, full to the weir
      expect(container.querySelector('[data-quill="dosing"]')).toBeTruthy();
    }
  });

  it('the quill goes grey and loses its plume when the model reports no dose', () => {
    const { container } = draw(ChlorinationSymbol, {
      snap: snap({ metrics: { ...FULL.chlorination, dose_kg_d: 0 } }),
    });
    expect(container.querySelector('[data-quill="idle"]')).toBeTruthy();
    expect(container.querySelector('[data-quill="dosing"]')).toBeNull();
  });

  it('the surface wave takes its period from a computed flow, bucketed', () => {
    const slow = draw(ChlorinationSymbol, {
      snap: snap({ metrics: FULL.chlorination, outputs: { effluent: { Q: 100 } } }),
    }).container.querySelector('.ws-wave');
    const fast = draw(ChlorinationSymbol, {
      snap: snap({ metrics: FULL.chlorination, outputs: { effluent: { Q: 2000 } } }),
    }).container.querySelector('.ws-wave');

    expect(slow.classList.contains('ws-anim')).toBe(true);
    const ps = parseFloat(slow.style.getPropertyValue('--ws-drift'));
    const pf = parseFloat(fast.style.getPropertyValue('--ws-drift'));
    expect(pf).toBeLessThan(ps);
    for (const p of [ps, pf]) {
      expect(p).toBeGreaterThanOrEqual(1.6);
      expect(p).toBeLessThanOrEqual(6.0);
    }
  });

  it('a dead line (Q below 0.5) leaves a flat, still surface — never a 0s duration', () => {
    for (const outputs of [{ effluent: { Q: 0 } }, { effluent: { Q: 0.2 } }, {}, { effluent: { Q: null } }]) {
      const { container, unmount } = draw(ChlorinationSymbol, {
        snap: snap({ metrics: FULL.chlorination, outputs }),
      });
      expect(container.querySelector('.ws-wave')).toBeNull();
      expect(container.querySelector('.ws-fill')).toBeTruthy();     // level survives
      unmount();
    }
  });

  it('coagulation floc density follows TP removal, and the paddle stays parked', () => {
    const weak = draw(CoagulationSymbol, {
      snap: snap({ metrics: { ...FULL.coagulation, TP_removal_pct: 5 } }),
    }).container;
    const strong = draw(CoagulationSymbol, {
      snap: snap({ metrics: { ...FULL.coagulation, TP_removal_pct: 95 } }),
    }).container;
    expect(parseFloat(strong.querySelector('[data-floc="stipple"]').getAttribute('opacity')))
      .toBeGreaterThan(parseFloat(weak.querySelector('[data-floc="stipple"]').getAttribute('opacity')));

    // The model returns no rotational rate, so nothing here may spin.
    expect(strong.querySelector('[data-paddle="parked"]')).toBeTruthy();
    expect(strong.querySelector('.ws-rotor')).toBeNull();
    expect(strong.querySelector('.ws-rake')).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 7. gac_adsorption
// ═══════════════════════════════════════════════════════════════════════════

describe('#25 gac_adsorption', () => {
  it('draws a carbon bed and invents no breakthrough state', () => {
    const { container } = draw(GacAdsorptionSymbol, { snap: snap({ metrics: FULL.gac_adsorption }) });
    expect(container.querySelector('[data-bed="carbon"]')).toBeTruthy();
    expect(container.querySelectorAll('.ws-anim').length).toBe(0);
    expect(container.querySelector('.ws-freeboard')).toBeNull();
  });

  it('parses the STRING TSS_removal_pct that screen.js returns', () => {
    const low = draw(GacAdsorptionSymbol, {
      snap: snap({ metrics: { ...FULL.gac_adsorption, TSS_removal_pct: '5.0' } }),
    }).container;
    const high = draw(GacAdsorptionSymbol, {
      snap: snap({ metrics: { ...FULL.gac_adsorption, TSS_removal_pct: '95.0' } }),
    }).container;
    const lo = parseFloat(low.querySelector('[data-bed="carbon"]').getAttribute('opacity'));
    const hi = parseFloat(high.querySelector('[data-bed="carbon"]').getAttribute('opacity'));
    expect(hi).toBeGreaterThan(lo);
    expect(Number.isFinite(lo)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 8. The live gate, canvas-wide (§6.1 — values always, motion only live)
// ═══════════════════════════════════════════════════════════════════════════

describe('lane E — the live gate', () => {
  it.each(LANE)('%s mounts no loop element when live is false', (type, Sym) => {
    const { container } = draw(Sym, {
      snap: snap({ live: false, metrics: { ...FULL[type], backwash_needed: true }, outputs: { effluent: { Q: 1500 } } }),
      data: { params: { volume_m3: 400 } },
    });
    expect(container.querySelectorAll('.ws-anim').length).toBe(0);
    expect(container.querySelectorAll('.ws-pulse').length).toBe(0);
    expect(container.querySelectorAll('.ws-breathe').length).toBe(0);
    expect(container.querySelectorAll('.ws-wave').length).toBe(0);
    // ...and the drawing itself still renders
    expect(container.querySelector('[data-symbol]')).toBeTruthy();
  });

  it('static encoders survive live: false', () => {
    const off = { live: false };
    expect(draw(SandFilterSymbol, { snap: snap({ ...off, metrics: FULL.sand_filter }) })
      .container.querySelector('.ws-freeboard')).toBeTruthy();
    expect(draw(UvDisinfectionSymbol, { snap: snap({ ...off, metrics: FULL.uv_disinfection }) })
      .container.querySelector('[data-glow="uv"]')).toBeTruthy();
    expect(draw(RoMembraneSymbol, { snap: snap({ ...off, metrics: FULL.ro_membrane }) })
      .container.querySelector('.ws-needle')).toBeTruthy();
    expect(draw(CoagulationSymbol, { snap: snap({ ...off, metrics: FULL.coagulation }) })
      .container.querySelector('[data-floc="stipple"]')).toBeTruthy();
    expect(draw(GacAdsorptionSymbol, { snap: snap({ ...off, metrics: FULL.gac_adsorption }) })
      .container.querySelector('[data-bed="carbon"]')).toBeTruthy();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 9. Source scan — the §7 prohibitions, enforced mechanically
// ═══════════════════════════════════════════════════════════════════════════

describe('lane E — forbidden techniques', () => {
  // Sources are pulled through Vite rather than `fs`, so the scan works from
  // any cwd and cannot silently read the wrong file.
  const RAW = import.meta.glob('../components/canvas/symbols/*.jsx', {
    query: '?raw', import: 'default', eager: true,
  });

  /** Comments legitimately DISCUSS the bans, so scan code only. */
  const codeOf = (name) => {
    const key = Object.keys(RAW).find((k) => k.endsWith(`/${name}.jsx`));
    expect(key, `source for ${name}.jsx must be readable`).toBeTruthy();
    return String(RAW[key])
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^[ \t]*\/\/.*$/gm, '');
  };

  it('can read every lane E source (guards against a vacuously passing scan)', () => {
    for (const name of FILES) expect(codeOf(name).length).toBeGreaterThan(200);
  });

  it.each(FILES)('%s.jsx contains no SMIL, no filter/blur and no JS timers', (name) => {
    const code = codeOf(name);
    for (const banned of [
      '<animate', '<animateTransform', '<animateMotion',
      '<filter', 'filter:', 'filter=', 'blur(', 'drop-shadow',
      'backdrop-filter', 'box-shadow',
      'requestAnimationFrame', 'setInterval', 'setTimeout',
    ]) {
      expect(code.includes(banned), `${name}.jsx must not contain "${banned}"`).toBe(false);
    }
  });

  it.each(FILES)('%s.jsx never builds an animation shorthand in JS', (name) => {
    const code = codeOf(name);
    // Durations are custom properties; the `animation` shorthand is a constant
    // in canvas-motion.css and is never assembled here (§6.3).
    expect(/animation\s*:/.test(code)).toBe(false);
    expect(/animationName|animationDuration|animationTimingFunction/.test(code)).toBe(false);
  });

  it.each(FILES)('%s.jsx animates no SVG geometry attribute', (name) => {
    const code = codeOf(name);
    // Levels/bands are `transform` on anchored groups. A transition or
    // animation naming a geometry attribute would silently force layout.
    expect(/transition[^\n]*\b(height|width|cx|cy|[xy]1?|r)\b\s*[,)]/.test(code)).toBe(false);
  });
});
