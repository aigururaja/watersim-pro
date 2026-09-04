/**
 * pump — ISA centrifugal (spec §3.2 #3, §5.3 #4)
 * ─────────────────────────────────────────────────────────────────────────────
 * "d30 circle, tangential discharge trapezoid off top-right, suction stub left,
 *  baseplate line, 3 curved impeller vanes inside."
 *
 * DRIVERS
 *   GATE      metrics.status === 'ON'   (pump.js:98)
 *             fallback isControlOn(params.running) — the same coercion the
 *             backend uses, so an un-simulated pump still reads correctly.
 *   RATE      metrics.speed_pct → P = clamp(1.5 − 1.22·(speed/100), 0.28, 1.6)s
 *             5 buckets, 15% hysteresis.
 *             `speed_pct` is a Class-C ECHO (pump.js:99, a clamped setpoint)
 *             and this is one of the TWO places §0.2 rule 2 permits an echo to
 *             drive a rate: the VFD setpoint IS the rotation rate depicted.
 *   WATCH     metrics.blocked_Q_m3_d > 0 (Class A, pump.js:102) → a 1.1s amber
 *             throb on the DISCHARGE NOZZLE, which lives on its own outer <g>
 *             so the throb and the impeller spin never fight one `transform`.
 *   STATIC    metrics.power_kW (Class A, pump.js:103) → rim arc length via
 *             `pathLength="100"`. NO MOTION: power is a magnitude, not a rate.
 *
 * OFF (spec §2.4): impeller PARKED at 12° — parked, not paused mid-frame —
 * de-energised hatch in the casing, ink at 45%, alarm-coloured shell. Legible
 * as stopped with zero motion, in a still frame and in print.
 */

import { useRef } from 'react';
import { registerSymbol } from './index';
import { Rotor, ink, clamp } from './primitives';
import { DEF_IDS, paint } from './defs';
import { num, drive, bucket, secs } from '../liveStore';
import { isControlOn, controlPct } from '../controlState';

const EMPTY = Object.freeze({});
const INK = 'var(--ws-ink-700, #1E293B)';
const INK_SOFT = 'var(--ws-ink-400, #94A3B8)';
const ALARM = 'var(--ws-alarm, #DC2626)';
const WATCH = 'var(--ws-watch, #D97706)';
const BRAND = 'var(--ws-brand-600, #2E75B6)';

const CX = 66;
const CY = 30;
const R = 15;                       // d30 casing
const ARC_R = R + 3.5;              // static power rim arc
const VANE = 'M 69 27.5 Q 76.5 25 78 31.5';
const VANE_ANGLES = [0, 120, 240];
/* Tangential discharge trapezoid, springing off the casing between 25° and 70°
   above the horizontal and opening up-right into a flange. */
const NOSE = 'M 79.6 23.7 L 88.4 14.1 L 79.9 6.3 L 71.1 15.9';
const SPIN_STEPS = 5;

const cxs = (...p) => p.filter(Boolean).join(' ');

export function PumpSymbol({ opType = 'pump', data, state, snap }) {
  const spinBucket = useRef(undefined);

  const m = snap?.metrics || EMPTY;
  const refs = snap?.refs || EMPTY;
  const params = data?.params || EMPTY;
  const errored = state === 'error' || m.error != null;

  // ── Gate: the solver's own status, else the same coercion the model uses ──
  const status = typeof m.status === 'string' ? m.status : null;
  const on = state === 'off'
    ? false
    : status ? status === 'ON' : isControlOn(params.running);

  // ── Rate (legal Class-C: the VFD setpoint IS the depicted rotation rate) ──
  const speedPct = num(m.speed_pct) ?? controlPct(params.speed_pct);
  let spinDur = null;
  if (on && !errored) {
    const idx = bucket(drive(speedPct, 0, 100), SPIN_STEPS, spinBucket.current);
    spinBucket.current = idx;
    // Bucket EDGES, not centres, so 100% lands on the catalogue's 0.28s floor.
    spinDur = secs(clamp(1.5 - 1.22 * (idx / (SPIN_STEPS - 1)), 0.28, 1.6));
  }

  // ── Blocked discharge (Class A) ──
  const blocked = (num(m.blocked_Q_m3_d) ?? 0) > 0;
  const throbbing = blocked && on && !errored;

  // ── Static power rim arc (Class A magnitude — never a rate) ──
  const powerRef = num(refs.powerRef) ?? 1;
  const power = num(m.power_kW);
  const arc = power != null && powerRef > 0 ? clamp((power / powerRef) * 100, 0, 100) : null;

  const shell = errored || !on ? ALARM : INK;
  const nose = throbbing ? WATCH : shell;
  const nodeState = errored ? 'error' : !on ? 'off' : throbbing ? 'watch' : 'rest';

  return (
    <g
      className="ws-sym ws-sym--pump"
      data-op={opType}
      data-state={nodeState}
      data-watch={throbbing ? 'true' : undefined}
      opacity={!on && !errored ? 0.45 : undefined}
      aria-hidden="true"
    >
      <title>
        {on ? `Pump running at ${speedPct.toFixed(0)}% speed` : 'Pump stopped'}
      </title>

      {/* suction stub + flange, on the symbol centreline */}
      <line className="ws-detail" x1={36} y1={CY} x2={CX - R} y2={CY} {...ink('detail', shell)} />
      <line className="ws-detail" x1={36} y1={CY - 5} x2={36} y2={CY + 5} {...ink('detail', shell)} />

      {/* baseplate */}
      <line className="ws-detail" x1={CX - 18} y1={49} x2={CX + 20} y2={49} {...ink('detail', INK_SOFT)} />

      {/* casing */}
      <circle className="ws-shell" cx={CX} cy={CY} r={R} {...ink('shell', shell)} />

      {/* de-energised hatch — the interior of a stopped machine (spec §2.4) */}
      {!on && (
        <circle
          className="ws-media ws-hatch"
          cx={CX} cy={CY} r={R - 0.9}
          fill={paint(DEF_IDS.hatch)}
        />
      )}

      {/* STATIC power rim arc — `pathLength="100"` makes the dash a percentage.
          Starts at 12 o'clock. There is deliberately no animation on it. */}
      {arc != null && on && (
        <circle
          className="ws-detail ws-rim"
          cx={CX} cy={CY} r={ARC_R}
          pathLength="100"
          strokeDasharray={`${arc.toFixed(1)} 100`}
          transform={`rotate(-90 ${CX} ${CY})`}
          {...ink('detail', BRAND)}
          data-arc={arc.toFixed(1)}
        />
      )}

      {/* 3 curved impeller vanes. The invisible anchor makes the group's bbox
          symmetric about the true pivot, so `transform-box: fill-box` spins the
          impeller about the shaft rather than about its own vane cluster. */}
      <Rotor dur={spinDur} parkedAt={12} anchor={[CX, CY, R - 2]} className="ws-internals">
        {VANE_ANGLES.map((a) => (
          <path key={a} d={VANE} transform={`rotate(${a} ${CX} ${CY})`} {...ink('detail', shell)} />
        ))}
      </Rotor>

      {/* shaft hub */}
      <circle cx={CX} cy={CY} r={2.4} {...ink('media', shell)} fill="var(--ws-card, #FFFFFF)" />

      {/* Discharge nozzle — its OWN outer <g>. Two loops must never fight one
          `transform`, so the throb lives here and the spin lives in the rotor. */}
      <g
        className={cxs('ws-detail', throbbing && 'ws-anim', throbbing && 'ws-throb', 'ws-origin-c')}
        style={throbbing
          ? { transformBox: 'fill-box', transformOrigin: '50% 50%', '--ws-throb': '1.10s' }
          : { transformBox: 'fill-box', transformOrigin: '50% 50%' }}
      >
        <path d={NOSE} {...ink('detail', nose)} />
      </g>
    </g>
  );
}

registerSymbol('pump', PumpSymbol);

export default PumpSymbol;
