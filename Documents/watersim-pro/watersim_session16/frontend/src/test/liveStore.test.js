/**
 * liveStore — the canvas live-animation frame store.
 *
 * Four things are load-bearing and each is asserted here:
 *
 *  1. `drive()` is NULL-SAFE and parses STRINGS. The screen/grit models return
 *     string metrics, and a null must stay null all the way to the style
 *     object — if it ever became 0 it would become a divisor, then an
 *     `Infinity`s or `0s` animation-duration. `0s` pins the CPU; `NaN`
 *     silently kills the animation.
 *  2. `bucket()` has hysteresis, so a jittering value does not retime a
 *     running loop every tick (retiming causes a visible phase jump).
 *  3. `setFrame()` notifies ONLY the ids whose data actually changed — the
 *     whole reason this is an external store and not a context.
 *  4. `getNodeSnapshot()` is REFERENTIALLY STABLE while nothing changed. This
 *     is the number-one failure mode of `useSyncExternalStore`: a freshly
 *     built object per call is an infinite render loop.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import {
  num, drive, bucket, secs,
  setFrame, resetLiveStore,
  subscribeNode, subscribeEdge,
  getNodeSnapshot, getEdgeSnapshot, getRefs,
  useLiveNode,
} from '../components/canvas/liveStore';

beforeEach(() => resetLiveStore());

// ── §5.1 drive() ─────────────────────────────────────────────────────────────

describe('drive() — null-safe normalisation', () => {
  it('returns null (never 0) for null, undefined and non-finite input', () => {
    for (const bad of [null, undefined, NaN, Infinity, -Infinity]) {
      expect(drive(bad, 0, 10)).toBeNull();
    }
    // The distinction that matters: null is a REST POSE, 0 is a real value.
    expect(drive(null, 0, 10)).not.toBe(0);
    expect(drive(0, 0, 10)).toBe(0);
  });

  it('parses STRINGS first — screen/grit models return them', () => {
    expect(drive('15.0', 0, 30)).toBe(0.5);
    expect(drive('  15.0  ', 0, 30)).toBe(0.5);
    expect(drive('12.5', 0, 25)).toBe(0.5);
    expect(num('15.0')).toBe(15);
    expect(num('84.3 %')).toBe(84.3);   // parseFloat, not Number
  });

  it('returns null for strings that are not numbers, and for booleans', () => {
    for (const bad of ['', '   ', 'abc', true, false, {}, []]) {
      expect(drive(bad, 0, 10)).toBeNull();
    }
  });

  it('clamps out-of-range values to 0..1', () => {
    expect(drive(50, 0, 30)).toBe(1);
    expect(drive(-5, 0, 30)).toBe(0);
    expect(drive(30, 0, 30)).toBe(1);
    expect(drive(0.1, 0.1, 2.0)).toBe(0);
  });

  it('returns null when the band is degenerate (hi <= lo)', () => {
    expect(drive(5, 10, 10)).toBeNull();
    expect(drive(5, 10, 2)).toBeNull();
    expect(drive(5, 0, NaN)).toBeNull();
    expect(drive(5, NaN, 10)).toBeNull();
  });
});

// ── §5.1 bucket() ────────────────────────────────────────────────────────────

describe('bucket() — 15% hysteresis', () => {
  it('maps 0..1 onto steps when there is no previous index', () => {
    expect(bucket(0, 5)).toBe(0);
    expect(bucket(0.5, 5)).toBe(2);
    expect(bucket(1, 5)).toBe(4);
    expect(bucket(0.99, 5)).toBe(4);
  });

  it('does NOT change bucket for a value jittering ±10% of a bucket width around a boundary', () => {
    // 5 steps → bucket width 0.2 → boundary between 1 and 2 sits at 0.4.
    // The hysteresis band is 15% of a bucket width (0.03), so a ±10%
    // (±0.02) jitter must be absorbed entirely.
    const boundary = 0.4;
    for (const j of [-0.02, -0.01, 0, 0.005, 0.01, 0.02]) {
      expect(bucket(boundary + j, 5, 1)).toBe(1);
    }
    // Same jitter approached from the bucket above.
    for (const j of [-0.02, -0.01, 0, 0.01, 0.02]) {
      expect(bucket(boundary + j, 5, 2)).toBe(2);
    }
  });

  it('does change bucket once the value clears the hysteresis band', () => {
    expect(bucket(0.44, 5, 1)).toBe(2);   // 0.4 + 0.03 margin = 0.43
    expect(bucket(0.36, 5, 2)).toBe(1);   // 0.4 - 0.03 margin = 0.37
    expect(bucket(0.95, 5, 0)).toBe(4);
  });

  it('holds the previous index for a null / non-finite normal, and 0 with no previous', () => {
    expect(bucket(null, 5, 3)).toBe(3);
    expect(bucket(NaN, 5, 3)).toBe(3);
    expect(bucket(null, 5)).toBe(0);
  });

  it('is safe for degenerate step counts and clamps a bogus previous index', () => {
    expect(bucket(0.5, 0)).toBe(0);
    expect(bucket(0.5, -3)).toBe(0);
    expect(bucket(0.5, 1)).toBe(0);
    expect(bucket(0.79, 5, 99)).toBe(4);   // clamped to the last bucket, then held
    expect(bucket(0.5, 5, -9)).toBe(2);    // clamped to bucket 0, then released
  });
});

// ── §5.1 secs() ──────────────────────────────────────────────────────────────

describe('secs() — duration formatting', () => {
  it('formats to two decimals with a unit', () => {
    expect(secs(0.7233)).toBe('0.72s');
    expect(secs(2)).toBe('2.00s');
    expect(secs(26)).toBe('26.00s');
  });

  it('returns null — never "0.00s" or "NaNs" — for a non-finite duration', () => {
    for (const bad of [null, undefined, NaN, Infinity]) expect(secs(bad)).toBeNull();
  });
});

// ── §5.2 sheet-wide references ───────────────────────────────────────────────

describe('setFrame() — §5.2 references', () => {
  it('defaults every reference to 1', () => {
    setFrame({ live: false, unitResults: {}, streamResults: {} });
    expect(getRefs()).toEqual({
      Qref: 1, O2ref: 1, screenRef: 1, doseRef: 1, gasRef: 1, sludgeRef: 1, powerRef: 1,
    });
  });

  it('computes each reference from its own family, parsing string metrics', () => {
    setFrame({
      live: true,
      unitResults: {
        as1: { paletteType: 'activated_sludge', metrics: { O2_demand_kg_d: 400 } },
        scr: { paletteType: 'screening', metrics: { screenings_kg_d: '12.5' } },
        dos: { paletteType: 'coagulant_dosing', metrics: { dose_kg_d: 8 } },
        dig: { paletteType: 'anaerobic_digester', metrics: {}, biogas: { volume_m3_d: 900 } },
        sc: { paletteType: 'secondary_clarifier', metrics: { RAS_Q_m3_d: 1500 } },
        p1: { paletteType: 'pump', metrics: { power_kW: 22 } },
      },
      streamResults: { e1: { Q: 5000 }, e2: { Q: 120 } },
    });
    expect(getRefs()).toEqual({
      Qref: 5000, O2ref: 400, screenRef: 12.5, doseRef: 8,
      gasRef: 900, sludgeRef: 1500, powerRef: 22,
    });
  });

  it('ratchets upward and never falls within a session', () => {
    setFrame({ live: true, unitResults: {}, streamResults: { e1: { Q: 5000 } } });
    expect(getRefs().Qref).toBe(5000);
    setFrame({ streamResults: { e1: { Q: 10 } } });
    expect(getRefs().Qref).toBe(5000);
    setFrame({ streamResults: { e1: { Q: 9000 } } });
    expect(getRefs().Qref).toBe(9000);
  });

  it('resolves the legacy `preliminary` alias onto the screening reference', () => {
    setFrame({
      live: true,
      unitResults: { s: { paletteType: 'preliminary', metrics: { screenings_kg_d: 40 } } },
      streamResults: {},
    });
    expect(getRefs().screenRef).toBe(40);
  });
});

// ── §5.4 blower adjacency ────────────────────────────────────────────────────

describe('setFrame() — blower duty derivation', () => {
  const aeration = { paletteType: 'activated_sludge', metrics: { O2_demand_kg_d: 250 } };

  it('sums the O2 demand of adjacent aeration basins in either edge direction', () => {
    setFrame({
      live: true,
      nodes: [
        { id: 'b1', data: { opType: 'blower' } },
        { id: 'as1', data: { opType: 'activated_sludge' } },
        { id: 'as2', data: { opType: 'membrane_bioreactor' } },
      ],
      edges: [
        { id: 'e1', source: 'b1', target: 'as1' },
        { id: 'e2', source: 'as2', target: 'b1' },   // reversed — still adjacent
      ],
      unitResults: {
        b1: { paletteType: 'blower', metrics: {} },
        as1: aeration,
        as2: { paletteType: 'membrane_bioreactor', metrics: { O2_demand_kg_d: 100 } },
      },
      streamResults: {},
    });
    expect(getNodeSnapshot('b1').derived).toEqual({ O2_served: 350, servedCount: 2 });
  });

  it('leaves an UNLINKED blower at zero duty so its rotor cannot turn', () => {
    setFrame({
      live: true,
      nodes: [{ id: 'b2', data: { opType: 'blower' } }],
      edges: [],
      unitResults: { b2: { paletteType: 'blower', metrics: {} } },
      streamResults: {},
    });
    expect(getNodeSnapshot('b2').derived).toEqual({ O2_served: 0, servedCount: 0 });
  });
});

// ── §6.2 targeted notification ───────────────────────────────────────────────

describe('setFrame() — notifies only the ids whose data changed', () => {
  it('leaves unchanged nodes and edges entirely alone', () => {
    setFrame({
      live: true,
      unitResults: { a: { metrics: { x: 1 } }, b: { metrics: { y: 2 } } },
      streamResults: { e1: { Q: 100 }, e2: { Q: 50 } },
      nodes: [], edges: [],
    });

    const seen = { a: 0, b: 0, e1: 0, e2: 0 };
    const off = [
      subscribeNode('a', () => { seen.a += 1; }),
      subscribeNode('b', () => { seen.b += 1; }),
      subscribeEdge('e1', () => { seen.e1 += 1; }),
      subscribeEdge('e2', () => { seen.e2 += 1; }),
    ];

    // `a` changes, `e2` changes; `b` and `e1` are value-identical. Qref stays
    // 100 so no reference ratchets and nothing is globally invalidated.
    setFrame({
      unitResults: { a: { metrics: { x: 2 } }, b: { metrics: { y: 2 } } },
      streamResults: { e1: { Q: 100 }, e2: { Q: 60 } },
    });

    expect(seen).toEqual({ a: 1, b: 0, e1: 0, e2: 1 });
    off.forEach((fn) => fn());
  });

  it('notifies nobody when the solver converges to the same numbers', () => {
    const results = () => ({ a: { metrics: { x: 1 } }, b: { metrics: { y: 2 } } });
    setFrame({ live: true, unitResults: results(), streamResults: {}, nodes: [], edges: [] });

    let hits = 0;
    const off = subscribeNode('a', () => { hits += 1; });
    setFrame({ unitResults: results(), streamResults: {} });
    setFrame({ unitResults: results(), streamResults: {} });
    expect(hits).toBe(0);
    off();
  });

  it('stamps changedSeq only when the data actually differed', () => {
    setFrame({ live: true, unitResults: { a: { metrics: { x: 1 } } }, streamResults: {} });
    const s1 = getNodeSnapshot('a');
    setFrame({ unitResults: { a: { metrics: { x: 1 } } }, streamResults: {} });
    expect(getNodeSnapshot('a').changedSeq).toBe(s1.changedSeq);
    setFrame({ unitResults: { a: { metrics: { x: 3 } } }, streamResults: {} });
    expect(getNodeSnapshot('a').changedSeq).toBeGreaterThan(s1.changedSeq);
  });
});

// ── §6.2 THE INFINITE-LOOP GUARD ─────────────────────────────────────────────

describe('getNodeSnapshot() — referential stability', () => {
  it('returns the SAME object reference across calls when nothing changed', () => {
    setFrame({ live: true, unitResults: { a: { metrics: { x: 1 } } }, streamResults: {} });
    const s1 = getNodeSnapshot('a');
    expect(getNodeSnapshot('a')).toBe(s1);
    expect(getNodeSnapshot('a')).toBe(s1);
    expect(getNodeSnapshot('a')).toBe(s1);
  });

  it('keeps the reference when a new frame carries value-identical data', () => {
    // This is exactly what the solver sends every tick: brand-new objects
    // holding the same numbers.
    setFrame({ live: true, unitResults: { a: { metrics: { x: 1, y: 2 } } }, streamResults: {} });
    const s1 = getNodeSnapshot('a');
    setFrame({ unitResults: { a: { metrics: { x: 1, y: 2 } } }, streamResults: {} });
    expect(getNodeSnapshot('a')).toBe(s1);
  });

  it('keeps the reference across value-identical nested arrays and Stream outputs', () => {
    const shape = () => ({
      o: {
        metrics: {
          compliant: true,
          permit_violations: [{ param: 'TN', value: 14.2, limit: 10, unit: 'mg/L' }],
          warnings: ['SLR high'],
        },
        outputs: { effluent: { Q: 1000, TSS: 12.5, BOD: 8 } },
      },
    });
    setFrame({ live: true, unitResults: shape(), streamResults: {} });
    const s1 = getNodeSnapshot('o');
    setFrame({ unitResults: shape(), streamResults: {} });
    expect(getNodeSnapshot('o')).toBe(s1);
  });

  it('returns a NEW object when the metrics change', () => {
    setFrame({ live: true, unitResults: { a: { metrics: { x: 1 } } }, streamResults: {} });
    const s1 = getNodeSnapshot('a');
    setFrame({ unitResults: { a: { metrics: { x: 2 } } }, streamResults: {} });
    const s2 = getNodeSnapshot('a');
    expect(s2).not.toBe(s1);
    expect(s2.metrics.x).toBe(2);
    expect(getNodeSnapshot('a')).toBe(s2);   // …and is stable again
  });

  it('returns a NEW object when live flips, and reports the new gate', () => {
    setFrame({ live: true, unitResults: { a: { metrics: { x: 1 } } }, streamResults: {} });
    const s1 = getNodeSnapshot('a');
    expect(s1.live).toBe(true);
    setFrame({ live: false });
    const s2 = getNodeSnapshot('a');
    expect(s2).not.toBe(s1);
    expect(s2.live).toBe(false);
    expect(s2.metrics.x).toBe(1);            // values always, motion only live
  });

  it('is stable even for a null / unknown id — no id may bypass the cache', () => {
    setFrame({ live: true, unitResults: { a: { metrics: { x: 1 } } }, streamResults: {} });
    const nil = getNodeSnapshot(null);
    expect(getNodeSnapshot(null)).toBe(nil);
    expect(getNodeSnapshot(undefined)).toBe(nil);
    expect(nil.hasResults).toBe(false);
    expect(nil.metrics).toEqual({});

    const unknown = getNodeSnapshot('never_seen');
    expect(getNodeSnapshot('never_seen')).toBe(unknown);
    expect(getEdgeSnapshot(null)).toBe(getEdgeSnapshot(null));
  });

  it('is stable for an id the solver produced nothing for', () => {
    setFrame({ live: true, unitResults: { a: { metrics: {} } }, streamResults: {} });
    const ghost = getNodeSnapshot('a');
    expect(ghost.hasResults).toBe(true);
    expect(ghost.metrics).toEqual({});
    expect(getNodeSnapshot('a')).toBe(ghost);
  });

  it('getEdgeSnapshot is stable on the same terms', () => {
    setFrame({ live: true, unitResults: {}, streamResults: { e1: { Q: 100, TSS: 30 } } });
    const s1 = getEdgeSnapshot('e1');
    expect(getEdgeSnapshot('e1')).toBe(s1);
    expect(s1.Q).toBe(100);
    setFrame({ streamResults: { e1: { Q: 100, TSS: 30 } } });
    expect(getEdgeSnapshot('e1')).toBe(s1);
    setFrame({ streamResults: { e1: { Q: 101, TSS: 30 } } });
    expect(getEdgeSnapshot('e1')).not.toBe(s1);
  });
});

describe('useLiveNode()', () => {
  it('does not re-render on a no-op frame and re-renders once on a real change', () => {
    setFrame({ live: true, unitResults: { a: { metrics: { x: 1 } } }, streamResults: {} });

    let renders = 0;
    const { result } = renderHook(() => { renders += 1; return useLiveNode('a'); });
    const first = result.current;
    const settled = renders;

    act(() => { setFrame({ unitResults: { a: { metrics: { x: 1 } } }, streamResults: {} }); });
    expect(result.current).toBe(first);
    expect(renders).toBe(settled);

    act(() => { setFrame({ unitResults: { a: { metrics: { x: 5 } } }, streamResults: {} }); });
    expect(result.current).not.toBe(first);
    expect(result.current.metrics.x).toBe(5);
    expect(renders).toBe(settled + 1);
  });

  it('unsubscribes on unmount', () => {
    setFrame({ live: true, unitResults: { a: { metrics: { x: 1 } } }, streamResults: {} });
    const { unmount } = renderHook(() => useLiveNode('a'));
    unmount();
    // No listener left to throw — a changed frame is a no-op.
    expect(() => setFrame({ unitResults: { a: { metrics: { x: 9 } } }, streamResults: {} })).not.toThrow();
    expect(getNodeSnapshot('a').metrics.x).toBe(9);
  });
});
