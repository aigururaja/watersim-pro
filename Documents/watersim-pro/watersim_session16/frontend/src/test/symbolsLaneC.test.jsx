/**
 * Lane C — the ten "inline family" symbols (spec §3.2 #1–#6, #18–#21, §5.3
 * rows 1, 3, 4, 5, 12, 16, 18).
 *
 * These tests pin the four things that would otherwise ship a symbol that
 * LOOKS right and LIES:
 *
 *  1. The ECHO BUGS. `headloss_m` and `dose_mg_L` are verbatim parameter echoes
 *     (`screen.js:78`, `chemicalDosing.js:143`). A rate driven from either can
 *     never move on its own. The screening test changes ONLY `headloss_m` and
 *     asserts the period does NOT move; the dosing test drives from
 *     `dose_kg_d`.
 *  2. The REFUSALS. No adjacent aeration basin → the blower rotor does not
 *     turn (there is no blower model at all). No dose → no droplet is mounted.
 *     "Very slow" and "not running" must never look the same.
 *  3. VALUES ALWAYS, MOTION ONLY LIVE (§6.1). The outlet's violation chips and
 *     red ring must render with `live: false` — a permit violation has to
 *     survive a screenshot and a print.
 *  4. NULL-SAFETY. `sweepNonFinite` nulls non-finites, `metrics` is `{}` for
 *     the blower, and `{error}` when a model throws. Every symbol renders for
 *     all four shapes without throwing.
 */

import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { SYMBOLS, getSymbol, hasSymbol } from '../components/canvas/symbols';
import '../components/canvas/symbols/inlet';
import '../components/canvas/symbols/outlet';
import '../components/canvas/symbols/pump';
import '../components/canvas/symbols/valve';
import '../components/canvas/symbols/blower';
import '../components/canvas/symbols/screening';
import '../components/canvas/symbols/chemical_dosing';
import '../components/canvas/symbols/coagulant_dosing';
import '../components/canvas/symbols/polymer_dosing';
import '../components/canvas/symbols/ph_adjustment';

const LANE_C = [
  'inlet', 'outlet', 'pump', 'valve', 'blower', 'screening',
  'chemical_dosing', 'coagulant_dosing', 'polymer_dosing', 'ph_adjustment',
];

const DOSING = ['chemical_dosing', 'coagulant_dosing', 'polymer_dosing', 'ph_adjustment'];

const REFS = Object.freeze({
  Qref: 10000, O2ref: 800, screenRef: 120, doseRef: 400,
  gasRef: 4200, sludgeRef: 500, powerRef: 20,
});

const snapOf = (over = {}) => ({
  id: 'n1',
  live: false,
  seq: 3,
  changedSeq: 3,
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

/** Symbols render SVG CHILDREN ONLY; the host supplies the <svg> and the
 *  `.ws-sheet` scope that every canvas-motion.css rule is nested under. */
function sheet(opType, props = {}) {
  const Comp = getSymbol(opType);
  const live = !!props.snap?.live;
  return render(
    <div className={live ? 'ws-sheet ws-live' : 'ws-sheet'}>
      <svg viewBox="0 0 144 60">
        <Comp nodeId="n1" opType={opType} {...props} />
      </svg>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. Registration + the four metric shapes the solver can actually produce
// ═══════════════════════════════════════════════════════════════════════════

const FULL = {
  inlet: { Q_in: 10000 },
  outlet: { Q_out: 9800, compliant: true, permit_violations: [] },
  pump: { status: 'ON', speed_pct: 85, blocked_Q_m3_d: 0, power_kW: 14.2 },
  valve: { status: 'OPEN', opening_pct: 100, blocked_Q_m3_d: 0 },
  blower: {},
  screening: { screenType: 'fine', TSS_removal_pct: '15.0', screenings_kg_d: 82.5, headloss_m: 0.15 },
  chemical_dosing: { dose_mg_L: 30, dose_kg_d: 300, pH_in: 7.2, pH_out: 7.2 },
  coagulant_dosing: { dose_mg_L: 30, dose_kg_d: 220, pH_in: 7.2, pH_out: 7.2 },
  polymer_dosing: { dose_mg_L: 4, dose_kg_d: 40, pH_in: 7.2, pH_out: 7.2 },
  ph_adjustment: { dose_mg_L: 60, dose_kg_d: 380, pH_in: 6.4, pH_out: 8.4 },
};

/** Everything a `sweepNonFinite` pass or a hand-edited save could hand us. */
const NASTY = Object.freeze({
  status: null, speed_pct: NaN, opening_pct: null, blocked_Q_m3_d: NaN,
  power_kW: null, Q_in: NaN, Q_out: null,
  screenings_kg_d: null, headloss_m: NaN, TSS_removal_pct: null, screenType: 42,
  dose_kg_d: NaN, dose_mg_L: null, pH_in: NaN, pH_out: null,
  compliant: null, permit_violations: null,
});

describe('lane C — registration and null safety', () => {
  it('registers all ten inline-family symbols', () => {
    for (const t of LANE_C) {
      expect(hasSymbol(t), t).toBe(true);
      expect(typeof SYMBOLS[t], t).toBe('function');
    }
  });

  it.each(LANE_C)('%s renders for full / {} / {error} / null-NaN metrics', (opType) => {
    const cases = [
      { metrics: FULL[opType], live: false },
      { metrics: FULL[opType], live: true },
      { metrics: {}, live: true },
      { metrics: { error: 'model threw' }, live: true },
      { metrics: NASTY, live: true },
    ];
    for (const c of cases) {
      const { container, unmount } = sheet(opType, {
        data: { label: 'X', params: {} },
        state: 'rest',
        snap: snapOf(c),
      });
      expect(container.querySelector('.ws-sym')).toBeTruthy();
      unmount();
    }
  });

  it.each(LANE_C)('%s renders with NO snapshot at all (palette rail legend)', (opType) => {
    const { container } = sheet(opType, {});
    expect(container.querySelector('.ws-sym')).toBeTruthy();
  });

  it.each(LANE_C)('%s never emits a 0s or NaNs duration', (opType) => {
    const { container } = sheet(opType, {
      data: { label: 'X', params: {} },
      state: 'rest',
      snap: snapOf({ metrics: NASTY, live: true }),
    });
    expect(container.innerHTML).not.toMatch(/0\.00s/);
    expect(container.innerHTML).not.toMatch(/NaN/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. Pump — catalogue #4
// ═══════════════════════════════════════════════════════════════════════════

function pumpSpin(metrics, params = {}) {
  const { container } = sheet('pump', {
    data: { label: 'P', params },
    state: 'rest',
    snap: snapOf({ metrics, live: true }),
  });
  return container.querySelector('.ws-rotor');
}

describe('pump — impeller rate is the VFD setpoint (the legal Class-C rate)', () => {
  it('ON spins: the rotor carries .ws-anim and a --ws-spin duration', () => {
    const r = pumpSpin({ status: 'ON', speed_pct: 85 });
    expect(r.classList.contains('ws-anim')).toBe(true);
    expect(r.classList.contains('ws-rotor')).toBe(true);
    expect(r.style.getPropertyValue('--ws-spin')).toMatch(/^\d+\.\d\ds$/);
  });

  it('speed 100 and speed 30 produce DIFFERENT durations, and 30 is slower', () => {
    const fast = pumpSpin({ status: 'ON', speed_pct: 100 }).style.getPropertyValue('--ws-spin');
    const slow = pumpSpin({ status: 'ON', speed_pct: 30 }).style.getPropertyValue('--ws-spin');
    expect(fast).not.toBe(slow);
    expect(parseFloat(slow)).toBeGreaterThan(parseFloat(fast));
    // The catalogue's clamp floor: 100% lands on 0.28s.
    expect(parseFloat(fast)).toBeCloseTo(0.28, 2);
    expect(parseFloat(slow)).toBeGreaterThan(1);
  });

  it('OFF parks at 12° with NO spin variable — parked, not paused mid-frame', () => {
    const r = pumpSpin({ status: 'OFF', speed_pct: 85, blocked_Q_m3_d: 9000 });
    expect(r.style.getPropertyValue('--ws-spin')).toBe('');
    expect(r.classList.contains('ws-anim')).toBe(false);
    expect(r.style.transform).toBe('rotate(12deg)');
  });

  it('falls back to isControlOn(params.running) when the solver said nothing', () => {
    expect(pumpSpin({}, { running: 0 }).style.getPropertyValue('--ws-spin')).toBe('');
    expect(pumpSpin({}, { running: 1 }).style.getPropertyValue('--ws-spin')).not.toBe('');
  });

  it('blocked flow throbs the discharge on its OWN group, never the rotor', () => {
    const { container } = sheet('pump', {
      data: { label: 'P', params: {} },
      state: 'rest',
      snap: snapOf({ metrics: { status: 'ON', speed_pct: 80, blocked_Q_m3_d: 1500 }, live: true }),
    });
    const throb = container.querySelector('.ws-throb');
    expect(throb).toBeTruthy();
    expect(throb.style.getPropertyValue('--ws-throb')).toBe('1.10s');
    // Two loops must never share one transform.
    expect(throb.classList.contains('ws-rotor')).toBe(false);
    expect(container.querySelector('.ws-sym').getAttribute('data-watch')).toBe('true');
  });

  it('power_kW drives a STATIC rim arc and no motion at all', () => {
    const { container } = sheet('pump', {
      data: { label: 'P', params: {} },
      state: 'rest',
      snap: snapOf({ metrics: { status: 'ON', speed_pct: 100, power_kW: 10 }, live: true }),
    });
    const rim = container.querySelector('.ws-rim');
    expect(rim.getAttribute('pathLength')).toBe('100');
    expect(rim.getAttribute('stroke-dasharray')).toBe('50.0 100');   // 10 / powerRef 20
    expect(rim.classList.contains('ws-anim')).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. Valve — catalogue #5
// ═══════════════════════════════════════════════════════════════════════════

function valve(metrics, params = {}) {
  const { container } = sheet('valve', {
    data: { label: 'V', params },
    state: 'rest',
    snap: snapOf({ metrics, live: true }),
  });
  return container;
}

describe('valve — disc angle is the opening setpoint (the other legal echo)', () => {
  it('opening 40 and 100 give DIFFERENT disc angles', () => {
    const a = valve({ status: 'THROTTLED', opening_pct: 40 }).querySelector('.ws-disc');
    const b = valve({ status: 'OPEN', opening_pct: 100 }).querySelector('.ws-disc');
    expect(a.getAttribute('data-angle')).toBe('54.0');    // 90 - 0.9 * 40
    expect(b.getAttribute('data-angle')).toBe('0.0');     // edge-on
    expect(a.style.transform).not.toBe(b.style.transform);
  });

  it('CLOSED puts the disc square across the throat as a RED bar, throat empty', () => {
    const c = valve({ status: 'CLOSED', opening_pct: 0 });
    const disc = c.querySelector('.ws-disc');
    expect(disc.getAttribute('data-angle')).toBe('90.0');
    expect(c.querySelector('.ws-disc-bar').getAttribute('fill')).toContain('--ws-alarm');
    expect(c.querySelector('.ws-throat-fill')).toBeNull();
    expect(c.querySelector('.ws-sym').getAttribute('data-state')).toBe('off');
  });

  it('throat fill width is STATIC and tracks opening_pct', () => {
    const f = valve({ status: 'THROTTLED', opening_pct: 25 }).querySelector('.ws-throat-fill');
    expect(f.getAttribute('data-fill-pct')).toBe('25');
    expect(f.classList.contains('ws-anim')).toBe(false);
  });

  it('THROTTLED chatters on a NESTED inner group, at the catalogue period', () => {
    const c = valve({ status: 'THROTTLED', opening_pct: 40 });
    const chatter = c.querySelector('.ws-disc .ws-anim');
    expect(chatter).toBeTruthy();
    // clamp(3.2 - 0.024 * 40, 0.8, 3.0) = 2.24s
    expect(chatter.getAttribute('data-chatter')).toBe('2.24s');
    expect(chatter.parentElement.classList.contains('ws-disc')).toBe(true);
    // amplitude is still published for the stylesheet
    expect(chatter.style.getPropertyValue('--ws-chatter-amp')).toBe('1.40');
  });

  it('a fully open valve does not chatter', () => {
    expect(valve({ status: 'OPEN', opening_pct: 100 }).querySelector('.ws-disc .ws-anim')).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. Blower — catalogue #3 (there is NO blower model)
// ═══════════════════════════════════════════════════════════════════════════

function blower(derived, live = true) {
  const { container } = sheet('blower', {
    data: { label: 'B', params: {} },
    state: 'rest',
    snap: snapOf({ metrics: {}, derived, live }),
  });
  return container;
}

describe('blower — duty is derived, and with nothing served it does not turn', () => {
  it('no adjacent aeration node: NO spin variable, UNLINKED, no air pulses', () => {
    for (const d of [{}, { O2_served: 0, servedCount: 0 }]) {
      const c = blower(d);
      const rotors = c.querySelectorAll('.ws-rotor');
      expect(rotors.length).toBe(2);
      for (const r of rotors) {
        expect(r.style.getPropertyValue('--ws-spin')).toBe('');
        expect(r.classList.contains('ws-anim')).toBe(false);
        expect(r.style.transform).toBe('rotate(12deg)');
      }
      expect(c.querySelector('[data-unlinked="true"]')).toBeTruthy();
      expect(c.querySelector('.ws-sym').getAttribute('data-state')).toBe('nomodel');
      expect(c.querySelector('.ws-pulse')).toBeNull();
    }
  });

  it('served by an aeration basin: both lobes spin, one reversed, header pulses', () => {
    const c = blower({ O2_served: 800, servedCount: 2 });
    const rotors = c.querySelectorAll('.ws-rotor');
    expect(rotors.length).toBe(2);
    expect(rotors[0].style.getPropertyValue('--ws-spin')).toBeTruthy();
    expect(rotors[1].classList.contains('ws-rotor--rev')).toBe(true);
    expect(c.querySelector('[data-unlinked="true"]')).toBeNull();
    const pulse = c.querySelector('.ws-pulse');
    expect(pulse.style.getPropertyValue('--ws-flow')).toBe(rotors[0].style.getPropertyValue('--ws-spin'));
  });

  it('more O2 served means a faster rotor', () => {
    const hi = blower({ O2_served: 800, servedCount: 2 }).querySelector('.ws-rotor');
    const lo = blower({ O2_served: 120, servedCount: 1 }).querySelector('.ws-rotor');
    expect(parseFloat(hi.style.getPropertyValue('--ws-spin')))
      .toBeLessThan(parseFloat(lo.style.getPropertyValue('--ws-spin')));
  });

  it('air pulses are existence-gated on live, the lobes are play-state gated', () => {
    const c = blower({ O2_served: 800, servedCount: 2 }, false);
    expect(c.querySelector('.ws-pulse')).toBeNull();
    expect(c.querySelector('.ws-rotor').style.getPropertyValue('--ws-spin')).toBeTruthy();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. Screening — catalogue #12. THE ECHO TEST.
// ═══════════════════════════════════════════════════════════════════════════

function rakeDur(metrics) {
  const { container } = sheet('screening', {
    data: { label: 'S', params: {} },
    state: 'rest',
    snap: snapOf({ metrics, live: true }),
  });
  return container.querySelector('[data-rake]').getAttribute('data-rake');
}

describe('screening — the rake is driven by screenings_kg_d, NOT headloss_m', () => {
  it('two different screenings loads give two different periods', () => {
    const light = rakeDur({ screenings_kg_d: 12, headloss_m: 0.15 });
    const heavy = rakeDur({ screenings_kg_d: 115, headloss_m: 0.15 });
    expect(light).not.toBe(heavy);
    expect(parseFloat(heavy)).toBeLessThan(parseFloat(light));
  });

  it('changing ONLY headloss_m does NOT change the period (it is a verbatim echo)', () => {
    const a = rakeDur({ screenings_kg_d: 60, headloss_m: 0.10 });
    const b = rakeDur({ screenings_kg_d: 60, headloss_m: 0.90 });
    expect(a).toBe(b);
    expect(a).toMatch(/s$/);
  });

  it('headloss_m still drives STATIC encoders: blinding and the level differential', () => {
    const low = sheet('screening', {
      data: { label: 'S', params: {} }, state: 'rest',
      snap: snapOf({ metrics: { screenings_kg_d: 60, headloss_m: 0.05 }, live: true }),
    }).container;
    const high = sheet('screening', {
      data: { label: 'S', params: {} }, state: 'rest',
      snap: snapOf({ metrics: { screenings_kg_d: 60, headloss_m: 0.30 }, live: true }),
    }).container;
    const bLow = low.querySelector('.ws-blinding').getAttribute('data-blinding');
    const bHigh = high.querySelector('.ws-blinding').getAttribute('data-blinding');
    expect(parseFloat(bHigh)).toBeGreaterThan(parseFloat(bLow));
    expect(low.querySelector('.ws-blinding').classList.contains('ws-anim')).toBe(false);
  });

  it('idle parks the rake at the foot, and the skip and blinding are still drawn', () => {
    const { container } = sheet('screening', {
      data: { label: 'S', params: {} }, state: 'rest',
      snap: snapOf({ metrics: { screenings_kg_d: 0, headloss_m: 0.2 }, live: true }),
    });
    const carriage = container.querySelector('[data-rake]');
    expect(carriage.getAttribute('data-rake')).toBe('parked');
    expect(carriage.classList.contains('ws-rake-travel')).toBe(false);
    expect(container.querySelector('.ws-blinding')).toBeTruthy();
  });

  it('TSS_removal_pct is a STRING and is parsed before it picks the rack', () => {
    const micro = sheet('screening', {
      data: { label: 'S', params: {} }, state: 'rest',
      snap: snapOf({ metrics: { TSS_removal_pct: '30.0', screenings_kg_d: 10 } }),
    }).container.querySelector('.ws-sym');
    const coarse = sheet('screening', {
      data: { label: 'S', params: {} }, state: 'rest',
      snap: snapOf({ metrics: { TSS_removal_pct: '5.0', screenings_kg_d: 10 } }),
    }).container.querySelector('.ws-sym');
    expect(micro.getAttribute('data-screen-type')).toBe('micro');
    expect(coarse.getAttribute('data-screen-type')).toBe('coarse');
  });

  it('headloss above 0.45 m flags watch — amber, and it never blinks', () => {
    const { container } = sheet('screening', {
      data: { label: 'S', params: {} }, state: 'rest',
      snap: snapOf({ metrics: { screenings_kg_d: 60, headloss_m: 0.6 }, live: true }),
    });
    expect(container.querySelector('.ws-sym').getAttribute('data-state')).toBe('watch');
    expect(container.querySelector('.ws-alarm')).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. Dosing family — catalogue #16. THE OTHER ECHO TEST.
// ═══════════════════════════════════════════════════════════════════════════

function dosing(opType, metrics, live = true) {
  const { container } = sheet(opType, {
    data: { label: 'D', params: {} },
    state: 'rest',
    snap: snapOf({ metrics, live }),
  });
  return container;
}

describe('dosing family — the droplet is driven by dose_kg_d, NOT dose_mg_L', () => {
  it.each(DOSING)('%s: dose_kg_d null mounts NO droplet and caps the stinger grey', (t) => {
    const c = dosing(t, { dose_mg_L: 30, dose_kg_d: null });
    expect(c.querySelector('.ws-droplet')).toBeNull();
    expect(c.querySelector('.ws-cap')).toBeTruthy();
    expect(c.querySelector('.ws-sym').getAttribute('data-capped')).toBe('true');
  });

  it.each(DOSING)('%s: a real dose_kg_d mounts one droplet with a duration var', (t) => {
    const c = dosing(t, { dose_mg_L: 30, dose_kg_d: 300 });
    const drops = c.querySelectorAll('.ws-droplet');
    expect(drops.length).toBe(1);
    expect(drops[0].style.getPropertyValue('--ws-droplet-dur')).toMatch(/^\d+\.\d\ds$/);
    expect(drops[0].classList.contains('ws-anim')).toBe(true);
  });

  it('dose_mg_L === 0 mounts no droplet even when dose_kg_d is a number', () => {
    expect(dosing('chemical_dosing', { dose_mg_L: 0, dose_kg_d: 0 }).querySelector('.ws-droplet')).toBeNull();
  });

  it('changing ONLY dose_mg_L does not change the period (it is a verbatim echo)', () => {
    const a = dosing('chemical_dosing', { dose_mg_L: 10, dose_kg_d: 300 })
      .querySelector('.ws-droplet').getAttribute('data-drop-dur');
    const b = dosing('chemical_dosing', { dose_mg_L: 90, dose_kg_d: 300 })
      .querySelector('.ws-droplet').getAttribute('data-drop-dur');
    expect(a).toBe(b);
  });

  it('a heavier dose_kg_d drips faster', () => {
    const light = dosing('chemical_dosing', { dose_mg_L: 30, dose_kg_d: 20 })
      .querySelector('.ws-droplet').getAttribute('data-drop-dur');
    const heavy = dosing('chemical_dosing', { dose_mg_L: 30, dose_kg_d: 400 })
      .querySelector('.ws-droplet').getAttribute('data-drop-dur');
    expect(parseFloat(heavy)).toBeLessThan(parseFloat(light));
  });

  it('the droplet is existence-gated on live', () => {
    expect(dosing('chemical_dosing', { dose_mg_L: 30, dose_kg_d: 300 }, false)
      .querySelector('.ws-droplet')).toBeNull();
  });

  it('the four variants are four different marks on one drawing', () => {
    const marks = DOSING.map((t) => dosing(t, { dose_mg_L: 30, dose_kg_d: 300 }).querySelector('.ws-sym').className.baseVal);
    expect(new Set(marks).size).toBe(4);
  });

  it('ph_adjustment tints the receiving liquid from the computed pH_out', () => {
    const acid = dosing('ph_adjustment', { dose_mg_L: 30, dose_kg_d: 300, pH_in: 7.2, pH_out: 4.5 })
      .querySelector('.ws-receiving').getAttribute('data-receiving');
    const base = dosing('ph_adjustment', { dose_mg_L: 30, dose_kg_d: 300, pH_in: 7.2, pH_out: 9.5 })
      .querySelector('.ws-receiving').getAttribute('data-receiving');
    expect(acid).toMatch(/^rgb\(/);
    expect(acid).not.toBe(base);
    // the other three variants leave the line the process-water service colour
    expect(dosing('chemical_dosing', { dose_mg_L: 30, dose_kg_d: 300, pH_out: 4.5 })
      .querySelector('.ws-receiving').getAttribute('data-receiving')).toBeNull();
  });

  it('ph_adjustment flags watch when |pH_out - pH_in| > 1.5', () => {
    const c = dosing('ph_adjustment', { dose_mg_L: 30, dose_kg_d: 300, pH_in: 6.2, pH_out: 8.4 });
    expect(c.querySelector('.ws-sym').getAttribute('data-watch')).toBe('true');
    const calm = dosing('ph_adjustment', { dose_mg_L: 30, dose_kg_d: 300, pH_in: 7.0, pH_out: 7.4 });
    expect(calm.querySelector('.ws-sym').getAttribute('data-watch')).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 7. Inlet / outlet — catalogue #18
// ═══════════════════════════════════════════════════════════════════════════

describe('outlet — the compliance stamp, and what must survive a screenshot', () => {
  const violations = [
    { param: 'TN', value: 14.2, limit: 10, unit: 'mg/L' },
    { param: 'TSS', value: 41.0, limit: 30, unit: 'mg/L' },
    { param: 'TP', value: 2.4, limit: 1, unit: 'mg/L' },
    { param: 'BOD', value: 35.1, limit: 30, unit: 'mg/L' },
  ];

  it('renders the ring and the chips with live: FALSE — values always', () => {
    const { container } = sheet('outlet', {
      state: 'rest',
      snap: snapOf({ live: false, metrics: { compliant: false, permit_violations: violations } }),
    });
    expect(container.querySelector('.ws-ring')).toBeTruthy();
    const chips = container.querySelectorAll('.ws-chips text');
    expect(chips.length).toBe(4);                     // 3 violations + the "+1"
    expect(chips[0].textContent).toBe('TN 14.2 > 10.0');
    expect(chips[3].textContent).toBe('+1');
    expect(container.querySelector('.ws-sym').getAttribute('data-state')).toBe('alarm');
  });

  it('the ring uses the fixed 1.0s cadence and is paused outside live by .ws-anim', () => {
    const { container } = sheet('outlet', {
      state: 'rest',
      snap: snapOf({ live: true, metrics: { compliant: false, permit_violations: violations.slice(0, 1) } }),
    });
    const ring = container.querySelector('.ws-ring');
    expect(ring.classList.contains('ws-anim')).toBe(true);
    expect(ring.classList.contains('ws-alarm')).toBe(true);
    // the cadence is a stylesheet constant — no per-node duration is written
    expect(ring.style.getPropertyValue('--ws-dur-alarm')).toBe('');
  });

  it('a pH MINIMUM breach reads as a floor, not a ceiling', () => {
    const { container } = sheet('outlet', {
      state: 'rest',
      snap: snapOf({ metrics: { compliant: false, permit_violations: [{ param: 'pH', value: 5.4, limit: 6, unit: '(min)' }] } }),
    });
    expect(container.querySelector('.ws-chips text').textContent).toBe('pH 5.4 < 6.0');
  });

  it('compliant draws the stamp statically, and does NOT fire it on first sight', () => {
    const { container } = sheet('outlet', {
      state: 'rest',
      snap: snapOf({ live: true, metrics: { compliant: true, permit_violations: [] } }),
    });
    const stamp = container.querySelector('[data-stamp]');
    expect(stamp).toBeTruthy();
    expect(stamp.getAttribute('data-stamp')).toBe('still');   // no transition observed
    expect(container.querySelector('.ws-ring')).toBeNull();
  });

  it('the one-shot fires ONLY on a transition to compliant, and only once', () => {
    const Comp = getSymbol('outlet');
    const view = (snap) => (
      <div className="ws-sheet ws-live">
        <svg viewBox="0 0 144 60"><Comp nodeId="n1" opType="outlet" state="rest" snap={snap} /></svg>
      </div>
    );
    const bad = snapOf({ live: true, seq: 1, changedSeq: 1, metrics: { compliant: false, permit_violations: violations.slice(0, 1) } });
    const good = snapOf({ live: true, seq: 2, changedSeq: 2, metrics: { compliant: true, permit_violations: [] } });
    const same = snapOf({ live: true, seq: 3, changedSeq: 2, metrics: { compliant: true, permit_violations: [] } });
    const later = snapOf({ live: true, seq: 4, changedSeq: 4, metrics: { compliant: true, permit_violations: [] } });

    const { container, rerender } = render(view(bad));
    expect(container.querySelector('[data-stamp]')).toBeNull();

    rerender(view(good));
    expect(container.querySelector('[data-stamp]').getAttribute('data-stamp')).toBe('fire');

    rerender(view(same));   // same changedSeq — the completed one-shot stays put
    expect(container.querySelector('[data-stamp]').getAttribute('data-stamp')).toBe('fire');

    rerender(view(later));  // a later tick with no transition must NOT replay it
    expect(container.querySelector('[data-stamp]').getAttribute('data-stamp')).toBe('still');
  });

  it('a malformed permit_violations array cannot crash the sink', () => {
    for (const v of [null, 'nope', [null], [{}], [{ param: 'TN' }]]) {
      const { container, unmount } = sheet('outlet', {
        state: 'rest',
        snap: snapOf({ metrics: { compliant: false, permit_violations: v } }),
      });
      expect(container.querySelector('.ws-sym')).toBeTruthy();
      unmount();
    }
  });
});

describe('inlet — a magnitude, never a rate', () => {
  it('Q_in scales the entry chevrons statically and mounts no animation', () => {
    const big = sheet('inlet', { snap: snapOf({ metrics: { Q_in: 10000 }, live: true }) }).container;
    const small = sheet('inlet', { snap: snapOf({ metrics: { Q_in: 500 }, live: true }) }).container;
    const o = (c) => parseFloat(c.querySelector('.ws-internals path').getAttribute('opacity'));
    expect(o(big)).toBeGreaterThan(o(small));
    expect(big.querySelector('.ws-anim')).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 8. The forbidden list (spec §7, acceptance check #21) — scanned in source
// ═══════════════════════════════════════════════════════════════════════════

describe('lane C source — the forbidden techniques', () => {
  const HERE = dirname(fileURLToPath(import.meta.url));
  const DIR = join(HERE, '..', 'components', 'canvas', 'symbols');
  const FILES = [...LANE_C.map((t) => join(DIR, `${t}.jsx`)),
    join(HERE, '..', 'pages', '__dev__', 'SymbolSheet.jsx')];

  const BANNED = [
    ['SMIL <animate>', /<animate[\s/>]/],
    ['SMIL <animateTransform>', /<animateTransform/],
    ['SMIL <animateMotion>', /<animateMotion/],
    ['an SVG <filter>', /<filter[\s/>]/],
    ['a CSS filter', /\bfilter\s*:/],
    ['requestAnimationFrame', /requestAnimationFrame/],
    ['setInterval', /setInterval/],
    ['a JS-built animation shorthand', /\banimation\s*:/],
  ];

  it.each(BANNED)('never uses %s', (_label, re) => {
    for (const f of FILES) {
      expect(readFileSync(f, 'utf8'), f).not.toMatch(re);
    }
  });

  it('every duration reaches CSS as a custom property, never as a string', () => {
    for (const f of FILES) {
      const src = readFileSync(f, 'utf8');
      // durations are only ever written into a `--ws-*` variable
      const durations = src.match(/'\d+\.\d\ds'/g) || [];
      for (const d of durations) {
        const line = src.split('\n').find((l) => l.includes(d));
        expect(line, `${f}: ${d}`).toMatch(/--ws-/);
      }
    }
  });
});
