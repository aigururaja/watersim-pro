/**
 * useUndoRedo — bounded undo/redo history for {nodes, edges} canvas snapshots.
 *
 * The pure logic lives in createHistory() (exported for unit tests — no React
 * or ReactFlow imports are needed to exercise it). useUndoRedo() is a thin
 * reactive wrapper exposing { record, undo, redo, canUndo, canRedo, clear }.
 *
 * Semantics:
 * - The history is a timeline of snapshots with a cursor. record(nodes, edges)
 *   pushes the post-change state; undo() steps the cursor back and returns the
 *   snapshot to apply; redo() steps forward. Both return null when there is
 *   nothing to do.
 * - Rapid successive record() calls (each within `coalesceMs` of the previous
 *   one — a sliding window) REPLACE the newest entry instead of pushing, so
 *   bursts (drag position updates, param spinner holds) collapse into a single
 *   undo step.
 * - Recording after an undo discards the redo tail (standard branching rule),
 *   and coalescing never crosses an undo/redo boundary.
 * - The timeline is capped at `limit` entries; the oldest entries fall off.
 * - Snapshots are stored and returned as fresh array copies; the node/edge
 *   objects themselves are treated as immutable (ReactFlow's own model).
 */

import { useCallback, useRef, useState } from 'react';

export const DEFAULT_LIMIT = 50;
export const DEFAULT_COALESCE_MS = 400;

export function createHistory({
  limit = DEFAULT_LIMIT,
  coalesceMs = DEFAULT_COALESCE_MS,
  now = () => Date.now(),
} = {}) {
  let entries = [];        // snapshot timeline: [{ nodes, edges }, …]
  let index = -1;          // cursor into entries (current state)
  let lastRecordAt = null; // timestamp of last record(); null blocks coalescing

  const snapOf = (nodes, edges) => ({
    nodes: Array.isArray(nodes) ? nodes.slice() : [],
    edges: Array.isArray(edges) ? edges.slice() : [],
  });
  const copyOut = (entry) =>
    entry ? { nodes: entry.nodes.slice(), edges: entry.edges.slice() } : null;

  return {
    record(nodes, edges) {
      const t = now();
      const snap = snapOf(nodes, edges);
      // A new change invalidates any redo tail…
      if (index < entries.length - 1) {
        entries = entries.slice(0, index + 1);
        lastRecordAt = null; // …and must never coalesce into the undone-to state
      }
      const coalesce =
        entries.length > 0 && lastRecordAt !== null && t - lastRecordAt <= coalesceMs;
      if (coalesce) {
        entries[entries.length - 1] = snap;
      } else {
        entries.push(snap);
        if (entries.length > limit) entries = entries.slice(entries.length - limit);
      }
      index = entries.length - 1;
      lastRecordAt = t;
    },

    undo() {
      if (index <= 0) return null;
      index -= 1;
      lastRecordAt = null;
      return copyOut(entries[index]);
    },

    redo() {
      if (index >= entries.length - 1) return null;
      index += 1;
      lastRecordAt = null;
      return copyOut(entries[index]);
    },

    clear() {
      entries = [];
      index = -1;
      lastRecordAt = null;
    },

    canUndo() { return index > 0; },
    canRedo() { return index < entries.length - 1; },
    size()    { return entries.length; },
  };
}

export function useUndoRedo(options = {}) {
  const historyRef = useRef(null);
  if (historyRef.current === null) historyRef.current = createHistory(options);
  const h = historyRef.current;

  // Bump a tick so canUndo/canRedo re-derive after every history mutation.
  const [, setTick] = useState(0);
  const bump = useCallback(() => setTick((t) => t + 1), []);

  const record = useCallback((nodes, edges) => { h.record(nodes, edges); bump(); }, [h, bump]);
  const undo   = useCallback(() => { const snap = h.undo(); bump(); return snap; }, [h, bump]);
  const redo   = useCallback(() => { const snap = h.redo(); bump(); return snap; }, [h, bump]);
  const clear  = useCallback(() => { h.clear(); bump(); }, [h, bump]);

  return {
    record,
    undo,
    redo,
    clear,
    canUndo: h.canUndo(),
    canRedo: h.canRedo(),
  };
}

export default useUndoRedo;
