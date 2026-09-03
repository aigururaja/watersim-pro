/**
 * Valve — flow-control unit operation
 *
 * Passes the influent stream when open, throttles it proportionally to the
 * opening, and blocks it entirely when closed — replicating an isolation /
 * throttling valve in typical plant operation.
 *
 * Parameters:
 *   open         open/closed state — numeric 1/0 preferred (PLC values arrive
 *                as numbers). 0, '0', false, 'false', 'off' → CLOSED; anything
 *                else (including undefined/null) → OPEN.          (default: 1)
 *   opening_pct  valve position, 0–100 % open                  (default: 100)
 *
 * Q_out = CLOSED ? 0 : Q_in × opening/100 (linear valve characteristic).
 * Flow the valve does not pass (blocked_Q_m3_d) is reported as a warning — the
 * steady-state solver has no storage upstream, so it would otherwise vanish
 * silently.
 */

const { Stream } = require('../stream');

const DEFAULTS = {
  open:        1,
  opening_pct: 100,
};

/** Robust open/closed coercion: 0, '0', false, 'false', 'off' → false; else true. */
function coerceOpen(value) {
  if (value === 0 || value === false) return false;
  if (typeof value === 'string') {
    const s = value.trim().toLowerCase();
    if (s === '0' || s === 'false' || s === 'off') return false;
  }
  return true; // undefined / null / anything else = OPEN (default)
}

/** Clamp a percentage to 0–100; unset ('' / null) or non-finite → 100. */
function clampPct(value) {
  if (value == null || value === '') return 100; // Number('')/Number(null) are 0 — treat as unset
  const n = Number(value);
  if (!Number.isFinite(n)) return 100;
  return Math.min(100, Math.max(0, n));
}

/**
 * @param {{ influent: Stream, RAS?: Stream }} inputs
 * @param {object} params
 * @returns {{ effluent: Stream, metrics: object }}
 */
function solve(inputs, params = {}) {
  const p = { ...DEFAULTS, ...params };
  // A valve sits on any line, including a role-marked RAS return: the solver
  // routes torn 'ras' inflows into inputs.RAS, which must pass through like
  // any other inflow — dropping it would silently lose recycle flow.
  let inf = inputs.influent || new Stream();
  if (inputs.RAS) inf = inf.Q > 0 ? Stream.mix([inf, inputs.RAS]) : inputs.RAS;

  const isOpen     = coerceOpen(p.open);
  const openingPct = clampPct(p.opening_pct);

  const Q_in  = Number.isFinite(inf.Q) ? Math.max(0, inf.Q) : 0;
  const Q_out = !isOpen ? 0 : Q_in * openingPct / 100;

  const blocked  = Q_in - Q_out;
  const effluent = inf.clone({ Q: Q_out });

  const warnings = [];
  if (blocked > 1e-6) {
    warnings.push(isOpen
      ? `Valve throttling flow — ${blocked.toFixed(1)} m³/d backing up upstream`
      : `Valve CLOSED — ${blocked.toFixed(1)} m³/d backing up upstream`);
  }

  const metrics = {
    status:         !isOpen ? 'CLOSED' : openingPct < 100 ? 'THROTTLED' : 'OPEN',
    opening_pct:    +openingPct.toFixed(1),
    Q_in_m3_d:      +Q_in.toFixed(1),
    Q_out_m3_d:     +Q_out.toFixed(1),
    blocked_Q_m3_d: +Math.max(0, blocked).toFixed(1),
  };
  if (warnings.length) metrics.warnings = warnings;

  return { effluent, metrics };
}

module.exports = { solve, DEFAULTS };
