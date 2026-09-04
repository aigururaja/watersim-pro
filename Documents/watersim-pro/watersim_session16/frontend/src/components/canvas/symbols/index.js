/**
 * SYMBOLS — the equipment glyph registry (spec §3.2, §3.4)
 * ─────────────────────────────────────────────────────────────────────────────
 * One entry per `opType`. This is what kills the current gap where
 * `chemical_dosing`, `coagulant_dosing`, `polymer_dosing`, `ph_adjustment`,
 * `coagulation`, `uf_membrane`, `gac_adsorption` and `tank` all render as the
 * same grey ⬡. All emoji are deleted.
 *
 * The registry is ALSO the palette rail's legend: each of the 26 palette items
 * renders its actual symbol at 24x18 from this same map with a smaller
 * viewBox, so the rail teaches the sheet.
 *
 * ── THE ENTRY CONTRACT ───────────────────────────────────────────────────────
 * A registry value is a React component that renders SVG CHILDREN ONLY — no
 * <svg> wrapper. The host supplies `<svg viewBox="0 0 144 60">`, which is what
 * lets one entry serve both the 144x60 node frame and the 24x18 palette chip.
 *
 *   function PumpSymbol({ nodeId, opType, data, state, snap }) { return (<g>…</g>); }
 *
 *   nodeId  string   ReactFlow node id — pass to `useLiveNode` if the symbol
 *                    reads live values itself (most do)
 *   opType  string   the RESOLVED op type (legacy aliases already applied)
 *   data    object   node.data — label / params. READ ONLY: nothing may ever
 *                    be written back into node.data or params
 *   state   string   'rest' | 'off' | 'watch' | 'alarm' | 'error' | 'nomodel'
 *   snap    object   optional pre-read NodeSnapshot, when the host already has one
 *
 * Symbols must render something sane for EVERY combination — including no
 * results at all (draw the vessel as an empty outline) and `metrics.error`
 * (all animation suppressed).
 *
 * ── FILLING IT IN ────────────────────────────────────────────────────────────
 * Phases C–E each own a disjoint set of `symbols/<opType>.jsx` files and
 * register them with `registerSymbols({ … })`. Until a lane lands,
 * `getSymbol()` returns `PlaceholderSymbol`, so an unregistered or unknown
 * type renders as slate + dashed + hatched — the canvas's existing
 * "NO MODEL / UNLINKED" language — and the app never crashes on a missing
 * entry.
 */

import { PlaceholderSymbol } from './primitives';

// ═══════════════════════════════════════════════════════════════════════════
// Equipment tags (spec §1.2 — 9.5 / 700 / 0.06em, uppercase, mono, ink-400)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * The abbreviation printed in the node header before the label. Short enough
 * that the label still gets the room, conventional enough that a process
 * engineer reads it without the legend.
 */
export const TAG = Object.freeze({
  // Flow boundaries
  inlet: 'SRC',
  outlet: 'OUT',
  // Flow control
  pump: 'P',
  valve: 'V',
  blower: 'B',
  // Preliminary
  screening: 'SCR',
  grit_removal: 'GRT',
  // Primary
  primary_clarifier: 'PC',
  // Secondary (biological)
  activated_sludge: 'AS',
  secondary_clarifier: 'SC',
  membrane_bioreactor: 'MBR',
  uct_reactor: 'UCT',
  jhb_reactor: 'JHB',
  anaerobic_digester: 'AD',
  // Tertiary
  uv_disinfection: 'UV',
  chlorination: 'CL2',
  sand_filter: 'FLT',
  // Chemical dosing
  chemical_dosing: 'DOS',
  coagulant_dosing: 'COAG',
  polymer_dosing: 'POLY',
  ph_adjustment: 'PH',
  // Water purification
  coagulation: 'FLOC',
  ro_membrane: 'RO',
  uf_membrane: 'UF',
  gac_adsorption: 'GAC',
  // Utilities
  tank: 'TK',
  // Legacy (imported / seeded sheets — not on the palette)
  preliminary: 'PRE',
  granular_filter: 'FLT',
  thickener: 'THK',
});

// ═══════════════════════════════════════════════════════════════════════════
// Legacy aliases (spec §3.2)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Types that only ever arrive on imported or seeded sheets.
 *
 *   preliminary     → #6  screening
 *   granular_filter → #17 sand_filter
 *   thickener       → #9  secondary_clarifier, minus the second rake arm plus a
 *                     screw stub — so it gets its OWN entry in Lane D. The
 *                     alias below is only the graceful fallback until that
 *                     lands; a real `thickener` entry always wins.
 *
 * Aliases are consulted ONLY when the type has no entry of its own, so a lane
 * can promote any of these to a first-class symbol without touching this map.
 */
export const SYMBOL_ALIASES = Object.freeze({
  preliminary: 'screening',
  granular_filter: 'sand_filter',
  thickener: 'secondary_clarifier',
});

// ═══════════════════════════════════════════════════════════════════════════
// The registry
// ═══════════════════════════════════════════════════════════════════════════

/**
 * opType → symbol component. Deliberately a mutable plain object: phases C–E
 * fill it from their own modules via `registerSymbols`, with no import cycle
 * back through this file and no edit to this file per symbol.
 *
 * @type {Object<string, Function>}
 */
export const SYMBOLS = {};

/** Register one symbol. Last write wins, so a lane may override an alias. */
export function registerSymbol(opType, Component) {
  if (!opType || typeof Component !== 'function') return;
  SYMBOLS[opType] = Component;
}

/** Register a whole lane at once: `registerSymbols({ pump: PumpSymbol, … })`. */
export function registerSymbols(map) {
  if (!map) return;
  for (const k of Object.keys(map)) registerSymbol(k, map[k]);
}

/** Resolve a legacy op type to the type whose symbol should be drawn. */
export function resolveSymbolType(opType) {
  if (!opType) return null;
  if (SYMBOLS[opType]) return opType;
  return SYMBOL_ALIASES[opType] || opType;
}

/** True when this type has a real drawing (not the fallback). */
export function hasSymbol(opType) {
  const t = resolveSymbolType(opType);
  return !!(t && SYMBOLS[t]);
}

/**
 * The component to render for an op type. NEVER returns undefined — an
 * unknown, unregistered or null type falls back to `PlaceholderSymbol`, so the
 * canvas cannot crash on a sheet from a newer version of the app.
 *
 * @param {string|null|undefined} opType
 * @returns {Function} a React component
 */
export function getSymbol(opType) {
  const t = resolveSymbolType(opType);
  return (t && SYMBOLS[t]) || PlaceholderSymbol;
}

/**
 * The equipment tag for an op type. Falls back through the alias map, then to
 * a generic mark — a tag slot is always occupied so the header never reflows.
 */
export function getTag(opType) {
  if (!opType) return '—';
  return TAG[opType] || TAG[SYMBOL_ALIASES[opType]] || '—';
}

export { PlaceholderSymbol };
export { default as SymbolDefs, DEF_IDS, paint, href } from './defs';
