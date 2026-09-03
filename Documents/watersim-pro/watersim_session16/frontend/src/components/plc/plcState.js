/**
 * plcState — pure helpers for PLC binding / live-value state.
 *
 * Live-value state shape (kept in CanvasPage):
 *   { [`${nodeId}:${paramKey}`]: { bindingId, value, quality, ts } }
 *
 * quality: 'good' | 'stale' | 'bad' | 'unknown'
 */

export const QUALITY_COLORS = {
  good:    '#16A34A', // green
  stale:   '#D97706', // amber
  bad:     '#DC2626', // red
  unknown: '#9CA3AF', // gray
};

// Higher = worse. Unknown sits between stale and bad — no data is worse than
// stale data, but not as bad as a confirmed-bad read.
const QUALITY_RANK = { good: 0, stale: 1, unknown: 2, bad: 3 };

export const bindingKey = (nodeId, paramKey) => `${nodeId}:${paramKey}`;

/** GET plc-bindings rows → map keyed `${nodeId}:${paramKey}`. */
export function bindingsToMap(bindings) {
  const out = {};
  for (const b of Array.isArray(bindings) ? bindings : []) {
    if (b && b.node_id != null && b.param_key != null) {
      out[bindingKey(b.node_id, b.param_key)] = b;
    }
  }
  return out;
}

/**
 * Seed the live-value map from binding rows (each row carries the persisted
 * last_value / quality / last_read_at, so chips show data before the first
 * WS update arrives).
 */
export function liveFromBindings(bindings) {
  const out = {};
  for (const b of Array.isArray(bindings) ? bindings : []) {
    if (!b || b.node_id == null || b.param_key == null) continue;
    if (b.last_value == null && !b.quality) continue; // nothing read yet
    out[bindingKey(b.node_id, b.param_key)] = {
      bindingId: b.id ?? null,
      value:     b.last_value ?? null,
      quality:   b.quality || 'unknown',
      ts:        b.last_read_at || null,
    };
  }
  return out;
}

/**
 * Reducer for incoming PLC values — both the WS `plc:update` payload
 * (`{bindingId, nodeId, paramKey, value, quality, ts}`) and the polled
 * GET plc-values rows (`{…, lastReadAt}` instead of `ts`).
 * Returns `prev` unchanged (same reference) when nothing merged.
 */
export function mergePlcValues(prev, values) {
  const base = prev || {};
  if (!Array.isArray(values) || values.length === 0) return base;
  let next = null;
  for (const v of values) {
    if (!v || v.nodeId == null || v.paramKey == null) continue;
    if (!next) next = { ...base };
    const key = bindingKey(v.nodeId, v.paramKey);
    const old = next[key];
    next[key] = {
      bindingId: v.bindingId ?? old?.bindingId ?? null,
      value:     v.value !== undefined ? v.value : (old?.value ?? null),
      quality:   v.quality || 'unknown',
      ts:        v.ts ?? v.lastReadAt ?? old?.ts ?? null,
    };
  }
  return next || base;
}

/**
 * Worst quality across the given binding keys (default: every key in the
 * live map). A bound key with no live entry counts as 'unknown'.
 * Returns null when there are no keys at all.
 */
export function worstQuality(liveMap, keys) {
  const list = keys || Object.keys(liveMap || {});
  let worst = null;
  for (const k of list) {
    const q = liveMap?.[k]?.quality || 'unknown';
    if (worst === null || (QUALITY_RANK[q] ?? 2) > (QUALITY_RANK[worst] ?? 2)) worst = q;
  }
  return worst;
}

/** Compact relative time — '12s ago', '3m ago', '2h ago', else a date. */
export function relTime(ts, now = Date.now()) {
  if (ts == null) return '';
  const t = typeof ts === 'number' ? ts : Date.parse(ts);
  if (!Number.isFinite(t)) return '';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 5)    return 'just now';
  if (s < 60)   return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(t).toLocaleDateString();
}
