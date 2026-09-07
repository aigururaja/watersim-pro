/**
 * `sludge_centrifuge` — the ITC plant's decanter centrifuge (Hiller, 1 m³/hr)
 * ─────────────────────────────────────────────────────────────────────────────
 * A horizontal bowl with a scroll conveyor inside it: solids are thrown to the
 * wall, the scroll walks them up the beach to the cake port, and clarified
 * centrate leaves the wide end. The drawing is that section.
 *
 * ── WHY THE SCROLL DOES NOT TURN ─────────────────────────────────────────────
 * This is the one symbol where a rotation would be the obvious choice and is
 * still wrong. `sludgeThickener.js` — which this type resolves to — computes a
 * solids loading rate, a capture percentage and a thickened solids
 * concentration. It has no bowl speed, no differential speed and no torque.
 * A spinning scroll would be a fixed cadence pretending to be a machine
 * setting, which is exactly the failure mode the catalogue's Class A/B rule
 * exists to prevent. The flights are drawn still.
 *
 * ── DRIVERS ──────────────────────────────────────────────────────────────────
 *   thickened_TSS_g_L    computed → cake tone at the discharge end
 *   capture_pct          computed → how far up the beach the cake wedge reaches
 *   solids_in_kg_d       computed → feed-side tone
 *   no results           → empty outline, flights drawn hollow
 */

import { registerSymbol } from './index';
import { DEF_IDS, href } from './defs';
import { Shell, Nozzle, GEO, ink, clamp } from './primitives';
import { getNodeSnapshot, num } from '../liveStore';

const INK = 'var(--ws-ink-700, #1E293B)';
const SOFT = 'var(--ws-ink-400, #94A3B8)';
const SLUDGE = 'var(--ws-svc-sludge, #78350F)';
const WATER = 'var(--ws-svc-water, #2E75B6)';

const P = GEO.pill;                       // x 28, y 12, w 88, h 36
const BEACH_X = P.x + P.w - 26;           // where the cone starts
const AXIS = P.y + P.h / 2;               // 30

const uid = (id) => String(id ?? '').replace(/[^A-Za-z0-9_-]/g, '') || 'x';

export function SludgeCentrifugeSymbol({ nodeId, snap }) {
  const s = snap || getNodeSnapshot(nodeId);
  const m = s?.metrics || {};
  const bowl = `wsCfgBowl_${uid(nodeId)}`;

  const cakeTSS = num(m.thickened_TSS_g_L);
  const capture = num(m.capture_pct);
  const feed = num(m.solids_in_kg_d);
  const cakeQ = num(m.thickened_Q_m3_d);

  const hasResults = cakeTSS != null || capture != null;
  const cakeTone = 0.30 + 0.50 * clamp((cakeTSS ?? 0) / 250, 0, 1);
  const feedTone = 0.18 + 0.35 * clamp((feed ?? 0) / 200, 0, 1);
  // The cake wedge climbs the beach in proportion to capture.
  const beachReach = clamp((capture ?? 0) / 100, 0, 1);

  return (
    <g aria-hidden="true" data-symbol="sludge_centrifuge">
      <Shell.Pill clipId={bowl} />

      <g clipPath={`url(#${bowl})`}>
        {hasResults && (
          <>
            {/* Pool along the bowl wall — solids thrown outward. */}
            <rect x={P.x} y={P.y + P.h - 12} width={BEACH_X - P.x} height={12}
                  fill={SLUDGE} opacity={feedTone} />
            <rect x={P.x} y={P.y + 2} width={BEACH_X - P.x} height={10}
                  fill={WATER} opacity={0.18} />
            {/* Cake wedge climbing the beach toward the discharge. */}
            <path
              d={`M ${BEACH_X} ${P.y + P.h - 2}
                  L ${BEACH_X + beachReach * 24} ${AXIS + 3}
                  L ${BEACH_X + beachReach * 24} ${P.y + P.h - 2} Z`}
              fill={SLUDGE} opacity={cakeTone}
            />
          </>
        )}
      </g>

      {/* Scroll conveyor: shaft plus flights. Still — see the header. */}
      <g className="ws-detail" data-scroll="static">
        <line x1={P.x + 4} y1={AXIS} x2={P.x + P.w - 4} y2={AXIS} {...ink('media', INK)} />
        {[0, 1, 2, 3, 4, 5].map((i) => {
          const x = P.x + 10 + i * 12;
          return (
            <use
              key={i}
              href={href(DEF_IDS.flight)}
              x={x} y={AXIS - 9} width={8} height={6}
              fill={hasResults ? SOFT : 'none'}
              stroke={SOFT}
              strokeWidth={0.75}
              vectorEffect="non-scaling-stroke"
            />
          );
        })}
      </g>

      {/* Beach taper — the conical end the cake is pushed up. */}
      <line x1={BEACH_X} y1={P.y + 2} x2={P.x + P.w - 2} y2={AXIS - 6} {...ink('media', SOFT)} />
      <line x1={BEACH_X} y1={P.y + P.h - 2} x2={P.x + P.w - 2} y2={AXIS + 6} {...ink('media', SOFT)} />

      {/* Feed in at the axis, centrate out the wide end, cake out the beach. */}
      <Nozzle x={P.x - 8} y={AXIS} dir="right" len={8} color={INK} />
      <Nozzle x={P.x + 8} y={P.y + P.h} dir="down" len={6} color={WATER} />
      <Nozzle x={P.x + P.w} y={AXIS} dir="right" len={8} color={SLUDGE} />

      <title>
        {hasResults
          ? `Decanter centrifuge — cake at ${cakeTSS != null ? `${cakeTSS.toFixed(1)} g/L` : 'unknown solids'}`
            + (capture != null ? `, ${capture.toFixed(1)} % solids capture` : '')
            + (cakeQ != null ? `, ${cakeQ.toFixed(2)} m³/d to the skip.` : '.')
            + ' The scroll is drawn still: no bowl or differential speed is modelled.'
          : 'Decanter centrifuge — no results yet.'}
      </title>
    </g>
  );
}

registerSymbol('sludge_centrifuge', SludgeCentrifugeSymbol);

export default SludgeCentrifugeSymbol;
