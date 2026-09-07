/**
 * `water_softener` — the ITC plant's SOF vessel and its brine tank
 * ─────────────────────────────────────────────────────────────────────────────
 * Two vessels in one frame, because on this plant they are one unit: a resin
 * column with a brine tank beside it, and the agitator that keeps the brine
 * mixed. Drawing the brine tank separately would leave the column looking like
 * a filter, which is exactly the confusion this symbol has to prevent.
 *
 * ── DRIVERS ──────────────────────────────────────────────────────────────────
 *   hardness_removed_ppm / product   computed → resin-bed tone: a bed working
 *                                    hard against high hardness reads darker
 *   regenerations_per_day            computed → the regeneration clock ticks
 *                                    around the column; more than two a day and
 *                                    it is drawn in watch ochre, which is the
 *                                    model's own warning threshold
 *   reject_m3_d                      computed → the reject nozzle is drawn
 *   recovery_pct                     computed → printed in the title
 *
 * The brine tank's level is NOT drawn as a fill. Nothing computes it: the model
 * consumes salt per regeneration and knows nothing about how much is left in
 * the tank. It gets the canvas's dashed no-model line, like `tank.jsx`.
 *
 * The agitator is drawn parked. It runs only during regeneration, which is a
 * fraction of the day the model averages over rather than resolves.
 */

import { registerSymbol } from './index';
import { DEF_IDS, paint } from './defs';
import { Shell, Nozzle, GEO, ink, clamp } from './primitives';
import { getNodeSnapshot, num } from '../liveStore';

const INK = 'var(--ws-ink-700, #1E293B)';
const SOFT = 'var(--ws-ink-400, #94A3B8)';
const WATER = 'var(--ws-svc-water, #2E75B6)';
const CHEM = 'var(--ws-svc-chem, #7C3AED)';
const WATCH = 'var(--ws-watch, #D97706)';

/** The resin column sits left of centre to leave room for the brine tank. */
const COL = Object.freeze({ x: 38, w: 40, top: 6, bottom: 54 });
const BED_TOP = 20;
const BED_BOT = 48;
/** The brine tank — smaller, to the right. */
const BRINE = Object.freeze({ x: 92, y: 24, w: 26, h: 28 });

const uid = (id) => String(id ?? '').replace(/[^A-Za-z0-9_-]/g, '') || 'x';

export function WaterSoftenerSymbol({ nodeId, snap }) {
  const s = snap || getNodeSnapshot(nodeId);
  const m = s?.metrics || {};
  const shell = `wsSofBowl_${uid(nodeId)}`;

  const removed = num(m.hardness_removed_ppm);
  const regens = num(m.regenerations_per_day);
  const reject = num(m.reject_m3_d);
  const recovery = num(m.recovery_pct);
  const hours = num(m.hours_between_regen);
  const salt = num(m.salt_kg_d);

  const hasResults = removed != null;
  const frequent = regens != null && regens > 2;
  const bedTone = 0.30 + 0.45 * clamp((removed ?? 0) / 400, 0, 1);

  return (
    <g aria-hidden="true" data-symbol="water_softener">
      {/* ── Resin column ─────────────────────────────────────────────────── */}
      <Shell.Cyl clipId={shell} x={COL.x} w={COL.w} top={COL.top} bottom={COL.bottom} />

      <g clipPath={`url(#${shell})`}>
        {hasResults && (
          <rect x={COL.x} y={COL.top + 3} width={COL.w} height={BED_TOP - COL.top - 3}
                fill={WATER} opacity={0.18} />
        )}
        <rect
          x={COL.x} y={BED_TOP} width={COL.w} height={BED_BOT - BED_TOP}
          fill={paint(DEF_IDS.stippleSand)} opacity={hasResults ? bedTone : 0.18}
        />
      </g>
      <line x1={COL.x} y1={BED_TOP} x2={COL.x + COL.w} y2={BED_TOP} {...ink('media', SOFT)} />

      {/* Regeneration clock: a ring with one hand. A COUNT per day, drawn as a
          position on the dial — never as a rotation, because the model gives a
          daily total, not an instantaneous speed. */}
      <g className="ws-detail" data-regens={regens == null ? '' : regens.toFixed(2)}>
        <circle cx={COL.x + COL.w / 2} cy={13} r={5}
                {...ink('media', frequent ? WATCH : SOFT)} />
        {regens != null && (
          <line
            x1={COL.x + COL.w / 2} y1={13}
            x2={COL.x + COL.w / 2 + 4 * Math.sin(clamp(regens, 0, 4) / 4 * 2 * Math.PI)}
            y2={13 - 4 * Math.cos(clamp(regens, 0, 4) / 4 * 2 * Math.PI)}
            {...ink('media', frequent ? WATCH : INK)}
          />
        )}
      </g>

      {/* ── Brine tank ───────────────────────────────────────────────────── */}
      <rect x={BRINE.x} y={BRINE.y} width={BRINE.w} height={BRINE.h} rx={1.5}
            {...ink('detail', INK)} />
      {/* Dashed brine level — nothing computes it (see the header note). */}
      <line
        x1={BRINE.x + 2} y1={BRINE.y + BRINE.h * 0.35}
        x2={BRINE.x + BRINE.w - 2} y2={BRINE.y + BRINE.h * 0.35}
        {...ink('media', SOFT)} strokeDasharray="3 3"
      />
      {/* Agitator: shaft and paddle, parked. */}
      <g className="ws-detail" data-agitator="parked">
        <line x1={BRINE.x + BRINE.w / 2} y1={BRINE.y - 5} x2={BRINE.x + BRINE.w / 2} y2={BRINE.y + BRINE.h - 6}
              {...ink('media', INK)} />
        <line x1={BRINE.x + BRINE.w / 2 - 5} y1={BRINE.y + BRINE.h - 6}
              x2={BRINE.x + BRINE.w / 2 + 5} y2={BRINE.y + BRINE.h - 6} {...ink('media', INK)} />
        <rect x={BRINE.x + BRINE.w / 2 - 4} y={BRINE.y - 10} width={8} height={5} rx={1}
              {...ink('media', INK)} />
      </g>
      {/* Brine draw into the column. */}
      <line x1={BRINE.x} y1={BRINE.y + 6} x2={COL.x + COL.w} y2={BRINE.y + 6}
            {...ink('media', CHEM)} strokeDasharray="2 2" />

      <Nozzle x={COL.x - 12} y={11} dir="right" len={12} color={INK} />
      <Nozzle x={COL.x + COL.w} y={BED_BOT + 3} dir="right" len={10} color={INK} />
      {reject > 0 && <Nozzle x={COL.x + COL.w / 2} y={COL.bottom} dir="down" len={5} color={WATCH} />}

      <title>
        {hasResults
          ? `Ion-exchange softener — removing ${removed.toFixed(0)} ppm hardness`
            + (hours != null ? `, regenerating every ${hours.toFixed(1)} h` : '')
            + (salt != null ? ` on ${salt.toFixed(1)} kg salt/day` : '')
            + (recovery != null ? `. Recovery ${recovery.toFixed(1)} %.` : '.')
            + (frequent ? ' Regenerating more than twice a day — the bed is undersized for this load.' : '')
          : 'Ion-exchange softener — no results yet. The brine level is not simulated.'}
      </title>
    </g>
  );
}

registerSymbol('water_softener', WaterSoftenerSymbol);

export default WaterSoftenerSymbol;
