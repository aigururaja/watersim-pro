/**
 * useUndoRedo — bounded, coalescing undo/redo history for canvas snapshots.
 *
 * The pure engine (createHistory) is tested with an injected clock so the
 * coalescing window is deterministic; the React hook wrapper is tested for
 * reactive canUndo/canRedo flags.
 */
import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { createHistory, useUndoRedo, DEFAULT_LIMIT } from '../hooks/useUndoRedo';

// Deterministic clock: now() returns the current time, advance(ms) moves it.
const mkClock = (start = 0) => {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
};

const nodesOf = (n) => [{ id: `node_${n}`, position: { x: n, y: n } }];
const edgesOf = (n) => [{ id: `edge_${n}` }];

// Record with >coalesceMs spacing so entries never coalesce unless intended.
const recordSpaced = (h, clock, n) => {
  clock.advance(1000);
  h.record(nodesOf(n), edgesOf(n));
};

describe('createHistory — record/undo/redo ordering', () => {
  it('undo walks back through snapshots, redo walks forward, null at the ends', () => {
    const clock = mkClock();
    const h = createHistory({ now: clock.now });

    expect(h.undo()).toBeNull();
    expect(h.redo()).toBeNull();

    recordSpaced(h, clock, 0); // baseline
    recordSpaced(h, clock, 1);
    recordSpaced(h, clock, 2);

    expect(h.canUndo()).toBe(true);
    expect(h.canRedo()).toBe(false);

    const u1 = h.undo();
    expect(u1.nodes[0].id).toBe('node_1');
    expect(u1.edges[0].id).toBe('edge_1'); // restores edges too

    const u2 = h.undo();
    expect(u2.nodes[0].id).toBe('node_0');

    expect(h.undo()).toBeNull(); // at baseline — nothing further
    expect(h.canUndo()).toBe(false);
    expect(h.canRedo()).toBe(true);

    expect(h.redo().nodes[0].id).toBe('node_1');
    expect(h.redo().nodes[0].id).toBe('node_2');
    expect(h.redo()).toBeNull();
    expect(h.canRedo()).toBe(false);
  });

  it('a new record clears the redo stack', () => {
    const clock = mkClock();
    const h = createHistory({ now: clock.now });

    recordSpaced(h, clock, 0);
    recordSpaced(h, clock, 1);
    recordSpaced(h, clock, 2);
    h.undo();
    h.undo();
    expect(h.canRedo()).toBe(true);

    recordSpaced(h, clock, 9); // branches — redo tail discarded

    expect(h.canRedo()).toBe(false);
    expect(h.redo()).toBeNull();
    expect(h.undo().nodes[0].id).toBe('node_0');
    expect(h.redo().nodes[0].id).toBe('node_9');
  });
});

describe('createHistory — cap at 50', () => {
  it(`keeps at most ${DEFAULT_LIMIT} entries, dropping the oldest`, () => {
    const clock = mkClock();
    const h = createHistory({ now: clock.now });

    for (let i = 0; i < 60; i++) recordSpaced(h, clock, i);

    expect(h.size()).toBe(50);

    // Walk all the way back: 49 undos, landing on the oldest surviving entry.
    let last = null;
    let steps = 0;
    for (let s = h.undo(); s !== null; s = h.undo()) { last = s; steps++; }
    expect(steps).toBe(49);
    expect(last.nodes[0].id).toBe('node_10'); // 0..9 fell off the front
  });

  it('honours a custom limit', () => {
    const clock = mkClock();
    const h = createHistory({ now: clock.now, limit: 3 });
    for (let i = 0; i < 10; i++) recordSpaced(h, clock, i);
    expect(h.size()).toBe(3);
    expect(h.undo().nodes[0].id).toBe('node_8');
    expect(h.undo().nodes[0].id).toBe('node_7');
    expect(h.undo()).toBeNull();
  });
});

describe('createHistory — coalescing window', () => {
  it('rapid successive records within 400ms collapse into one entry', () => {
    const clock = mkClock();
    const h = createHistory({ now: clock.now, coalesceMs: 400 });

    recordSpaced(h, clock, 0); // baseline
    recordSpaced(h, clock, 1); // new entry
    clock.advance(100);
    h.record(nodesOf(2), edgesOf(2)); // coalesces into the node_1 entry
    clock.advance(399);
    h.record(nodesOf(3), edgesOf(3)); // sliding window — still coalesces

    expect(h.size()).toBe(2); // baseline + one coalesced entry
    expect(h.undo().nodes[0].id).toBe('node_0');
    expect(h.redo().nodes[0].id).toBe('node_3'); // latest burst state won
  });

  it('records beyond the window become separate entries', () => {
    const clock = mkClock();
    const h = createHistory({ now: clock.now, coalesceMs: 400 });

    recordSpaced(h, clock, 0);
    recordSpaced(h, clock, 1);
    clock.advance(401); // just outside the window
    h.record(nodesOf(2), edgesOf(2));

    expect(h.size()).toBe(3);
    expect(h.undo().nodes[0].id).toBe('node_1');
    expect(h.undo().nodes[0].id).toBe('node_0');
  });

  it('never coalesces across an undo boundary', () => {
    const clock = mkClock();
    const h = createHistory({ now: clock.now, coalesceMs: 400 });

    recordSpaced(h, clock, 0);
    recordSpaced(h, clock, 1);
    h.undo(); // back at node_0
    clock.advance(10);
    h.record(nodesOf(2), edgesOf(2)); // rapid, but must PUSH, not overwrite node_0

    expect(h.size()).toBe(2);
    expect(h.undo().nodes[0].id).toBe('node_0'); // baseline intact
  });
});

describe('createHistory — misc', () => {
  it('clear() empties the history', () => {
    const clock = mkClock();
    const h = createHistory({ now: clock.now });
    recordSpaced(h, clock, 0);
    recordSpaced(h, clock, 1);
    h.clear();
    expect(h.size()).toBe(0);
    expect(h.canUndo()).toBe(false);
    expect(h.canRedo()).toBe(false);
    expect(h.undo()).toBeNull();
    expect(h.redo()).toBeNull();
  });

  it('stores and returns detached array copies (mutation-safe)', () => {
    const clock = mkClock();
    const h = createHistory({ now: clock.now });

    const liveNodes = [{ id: 'a' }];
    clock.advance(1000);
    h.record(liveNodes, [{ id: 'e1' }]);
    liveNodes.push({ id: 'b' }); // caller mutates its array after recording
    clock.advance(1000);
    h.record(liveNodes, [{ id: 'e1' }]);

    const snap = h.undo(); // first entry: only 'a'
    expect(snap.nodes.map((n) => n.id)).toEqual(['a']);

    snap.nodes.push({ id: 'evil' }); // mutating a returned snapshot…
    snap.edges.length = 0;

    const fwd = h.redo();
    expect(fwd.nodes.map((n) => n.id)).toEqual(['a', 'b']);
    const back = h.undo(); // …must not pollute the stored history
    expect(back.nodes.map((n) => n.id)).toEqual(['a']);
    expect(back.edges.map((e) => e.id)).toEqual(['e1']);
  });
});

describe('useUndoRedo — React hook wrapper', () => {
  it('exposes reactive canUndo/canRedo and the same record/undo/redo semantics', () => {
    let t = 0;
    const now = () => (t += 1000); // spaced — no coalescing
    const { result } = renderHook(() => useUndoRedo({ now }));

    expect(result.current.canUndo).toBe(false);
    expect(result.current.canRedo).toBe(false);

    act(() => { result.current.record(nodesOf(0), edgesOf(0)); });
    expect(result.current.canUndo).toBe(false); // baseline alone: nothing to undo

    act(() => { result.current.record(nodesOf(1), edgesOf(1)); });
    expect(result.current.canUndo).toBe(true);

    let snap;
    act(() => { snap = result.current.undo(); });
    expect(snap.nodes[0].id).toBe('node_0');
    expect(result.current.canUndo).toBe(false);
    expect(result.current.canRedo).toBe(true);

    act(() => { snap = result.current.redo(); });
    expect(snap.nodes[0].id).toBe('node_1');
    expect(result.current.canRedo).toBe(false);

    act(() => { result.current.clear(); });
    expect(result.current.canUndo).toBe(false);
    expect(result.current.canRedo).toBe(false);
  });
});
