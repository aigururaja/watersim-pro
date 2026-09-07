/**
 * `oil_grease_trap` — the OGT on the ITC kitchen influent
 * ─────────────────────────────────────────────────────────────────────────────
 * A baffled box where grease floats and grit sinks. The drawing is the section
 * through it: inlet baffle, outlet baffle dipping below the surface, a grease
 * layer on top and a grit wedge on the floor.
 *
 * ── DRIVERS ──────────────────────────────────────────────────────────────────
 *   fog_removal_pct        computed → grease-layer TONE (a static encoder, not
 *                          a thickness: the model computes a MASS captured per
 *                          day, never a layer depth, so depth stays fixed)
 *   solids_removed_kg_d    computed → grit-wedge tone, same reasoning
 *   derate_pct < 100       computed → the outlet baffle is drawn dashed, the
 *                          canvas's "this is not doing what it should" mark
 *   days_between_cleanout  computed → printed in the title only
 *
 * There is no rate here that the model computes, so nothing loops. A trap has
 * no moving parts, which makes an animated one a lie twice over.
 */

import { registerSymbol } from './index';
import { Shell, Nozzle, GEO, ink, clamp } from './primitives';
import { getNodeSnapshot, num } from '../liveStore';

const INK = 'var(--ws-ink-700, #1E293B)';
const SOFT = 'var(--ws-ink-400, #94A3B8)';
const WATER = 'var(--ws-svc-water, #2E75B6)';
const GREASE = 'var(--ws-svc-recycle, #B45309)';
const GRIT = 'var(--ws-svc-sludge, #78350F)';

const R = GEO.rect;                  // 30, 6, 84, 48
const IN_X = R.x + 1;
const IN_W = R.w - 2;
const SURFACE = R.y + 14;            // 20 — water surface
const GREASE_H = 5;
const FLOOR = R.y + R.h - 1;         // 53
const GRIT_H = 5;

const uid = (id) => String(id ?? '').replace(/[^A-Za-z0-9_-]/g, '') || 'x';

export function OilGreaseTrapSymbol({ nodeId, snap }) {
  const s = snap || getNodeSnapshot(nodeId);
  const m = s?.metrics || {};
  const bowl = `wsOgtBowl_${uid(nodeId)}`;

  const fogPct = num(m.fog_removal_pct);
  const grit = num(m.solids_removed_kg_d);
  const derate = num(m.derate_pct);
  const days = num(m.days_between_cleanout);
  const hasResults = fogPct != null;
  const starved = derate != null && derate < 100;

  // Tone, not thickness. 0.25 floor so a working trap is always visible.
  const greaseTone = 0.25 + 0.55 * clamp((fogPct ?? 0) / 100, 0, 1);
  const gritTone = 0.20 + 0.50 * clamp((grit ?? 0) / 20, 0, 1);

  return (
    <g aria-hidden="true" data-symbol="oil_grease_trap">
      <Shell.Rect clipId={bowl} rx={2} />

      <g clipPath={`url(#${bowl})`}>
        {/* Water body — drawn only once the engine has produced a result. */}
        {hasResults && (
          <rect x={IN_X} y={SURFACE} width={IN_W} height={FLOOR - SURFACE} fill={WATER} opacity={0.22} />
        )}

        {/* The floating grease layer. Fixed depth, tone from what is captured. */}
        {hasResults && (
          <rect x={IN_X} y={SURFACE - GREASE_H} width={IN_W} height={GREASE_H}
                fill={GREASE} opacity={greaseTone} />
        )}

        {/* Settled grit wedge on the floor. */}
        {hasResults && (
          <path
            d={`M ${IN_X} ${FLOOR} L ${IN_X + IN_W} ${FLOOR} L ${IN_X + IN_W} ${FLOOR - GRIT_H} Z`}
            fill={GRIT} opacity={gritTone}
          />
        )}
      </g>

      {/* Surface line — solid, because the interface between the two phases is
          what the model actually separates. */}
      <line x1={IN_X} y1={SURFACE} x2={IN_X + IN_W} y2={SURFACE} {...ink('media', WATER)} />

      {/* Inlet baffle: dips from the roof, forcing flow under the grease. */}
      <line x1={R.x + 22} y1={R.y + 1} x2={R.x + 22} y2={FLOOR - 14} {...ink('detail', INK)} />

      {/* Outlet baffle: draws from below the surface so grease cannot pass.
          Dashed when the trap is running short of its design retention. */}
      <line
        x1={R.x + R.w - 22} y1={R.y + 1} x2={R.x + R.w - 22} y2={FLOOR - 10}
        {...ink('detail', starved ? SOFT : INK)}
        strokeDasharray={starved ? '3 3' : undefined}
      />

      <Nozzle x={R.x - 8} y={SURFACE - 2} dir="right" len={8} color={INK} />
      <Nozzle x={R.x + R.w} y={SURFACE + 8} dir="right" len={8} color={INK} />
      {/* Skimmed-grease take-off, one nozzle for the one side stream. */}
      <Nozzle x={R.x + R.w / 2} y={R.y} dir="up" len={7} color={GREASE} />

      <title>
        {hasResults
          ? `Oil & grease trap — capturing ${fogPct.toFixed(0)} % of incoming FOG`
            + (starved ? `, derated to ${derate.toFixed(0)} % by short retention time` : '')
            + (days != null ? `. Fills in ${days.toFixed(1)} day(s).` : '.')
          : 'Oil & grease trap — no results yet.'}
      </title>
    </g>
  );
}

registerSymbol('oil_grease_trap', OilGreaseTrapSymbol);

export default OilGreaseTrapSymbol;
