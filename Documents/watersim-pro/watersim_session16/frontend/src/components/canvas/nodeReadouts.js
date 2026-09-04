/**
 * nodeReadouts — what a node card PRINTS, and what state it is in (spec §2)
 * ─────────────────────────────────────────────────────────────────────────────
 * One headline metric per opType, its formatter and its unit, plus the footer
 * chips and the card state machine. Values render from whatever results exist —
 * after a manual run, in a still, and in print. Only the loops are live-gated
 * (§6.1: "values always, motion only live").
 *
 * ── THE HONESTY RULES THAT SHAPE THIS FILE ───────────────────────────────────
 * 1. Every key read below is a field the solver actually returns. They were
 *    taken from backend/src/simulation/models/*.js, not guessed. `sweepNonFinite`
 *    (solver.js) turns any non-finite number into `null`, `metrics` is `{}` for
 *    `blower` and `tank` (both `PALETTE_TYPE_MAP` → null → passthrough), and
 *    `metrics` is `{ error }` when a model throws. Every read is guarded.
 * 2. `screen.js` and `grit.js` return `TSS_removal_pct` as a STRING
 *    (`.toFixed(1)` with no leading `+`). `num()` parses strings first, which is
 *    why every read goes through it.
 * 3. NOTHING here is ever written back into `node.data` or `params`.
 * 4. `metrics.warnings.length` NEVER drives a state. That array is non-empty on
 *    essentially every sheet (secondaryClarifier's `SLR > 6.0` test is a units
 *    bug — the defaults give ≈48), so wiring it to the amber ring would leave
 *    every clarifier permanently on watch. Acceptance check #13 exists to catch
 *    exactly that.
 */

import { createContext, useContext } from 'react';
import { num, drive, resolveType, AERATION_TYPES, DOSING_TYPES } from './liveStore';
import { isControlOn } from './controlState';
import { tankTurnoversPerDay, TANK_FOOTER_UNIT } from './symbols/tank';

const EMPTY = Object.freeze({});
const EMPTY_ARR = Object.freeze([]);

const AERATION = new Set(AERATION_TYPES);
const DOSING = new Set(DOSING_TYPES);

// ═══════════════════════════════════════════════════════════════════════════
// 1. FLOW-CONTROL DEFINITIONS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * The two op types that carry a `<ControlRow>` in the footer instead of a
 * readout. Moved here from UnitOpNode so the node, the state machine and the
 * sheet-wide alarm count all read one definition. The pill labels are pinned by
 * `src/test/unitOpNode.test.jsx` and must not change.
 */
export const CONTROL_DEFS = {
  pump:  { paramKey: 'running', pctKey: 'speed_pct',   onLabel: 'ON',   offLabel: 'OFF' },
  valve: { paramKey: 'open',    pctKey: 'opening_pct', onLabel: 'OPEN', offLabel: 'CLOSED' },
};

/** True when this op type renders a control row rather than a readout. */
export const isControlType = (opType) => !!CONTROL_DEFS[opType];

// ═══════════════════════════════════════════════════════════════════════════
// 2. SERVICE BAND (spec §2.1) — the node's DOMINANT MEDIUM, never its category
// ═══════════════════════════════════════════════════════════════════════════
//
// "Equipment is never coloured by category. Colour encodes service or state
// only." The 4px band across the card's top edge is the one place a node shows
// a service colour, and it is the target of the §5.3 #20 per-tick heartbeat.

const SERVICE_TOKEN = {
  water:    'var(--ws-svc-water, #2E75B6)',
  recycle:  'var(--ws-svc-recycle, #B45309)',
  sludge:   'var(--ws-svc-sludge, #78350F)',
  air:      'var(--ws-svc-air, #0891B2)',
  chemical: 'var(--ws-svc-chem, #7C3AED)',
  permeate: 'var(--ws-svc-permeate, #0D9488)',
  dead:     'var(--ws-svc-dead, #94A3B8)',
  nomodel:  'var(--ws-nomodel, #64748B)',
};

const SERVICE_BY_OP = {
  blower: 'air',
  primary_clarifier: 'sludge',
  secondary_clarifier: 'sludge',
  thickener: 'sludge',
  anaerobic_digester: 'sludge',
  ro_membrane: 'permeate',
  uf_membrane: 'permeate',
  gac_adsorption: 'permeate',
  tank: 'dead',
};

/** @returns {string} one of the §4.3 service names. */
export function serviceNameOf(opType) {
  const t = resolveType(opType);
  if (!t) return 'water';
  if (DOSING.has(t)) return 'chemical';
  return SERVICE_BY_OP[t] || 'water';
}

/** @returns {string} a CSS custom-property reference — never a literal hex. */
export function serviceColorOf(opType) {
  return SERVICE_TOKEN[serviceNameOf(opType)] || SERVICE_TOKEN.water;
}

/** The service palette, for the Encoding Legend. */
export const SERVICE_TOKENS = Object.freeze({ ...SERVICE_TOKEN });

// ═══════════════════════════════════════════════════════════════════════════
// 3. FORMATTING (spec §1.2) — tabular figures, magnitude dominant
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Significant-figure-ish formatting so a 12,400 m³/d and a 0.42 m both read
 * well in the same 22px footer. Returns null — never '0' and never 'NaN' —
 * for a value the solver could not produce, and null means PRINT NOTHING.
 *
 * @param {*} v raw metric (may be a string; may be null after sweepNonFinite)
 * @returns {string|null}
 */
export function fmtValue(v) {
  const n = num(v);
  if (n == null) return null;
  const a = Math.abs(n);
  const digits = a >= 100 ? 0 : a >= 10 ? 1 : a >= 1 ? 2 : 3;
  return n.toLocaleString('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: digits,
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// 4. THE HEADLINE READOUT — one metric per op type
// ═══════════════════════════════════════════════════════════════════════════
//
// Each entry: `pick(snap, params)` → the raw value, plus a unit and the ⓘ-grade
// title that says WHICH metric it is. Types absent from this table print
// nothing, which is the correct picture for a unit with no headline number.

const READOUTS = {
  inlet:  { pick: (s) => s.metrics.Q_in,  unit: 'm³/d', title: 'Influent flow (Q_in)' },
  outlet: { pick: (s) => s.metrics.Q_out, unit: 'm³/d', title: 'Discharge flow (Q_out)' },

  pump:  { pick: (s) => s.metrics.Q_delivered_m3_d, unit: 'm³/d', title: 'Flow delivered (Q_delivered_m3_d)' },
  valve: { pick: (s) => s.metrics.Q_out_m3_d,       unit: 'm³/d', title: 'Flow passed (Q_out_m3_d)' },

  // No blower model exists. This is the DERIVED duty — the O₂ demand of the
  // aeration basins this blower is adjacent to — and the ⓘ says so.
  // An UNLINKED blower prints NOTHING, not a zero: the footer already carries
  // the slate UNLINKED chip, and "0 kg O₂/d" would read as a measurement.
  blower: {
    pick: (s) => ((num(s.derived.servedCount) ?? 0) > 0 ? s.derived.O2_served : null),
    unit: 'kg O₂/d',
    title: 'Derived duty — O₂ demand of the basins served',
  },

  screening:    { pick: (s) => s.metrics.screenings_kg_d,   unit: 'kg/d', title: 'Screenings captured (screenings_kg_d)' },
  grit_removal: { pick: (s) => s.metrics.grit_removed_kg_d, unit: 'kg/d', title: 'Grit removed (grit_removed_kg_d)' },

  primary_clarifier:   { pick: (s) => s.metrics.sludge_Q_m3_d, unit: 'm³/d', title: 'Primary sludge flow (sludge_Q_m3_d)' },
  secondary_clarifier: { pick: (s) => s.metrics.RAS_Q_m3_d,    unit: 'm³/d', title: 'Return sludge flow (RAS_Q_m3_d)' },
  thickener:           { pick: (s) => s.metrics.thickened_Q_m3_d, unit: 'm³/d', title: 'Thickened sludge flow (thickened_Q_m3_d)' },

  activated_sludge:    { pick: (s) => s.metrics.O2_demand_kg_d, unit: 'kg O₂/d', title: 'Oxygen demand (O2_demand_kg_d)' },
  membrane_bioreactor: { pick: (s) => s.metrics.O2_demand_kg_d, unit: 'kg O₂/d', title: 'Oxygen demand (O2_demand_kg_d)' },
  uct_reactor:         { pick: (s) => s.metrics.O2_demand_kg_d, unit: 'kg O₂/d', title: 'Oxygen demand (O2_demand_kg_d)' },
  jhb_reactor:         { pick: (s) => s.metrics.O2_demand_kg_d, unit: 'kg O₂/d', title: 'Oxygen demand (O2_demand_kg_d)' },

  // `biogas` lives OUTSIDE `metrics`. Production is a RATE — the gasholder
  // cover deliberately does not move (§5.4); the number carries it instead.
  anaerobic_digester: { pick: (s) => s.biogas?.volume_m3_d, unit: 'm³/d', title: 'Biogas production (biogas.volume_m3_d)' },

  uv_disinfection: { pick: (s) => s.metrics.log_reduction, unit: 'log', title: 'Log reduction achieved (log_reduction)' },
  chlorination:    { pick: (s) => s.metrics.dose_kg_d,     unit: 'kg/d', title: 'Chlorine consumed (dose_kg_d)' },
  sand_filter:     { pick: (s) => s.metrics.h_clogged_m,   unit: 'm',    title: 'Head loss through the bed (h_clogged_m)' },

  chemical_dosing:  { pick: (s) => s.metrics.dose_kg_d, unit: 'kg/d', title: 'Chemical consumed (dose_kg_d)' },
  coagulant_dosing: { pick: (s) => s.metrics.dose_kg_d, unit: 'kg/d', title: 'Coagulant consumed (dose_kg_d)' },
  polymer_dosing:   { pick: (s) => s.metrics.dose_kg_d, unit: 'kg/d', title: 'Polymer consumed (dose_kg_d)' },
  ph_adjustment:    { pick: (s) => s.metrics.dose_kg_d, unit: 'kg/d', title: 'Reagent consumed (dose_kg_d)' },
  coagulation:      { pick: (s) => s.metrics.dose_kg_d, unit: 'kg/d', title: 'Coagulant consumed (dose_kg_d)' },

  ro_membrane: { pick: (s) => s.metrics.perm_Q_m3_d, unit: 'm³/d', title: 'Permeate flow (perm_Q_m3_d)' },
  // uf_membrane and gac_adsorption reuse the SCREEN model, whose
  // `TSS_removal_pct` is a STRING. `num()` parses it.
  uf_membrane:    { pick: (s) => s.metrics.TSS_removal_pct, unit: '%', title: 'TSS removal (TSS_removal_pct — screen model)' },
  gac_adsorption: { pick: (s) => s.metrics.TSS_removal_pct, unit: '%', title: 'TSS removal (TSS_removal_pct — screen model)' },

  // The ONE number a tank may legitimately print: a residence figure, never a
  // level. Null (no volume_m3 set) means print nothing.
  tank: {
    pick: (s, params) => tankTurnoversPerDay(s, params),
    unit: TANK_FOOTER_UNIT,
    title: 'Throughput turnovers per day (Q_in / volume_m3) — not a level',
  },
};

/**
 * The headline number for a node's footer.
 *
 * @param {string} opType
 * @param {object} snap   NodeSnapshot from liveStore
 * @param {object} [params] node.data.params (tank only)
 * @returns {{value:string, unit:string, title:string, raw:number}|null}
 *          null means PRINT NOTHING — never a zero standing in for missing data.
 */
export function nodeReadout(opType, snap, params) {
  const t = resolveType(opType);
  const def = READOUTS[t];
  if (!def || !snap) return null;
  if (snap.metrics?.error != null) return null;

  const s = { metrics: snap.metrics || EMPTY, derived: snap.derived || EMPTY, biogas: snap.biogas, outputs: snap.outputs || EMPTY };
  const raw = num(def.pick(s, params || EMPTY));
  if (raw == null) return null;
  const value = fmtValue(raw);
  if (value == null) return null;
  return { value, unit: def.unit, title: def.title, raw };
}

/**
 * The digester's second footer figure — Lane D asks for `volume_m3_d` AND
 * `CH4_pct`. `CH4_pct` is a verbatim echo of the `biogas_CH4_frac` param, so it
 * is PRINTED ONLY: it never drives motion.
 * @returns {string|null}
 */
export function nodeSecondary(opType, snap) {
  if (resolveType(opType) !== 'anaerobic_digester') return null;
  const pct = num(snap?.biogas?.CH4_pct);
  if (pct == null) return null;
  return `${pct.toFixed(0)}% CH₄`;
}

// ═══════════════════════════════════════════════════════════════════════════
// 5. THE CARD STATE MACHINE (spec §2.4)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * `nomodel` — the two units the engine genuinely does not simulate.
 *   tank    always (PALETTE_TYPE_MAP.tank = null → passthrough → metrics {})
 *   blower  only when NO aeration basin is adjacent, in which case the rotor
 *           does not turn either. `servedCount` is seeded for EVERY blower by
 *           liveStore, so 0 means "connected to nothing", not "no record".
 * @returns {string|null} the footer chip text, or null
 */
export function unlinkedChip(opType, snap) {
  const t = resolveType(opType);
  if (t === 'tank') return 'NOT SIMULATED';
  if (t !== 'blower') return null;
  const served = num(snap?.derived?.servedCount);
  return served != null && served > 0 ? null : 'UNLINKED';
}

/**
 * Amber WATCH conditions. Every one is a real metric with a real threshold; a
 * type with no entry here can never go amber.
 *
 * Deliberately ABSENT: `metrics.warnings.length` (see rule 4 at the top) and
 * `valve` THROTTLED, which is a normal operating state, not a warning.
 */
function watchReason(t, m) {
  switch (t) {
    case 'pump':
      return (num(m.blocked_Q_m3_d) ?? 0) > 0 ? 'BLOCKED' : null;
    case 'screening':
      return (num(m.headloss_m) ?? 0) > 0.45 ? 'BLINDING' : null;
    case 'secondary_clarifier': {
      // SLR = MLSS x SOR / 1000 — flow cancels exactly, so this is a SETPOINT
      // indicator. 144 kg/m²/d = the classic 6 kg/m²/h limit, per day.
      const slr = num(m.SLR_kg_m2_d);
      const ras = num(m.RAS_TSS_mg_L);
      if ((slr != null && slr > 144) || (ras != null && ras > 12000)) return 'SLR HIGH';
      return null;
    }
    case 'sand_filter':
      return m.backwash_needed === true ? 'BACKWASH' : null;
    case 'uv_disinfection':
      return (num(m.log_deficit) ?? 0) > 0 && m.compliant !== false ? 'DOSE LOW' : null;
    case 'ro_membrane': {
      const rec = num(m.recovery_pct);
      const p = num(m.pressure_bar);
      if ((rec != null && rec > 85) || (p != null && p > 70)) return 'RECOVERY HIGH';
      return null;
    }
    case 'anaerobic_digester':
      return m.stable === false ? 'UNSTABLE' : null;
    case 'ph_adjustment': {
      const a = num(m.pH_in);
      const b = num(m.pH_out);
      if (a != null && b != null && Math.abs(b - a) > 1.5) return 'pH SHIFT';
      return null;
    }
    default:
      if (AERATION.has(t)) {
        // A basin that is not nitrifying while it was asked to is a real
        // operational watch, and `nitrification` is a computed boolean.
        return m.nitrification === false && (num(m.NH4_effluent) ?? 0) > 5 ? 'NH₄ HIGH' : null;
      }
      return null;
  }
}

/**
 * Red ALARM conditions — the ones that must survive a screenshot and a print.
 * @returns {string|null}
 */
function alarmReason(t, m) {
  if (t === 'outlet') {
    if (m.compliant === false) {
      const n = Array.isArray(m.permit_violations) ? m.permit_violations.length : 0;
      return n > 0 ? `${n} VIOLATION${n === 1 ? '' : 'S'}` : 'NON-COMPLIANT';
    }
    return null;
  }
  if (t === 'uv_disinfection') return m.compliant === false ? 'NOT COMPLIANT' : null;
  if (t === 'anaerobic_digester') {
    const ph = num(m.pH_out);
    return ph != null && ph < 6.6 ? 'pH LOW' : null;
  }
  return null;
}

/**
 * The card's state, in strict precedence order.
 *
 *   error   — the model threw; ALL animation is suppressed
 *   off     — pump stopped / valve closed: red border, hatch, 45% ink
 *   alarm   — red ring + violation chips, STATIC in a still, blinks only live
 *   watch   — 1px amber ring, amber band, static, NEVER blinks
 *   nomodel — slate chip + hatch, no motion (tank, unlinked blower)
 *   rest    — flat, hairline only
 *
 * @returns {{state:string, chip:string|null, reason:string|null}}
 */
export function deriveNodeState(opType, snap, params) {
  const t = resolveType(opType);
  const m = snap?.metrics || EMPTY;

  if (m.error != null) return { state: 'error', chip: 'ERR', reason: String(m.error) };

  const def = CONTROL_DEFS[t];
  if (def && !isControlOn(params?.[def.paramKey])) {
    return { state: 'off', chip: null, reason: def.offLabel };
  }

  const alarm = alarmReason(t, m);
  if (alarm) return { state: 'alarm', chip: alarm, reason: alarm };

  const unlinked = unlinkedChip(t, snap);
  const watch = watchReason(t, m);
  if (watch) return { state: 'watch', chip: watch, reason: watch };
  if (unlinked) return { state: 'nomodel', chip: unlinked, reason: unlinked };

  return { state: 'rest', chip: null, reason: null };
}

/** True when this node's card carries the red ring. */
export const isAlarmState = (state) => state === 'alarm' || state === 'error';

/**
 * §5 row 19 FLOOD GUARD, computed sheet-wide.
 *
 * "More than 6 alarm nodes on screen → per-card blinking is suppressed
 *  entirely and only the toolbar alarm chip blinks." Severity is carried by
 * colour and chip count, never by tempo, and twenty blinking cards is noise,
 * not information.
 *
 * Derived in CanvasPage from the SAME `deriveNodeState` the cards use, so the
 * count can never disagree with what is on screen.
 *
 * @param {Array}  nodes       ReactFlow nodes
 * @param {Object} unitResults results.unitResults keyed by node id
 * @returns {number} how many cards are in `alarm` or `error`
 */
export function countAlarms(nodes, unitResults) {
  if (!Array.isArray(nodes) || !unitResults) return 0;
  let n = 0;
  for (const node of nodes) {
    const u = unitResults[node?.id];
    if (!u) continue;
    const snap = {
      metrics: u.metrics || EMPTY,
      derived: EMPTY,
      biogas: u.biogas ?? null,
      outputs: u.outputs || EMPTY,
    };
    const { state } = deriveNodeState(node.data?.opType, snap, node.data?.params);
    if (isAlarmState(state)) n++;
  }
  return n;
}

/** More than six alarmed cards suppresses every per-card blink. */
export const ALARM_FLOOD_LIMIT = 6;

/**
 * Sheet-wide "too many alarms to blink" flag.
 *
 * A CONTEXT is the right tool here and a per-node store subscription is not:
 * this is one BOOLEAN for the whole sheet that flips at most a handful of times
 * in a session, so the §6.2 objection to contexts ("re-renders all 30 consumers
 * every tick") does not apply — the value is `false` for the entire life of a
 * healthy sheet. It also keeps the flag out of `node.data`, which is saved to
 * the DB, broadcast over collab and hashed by `liveSignature`.
 */
export const AlarmFloodContext = createContext(false);

/** @returns {boolean} true while per-card alarm blinking is suppressed. */
export const useAlarmFlood = () => useContext(AlarmFloodContext);

// ═══════════════════════════════════════════════════════════════════════════
// 6. VIOLATION CHIPS (spec §5 row 18)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * `TN 14.2 > 10` — at most 3, then `+N`. Rendered whenever results exist, live
 * or not: a permit violation must survive a screenshot.
 *
 * The outlet SYMBOL already draws these inside its frame, so the node footer
 * prints only the count chip. This function exists for the legend and for any
 * caller that wants the full list.
 */
export function violationChips(snap, max = 3) {
  const list = snap?.metrics?.permit_violations;
  if (!Array.isArray(list) || !list.length) return EMPTY_ARR;
  const out = list.slice(0, max).map((v) => {
    const p = typeof v?.param === 'string' ? v.param : '?';
    const val = num(v?.value);
    const lim = num(v?.limit);
    const cmp = typeof v?.unit === 'string' && v.unit.indexOf('min') >= 0 ? '<' : '>';
    return `${p} ${val == null ? '—' : val.toFixed(1)} ${cmp} ${lim == null ? '—' : lim.toFixed(1)}`;
  });
  if (list.length > max) out.push(`+${list.length - max}`);
  return out;
}

// Re-exported so a symbol-free consumer (the legend) does not have to reach
// into liveStore for the one helper it needs.
export { drive };
