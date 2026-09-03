/**
 * Shared state helpers for flow-control elements (pump / valve).
 *
 * On/off params are numeric 1/0 (PLC values arrive as numbers), but values may
 * also come from older saves or hand-edited data — coercion mirrors the
 * backend models: 0, '0', false, 'false', 'off' → OFF; undefined/null/anything
 * else → ON (default running/open).
 */
import { createContext } from 'react';

/** Robust on/off coercion — must stay in sync with backend pump/valve models. */
export function isControlOn(value) {
  if (value === 0 || value === false) return false;
  if (typeof value === 'string') {
    const s = value.trim().toLowerCase();
    if (s === '0' || s === 'false' || s === 'off') return false;
  }
  return true;
}

/** Clamp a percentage to 0–100; non-finite (or unset) falls back to 100. */
export function controlPct(value) {
  const n = Number(value);
  if (value == null || value === '' || !Number.isFinite(n)) return 100;
  return Math.min(100, Math.max(0, n));
}

/**
 * Stable toggle channel from the canvas node renderer up to CanvasPage.
 * Value: (nodeId, paramKey, value) => void — CanvasPage provides ONE stable
 * useCallback (reading the latest updateParam through a ref) so the module-
 * scope nodeTypes map is never recreated and memoized nodes don't re-render.
 */
export const NodeControlContext = createContext(null);

/**
 * Stable info channel from the canvas node renderer up to CanvasPage — the
 * exact same pattern as NodeControlContext.
 * Value: (opType, label) => void — CanvasPage provides ONE stable useCallback
 * that opens the node-info modal (title, what/how/watch-for + parameter docs).
 */
export const NodeInfoContext = createContext(null);
