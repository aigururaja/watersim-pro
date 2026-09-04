/**
 * Lane D — the nine vessel symbols.
 *
 * These tests exist to pin the SPECIFIC MISTAKES §0.3 was written to prevent.
 * Rendering is the easy part; the tests that matter are the negative ones:
 *
 *  · the secondary clarifier's rake must NOT retime when only `SOR_m3_m2_d`
 *    changes — SOR is a verbatim echo of the user's setpoint, and an arm timed
 *    from it would never once move in response to the plant;
 *  · the amber ring must NOT come from `metrics.warnings.length` — the model's
 *    `SLR > 6.0` test is a units bug against a per-DAY value, so that array is
 *    non-empty on essentially every sheet;
 *  · the primary blanket must NOT respond to `sludge_TSS_mg_L` — also an echo;
 *  · the digester's floating cover must carry NO animation and NO duration
 *    custom property AT ANY GAS RATE, because `volume_m3_d` is a production
 *    rate and a gasholder cover tracks an inventory this engine never holds.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';

import { FRAME } from '../components/canvas/symbols/primitives';
import { getSymbol, hasSymbol, resolveSymbolType } from '../components/canvas/symbols';

import ActivatedSludge from '../components/canvas/symbols/activated_sludge';
import MembraneBioreactor from '../components/canvas/symbols/membrane_bioreactor';
import UctReactor from '../components/canvas/symbols/uct_reactor';
import JhbReactor from '../components/canvas/symbols/jhb_reactor';
import PrimaryClarifier from '../components/canvas/symbols/primary_clarifier';
import SecondaryClarifier from '../components/canvas/symbols/secondary_clarifier';
import GritRemoval from '../components/canvas/symbols/grit_removal';
import Thickener from '../components/canvas/symbols/thickener';
import AnaerobicDigester from '../components/canvas/symbols/anaerobic_digester';

// ═══════════════════════════════════════════════════════════════════════════
// Harness
// ═══════════════════════════════════════════════════════════════════════════

const LANE_D = Object.freeze({
  activated_sludge: ActivatedSludge,
  membrane_bioreactor: MembraneBioreactor,
  uct_reactor: UctReactor,
  jhb_reactor: JhbReactor,
  primary_clarifier: PrimaryClarifier,
  secondary_clarifier: SecondaryClarifier,
  grit_removal: GritRemoval,
  thickener: Thickener,
  anaerobic_digester: AnaerobicDigester,
});

const REFS = Object.freeze({
  Qref: 10000, O2ref: 2000, screenRef: 1, doseRef: 1,
  gasRef: 1000, sludgeRef: 1000, powerRef: 1,
});

/** A NodeSnapshot exactly as `liveStore.getNodeSnapshot` shapes one. */
function snapOf(over = {}) {
  return {
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
  };
}

/** Symbols render SVG CHILDREN ONLY — the host supplies the frame. */
function draw(Comp, snap, props = {}) {
  return render(
    <div className="ws-sheet ws-live">
      <svg viewBox={`0 0 ${FRAME.w} ${FRAME.h}`}>
        <Comp nodeId="n1" snap={snap} state="rest" {...props} />
      </svg>
    </div>,
  );
}

const q = (c, sel) => c.querySelector(sel);
const qa = (c, sel) => Array.from(c.querySelectorAll(sel));
const bubbleDur = (c) => q(c, '.ws-bubble')?.style.getPropertyValue('--ws-bubble-dur') ?? null;
const rakeDur = (c) => q(c, '.ws-rake')?.style.getPropertyValue('--ws-rake-dur') ?? null;
const blanketScale = (c) => q(c, '.ws-blanket')?.style.transform ?? null;
/** The painted liquid rect — NOT the invisible bbox anchor `Fill` draws first. */
const fillOpacity = (c) => qa(c, '.ws-fill rect')
  .map((r) => r.getAttribute('opacity')).find((o) => o != null) ?? null;
/** Any duration custom property written anywhere in the tree. */
const ZERO_DUR = /--ws-[a-z-]*(?:dur|drift|spin|flow)\s*:\s*0s/;

// Metric sets that exercise every guarded read.
const FULL = Object.freeze({
  activated_sludge: {
    O2_demand_kg_d: 900, volume_m3: 1200, MLSS_mg_L: 3500,
    nitrification: true, denitrification: false, HRT_h: 8, config: 'none',
  },
  primary_clarifier: {
    SOR_m3_m2_d: 40, sludge_Q_m3_d: 60, sludge_TSS_mg_L: 25000, TSS_removal_pct: 60.5,
  },
  secondary_clarifier: {
    SOR_m3_m2_d: 16, SLR_kg_m2_d: 48, RAS_Q_m3_d: 3300, RAS_TSS_mg_L: 8200,
    eff_TSS_mg_L: 12, warnings: ['High solids loading rate (48.0 kg/m²/d)'],
  },
  grit_removal: {
    chamberType: 'vortex', TSS_removal_pct: '12.0',
    grit_removed_kg_d: 300, chamber_volume_m3: 20.8, HRT_min: 3,
  },
  thickener: {
    type: 'gravity', SLR_kg_m2_d: 80, solids_in_kg_d: 800,
    thickened_Q_m3_d: 12.7, thickened_TSS_g_L: 60, capture_pct: 95,
  },
  anaerobic_digester: { pH_out: 7.1, stable: true, HRT_d: 20, warnings: [] },
});

const OUTPUTS = Object.freeze({
  primary_clarifier: { effluent: { Q: 9940 }, primarySludge: { Q: 60 } },
  secondary_clarifier: { effluent: { Q: 6700 }, RAS: { Q: 3300 } },
  activated_sludge: { effluent: { Q: 9900 }, WAS: { Q: 100 } },
  grit_removal: { effluent: { Q: 10000 } },
  thickener: { thickened: { Q: 12.7 }, filtrate: { Q: 87.3 } },
  anaerobic_digester: { digestate: { Q: 30 }, filtrate: { Q: 70 } },
});

const fullSnap = (type, over = {}) => snapOf({
  opType: type,
  metrics: FULL[type] ?? FULL[type === 'membrane_bioreactor' || type === 'uct_reactor' || type === 'jhb_reactor'
    ? 'activated_sludge' : type] ?? {},
  outputs: OUTPUTS[type] ?? OUTPUTS.activated_sludge,
  biogas: type === 'anaerobic_digester' ? { volume_m3_d: 600, CH4_pct: 63 } : null,
  ...over,
});

// ═══════════════════════════════════════════════════════════════════════════
// 1. Registration and robustness
// ═══════════════════════════════════════════════════════════════════════════

describe('lane D — registration', () => {
  it('registers all nine vessel types', () => {
    for (const t of Object.keys(LANE_D)) {
      expect(hasSymbol(t), t).toBe(true);
      expect(getSymbol(t)).toBe(LANE_D[t]);
    }
  });

  it('thickener is now a first-class symbol, not an alias', () => {
    expect(resolveSymbolType('thickener')).toBe('thickener');
    expect(getSymbol('thickener')).toBe(Thickener);
  });
});

describe('lane D — every symbol survives every snapshot shape', () => {
  const SHAPES = {
    'full metrics': (t) => fullSnap(t),
    'empty metrics': (t) => snapOf({ opType: t, metrics: {} }),
    'model error': (t) => snapOf({ opType: t, metrics: { error: 'model threw' } }),
    'no results at all': (t) => snapOf({ opType: t, hasResults: false }),
    'null / NaN values': (t) => snapOf({
      opType: t,
      metrics: {
        O2_demand_kg_d: null, volume_m3: NaN, MLSS_mg_L: null,
        SLR_kg_m2_d: NaN, RAS_Q_m3_d: null, RAS_TSS_mg_L: undefined,
        sludge_Q_m3_d: NaN, sludge_TSS_mg_L: null, grit_removed_kg_d: null,
        chamber_volume_m3: NaN, thickened_Q_m3_d: null, pH_out: NaN,
        stable: null, zone_volumes_m3: null, nitrification: null,
      },
      outputs: { effluent: { Q: null } },
      biogas: { volume_m3_d: NaN },
      refs: { ...REFS, Qref: NaN, sludgeRef: null, gasRef: undefined },
    }),
    'not live': (t) => fullSnap(t, { live: false }),
  };

  for (const [type, Comp] of Object.entries(LANE_D)) {
    for (const [label, build] of Object.entries(SHAPES)) {
      it(`${type} renders with ${label}`, () => {
        const { container } = draw(Comp, build(type));
        // A vessel always draws its shell, whatever the solver did.
        expect(q(container, '.ws-shell')).toBeTruthy();
        // A rest pose is never smuggled in as a 0s or NaNs duration — `0s`
        // pins the CPU and `NaN` silently kills the animation.
        for (const el of qa(container, '[style]')) {
          const css = el.getAttribute('style');
          expect(css).not.toMatch(/NaN|Infinity/);
          expect(css).not.toMatch(ZERO_DUR);
        }
      });
    }
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. §5.3 #2 — aeration bubble columns
// ═══════════════════════════════════════════════════════════════════════════

describe('aeration — bubble columns are driven by O2 demand per unit volume', () => {
  const aerSnap = (O2_demand_kg_d, volume_m3, extra = {}) => snapOf({
    opType: 'activated_sludge',
    metrics: { O2_demand_kg_d, volume_m3, MLSS_mg_L: 3000, ...extra },
    outputs: OUTPUTS.activated_sludge,
  });

  it('a higher O2 loading gives MORE columns AND a shorter rise period', () => {
    // 0.2 kg O2/m3/d — the bottom of the band.
    const low = draw(ActivatedSludge, aerSnap(240, 1200)).container;
    // 1.5 kg O2/m3/d — near the top.
    const high = draw(ActivatedSludge, aerSnap(1800, 1200)).container;

    const lowX = new Set(qa(low, '.ws-bubble').map((c) => c.getAttribute('cx')));
    const highX = new Set(qa(high, '.ws-bubble').map((c) => c.getAttribute('cx')));
    expect(lowX.size).toBe(2);
    expect(highX.size).toBe(6);

    expect(parseFloat(bubbleDur(high))).toBeLessThan(parseFloat(bubbleDur(low)));
  });

  it('the band is scale-invariant — a package plant reads like a big works', () => {
    const small = draw(ActivatedSludge, aerSnap(75, 50)).container;   // 1.5 kg/m3/d
    const big = draw(ActivatedSludge, aerSnap(75000, 50000)).container; // 1.5 kg/m3/d
    expect(bubbleDur(small)).toBe(bubbleDur(big));
    expect(qa(small, '.ws-bubble').length).toBe(qa(big, '.ws-bubble').length);
  });

  it('no O2 demand → NO bubbles mounted and the diffuser header goes grey', () => {
    for (const o2 of [null, 0, 0.4]) {
      const { container } = draw(ActivatedSludge, aerSnap(o2, 1200));
      expect(qa(container, '.ws-bubble').length, `O2=${o2}`).toBe(0);
      expect(q(container, '[data-ws="diffuser"]').getAttribute('opacity')).toBe('0.45');
    }
    const on = draw(ActivatedSludge, aerSnap(900, 1200)).container;
    expect(q(on, '[data-ws="diffuser"]').getAttribute('opacity')).toBe('1');
  });

  it('nitrification === true tints the bubbles cyan', () => {
    const nit = draw(ActivatedSludge, aerSnap(900, 1200, { nitrification: true })).container;
    const off = draw(ActivatedSludge, aerSnap(900, 1200, { nitrification: false })).container;
    expect(q(nit, '.ws-bubble').getAttribute('fill')).toContain('--ws-svc-air');
    expect(q(off, '.ws-bubble').getAttribute('fill')).not.toContain('--ws-svc-air');
  });

  it('stays inside the §7 budget: at most 18 circles, staggered with NO JS timing', () => {
    const { container } = draw(ActivatedSludge, aerSnap(3000, 1200));
    const bubbles = qa(container, '.ws-bubble');
    expect(bubbles.length).toBeLessThanOrEqual(18);
    // Every stagger is a static NEGATIVE animation-delay.
    expect(bubbles.slice(1).some((b) => b.style.animationDelay.includes('-'))).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. §5.3 #2b — UCT / JHB zones
// ═══════════════════════════════════════════════════════════════════════════

describe('UCT / JHB — zones, mixers and the recycle arc', () => {
  const zoned = (type, zone_volumes_m3) => snapOf({
    opType: type,
    metrics: { O2_demand_kg_d: 900, volume_m3: 1200, MLSS_mg_L: 3500, nitrification: true, zone_volumes_m3 },
    outputs: OUTPUTS.activated_sludge,
  });

  it('draws two baffles and mixes — never aerates — the unaerated zones', () => {
    for (const [type, Comp, zv] of [
      ['uct_reactor', UctReactor, { anaerobic: 180, anoxic: 300, aerobic: 720 }],
      ['jhb_reactor', JhbReactor, { pre_anoxic: 96, anaerobic: 180, main_anoxic: 300, aerobic: 624 }],
    ]) {
      const { container } = draw(Comp, zoned(type, zv));
      expect(qa(container, '[data-ws="baffle"]').length, type).toBe(2);
      expect(qa(container, '[data-ws="mixer"]').length, type).toBe(2);
      // The mixer wash reuses ws-drift; it never becomes a bubble column.
      for (const mx of qa(container, '[data-ws="mixer"]')) {
        expect(mx.classList.contains('ws-wave')).toBe(true);
        expect(mx.classList.contains('ws-anim')).toBe(true);
      }
    }
  });

  it('every bubble sits inside the AEROBIC zone', () => {
    const { container } = draw(UctReactor, zoned('uct_reactor', { anaerobic: 180, anoxic: 300, aerobic: 720 }));
    // anaerobic 0.15 + anoxic 0.25 of an 84px basin starting at x=30 → 63.6
    const aerobicStart = 30 + 84 * 0.4;
    const xs = qa(container, '.ws-bubble').map((c) => parseFloat(c.getAttribute('cx')));
    expect(xs.length).toBeGreaterThan(0);
    for (const x of xs) expect(x).toBeGreaterThanOrEqual(aerobicStart);
  });

  it('idle → zones are drawn and NOTHING moves', () => {
    const { container } = draw(UctReactor, zoned('uct_reactor', { anaerobic: 180, anoxic: 300, aerobic: 720 }), {});
    const idle = draw(UctReactor, snapOf({
      opType: 'uct_reactor', live: false,
      metrics: { O2_demand_kg_d: 900, volume_m3: 1200, zone_volumes_m3: { anaerobic: 180, anoxic: 300, aerobic: 720 } },
      outputs: OUTPUTS.activated_sludge,
    })).container;
    expect(qa(container, '[data-ws="baffle"]').length).toBe(2);
    expect(qa(idle, '[data-ws="baffle"]').length).toBe(2);
    expect(qa(idle, '.ws-bubble').length).toBe(0);
    for (const mx of qa(idle, '[data-ws="mixer"]')) {
      expect(mx.classList.contains('ws-anim')).toBe(false);
    }
  });

  it('the recycle arc lands on a DIFFERENT zone for UCT and JHB', () => {
    const zv = { anaerobic: 180, anoxic: 300, aerobic: 720 };
    const uct = draw(UctReactor, zoned('uct_reactor', zv)).container;
    const jhb = draw(JhbReactor, zoned('jhb_reactor', zv)).container;
    const d = (c) => q(c, '[data-ws="recycle-arc"] path').getAttribute('d');
    expect(d(uct)).not.toBe(d(jhb));
  });

  it('plain activated_sludge has no zones; the MBR adds a leaf stack', () => {
    const plain = draw(ActivatedSludge, fullSnap('activated_sludge')).container;
    const mbr = draw(MembraneBioreactor, fullSnap('membrane_bioreactor')).container;
    expect(qa(plain, '[data-ws="baffle"]').length).toBe(0);
    expect(q(plain, '[data-ws="leaves"]')).toBeNull();
    expect(qa(mbr, '[data-ws="baffle"]').length).toBe(0);
    expect(q(mbr, '[data-ws="leaves"]')).toBeTruthy();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. §5.3 #6, #7 — the secondary clarifier, and the two traps
// ═══════════════════════════════════════════════════════════════════════════

describe('secondary clarifier — the rake, and the echo it must ignore', () => {
  const sc = (over) => snapOf({
    opType: 'secondary_clarifier',
    metrics: { ...FULL.secondary_clarifier, ...over },
    outputs: OUTPUTS.secondary_clarifier,
  });

  it('the rake period responds to RAS_Q_m3_d', () => {
    const slow = draw(SecondaryClarifier, sc({ RAS_Q_m3_d: 80 })).container;
    const fast = draw(SecondaryClarifier, sc({ RAS_Q_m3_d: 990 })).container;
    expect(rakeDur(slow)).toBeTruthy();
    expect(rakeDur(fast)).toBeTruthy();
    expect(parseFloat(rakeDur(fast))).toBeLessThan(parseFloat(rakeDur(slow)));
  });

  it('the rake period does NOT respond to SOR_m3_m2_d — SOR is a verbatim echo', () => {
    const a = draw(SecondaryClarifier, sc({ SOR_m3_m2_d: 8 })).container;
    const b = draw(SecondaryClarifier, sc({ SOR_m3_m2_d: 32 })).container;
    expect(rakeDur(a)).toBe(rakeDur(b));
  });

  it('only four rake periods exist, and they are [26, 20, 14, 8]s', () => {
    const seen = new Set();
    for (const RAS_Q_m3_d of [10, 120, 260, 380, 510, 640, 760, 880, 1000]) {
      seen.add(rakeDur(draw(SecondaryClarifier, sc({ RAS_Q_m3_d })).container));
    }
    for (const d of seen) expect(['26.00s', '20.00s', '14.00s', '8.00s']).toContain(d);
    expect(seen.size).toBeGreaterThan(1);
  });

  it('inbound Q below 0.5 parks the rake at 45° — the blanket is still drawn', () => {
    expect(rakeDur(draw(SecondaryClarifier, sc({})).container)).toBeTruthy();

    const dead = draw(SecondaryClarifier, snapOf({
      opType: 'secondary_clarifier',
      metrics: { ...FULL.secondary_clarifier, RAS_Q_m3_d: 0 },
      outputs: { effluent: { Q: 0 }, RAS: { Q: 0 } },
    })).container;
    const rake = q(dead, '.ws-rake');
    expect(rake.classList.contains('ws-anim')).toBe(false);
    expect(rake.style.transform).toBe('rotate(45deg)');
    expect(q(dead, '.ws-blanket')).toBeTruthy();
  });

  it('the blanket height responds to SLR_kg_m2_d', () => {
    const thin = draw(SecondaryClarifier, sc({ SLR_kg_m2_d: 20 })).container;
    const thick = draw(SecondaryClarifier, sc({ SLR_kg_m2_d: 60 })).container;
    const capped = draw(SecondaryClarifier, sc({ SLR_kg_m2_d: 900 })).container;
    expect(blanketScale(thin)).toBe('scaleY(0.1388888888888889)');
    expect(blanketScale(thick)).toBe('scaleY(0.4166666666666667)');
    expect(blanketScale(capped)).toBe('scaleY(0.6)');   // clamped at 0.60
    // scaleY on a bottom-anchored group — never the height attribute.
    expect(q(thin, '.ws-blanket').getAttribute('height')).toBeNull();
    expect(q(thin, '.ws-blanket').style.transformOrigin).toBe('50% 100%');
  });

  it('a non-empty warnings array with SLR under the limit does NOT go amber', () => {
    // The model warns whenever SLR > 6.0 — a units bug against a per-DAY value —
    // so this array is non-empty on essentially every default sheet.
    const { container } = draw(SecondaryClarifier, sc({
      SLR_kg_m2_d: 48,
      RAS_TSS_mg_L: 8200,
      warnings: [
        'High solids loading rate (48.0 kg/m²/d)',
        'RAS TSS from mass balance is below the target thickening',
      ],
    }));
    expect(q(container, '[data-ws="warn"]')).toBeNull();
  });

  it('goes amber on a real overload — SLR > 144 or RAS TSS > 12000', () => {
    const slr = draw(SecondaryClarifier, sc({ SLR_kg_m2_d: 160, warnings: [] })).container;
    const ras = draw(SecondaryClarifier, sc({ SLR_kg_m2_d: 48, RAS_TSS_mg_L: 13500, warnings: [] })).container;
    expect(q(slr, '[data-ws="warn"]').getAttribute('data-level')).toBe('watch');
    expect(q(ras, '[data-ws="warn"]').getAttribute('data-level')).toBe('watch');
  });

  it('has two rake arms and no scum baffle; the primary has one arm and a baffle', () => {
    const sec = draw(SecondaryClarifier, fullSnap('secondary_clarifier')).container;
    const pri = draw(PrimaryClarifier, fullSnap('primary_clarifier')).container;
    expect(qa(sec, '.ws-rake [data-ws="rake"] > g').length).toBe(2);
    expect(q(sec, '[data-ws="scum-baffle"]')).toBeNull();
    expect(qa(pri, '.ws-rake [data-ws="rake"] > g').length).toBe(1);
    expect(q(pri, '[data-ws="scum-baffle"]')).toBeTruthy();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. §5.3 #8 — the primary clarifier blanket
// ═══════════════════════════════════════════════════════════════════════════

describe('primary clarifier — the blanket follows the underflow split', () => {
  const pc = (metrics, outputs) => snapOf({
    opType: 'primary_clarifier',
    metrics: { ...FULL.primary_clarifier, ...metrics },
    outputs: outputs ?? OUTPUTS.primary_clarifier,
  });

  it('responds to sludge_Q_m3_d', () => {
    const thin = draw(PrimaryClarifier, pc({ sludge_Q_m3_d: 20 }, { effluent: { Q: 9980 } })).container;
    const thick = draw(PrimaryClarifier, pc({ sludge_Q_m3_d: 200 }, { effluent: { Q: 9800 } })).container;
    expect(blanketScale(thin)).not.toBe(blanketScale(thick));
    expect(parseFloat(blanketScale(thin).slice(7))).toBeLessThan(parseFloat(blanketScale(thick).slice(7)));
  });

  it('does NOT respond to sludge_TSS_mg_L — that is a verbatim echo', () => {
    const a = draw(PrimaryClarifier, pc({ sludge_TSS_mg_L: 10000 })).container;
    const b = draw(PrimaryClarifier, pc({ sludge_TSS_mg_L: 60000 })).container;
    expect(blanketScale(a)).toBe(blanketScale(b));
  });

  it('the rake follows sludge_Q_m3_d, not SOR_m3_m2_d', () => {
    const slow = draw(PrimaryClarifier, pc({ sludge_Q_m3_d: 40 })).container;
    const fast = draw(PrimaryClarifier, pc({ sludge_Q_m3_d: 950 })).container;
    expect(parseFloat(rakeDur(fast))).toBeLessThan(parseFloat(rakeDur(slow)));

    const sorA = draw(PrimaryClarifier, pc({ SOR_m3_m2_d: 20 })).container;
    const sorB = draw(PrimaryClarifier, pc({ SOR_m3_m2_d: 60 })).container;
    expect(rakeDur(sorA)).toBe(rakeDur(sorB));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. grit + thickener
// ═══════════════════════════════════════════════════════════════════════════

describe('grit removal and thickener', () => {
  it('grit turns only on a VORTEX chamber, and its spiral tells it apart', () => {
    const base = FULL.grit_removal;
    const vortex = draw(GritRemoval, snapOf({
      opType: 'grit_removal', metrics: base, outputs: OUTPUTS.grit_removal,
    })).container;
    const horizontal = draw(GritRemoval, snapOf({
      opType: 'grit_removal',
      metrics: { ...base, chamberType: 'horizontal' },
      outputs: OUTPUTS.grit_removal,
    })).container;

    expect(rakeDur(vortex)).toBeTruthy();
    expect(q(horizontal, '.ws-rake').classList.contains('ws-anim')).toBe(false);
    expect(q(horizontal, '.ws-rake').style.transform).toBe('rotate(45deg)');
    expect(q(vortex, '[data-ws="spiral"]')).toBeTruthy();
    expect(qa(vortex, '[data-ws="grit-dots"] circle').length).toBe(3);
    // A grit chamber has no sludge blanket.
    expect(q(vortex, '.ws-blanket')).toBeNull();
  });

  it('the grit rate is scale-invariant and responds to the arriving solids', () => {
    const g = (grit_removed_kg_d, chamber_volume_m3) => draw(GritRemoval, snapOf({
      opType: 'grit_removal',
      metrics: { chamberType: 'vortex', grit_removed_kg_d, chamber_volume_m3 },
      outputs: OUTPUTS.grit_removal,
    })).container;
    expect(rakeDur(g(30, 2.08))).toBe(rakeDur(g(3000, 208)));   // same intensity
    expect(parseFloat(rakeDur(g(600, 20.8)))).toBeLessThan(parseFloat(rakeDur(g(60, 20.8))));
  });

  it('the thickener has ONE arm, a screw stub and a blanket from its underflow', () => {
    const t = (thickened_Q_m3_d, filtrateQ) => draw(Thickener, snapOf({
      opType: 'thickener',
      metrics: { ...FULL.thickener, thickened_Q_m3_d },
      outputs: { thickened: { Q: thickened_Q_m3_d }, filtrate: { Q: filtrateQ } },
    })).container;
    const thin = t(4, 96);
    const thick = t(40, 60);
    expect(qa(thin, '.ws-rake [data-ws="rake"] > g').length).toBe(1);
    expect(q(thin, '[data-ws="screw"]')).toBeTruthy();
    expect(parseFloat(blanketScale(thin).slice(7)))
      .toBeLessThan(parseFloat(blanketScale(thick).slice(7)));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 7. §5.3 #15 — the digester, and the refusal
// ═══════════════════════════════════════════════════════════════════════════

describe('anaerobic digester', () => {
  const ad = (volume_m3_d, metrics = {}) => snapOf({
    opType: 'anaerobic_digester',
    metrics: { ...FULL.anaerobic_digester, ...metrics },
    biogas: volume_m3_d == null ? null : { volume_m3_d, CH4_pct: 63 },
    outputs: OUTPUTS.anaerobic_digester,
  });

  it('bubbles and the mixer respond to biogas.volume_m3_d — which is OUTSIDE metrics', () => {
    const low = draw(AnaerobicDigester, ad(80)).container;
    const high = draw(AnaerobicDigester, ad(980)).container;
    expect(parseFloat(bubbleDur(high))).toBeLessThan(parseFloat(bubbleDur(low)));
    const mixer = (c) => parseFloat(q(c, '.ws-rotor').style.getPropertyValue('--ws-spin'));
    expect(mixer(high)).toBeLessThan(mixer(low));
  });

  it('no gas → no bubbles, and the mixer parks', () => {
    for (const gas of [null, 0]) {
      const { container } = draw(AnaerobicDigester, ad(gas));
      expect(qa(container, '.ws-bubble').length).toBe(0);
      expect(q(container, '.ws-rotor').classList.contains('ws-anim')).toBe(false);
      expect(q(container, '[data-ws="takeoff-pulse"]')).toBeNull();
      // The take-off PIPE is structure and always renders.
      expect(q(container, '[data-ws="takeoff"] path')).toBeTruthy();
    }
  });

  it('THE FLOATING COVER DOES NOT MOVE — at any gas rate', () => {
    for (const gas of [null, 0, 1, 250, 980, 100000]) {
      const { container } = draw(AnaerobicDigester, ad(gas));
      const cover = q(container, '[data-ws="cover"]');
      expect(cover, `gas=${gas}`).toBeTruthy();
      // No animation class, no play-state class, no duration custom property,
      // and no animated ancestor. `volume_m3_d` is a rate, not an inventory.
      expect(cover.getAttribute('class')).toBeNull();
      expect(cover.getAttribute('style')).toBeNull();
      expect(cover.closest('.ws-anim')).toBeNull();
      expect(cover.closest('.ws-prime')).toBeNull();
      expect(cover.closest('.ws-fill')).toBeNull();
    }
  });

  it('stable === false slows the mixer 2.5x and goes amber; pH < 6.6 goes red', () => {
    const ok = draw(AnaerobicDigester, ad(600, { stable: true })).container;
    const sour = draw(AnaerobicDigester, ad(600, { stable: false })).container;
    const spin = (c) => parseFloat(q(c, '.ws-rotor').style.getPropertyValue('--ws-spin'));
    expect(spin(sour)).toBeGreaterThan(spin(ok));
    expect(q(ok, '[data-ws="warn"]')).toBeNull();
    expect(q(sour, '[data-ws="warn"]').getAttribute('data-level')).toBe('watch');

    const acid = draw(AnaerobicDigester, ad(600, { pH_out: 6.2 })).container;
    expect(q(acid, '[data-ws="warn"]').getAttribute('data-level')).toBe('alarm');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 8. §6.1 / §6.3 — values always, motion only live
// ═══════════════════════════════════════════════════════════════════════════

describe('live gating — values always, motion only live', () => {
  it('live:false removes every loop but keeps every static encoder', () => {
    const cases = [
      ['activated_sludge', ActivatedSludge],
      ['secondary_clarifier', SecondaryClarifier],
      ['primary_clarifier', PrimaryClarifier],
      ['anaerobic_digester', AnaerobicDigester],
    ];
    for (const [type, Comp] of cases) {
      const idle = draw(Comp, fullSnap(type, { live: false })).container;

      // No loops anywhere in the DOM.
      expect(qa(idle, '.ws-bubble').length, type).toBe(0);
      expect(qa(idle, '.ws-anim').length, type).toBe(0);
      expect(q(idle, '.ws-prime'), type).toBeNull();
      const wave = q(idle, '.ws-wave');
      if (wave) expect(wave.classList.contains('ws-anim'), type).toBe(false);

      // Static encoders all survive.
      expect(q(idle, '.ws-fill'), type).toBeTruthy();
      expect(q(idle, '.ws-shell'), type).toBeTruthy();
    }
    // …including the blanket height and the basin density.
    const sec = draw(SecondaryClarifier, fullSnap('secondary_clarifier', { live: false })).container;
    expect(blanketScale(sec)).toBe('scaleY(0.3333333333333333)');
    const bas = draw(ActivatedSludge, fullSnap('activated_sludge', { live: false })).container;
    expect(parseFloat(fillOpacity(bas))).toBeGreaterThan(0);
  });

  it('a model error suppresses all animation', () => {
    for (const [type, Comp] of Object.entries(LANE_D)) {
      const { container } = draw(Comp, snapOf({ opType: type, metrics: { error: 'boom' } }));
      expect(qa(container, '.ws-anim').length, type).toBe(0);
    }
  });

  it('the prime one-shot is mounted only in live, so React re-arms it', () => {
    const live = draw(ActivatedSludge, fullSnap('activated_sludge')).container;
    const idle = draw(ActivatedSludge, fullSnap('activated_sludge', { live: false })).container;
    expect(q(live, '.ws-prime')).toBeTruthy();
    expect(q(idle, '.ws-prime')).toBeNull();
  });

  it('the prime stagger comes from node.position.x / 4, clamped to 0..400', () => {
    const at = (x) => q(
      draw(ActivatedSludge, fullSnap('activated_sludge'), { position: { x, y: 0 } }).container,
      '.ws-prime',
    ).style.getPropertyValue('--ws-x');
    expect(at(0)).toBe('0');
    expect(at(800)).toBe('200');
    expect(at(99999)).toBe('400');
    expect(at(-50)).toBe('0');
  });

  it('the wave is FLAT with no inbound flow, and moves with it', () => {
    const flowing = draw(ActivatedSludge, fullSnap('activated_sludge')).container;
    const dead = draw(ActivatedSludge, snapOf({
      opType: 'activated_sludge',
      metrics: FULL.activated_sludge,
      outputs: { effluent: { Q: 0 } },
    })).container;
    expect(q(flowing, '.ws-wave').classList.contains('ws-anim')).toBe(true);
    expect(q(dead, '.ws-wave').classList.contains('ws-anim')).toBe(false);
  });

  it('basin density encodes the MLSS setpoint statically, never as a rate', () => {
    const op = (MLSS_mg_L) => fillOpacity(draw(ActivatedSludge, snapOf({
      opType: 'activated_sludge',
      metrics: { ...FULL.activated_sludge, MLSS_mg_L },
      outputs: OUTPUTS.activated_sludge,
    })).container);
    expect(parseFloat(op(1500))).toBeCloseTo(0.30, 5);
    expect(parseFloat(op(5000))).toBeCloseTo(0.85, 5);
    expect(parseFloat(op(1500))).toBeLessThan(parseFloat(op(3500)));

    // …and it changes NO duration anywhere.
    const a = draw(ActivatedSludge, snapOf({
      opType: 'activated_sludge', metrics: { ...FULL.activated_sludge, MLSS_mg_L: 1500 },
      outputs: OUTPUTS.activated_sludge,
    })).container;
    const b = draw(ActivatedSludge, snapOf({
      opType: 'activated_sludge', metrics: { ...FULL.activated_sludge, MLSS_mg_L: 5000 },
      outputs: OUTPUTS.activated_sludge,
    })).container;
    expect(bubbleDur(a)).toBe(bubbleDur(b));
    expect(q(a, '.ws-wave').style.getPropertyValue('--ws-drift'))
      .toBe(q(b, '.ws-wave').style.getPropertyValue('--ws-drift'));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 9. §7 — the element and animation budget
// ═══════════════════════════════════════════════════════════════════════════

describe('§7 budget', () => {
  /** A bubble COLUMN is one animated thing, however many circles it holds. */
  const animatedGroups = (svg) => {
    const cols = new Set(qa(svg, '.ws-bubble').map((c) => c.getAttribute('cx')));
    const others = qa(svg, '.ws-anim:not(.ws-bubble)').length;
    return cols.size + others;
  };

  it('rest-pose element counts stay small and only known classes animate', () => {
    const ALLOWED = ['ws-bubble', 'ws-wave', 'ws-rotor', 'ws-rake', 'ws-pulse'];
    const table = [];
    for (const [type, Comp] of Object.entries(LANE_D)) {
      const rest = q(draw(Comp, fullSnap(type, { live: false })).container, 'svg');
      const live = q(draw(Comp, fullSnap(type)).container, 'svg');
      table.push({
        type,
        rest: qa(rest, '*').length,
        live: qa(live, '*').length,
        animated: qa(live, '.ws-anim').length,
        groups: animatedGroups(live),
      });
      // Nothing moves at rest, ever.
      expect(qa(rest, '.ws-anim').length, type).toBe(0);
      // Everything that moves does so through one of the shared shorthands —
      // which are all transform/opacity, and all declared in canvas-motion.css.
      for (const el of qa(live, '.ws-anim')) {
        expect(ALLOWED.some((c) => el.classList.contains(c)), `${type}: ${el.getAttribute('class')}`).toBe(true);
      }
      expect(qa(rest, '*').length, type).toBeLessThan(70);
    }
    if (process.env.WS_BUDGET) console.table(table);
  });

  it('draws nothing outside the 144 x 60 symbol frame', () => {
    // Animation is confined to a bounded symbol frame; so is the ink. A stray
    // coordinate here is a glyph that overlaps the card header or the handles.
    const inX = (n) => n >= -8 && n <= FRAME.w + 8;
    const inY = (n) => n >= -3 && n <= FRAME.h + 3;
    for (const [type, Comp] of Object.entries(LANE_D)) {
      const svg = q(draw(Comp, fullSnap(type)).container, 'svg');
      for (const el of qa(svg, 'line, circle, rect, ellipse')) {
        const a = (k) => parseFloat(el.getAttribute(k));
        const check = (v, ok, k) => {
          if (Number.isFinite(v)) expect(ok(v), `${type} ${el.tagName}[${k}]=${v}`).toBe(true);
        };
        check(a('x1'), inX, 'x1'); check(a('x2'), inX, 'x2');
        check(a('y1'), inY, 'y1'); check(a('y2'), inY, 'y2');
        check(a('cx') - (a('r') || a('rx') || 0), inX, 'cx-r');
        check(a('cx') + (a('r') || a('rx') || 0), inX, 'cx+r');
        check(a('cy') - (a('r') || a('ry') || 0), inY, 'cy-r');
        check(a('cy') + (a('r') || a('ry') || 0), inY, 'cy+r');
        check(a('x'), inX, 'x'); check(a('x') + a('width'), inX, 'x+w');
        check(a('y'), inY, 'y'); check(a('y') + a('height'), inY, 'y+h');
      }
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 10. §7 — the forbidden techniques, scanned at source
// ═══════════════════════════════════════════════════════════════════════════

describe('lane D source scan — §7 forbidden techniques', () => {
  const FILES = [
    'activated_sludge', 'membrane_bioreactor', 'uct_reactor', 'jhb_reactor',
    'primary_clarifier', 'secondary_clarifier', 'grit_removal', 'thickener',
    'anaerobic_digester',
  ];
  // Resolved from the process cwd rather than `import.meta.url`: Vitest rewrites
  // module urls, and this file is read from disk, not imported.
  const dir = ['src/components/canvas/symbols', 'frontend/src/components/canvas/symbols']
    .map((d) => resolve(process.cwd(), d))
    .find((d) => existsSync(join(d, 'activated_sludge.jsx')));
  // Comments are stripped: this lane's files DISCUSS `@keyframes ws-drift` and
  // the forbidden techniques by name, and prose is not code.
  const strip = (src) => src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  const sources = FILES.map((f) => [f, strip(readFileSync(join(dir, `${f}.jsx`), 'utf8'))]);

  it('locates its own sources', () => expect(dir).toBeTruthy());

  it('contains no SMIL, no filter, no rAF, no timers', () => {
    for (const [name, src] of sources) {
      expect(src, name).not.toMatch(/<animate(Transform|Motion)?\b/);
      expect(src, name).not.toMatch(/\bfilter\s*:/);
      expect(src, name).not.toMatch(/<filter\b/);
      expect(src, name).not.toMatch(/\bdrop-shadow\b|\bblur\(/);
      expect(src, name).not.toMatch(/requestAnimationFrame/);
      expect(src, name).not.toMatch(/setInterval|setTimeout/);
    }
  });

  it('declares no @keyframes and builds no animation shorthand in JS', () => {
    for (const [name, src] of sources) {
      expect(src, name).not.toMatch(/@keyframes/);
      // Durations are custom properties; the shorthand lives in the stylesheet.
      expect(src, name).not.toMatch(/animation\s*:\s*['"`]/);
      expect(src, name).not.toMatch(/animationName|animationDuration\s*:/);
    }
  });

  it('never drives a RATE from a Class B or C echo', () => {
    // A duration custom property must never be written on the same line as an
    // echoed setpoint. These are the six echoes that reach this lane.
    const ECHOES = /SOR_m3_m2_d|MLSS_mg_L|sludge_TSS_mg_L|CH4_pct|RAS_ratio|depth_m/;
    const DURATION = /--ws-(spin|rake-dur|bubble-dur|drift|flow)|secs\(/;
    for (const [name, src] of sources) {
      for (const line of src.split('\n')) {
        if (ECHOES.test(line)) expect(DURATION.test(line), `${name}: ${line.trim()}`).toBe(false);
      }
    }
  });
});
