/**
 * #16 `chlorination` — chlorine contact basin   (spec §3.2 #16, §5.3 #9/#16)
 * ─────────────────────────────────────────────────────────────────────────────
 * A BASIN, not an injection point. `chlorination` and `coagulation` both run
 * `chemicalDosing.js` (PALETTE_TYPE_MAP.chlorination = 'chemical_dosing',
 * solver.js:65) — the SAME model as lane C's four inline dosing types. What
 * separates them on the sheet is the drawing: lane C ships a day-tank pot on a
 * stand with an injection quill INTO A LINE; these two ship a vessel with a
 * liquid level, internals and a residence time. A viewer must never have to
 * read the label to tell a dosing skid from a contact tank.
 *
 * ── DRIVERS ──────────────────────────────────────────────────────────────────
 *   dose_kg_d          A — plant-driven (`Q x dose / 1000`, chemicalDosing:108).
 *                      Drives STATIC encoders only here: the quill tick count
 *                      (1..3) and the injection plume's opacity, normalised
 *                      against the sheet-wide `doseRef`.
 *                      NOT `dose_mg_L` — that is `+p.dose_mg_L.toFixed(2)`
 *                      (chemicalDosing:143), a verbatim echo of the parameter.
 *   outputs.effluent.Q A — the surface wave's PERIOD, per §5.3 #9, which names
 *                      chlorination and coagulation explicitly. Flow is
 *                      conserved through this model, so the outlet Q IS the
 *                      basin's throughput. Bucketed to 5 steps with the store's
 *                      15% hysteresis so a jittering Q cannot retime the wave
 *                      every tick.
 *
 * ── WHAT DELIBERATELY DOES NOT MOVE ──────────────────────────────────────────
 * The liquid LEVEL is fixed at 88%. A contact basin in service is full to its
 * weir; the model returns no depth, and a level that wandered would be an
 * invented state variable. There is no paddle here — a serpentine contact tank
 * has no rotating member to animate, and `chemicalDosing.js` returns no
 * rotational rate that could honestly drive one if it did.
 *
 * The basin helpers below are shared with `coagulation.jsx` — one drawing
 * vocabulary for the two vessels that run the same model.
 */

import { useRef } from 'react';
import { Shell, Fill, Wave, Nozzle, GEO, ink, clamp } from './primitives';
import { registerSymbol } from './index';
import { getNodeSnapshot, num, drive, bucket, secs } from '../liveStore';

// ── Shared tokens ────────────────────────────────────────────────────────────
export const INK = 'var(--ws-ink-700, #1E293B)';
export const SOFT = 'var(--ws-ink-400, #94A3B8)';
export const WATER = 'var(--ws-svc-water, #2E75B6)';
export const CHEM = 'var(--ws-svc-chem, #7C3AED)';

// ── Shared basin geometry ────────────────────────────────────────────────────
const R = GEO.rect;                                   // x 30, y 6, w 84, h 48
/** Physically full to the weir, and stated as such (§5.3 #9). */
export const BASIN_LEVEL = 0.88;
export const BASIN = Object.freeze({
  x: R.x, y: R.y, w: R.w, h: R.h,
  inX: R.x + 1, inW: R.w - 2,
  floorY: R.y + R.h,                                  // 54
  surfaceY: R.y + R.h - BASIN_LEVEL * R.h,            // 11.76
});

/**
 * Wave periods, in seconds, from the §5.3 #9 band `clamp(3.2/v, 1.6, 6)`.
 * Quantised up front rather than computed then rounded, so the five values a
 * user can ever see are fixed, monotonic and reviewable.
 */
export const WAVE_PERIODS = Object.freeze([6.0, 4.6, 3.4, 2.4, 1.6]);

/** Below the §4.3 dead-line floor a basin is not flowing: flat, still surface. */
const Q_DEAD = 0.5;

export const uid = (id) => String(id ?? '').replace(/[^A-Za-z0-9_-]/g, '') || 'x';

/**
 * Surface-wave rate for a basin (Class A — it comes from a computed flow).
 *
 * Retiming a running loop causes a phase jump, so the normalised flow is
 * bucketed with the store's 15% hysteresis; `prev` is held in a ref, and the
 * write is idempotent (bucket(v, n, bucket(v, n, p)) === bucket(v, n, p)) so a
 * StrictMode double render cannot drift it.
 *
 * @returns {{dur: string|null, amp: number}} `dur === null` means REST POSE —
 *          a flat surface line and no motion. Never a 0s duration.
 */
export function useBasinWave(snap, motion) {
  const prev = useRef(undefined);
  const q = num(snap?.outputs?.effluent?.Q);
  const qref = num(snap?.refs?.Qref);
  const v = drive(q, 0, Math.max(qref ?? 1, 1e-6));

  if (!motion || v == null || q == null || q < Q_DEAD) return { dur: null, amp: 0 };

  const idx = bucket(v, WAVE_PERIODS.length, prev.current);
  prev.current = idx;
  return { dur: secs(WAVE_PERIODS[idx]), amp: clamp(1 + 2 * v, 1, 3) };
}

/**
 * The dose encoders shared by both basins. STATIC ONLY: `dose_kg_d` is Class A
 * but nothing here is a rate, so it sets a count and an opacity and nothing
 * that loops.
 *
 * @returns {{dosing: boolean, ticks: number, plume: number}}
 */
export function doseEncoders(snap) {
  const dose = num(snap?.metrics?.dose_kg_d);
  if (dose == null || dose <= 0) return { dosing: false, ticks: 0, plume: 0 };
  // Normalise against the sheet-wide reference, floored by this node's own
  // value so a lone basin reads full rather than clipping to nothing.
  const ref = Math.max(num(snap?.refs?.doseRef) ?? 1, dose);
  const v = drive(dose, 0, ref) ?? 0;
  return { dosing: true, ticks: 1 + Math.round(2 * v), plume: 0.15 + 0.45 * v };
}

/**
 * Dosing quill entering the basin from above, plus its injection plume.
 * Grey and capped when the model reports no chemical mass (§5.3 #16).
 */
export function DosingQuill({ x = 40, ticks = 0, plume = 0, dosing = false, clipId }) {
  const colour = dosing ? CHEM : SOFT;
  return (
    <g className="ws-detail" data-quill={dosing ? 'dosing' : 'idle'}>
      <line x1={x} y1={1} x2={x} y2={18} {...ink('detail', colour)} />
      <line x1={x - 4} y1={1} x2={x + 4} y2={1} {...ink('detail', colour)} />
      {Array.from({ length: ticks }, (_, i) => (
        <line key={i} x1={x - 3} y1={4 + i * 3} x2={x + 3} y2={4 + i * 3} {...ink('media', colour)} />
      ))}
      {dosing && (
        <g clipPath={clipId ? `url(#${clipId})` : undefined}>
          <ellipse cx={x} cy={24} rx={8} ry={6} fill={CHEM} opacity={plume} />
        </g>
      )}
    </g>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// The symbol
// ═══════════════════════════════════════════════════════════════════════════

export function ChlorinationSymbol({ nodeId, state, snap }) {
  const s = snap || getNodeSnapshot(nodeId);
  const m = s?.metrics || {};
  const err = !!m.error || state === 'error';
  const motion = !!s?.live && !err && state !== 'off';
  const bowl = `wsCl2Bowl_${uid(nodeId)}`;

  const wave = useBasinWave(s, motion);
  const dose = doseEncoders(s);
  const wet = !!s?.hasResults && !err;

  return (
    <g aria-hidden="true" data-symbol="chlorination">
      <Shell.Rect clipId={bowl} rx={2} />

      {/* Liquid at a FIXED 88% — full to the weir, and it never wanders. */}
      {wet && (
        <>
          <Fill clipId={bowl} level={BASIN_LEVEL} color={WATER} opacity={0.3} />
          {/* No flow -> `Fill`'s own solid surface line IS the flat surface.
              A `<Wave>` at amp 0 would still carry the `ws-drift` shorthand and
              burn a compositor animation to translate a straight line. */}
          {wave.dur && (
            <Wave clipId={bowl} y={BASIN.surfaceY} amp={wave.amp} dur={wave.dur} color={WATER} opacity={0.85} />
          )}
        </>
      )}

      {/* Serpentine contact path: 2 baffles, ceiling-hung then floor-mounted. */}
      <g className="ws-internals" data-baffles="2">
        <line x1={58} y1={BASIN.y} x2={58} y2={42} {...ink('detail', SOFT)} />
        <line x1={86} y1={BASIN.floorY} x2={86} y2={18} {...ink('detail', SOFT)} />
      </g>

      <DosingQuill x={40} clipId={bowl} {...dose} />

      <Nozzle x={BASIN.x - 6} y={16} dir="right" color={INK} />
      <Nozzle x={BASIN.x + BASIN.w} y={44} dir="right" color={INK} />

      <title>
        {dose.dosing
          ? `Chlorine contact basin — ${m.dose_kg_d} kg/d ${m.chemical_type || 'chemical'}`
          : 'Chlorine contact basin — no dose'}
      </title>
    </g>
  );
}

registerSymbol('chlorination', ChlorinationSymbol);

export default ChlorinationSymbol;
