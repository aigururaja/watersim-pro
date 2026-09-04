/**
 * liveStore — the canvas live-animation frame store (spec §5.1, §5.2, §6.2)
 * ─────────────────────────────────────────────────────────────────────────────
 * A module-scope external store read with React 18's `useSyncExternalStore`,
 * deliberately NOT a context. A context would re-render all 30 consumers every
 * tick; a per-node subscription re-renders only the nodes whose data identity
 * actually changed — typically 3–8 of 30, and 0 when the solver converges to
 * the same numbers.
 *
 * ── THE NUMBER-ONE FAILURE MODE ───────────────────────────────────────────────
 * `getNodeSnapshot(id)` MUST return a REFERENTIALLY STABLE object when nothing
 * changed. Returning a freshly built object on every call makes
 * `useSyncExternalStore` believe the store changed on every render → infinite
 * render loop. Every snapshot is therefore cached per id in `nodeSnap` /
 * `edgeSnap` and the cached object is replaced ONLY when:
 *   · a bounded deep compare of the node's data (metrics + biogas + outputs +
 *     derived + type) differs from the cached snapshot, OR
 *   · `live` flips, OR
 *   · the sheet-wide `refs` object is replaced (a ratchet — rare, and sticky).
 * `getNodeSnapshot` never mutates the frame; it only memoises.
 *
 * ── HONESTY / SCOPE RULES ─────────────────────────────────────────────────────
 * NOTHING here is ever written into `node.data` or `params`. `node.data` stays
 * plain JSON for `save()` and the collab `sendEvent` JSON.stringify, and
 * `liveSignature` hashes `data.params`, so any UI state stashed there would
 * retrigger the simulation.
 *
 * A motion RATE may be driven only by a Class-A (plant-driven) metric — with
 * one exception: a Class-C echo may drive a rate when the setpoint IS the
 * physical rate being depicted (pump `speed_pct` → impeller rpm; valve
 * `opening_pct` → disc angle). Class B and C otherwise drive STATIC encoders
 * only. This module gives you the raw numbers; the catalogue in §5.3 says
 * which one is legal where.
 */

import { useCallback, useSyncExternalStore } from 'react';

// ── Shared frozen empties — identity matters, these are compared by `===` ────
const EMPTY_OBJ = Object.freeze({});
const EMPTY_ARR = Object.freeze([]);

// ═══════════════════════════════════════════════════════════════════════════
// 1. §5.1 SHARED HELPERS — one implementation, used by every symbol
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Numeric coercion that parses STRINGS FIRST.
 *
 * This is not defensive padding: `screen.js` returns `TSS_removal_pct` as a
 * string and several grit/screen metrics are `+x.toFixed(2)`-shaped. `Number`
 * alone would also happily turn `''` into 0 and `true` into 1.
 *
 * @param {*} v
 * @returns {number|null} a finite number, or null. NEVER 0 for a bad input.
 */
export function num(v) {
  if (v == null) return null;
  const n = typeof v === 'string' ? parseFloat(v) : (typeof v === 'number' ? v : NaN);
  return Number.isFinite(n) ? n : null;
}

/**
 * Normalise a metric into 0..1 over the band [lo, hi], null-safe.
 *
 * A `null` return means REST POSE. It must never become `0`, then a divisor,
 * then an `Infinity`s or `0s` duration — `0s` pins the CPU and `NaN` silently
 * kills the animation. That is why this returns null and not 0.
 *
 * @param {number|string|null|undefined} v  raw metric (may be a string)
 * @param {number} lo  band floor
 * @param {number} hi  band ceiling (must be > lo)
 * @returns {number|null} 0..1 clamped, or null for null / non-finite / hi<=lo
 */
export function drive(v, lo, hi) {
  const n = num(v);
  if (n == null) return null;
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) return null;
  return Math.min(1, Math.max(0, (n - lo) / (hi - lo)));
}

/** Hysteresis band, as a fraction of ONE bucket's width. */
export const HYSTERESIS = 0.15;

/**
 * Snap a 0..1 normal to a bucket index with 15% hysteresis, so a value
 * jittering around a boundary does not retime the animation every tick.
 *
 * Retiming a running loop causes a PHASE JUMP (progress is a fraction of the
 * new duration). That is invisible on a repeating dash pattern but obvious on
 * a clarifier's single visible rake arm — which is why that one is bucketed to
 * only four steps.
 *
 * To leave the current bucket the value must travel `HYSTERESIS x bucketWidth`
 * PAST the boundary it is sitting on.
 *
 * @param {number|null} norm    0..1 (typically a `drive()` result)
 * @param {number} steps        how many buckets (>= 1)
 * @param {number} [prevIdx]    the index currently in use; omit on first call
 * @returns {number} bucket index, 0 .. steps-1
 */
export function bucket(norm, steps, prevIdx) {
  const n = Math.floor(Number(steps));
  if (!Number.isFinite(n) || n < 1) return 0;
  const last = n - 1;
  const clampIdx = (i) => Math.min(last, Math.max(0, Math.floor(i)));

  if (norm == null || !Number.isFinite(norm)) {
    return Number.isFinite(prevIdx) ? clampIdx(prevIdx) : 0;
  }
  const v = Math.min(1, Math.max(0, norm));
  const width = 1 / n;
  const raw = Math.min(last, Math.floor(v / width));

  if (!Number.isFinite(prevIdx)) return raw;
  const prev = clampIdx(prevIdx);
  if (raw === prev) return prev;

  const margin = HYSTERESIS * width;
  if (raw > prev) {
    // Climbing: must clear the top boundary of the current bucket by `margin`.
    return v >= (prev + 1) * width + margin ? raw : prev;
  }
  // Falling: must drop below the bottom boundary of the current bucket.
  return v <= prev * width - margin ? raw : prev;
}

/**
 * Format a duration for a CSS custom property.
 *
 * Returns `null` — not `'0.00s'`, not `'NaNs'` — for a non-finite input, so a
 * rest pose can never be smuggled into the compositor as a `0s` duration.
 * React drops a null style value, and the `var(--x, fallback)` in
 * canvas-motion.css takes over.
 *
 * @param {number} n seconds
 * @returns {string|null} e.g. `'0.72s'`
 */
export const secs = (n) => (Number.isFinite(n) ? `${n.toFixed(2)}s` : null);

// ═══════════════════════════════════════════════════════════════════════════
// 2. TYPE FAMILIES (spec §3.2, §5.3)
// ═══════════════════════════════════════════════════════════════════════════

/** Legacy op types that arrive on imported / seeded sheets. */
export const LEGACY_TYPE_ALIASES = Object.freeze({
  preliminary: 'screening',
  granular_filter: 'sand_filter',
});

/** Resolve a legacy op type to its modern equivalent. `thickener` is its own
 *  type (a clarifier-family vessel), so it is deliberately not aliased here. */
export function resolveType(t) {
  if (!t) return null;
  return LEGACY_TYPE_ALIASES[t] || t;
}

export const AERATION_TYPES = Object.freeze([
  'activated_sludge', 'uct_reactor', 'jhb_reactor', 'membrane_bioreactor',
]);
export const DOSING_TYPES = Object.freeze([
  'chemical_dosing', 'coagulant_dosing', 'polymer_dosing', 'ph_adjustment',
]);
export const CLARIFIER_TYPES = Object.freeze([
  'primary_clarifier', 'secondary_clarifier', 'grit_removal', 'thickener',
]);

const AERATION = new Set(AERATION_TYPES);
const DOSING = new Set(DOSING_TYPES);
const CLARIFIER = new Set(CLARIFIER_TYPES);

// ═══════════════════════════════════════════════════════════════════════════
// 3. THE FRAME
// ═══════════════════════════════════════════════════════════════════════════

/** @typedef {{Qref:number,O2ref:number,screenRef:number,doseRef:number,
 *             gasRef:number,sludgeRef:number,powerRef:number}} Refs */

export const REF_KEYS = Object.freeze([
  'Qref', 'O2ref', 'screenRef', 'doseRef', 'gasRef', 'sludgeRef', 'powerRef',
]);

const DEFAULT_REFS = Object.freeze({
  Qref: 1, O2ref: 1, screenRef: 1, doseRef: 1, gasRef: 1, sludgeRef: 1, powerRef: 1,
});

const initialFrame = () => ({
  live: false,
  seq: 0,
  unitResults: EMPTY_OBJ,
  streamResults: EMPTY_OBJ,
  nodes: EMPTY_ARR,
  edges: EMPTY_ARR,
  refs: DEFAULT_REFS,
  derived: EMPTY_OBJ,
});

// ── module-scope singleton ──────────────────────────────────────────────────
let frame = initialFrame();

const nodeSubs = new Map();       // id -> Set<cb>
const edgeSubs = new Map();       // id -> Set<cb>
const sheetSubs = new Set();      // Set<cb>

const nodeSnap = new Map();       // id -> cached snapshot object  ← CRITICAL
const edgeSnap = new Map();       // id -> cached snapshot object  ← CRITICAL
let sheetSnap = null;             // cached { live, refs }         ← CRITICAL

const nodeChangedSeq = new Map(); // id -> seq at which this node's data last differed
const edgeChangedSeq = new Map();

// ═══════════════════════════════════════════════════════════════════════════
// 4. COMPARISON — bounded deep equality
// ═══════════════════════════════════════════════════════════════════════════
//
// A plain shallow compare is not enough: `metrics` legitimately contains
// arrays (`permit_violations`, `warnings`) and small objects
// (`zone_volumes_m3`) that the server rebuilds every tick, and `outputs` is a
// map of Stream JSON objects. A shallow compare would report "changed" on
// every tick for those nodes and defeat the whole point of the store.
// Depth 3 covers `outputs.effluent.Q` and `metrics.permit_violations[0].value`
// and is still O(size of a small metrics object).

function valuesEq(a, b, depth = 3) {
  if (a === b) return true;
  if (typeof a === 'number' && typeof b === 'number') {
    return Number.isNaN(a) && Number.isNaN(b);   // NaN === NaN for our purposes
  }
  if (a == null || b == null) return false;
  if (typeof a !== 'object' || typeof b !== 'object') return false;
  if (depth <= 0) return false;

  const aArr = Array.isArray(a);
  if (aArr !== Array.isArray(b)) return false;
  if (aArr) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!valuesEq(a[i], b[i], depth - 1)) return false;
    return true;
  }
  const ak = Object.keys(a);
  if (ak.length !== Object.keys(b).length) return false;
  for (const k of ak) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
    if (!valuesEq(a[k], b[k], depth - 1)) return false;
  }
  return true;
}

// ═══════════════════════════════════════════════════════════════════════════
// 5. §5.2 SHEET-WIDE REFERENCES + §5.4 BLOWER ADJACENCY — ONE O(N+E) PASS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Qref     = max finite streamResults[*].Q
 * O2ref    = max O2_demand_kg_d  over aeration-family nodes
 * screenRef= max screenings_kg_d over screening nodes
 * doseRef  = max dose_kg_d       over the dosing family
 * gasRef   = max biogas.volume_m3_d over digesters   (biogas lives OUTSIDE metrics)
 * sludgeRef= max of sludge_Q_m3_d and RAS_Q_m3_d over clarifiers
 * powerRef = max power_kW
 *
 * All default to 1 and RATCHET UPWARD within a live session (sticky), so an
 * unrelated node's change does not visibly restyle the whole sheet. The
 * ratchet floor restarts when a live session starts (live false → true).
 *
 * Returns the PREVIOUS refs object unchanged when nothing ratcheted, so its
 * identity is stable and snapshots do not churn.
 */
function computeRefs(unitResults, streamResults, base) {
  const c = { Qref: 1, O2ref: 1, screenRef: 1, doseRef: 1, gasRef: 1, sludgeRef: 1, powerRef: 1 };
  const up = (k, v) => { if (v != null && v > c[k]) c[k] = v; };

  for (const id in streamResults) up('Qref', num(streamResults[id]?.Q));

  for (const id in unitResults) {
    const u = unitResults[id];
    if (!u) continue;
    const m = u.metrics || EMPTY_OBJ;
    const t = resolveType(u.paletteType || u.type);

    up('powerRef', num(m.power_kW));
    if (AERATION.has(t)) up('O2ref', num(m.O2_demand_kg_d));
    else if (t === 'screening') up('screenRef', num(m.screenings_kg_d));
    else if (DOSING.has(t)) up('doseRef', num(m.dose_kg_d));
    else if (t === 'anaerobic_digester') up('gasRef', num(u.biogas?.volume_m3_d));
    else if (CLARIFIER.has(t)) {
      up('sludgeRef', num(m.sludge_Q_m3_d));
      up('sludgeRef', num(m.RAS_Q_m3_d));
    }
  }

  if (!base) return Object.freeze(c);

  let changed = false;
  const out = {};
  for (const k of REF_KEYS) {
    const v = Math.max(base[k] ?? 1, c[k]);   // ratchet: never falls
    out[k] = v;
    if (base[k] !== v) changed = true;
  }
  return changed ? Object.freeze(out) : base;
}

/**
 * Blower duty (spec §5.3 #3, §5.4).
 *
 * There is NO blower model — `PALETTE_TYPE_MAP.blower = null` → passthrough →
 * `metrics = {}`. So duty is derived: the sum of `O2_demand_kg_d` over the
 * aeration-family nodes adjacent to this blower by any edge, EITHER DIRECTION.
 * With no aeration basin connected the rotor must not turn, and the ⓘ says so.
 *
 * One pass over nodes, one over edges — O(N + E).
 * @returns {Object<string, {O2_served:number, servedCount:number}>}
 */
function computeDerived(nodes, edges, unitResults) {
  const typeOf = new Map();
  for (const n of nodes) if (n?.id) typeOf.set(n.id, resolveType(n.data?.opType));
  for (const id in unitResults) {
    if (!typeOf.has(id)) {
      typeOf.set(id, resolveType(unitResults[id]?.paletteType || unitResults[id]?.type));
    }
  }

  // Seed every blower, so an UNLINKED blower is distinguishable from a
  // non-blower (which simply has no derived record at all).
  const served = new Map();
  for (const [id, t] of typeOf) if (t === 'blower') served.set(id, new Set());
  if (!served.size) return EMPTY_OBJ;

  for (const e of edges) {
    if (!e) continue;
    const s = typeOf.get(e.source);
    const t = typeOf.get(e.target);
    if (s === 'blower' && AERATION.has(t)) served.get(e.source)?.add(e.target);
    if (t === 'blower' && AERATION.has(s)) served.get(e.target)?.add(e.source);
  }

  const out = {};
  for (const [blowerId, set] of served) {
    let total = 0;
    for (const aerId of set) {
      const o = num(unitResults[aerId]?.metrics?.O2_demand_kg_d);
      if (o != null) total += o;
    }
    out[blowerId] = { O2_served: total, servedCount: set.size };
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════
// 6. SNAPSHOT CONSTRUCTION — cached, referentially stable
// ═══════════════════════════════════════════════════════════════════════════

/**
 * @typedef {Object} NodeSnapshot
 * @property {string}  id
 * @property {boolean} live        motion gate — `liveMode && liveStatus !== 'error'`
 * @property {number}  seq         frame sequence this snapshot was built at
 * @property {number}  changedSeq  frame sequence this node's DATA last differed —
 *                                 use as a React `key` to replay a one-shot
 *                                 (the §5.3 #20 service-band heartbeat)
 * @property {boolean} hasResults  false when the solver produced nothing for it
 * @property {string|null} type    solver model type
 * @property {string|null} opType  palette type, legacy aliases resolved
 * @property {Object}  metrics     `{}` when absent; `{error}` on a model throw
 * @property {Object|null} biogas  digester only — lives OUTSIDE `metrics`
 * @property {Object}  outputs     port name -> Stream JSON
 * @property {Object}  derived     `{}`, or `{O2_served, servedCount}` for a blower
 * @property {Refs}    refs        sheet-wide references, stable identity
 */

function buildNodeSnapshot(id) {
  const u = frame.unitResults[id] || null;
  const snap = Object.freeze({
    id,
    live: frame.live,
    seq: frame.seq,
    changedSeq: nodeChangedSeq.get(id) ?? frame.seq,
    hasResults: !!u,
    type: u?.type ?? null,
    opType: resolveType(u?.paletteType ?? u?.type ?? null),
    metrics: u?.metrics || EMPTY_OBJ,
    biogas: u?.biogas ?? null,
    outputs: u?.outputs || EMPTY_OBJ,
    derived: frame.derived[id] || EMPTY_OBJ,
    refs: frame.refs,
  });
  nodeSnap.set(id, snap);
  return snap;
}

/** True when the cached snapshot still describes the current frame's DATA. */
function nodeDataEq(snap, u, derivedRec) {
  if (!snap) return false;
  if (snap.hasResults !== !!u) return false;
  if (!valuesEq(snap.derived, derivedRec)) return false;
  if (!u) return true;
  return snap.type === (u.type ?? null)
    && snap.opType === resolveType(u.paletteType ?? u.type ?? null)
    && valuesEq(snap.metrics, u.metrics || EMPTY_OBJ)
    && valuesEq(snap.biogas, u.biogas ?? null)
    && valuesEq(snap.outputs, u.outputs || EMPTY_OBJ);
}

/**
 * @typedef {Object} EdgeSnapshot
 * @property {string}  id
 * @property {boolean} live
 * @property {number}  seq
 * @property {number}  changedSeq
 * @property {boolean} hasResults
 * @property {Object|null} stream  the Stream JSON for this edge
 * @property {number|null} Q       convenience — parsed, finite or null
 * @property {Refs}    refs
 */

function buildEdgeSnapshot(id) {
  const s = frame.streamResults[id] || null;
  const snap = Object.freeze({
    id,
    live: frame.live,
    seq: frame.seq,
    changedSeq: edgeChangedSeq.get(id) ?? frame.seq,
    hasResults: !!s,
    stream: s,
    Q: num(s?.Q),
    refs: frame.refs,
  });
  edgeSnap.set(id, snap);
  return snap;
}

function edgeDataEq(snap, s) {
  if (!snap) return false;
  if (snap.hasResults !== !!s) return false;
  if (!s) return true;
  return valuesEq(snap.stream, s);
}

function buildSheetSnapshot() {
  sheetSnap = Object.freeze({ live: frame.live, refs: frame.refs });
  return sheetSnap;
}

// ═══════════════════════════════════════════════════════════════════════════
// 7. PUBLIC READ API
// ═══════════════════════════════════════════════════════════════════════════

/** The whole frame — for debugging and tests. Do NOT subscribe components to it. */
export function getFrame() { return frame; }

/** @returns {Refs} the current sheet-wide references. */
export function getRefs() { return frame.refs; }

/**
 * A null / undefined id is normalised to one shared cache key rather than
 * short-circuiting past the cache. Bypassing the cache for ANY id — even one
 * that "cannot happen" — is the infinite render loop.
 */
const cacheKey = (id) => (id == null ? '' : id);

/** @returns {NodeSnapshot} STABLE across calls while nothing changed. */
export function getNodeSnapshot(id) {
  const k = cacheKey(id);
  return nodeSnap.get(k) ?? buildNodeSnapshot(k);
}

/** @returns {EdgeSnapshot} STABLE across calls while nothing changed. */
export function getEdgeSnapshot(id) {
  const k = cacheKey(id);
  return edgeSnap.get(k) ?? buildEdgeSnapshot(k);
}

/** @returns {{live:boolean, refs:Refs}} STABLE while neither changed. */
export function getSheetSnapshot() {
  return sheetSnap ?? buildSheetSnapshot();
}

// ═══════════════════════════════════════════════════════════════════════════
// 8. SUBSCRIPTIONS
// ═══════════════════════════════════════════════════════════════════════════

function subscribeIn(map, rawId, cb) {
  // Same normalisation as the snapshot cache, so a subscriber and its cached
  // baseline can never end up under two different keys.
  const id = cacheKey(rawId);
  let set = map.get(id);
  if (!set) { set = new Set(); map.set(id, set); }
  set.add(cb);
  return () => {
    const s = map.get(id);
    if (!s) return;
    s.delete(cb);
    if (!s.size) map.delete(id);
  };
}

/**
 * Subscribing PRIMES the snapshot cache for that id.
 *
 * Without a cached snapshot there is no baseline to diff the next frame
 * against, so `setFrame` would have to assume "changed" and notify. React
 * always renders (and therefore reads) before it subscribes, so this only
 * makes the direct API behave the way the hook already does.
 *
 * @returns {() => void} unsubscribe
 */
export function subscribeNode(id, cb) {
  const off = subscribeIn(nodeSubs, id, cb);
  getNodeSnapshot(id);
  return off;
}

/** @returns {() => void} unsubscribe */
export function subscribeEdge(id, cb) {
  const off = subscribeIn(edgeSubs, id, cb);
  getEdgeSnapshot(id);
  return off;
}
/** @returns {() => void} unsubscribe */
export function subscribeSheet(cb) { sheetSubs.add(cb); return () => sheetSubs.delete(cb); }

// ═══════════════════════════════════════════════════════════════════════════
// 9. WRITE — the single entry point
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Publish a new frame.
 *
 * CanvasPage calls this in exactly one place per path — immediately after
 * `applyStreamResults(data)` in both `simulate()` and `runLivePreview()` —
 * plus whenever `liveMode` / `liveStatus` / `reducedMotion` change.
 *
 * Fields omitted from `next` are CARRIED OVER, so `setFrame({ live: false })`
 * flips the gate without touching results, and vice versa.
 *
 * Governing principle (§6.1): VALUES ALWAYS, MOTION ONLY LIVE. Refs and
 * snapshots are computed whether or not `live` is true, so static encoders
 * render after a manual run and in print. Only the loops are gated.
 *
 * @param {Object} next
 * @param {boolean} [next.live]           `liveMode && liveStatus !== 'error' && !reducedMotion`
 * @param {Object}  [next.unitResults]    results.unitResults, keyed by node id
 * @param {Object}  [next.streamResults]  results.streamResults, keyed by edge id
 * @param {Array}   [next.nodes]          canvas nodes (for op types / adjacency)
 * @param {Array}   [next.edges]          canvas edges (for adjacency)
 */
export function setFrame(next = {}) {
  const prev = frame;
  const pick = (key, empty) => (next[key] !== undefined ? (next[key] || empty) : prev[key]);

  const unitResults = pick('unitResults', EMPTY_OBJ);
  const streamResults = pick('streamResults', EMPTY_OBJ);
  const nodes = pick('nodes', EMPTY_ARR);
  const edges = pick('edges', EMPTY_ARR);
  const live = next.live !== undefined ? !!next.live : prev.live;

  // A live session STARTS: drop the ratchet floor so the new session's scale
  // comes from the new session's own numbers.
  const sessionStart = live && !prev.live;
  const refs = computeRefs(unitResults, streamResults, sessionStart ? null : prev.refs);
  const derived = computeDerived(nodes, edges, unitResults);

  const seq = prev.seq + 1;
  frame = { live, seq, unitResults, streamResults, nodes, edges, refs, derived };

  const liveChanged = live !== prev.live;
  const refsChanged = refs !== prev.refs;
  // A refs ratchet legitimately restyles every node (it is the scale every
  // rate is normalised against), so it invalidates every cached snapshot.
  // Refs are sticky, so in a converged session this stops happening entirely.
  const invalidateAll = liveChanged || refsChanged;

  // ── Nodes ────────────────────────────────────────────────────────────────
  const nodeIds = new Set();
  for (const id of nodeSubs.keys()) nodeIds.add(id);
  for (const id of nodeSnap.keys()) nodeIds.add(id);

  const notifyNodes = [];
  for (const id of nodeIds) {
    const cached = nodeSnap.get(id);
    const u = unitResults[id] || null;
    const d = derived[id] || EMPTY_OBJ;
    const dataChanged = !nodeDataEq(cached, u, d);
    if (!invalidateAll && !dataChanged) continue;
    if (dataChanged) nodeChangedSeq.set(id, seq);
    nodeSnap.delete(id);              // rebuilt lazily on the next read
    notifyNodes.push(id);
  }

  // ── Edges ────────────────────────────────────────────────────────────────
  const edgeIds = new Set();
  for (const id of edgeSubs.keys()) edgeIds.add(id);
  for (const id of edgeSnap.keys()) edgeIds.add(id);

  const notifyEdges = [];
  for (const id of edgeIds) {
    const cached = edgeSnap.get(id);
    const s = streamResults[id] || null;
    const dataChanged = !edgeDataEq(cached, s);
    if (!invalidateAll && !dataChanged) continue;
    if (dataChanged) edgeChangedSeq.set(id, seq);
    edgeSnap.delete(id);
    notifyEdges.push(id);
  }

  // ── Sheet ────────────────────────────────────────────────────────────────
  if (invalidateAll) sheetSnap = null;

  // ── Prune caches for ids that are gone from the canvas ───────────────────
  for (const id of nodeSnap.keys()) {
    if (!nodeSubs.has(id) && !unitResults[id]) { nodeSnap.delete(id); nodeChangedSeq.delete(id); }
  }
  for (const id of edgeSnap.keys()) {
    if (!edgeSubs.has(id) && !streamResults[id]) { edgeSnap.delete(id); edgeChangedSeq.delete(id); }
  }

  // ── Notify ONLY what changed, after every cache is consistent ────────────
  for (const id of notifyNodes) {
    const set = nodeSubs.get(id);
    if (set) for (const cb of Array.from(set)) cb();
  }
  for (const id of notifyEdges) {
    const set = edgeSubs.get(id);
    if (set) for (const cb of Array.from(set)) cb();
  }
  if (invalidateAll) for (const cb of Array.from(sheetSubs)) cb();
}

/**
 * Wipe the store back to its initial state. Tests use it between cases; the
 * app can use it when a project is closed. Subscribers are NOT dropped — a
 * mounted node keeps its subscription and is notified.
 */
export function resetLiveStore() {
  frame = initialFrame();
  nodeSnap.clear();
  edgeSnap.clear();
  nodeChangedSeq.clear();
  edgeChangedSeq.clear();
  sheetSnap = null;
  for (const set of nodeSubs.values()) for (const cb of Array.from(set)) cb();
  for (const set of edgeSubs.values()) for (const cb of Array.from(set)) cb();
  for (const cb of Array.from(sheetSubs)) cb();
}

// ═══════════════════════════════════════════════════════════════════════════
// 10. REACT BINDINGS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Subscribe one node to the live frame.
 * @param {string} id ReactFlow node id
 * @returns {NodeSnapshot}
 */
export function useLiveNode(id) {
  const subscribe = useCallback((cb) => subscribeNode(id, cb), [id]);
  const snapshot = useCallback(() => getNodeSnapshot(id), [id]);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/**
 * Subscribe one edge to the live frame.
 * @param {string} id ReactFlow edge id
 * @returns {EdgeSnapshot}
 */
export function useLiveEdge(id) {
  const subscribe = useCallback((cb) => subscribeEdge(id, cb), [id]);
  const snapshot = useCallback(() => getEdgeSnapshot(id), [id]);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/**
 * Sheet-level live state — `live` plus the §5.2 references. Used by the
 * Encoding Legend (which prints the current Qref) and by chrome that needs the
 * gate without subscribing to any one node.
 * @returns {{live:boolean, refs:Refs}}
 */
export function useLiveSheet() {
  return useSyncExternalStore(subscribeSheet, getSheetSnapshot, getSheetSnapshot);
}
