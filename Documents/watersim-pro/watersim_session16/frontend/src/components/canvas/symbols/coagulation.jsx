/**
 * #22 `coagulation` — flocculation basin   (spec §3.2 #22, §5.3 #9/#16)
 * ─────────────────────────────────────────────────────────────────────────────
 * The second of the two BASINS that run `chemicalDosing.js`
 * (PALETTE_TYPE_MAP.coagulation = 'chemical_dosing', solver.js:63). It shares
 * chlorination's shell, level, wave and dose encoders — imported, not copied —
 * and differs where the process differs: a paddle flocculator and floc
 * particles instead of a serpentine contact path.
 *
 * ── DRIVERS ──────────────────────────────────────────────────────────────────
 *   dose_kg_d          A. STATIC encoders only: quill ticks + plume opacity.
 *   TP_removal_pct     computed (chemicalDosing:148, `(1 - TP_out/TP_in) x 100`).
 *                      A STATIC encoder for floc density — dimensionless, so it
 *                      is scale-invariant and cannot be read as a rate.
 *   outputs.effluent.Q A. The surface wave's period (§5.3 #9 names coagulation).
 *
 * ── THE PADDLE DOES NOT TURN, AND THAT IS THE CORRECT DRAWING ────────────────
 * A flocculator paddle runs at a set peripheral velocity / G-value. That is a
 * mechanical design parameter. `chemicalDosing.js` has no such parameter and
 * returns no rotational rate of any kind; its entire metric set is
 * `chemical_type`, `dose_mg_L` (echo), `dose_kg_d`, `sludge_kg_d`, the TP pair
 * and the pH pair. Nothing in it is a rotation.
 *
 * Spinning the paddle from `dose_kg_d` would depict a chemical mass flow as a
 * shaft speed; spinning it from throughput would be worse, since a flocculator's
 * speed is deliberately INDEPENDENT of flow. Both are the exact error §0.2
 * rule 2 exists to forbid ("clarifier rake speed from SOR" is illegal for the
 * same reason). So the paddle is drawn parked, in full ink, as a real piece of
 * equipment that this simulator simply does not turn — the same refusal the
 * digester's floating cover ships. The basin is not inert: its surface wave is
 * driven by a genuinely computed flow.
 */

import { Shell, Fill, Wave, Nozzle, ink, clamp } from './primitives';
import { DEF_IDS, paint } from './defs';
import { registerSymbol } from './index';
import { getNodeSnapshot, num, drive } from '../liveStore';
import {
  BASIN, BASIN_LEVEL, DosingQuill, doseEncoders, useBasinWave, uid,
  INK, SOFT, WATER,
} from './chlorination';

/** Paddle flocculator: horizontal shaft, three paddle bars, drive at the end. */
const PADDLE = Object.freeze({ y: 32, x0: 42, x1: 102, bars: [54, 72, 90], half: 8 });

export function CoagulationSymbol({ nodeId, state, snap }) {
  const s = snap || getNodeSnapshot(nodeId);
  const m = s?.metrics || {};
  const err = !!m.error || state === 'error';
  const motion = !!s?.live && !err && state !== 'off';
  const bowl = `wsFlocBowl_${uid(nodeId)}`;

  const wave = useBasinWave(s, motion);
  const dose = doseEncoders(s);
  const wet = !!s?.hasResults && !err;

  // Floc density — a dimensionless computed percentage, drawn as a stipple
  // opacity. Static: it says how well the coagulant is working, not how fast
  // anything is moving.
  const tp = drive(m.TP_removal_pct, 0, 100);
  const flocO = tp == null ? 0 : clamp(0.20 + 0.55 * tp, 0.2, 0.75);

  return (
    <g aria-hidden="true" data-symbol="coagulation">
      <Shell.Rect clipId={bowl} rx={2} />

      {wet && (
        <>
          <Fill clipId={bowl} level={BASIN_LEVEL} color={WATER} opacity={0.28} />
          {tp != null && (
            <g className="ws-media" clipPath={`url(#${bowl})`}>
              <rect
                data-floc="stipple"
                x={BASIN.inX} y={BASIN.surfaceY} width={BASIN.inW}
                height={BASIN.floorY - BASIN.surfaceY}
                fill={paint(DEF_IDS.stippleFloc)} opacity={flocO}
              />
            </g>
          )}
          {/* See chlorination.jsx: with no flow the `Fill` surface line is the
              flat surface, so no wave element is mounted at all. */}
          {wave.dur && (
            <Wave clipId={bowl} y={BASIN.surfaceY} amp={wave.amp} dur={wave.dur} color={WATER} opacity={0.85} />
          )}
        </>
      )}

      {/* ── Paddle flocculator — PARKED. See the header block: this model
             returns no rotational rate, so nothing here may spin. No
             `ws-rotor`/`ws-rake` class, no duration variable, by design. ──── */}
      <g className="ws-internals" data-paddle="parked">
        <rect x={34} y={PADDLE.y - 5} width={7} height={10} rx={1} {...ink('detail', SOFT)} />
        <line x1={PADDLE.x0 - 1} y1={PADDLE.y} x2={PADDLE.x1} y2={PADDLE.y} {...ink('detail', INK)} />
        {PADDLE.bars.map((x) => (
          <g key={x}>
            <line x1={x} y1={PADDLE.y - PADDLE.half} x2={x} y2={PADDLE.y + PADDLE.half} {...ink('detail', INK)} />
            <circle cx={x} cy={PADDLE.y} r={1.4} fill={INK} />
          </g>
        ))}
      </g>

      <DosingQuill x={40} clipId={bowl} {...dose} />

      <Nozzle x={BASIN.x - 6} y={16} dir="right" color={INK} />
      <Nozzle x={BASIN.x + BASIN.w} y={44} dir="right" color={INK} />

      <title>
        {dose.dosing
          ? `Flocculation basin — ${m.dose_kg_d} kg/d ${m.chemical_type || 'coagulant'}${num(m.TP_removal_pct) == null ? '' : `, ${m.TP_removal_pct}% TP removal`}`
          : 'Flocculation basin — no dose'}
      </title>
    </g>
  );
}

registerSymbol('coagulation', CoagulationSymbol);

export default CoagulationSymbol;
