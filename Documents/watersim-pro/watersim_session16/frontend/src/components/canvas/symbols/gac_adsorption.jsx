/**
 * #25 `gac_adsorption` — granular activated carbon contactor
 * (spec §3.2 #25, §0.2)
 * ─────────────────────────────────────────────────────────────────────────────
 * Drawn as what it IS — a vertical carbon contactor: pressure column, dense
 * carbon stipple bed, underdrain, downflow piping. Distinguished from the
 * `sand_filter` (#17) by being vertical and by the dark carbon stipple rather
 * than the sand one.
 *
 * ── WHAT THE ENGINE ACTUALLY GIVES US, AND WHAT WE REFUSE TO DRAW ────────────
 * `PALETTE_TYPE_MAP.gac_adsorption = 'screen'` (solver.js:66). A GAC contactor
 * on this canvas is solved by `screen.js` — a fixed-fraction solids removal.
 * Its whole metric set is `screenType`, `TSS_removal_pct` (a STRING, hence
 * `num()` before any arithmetic), `screenings_kg_d`, `BOD_removed_kg_d`,
 * `COD_removed_kg_d`, `screenings_Q_m3_d` and `headloss_m`.
 *
 * There is therefore NO breakthrough curve, NO bed-life integral, NO adsorbed
 * mass and NO exhaustion state anywhere in this simulator. A darkening bed, a
 * creeping mass-transfer zone or a "carbon exhausted" band would each be a
 * state variable invented in the front end and dressed as a result. None are
 * drawn.
 *
 * ── DRIVERS (both STATIC, both labelled) ─────────────────────────────────────
 *   TSS_removal_pct  C — echo (`(TSS_r x 100).toFixed(1)`, screen.js:73), and a
 *                    STRING. Sets the bed's tone only. A setpoint may set an
 *                    opacity; it may never set a rate.
 *   headloss_m       C — echo (screen.js:78). Amber above 0.45 m, the same
 *                    static threshold §5.3 #12 applies to this same metric on
 *                    this same model.
 *
 * ZERO animated elements, at rest and in live. That is not an omission; it is
 * the only honest reading of the model behind this symbol.
 */

import { registerSymbol } from './index';
import { DEF_IDS, paint } from './defs';
import { Shell, Fill, Nozzle, GEO, ink, clamp } from './primitives';
import { getNodeSnapshot, num, drive } from '../liveStore';

const INK = 'var(--ws-ink-700, #1E293B)';
const SOFT = 'var(--ws-ink-400, #94A3B8)';
const WATER = 'var(--ws-svc-water, #2E75B6)';
const CARBON = 'var(--ws-media-carbon, #3A3A3C)';
const WATCH = 'var(--ws-watch, #D97706)';

const C = GEO.cyl;                          // x 50, w 44, top 5, bottom 55
const RIGHT = C.x + C.w;                    // 94
const BED = Object.freeze({ x: C.x, y: 24, w: C.w, h: 22, drainY: 48 });

const uid = (id) => String(id ?? '').replace(/[^A-Za-z0-9_-]/g, '') || 'x';

export function GacAdsorptionSymbol({ nodeId, state, snap }) {
  const s = snap || getNodeSnapshot(nodeId);
  const m = s?.metrics || {};
  const err = !!m.error || state === 'error';
  const shellId = `wsGacBody_${uid(nodeId)}`;

  // `TSS_removal_pct` arrives as a STRING from screen.js — parse before use.
  const rem = drive(m.TSS_removal_pct, 0, 100);
  const tone = rem == null ? 0.55 : clamp(0.55 + 0.4 * rem, 0.55, 0.95);

  const headloss = num(m.headloss_m);
  const watch = headloss != null && headloss > 0.45;
  const wet = !!s?.hasResults && !err;

  return (
    <g aria-hidden="true" data-symbol="gac_adsorption">
      <Shell.Cyl clipId={shellId} />

      {/* A pressure contactor runs liquid-full: a FIXED, unvarying body of
          water, no surface to wander. Drawn only once results exist. */}
      {wet && (
        <Fill
          x={C.x} y={C.top} w={C.w} h={C.bottom - C.top}
          clipId={shellId} level={1} color={WATER} opacity={0.16} surface={false}
        />
      )}

      {/* ── Carbon bed ───────────────────────────────────────────────────────
          Tone is a labelled SETPOINT encoder. It says nothing about how much
          capacity is left, because the engine does not know. */}
      <g className="ws-media" clipPath={`url(#${shellId})`}>
        <rect data-bed="carbon" x={BED.x} y={BED.y} width={BED.w} height={BED.h} fill={CARBON} opacity={tone} />
        <rect x={BED.x} y={BED.y} width={BED.w} height={BED.h} fill={paint(DEF_IDS.stippleCarbon)} />
        <line x1={BED.x} y1={BED.y} x2={BED.x + BED.w} y2={BED.y} {...ink('detail', SOFT)} />
      </g>

      {/* ── Underdrain ───────────────────────────────────────────────────────── */}
      <g className="ws-internals">
        <line x1={C.x + 4} y1={BED.drainY} x2={RIGHT - 4} y2={BED.drainY} {...ink('detail', SOFT)} />
        {[0, 1, 2, 3].map((i) => {
          const px = C.x + 9 + i * 9;
          return <line key={i} x1={px} y1={BED.drainY} x2={px} y2={BED.drainY + 3} {...ink('media', SOFT)} />;
        })}
      </g>

      {/* Downflow service piping: feed high, filtrate low. */}
      <Nozzle x={C.x - 24} y={14} dir="right" len={24} color={INK} />
      <Nozzle x={RIGHT} y={50} dir="right" len={24} color={INK} />

      {watch && (
        <rect
          className="ws-ring ws-ring--watch"
          data-ring="watch"
          x={C.x - 3} y={C.top - 3} width={C.w + 6} height={C.bottom - C.top + 6} rx={3}
          {...ink('detail', WATCH)}
        />
      )}

      <title>
        {rem == null
          ? 'Carbon contactor — no results'
          : `Carbon contactor — ${m.TSS_removal_pct}% removal (setpoint)${watch ? '; head loss high' : ''}`}
      </title>
    </g>
  );
}

registerSymbol('gac_adsorption', GacAdsorptionSymbol);

export default GacAdsorptionSymbol;
