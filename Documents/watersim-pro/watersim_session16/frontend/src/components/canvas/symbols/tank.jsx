/**
 * #26 `tank` — THE DELIBERATE NON-ANIMATION   (spec §3.2 #26, §5.3 #17, §5.4)
 * ─────────────────────────────────────────────────────────────────────────────
 * Ship the refusal exactly. This file's most important property is what it does
 * NOT contain: no level, no fill, no wave, no animation class, no
 * `--ws-*` duration, no transition. Nothing inside this vessel moves, because
 * nothing inside this vessel is simulated.
 *
 * ── WHY, IN FULL ─────────────────────────────────────────────────────────────
 *   1. `PALETTE_TYPE_MAP.tank = null` (solver.js:73) -> `resolveNodeType`
 *      returns `'passthrough'` (solver.js:101) -> the solver emits
 *      `{ effluent: inputs.influent.clone(), metrics: {} }` (solver.js:338).
 *      `metrics` is LITERALLY `{}`. There is no tank metric of any kind.
 *   2. `dynamicSolver.js` runs a sequence of INDEPENDENT steady-state
 *      snapshots. It carries no accumulation term, and its results never reach
 *      the canvas. So no level state exists at any timescale, not even one we
 *      could integrate ourselves.
 *   3. Q_in/Q_out are equal by construction, so any level derived from
 *      throughput would be a constant dressed up as a measurement — a lie
 *      shaped exactly like a level, which is the worst kind.
 *
 * ⓘ copy, verbatim (§5.4):
 *   "This unit passes flow through unchanged. WaterSim has no tank level model
 *    — nothing inside this vessel is simulated."
 *
 * What we draw instead is the canvas-wide "not simulated" language: the 45°
 * de-energised hatch and a DASHED operating-level line (§3.3 — "a solid
 * surface line is a promise that a number backs it").
 *
 * The ONE number a tank may legitimately print is a residence figure, and it is
 * printed in the FOOTER as `turnovers/day`, never drawn as a level. See
 * `tankTurnoversPerDay` below; Phase F's readouts consume it.
 *
 * Only this node's inlet and outlet EDGES move, and that is someone else's
 * code responding to a real stream Q.
 */

import { registerSymbol } from './index';
import { Shell, Hatch, Nozzle, GEO, ink } from './primitives';
import { getNodeSnapshot, num } from '../liveStore';

const INK = 'var(--ws-ink-700, #1E293B)';
const SOFT = 'var(--ws-ink-400, #94A3B8)';

const C = GEO.cyl;                              // x 50, w 44, top 5, bottom 55
const RIGHT = C.x + C.w;                        // 94
/** Dashed operating level at 70% of the shell height (§3.2 #26). */
const OP_LEVEL_FRACTION = 0.70;
const OP_Y = C.bottom - OP_LEVEL_FRACTION * (C.bottom - C.top);   // 20
/** Sight-glass ticks at 0 / 25 / 50 / 75 / 100 %. */
const SIGHT = Object.freeze({ x: 100, w: 6, top: 12, bottom: 52 });

/** ⓘ copy, shipped verbatim per spec §5.4. */
export const TANK_REFUSAL_COPY =
  'This unit passes flow through unchanged. WaterSim has no tank level model — '
  + 'nothing inside this vessel is simulated.';

/** The footer unit. A rate through the vessel — NEVER a level. */
export const TANK_FOOTER_UNIT = 'turnovers/d';

/**
 * Throughput turnovers per day = Q_in / volume_m3.
 *
 * The tank is a passthrough, so `outputs.effluent.Q` IS Q_in. This is a
 * RESIDENCE figure, not a level, and it is printed as a number in the footer
 * and never encoded as a height, a fill or anything that moves.
 *
 * @param {object} snap   NodeSnapshot from liveStore
 * @param {object} params node.data.params
 * @returns {number|null} turnovers/day, or null when either term is missing —
 *                        null means PRINT NOTHING, never print 0.
 */
export function tankTurnoversPerDay(snap, params) {
  const vol = num(params?.volume_m3);
  if (vol == null || vol <= 0) return null;
  const q = num(snap?.outputs?.effluent?.Q);
  if (q == null || q < 0) return null;
  return q / vol;
}

const uid = (id) => String(id ?? '').replace(/[^A-Za-z0-9_-]/g, '') || 'x';

export function TankSymbol({ nodeId, data, snap }) {
  const s = snap || getNodeSnapshot(nodeId);
  const shellId = `wsTankBody_${uid(nodeId)}`;
  const turnovers = tankTurnoversPerDay(s, data?.params);

  return (
    <g aria-hidden="true" data-symbol="tank" data-simulated="false">
      <Shell.Cyl clipId={shellId} />

      {/* 45° de-energised hatch: the canvas-wide "not simulated" fill. */}
      <Hatch x={C.x} y={C.top} w={C.w} h={C.bottom - C.top} clipId={shellId} opacity={0.85} />

      {/* Roof vent nub. */}
      <g className="ws-detail">
        <line x1={C.x + C.w / 2} y1={C.top} x2={C.x + C.w / 2} y2={C.top - 4} {...ink('detail', INK)} />
        <line x1={C.x + C.w / 2 - 3} y1={C.top - 4} x2={C.x + C.w / 2 + 3} y2={C.top - 4} {...ink('detail', INK)} />
      </g>

      {/* DASHED operating-level line. Dashed because the engine does not
          compute it — and therefore never animated (§3.3). */}
      <line
        className="ws-oplevel"
        data-oplevel="dashed"
        x1={C.x + 2} y1={OP_Y} x2={RIGHT - 2} y2={OP_Y}
        {...ink('detail', SOFT)}
        strokeDasharray="3 3"
      />

      {/* Sight glass with ticks at 0/25/50/75/100 — a gauge face with NO
          reading on it, which is precisely the honest picture. */}
      <g className="ws-detail">
        <rect
          x={SIGHT.x} y={SIGHT.top} width={SIGHT.w} height={SIGHT.bottom - SIGHT.top}
          rx={1} {...ink('media', SOFT)}
        />
        {[0, 0.25, 0.5, 0.75, 1].map((f) => {
          const y = SIGHT.bottom - f * (SIGHT.bottom - SIGHT.top);
          return (
            <line
              key={f}
              x1={SIGHT.x + SIGHT.w} y1={y} x2={SIGHT.x + SIGHT.w + 3} y2={y}
              {...ink('media', SOFT)}
            />
          );
        })}
      </g>

      <Nozzle x={C.x - 12} y={16} dir="right" len={12} color={INK} />
      <Nozzle x={RIGHT} y={48} dir="right" len={12} color={INK} />

      <title>
        {turnovers != null
          ? `Storage tank — not simulated. ${turnovers.toFixed(2)} ${TANK_FOOTER_UNIT} through the vessel.`
          : `Storage tank — ${TANK_REFUSAL_COPY}`}
      </title>
    </g>
  );
}

registerSymbol('tank', TankSymbol);

export default TankSymbol;
