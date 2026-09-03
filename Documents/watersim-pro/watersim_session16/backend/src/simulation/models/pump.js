/**
 * Pump — flow-control unit operation
 *
 * Moves the influent stream downstream when running; when OFF it delivers zero
 * flow, so downstream units see an empty stream (typical plant operation:
 * stopping a transfer pump stops the train it feeds).
 *
 * Parameters:
 *   running          on/off state — numeric 1/0 preferred (PLC values arrive as
 *                    numbers). 0, '0', false, 'false', 'off' → OFF; anything
 *                    else (including undefined/null) → ON.        (default: 1)
 *   speed_pct        VFD speed, 0–100 % of nominal            (default: 100)
 *   capacity_m3_d    rated capacity at 100 % speed; 0 = unlimited (default: 0)
 *   head_m           total dynamic head (m)                     (default: 10)
 *   pump_efficiency  wire-to-water efficiency, 0–1            (default: 0.65)
 *
 * Q_delivered:
 *   OFF                → 0
 *   capacity_m3_d > 0  → min(Q_in, capacity_m3_d × speed/100)
 *   unlimited capacity → Q_in × speed/100
 *
 * Flow the pump cannot pass (blocked_Q_m3_d) is reported as a warning — the
 * steady-state solver has no storage upstream, so it would otherwise vanish
 * silently.
 */

const { Stream } = require('../stream');

const DEFAULTS = {
  running:         1,
  speed_pct:       100,
  capacity_m3_d:   0,     // 0 = unlimited
  head_m:          10,
  pump_efficiency: 0.65,
};

/** Robust on/off coercion: 0, '0', false, 'false', 'off' → false; else true. */
function coerceOn(value) {
  if (value === 0 || value === false) return false;
  if (typeof value === 'string') {
    const s = value.trim().toLowerCase();
    if (s === '0' || s === 'false' || s === 'off') return false;
  }
  return true; // undefined / null / anything else = ON (default running)
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
  // A pump sits on any line, including a role-marked RAS return: the solver
  // routes torn 'ras' inflows into inputs.RAS, which must be pumped through
  // like any other inflow — dropping it would silently lose recycle flow.
  let inf = inputs.influent || new Stream();
  if (inputs.RAS) inf = inf.Q > 0 ? Stream.mix([inf, inputs.RAS]) : inputs.RAS;

  const on       = coerceOn(p.running);
  const speedPct = clampPct(p.speed_pct);
  const capacity = Number.isFinite(Number(p.capacity_m3_d)) && Number(p.capacity_m3_d) > 0
    ? Number(p.capacity_m3_d) : 0;
  const head = Number.isFinite(Number(p.head_m)) ? Math.max(0, Number(p.head_m)) : DEFAULTS.head_m;
  const eff  = Number.isFinite(Number(p.pump_efficiency)) && Number(p.pump_efficiency) > 0
    ? Math.min(1, Number(p.pump_efficiency)) : DEFAULTS.pump_efficiency;

  const Q_in = Number.isFinite(inf.Q) ? Math.max(0, inf.Q) : 0;

  const Q_delivered = !on ? 0
    : capacity > 0 ? Math.min(Q_in, capacity * speedPct / 100)
    : Q_in * speedPct / 100;

  const blocked = Q_in - Q_delivered;

  const effluent = inf.clone({ Q: Q_delivered });

  // Hydraulic power for water (ρ ≈ 1000 kg/m³): 9.81 · Q[m³/s] · H[m] → kW
  const power_kW     = 9.81 * (Q_delivered / 86400) * head / eff;
  const energy_kWh_d = power_kW * 24;

  const warnings = [];
  if (blocked > 1e-6) {
    warnings.push(on
      ? `Pump limiting flow — ${blocked.toFixed(1)} m³/d backing up upstream`
      : `Pump OFF — ${blocked.toFixed(1)} m³/d backing up upstream`);
  }

  const metrics = {
    status:           on ? 'ON' : 'OFF',
    speed_pct:        +speedPct.toFixed(1),
    Q_in_m3_d:        +Q_in.toFixed(1),
    Q_delivered_m3_d: +Q_delivered.toFixed(1),
    blocked_Q_m3_d:   +Math.max(0, blocked).toFixed(1),
    power_kW:         +power_kW.toFixed(2),
    energy_kWh_d:     +energy_kWh_d.toFixed(1),
  };
  if (warnings.length) metrics.warnings = warnings;

  return { effluent, metrics };
}

module.exports = { solve, DEFAULTS };
