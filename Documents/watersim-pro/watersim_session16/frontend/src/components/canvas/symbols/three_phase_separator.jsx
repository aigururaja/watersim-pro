/**
 * `three_phase_separator` — a horizontal gas / oil / water separator
 * ─────────────────────────────────────────────────────────────────────────────
 * The section through the vessel: gas space and demister pad at the top, an oil
 * layer floating on the water, and the weir the oil spills over into its own
 * bucket. Inlet on the left; gas leaves from the top, water from below the
 * interface upstream of the weir, oil from the bucket downstream of it.
 *
 * ── DRIVERS ──────────────────────────────────────────────────────────────────
 *   oil_fraction_pct   computed → oil-layer TONE (the model splits flow by
 *                      fraction and computes no level, so the layer depth is
 *                      fixed and only its tone moves)
 *   retention_min < rated_retention_min → the weir is drawn dashed, the
 *                      canvas's "this is not doing what it should" mark
 *   gas / oil / water m³/d  printed in the title only
 *
 * Nothing moves: the model computes a steady split, no rate that could loop.
 */

import { registerSymbol } from './index';
import { Shell, Nozzle, GEO, ink, clamp } from './primitives';
import { getNodeSnapshot, num } from '../liveStore';

const INK = 'var(--ws-ink-700, #1E293B)';
const SOFT = 'var(--ws-ink-400, #94A3B8)';
const WATER = 'var(--ws-svc-water, #2E75B6)';
const OIL = 'var(--ws-svc-recycle, #B45309)';
const GAS = 'var(--ws-svc-air, #0891B2)';

const P = GEO.pill;                  // 28, 12, 88, 36
const SURFACE = P.y + 15;            // 27 — liquid surface
const INTERFACE = P.y + 23;          // 35 — oil / water interface
const BOTTOM = P.y + P.h;            // 48
const WEIR_X = P.x + P.w - 26;       // 90

const uid = (id) => String(id ?? '').replace(/[^A-Za-z0-9_-]/g, '') || 'x';

export function ThreePhaseSeparatorSymbol({ nodeId, snap }) {
  const s = snap || getNodeSnapshot(nodeId);
  const m = s?.metrics || {};
  const clip = `wsSep_${uid(nodeId)}`;

  const oilPct = num(m.oil_fraction_pct);
  const retention = num(m.retention_min);
  const rated = num(m.rated_retention_min);
  const hasResults = oilPct != null;
  const starved = retention != null && rated != null && retention < rated;
  const oilTone = 0.25 + 0.55 * clamp((oilPct ?? 0) / 60, 0, 1);

  const flows = hasResults
    ? `gas ${num(m.gas_m3_d) ?? 0}, oil ${num(m.oil_m3_d) ?? 0}, water ${num(m.water_m3_d) ?? 0} m³/d`
    : '';

  return (
    <g aria-hidden="true" data-symbol="three_phase_separator">
      <Shell.Pill clipId={clip} />

      <g clipPath={`url(#${clip})`}>
        {hasResults && (
          <>
            {/* Water below the interface, upstream of the weir. */}
            <rect x={P.x} y={INTERFACE} width={WEIR_X - P.x} height={BOTTOM - INTERFACE}
                  fill={WATER} opacity={0.22} />
            {/* Oil floating on it, and the oil collected past the weir. */}
            <rect x={P.x} y={SURFACE} width={WEIR_X - P.x} height={INTERFACE - SURFACE}
                  fill={OIL} opacity={oilTone} />
            <rect x={WEIR_X} y={SURFACE + 6} width={P.x + P.w - WEIR_X} height={BOTTOM - SURFACE - 6}
                  fill={OIL} opacity={oilTone} />
          </>
        )}
      </g>

      {/* Liquid surface and oil/water interface. */}
      <line x1={P.x + 6} y1={SURFACE} x2={WEIR_X} y2={SURFACE} {...ink('media', OIL)} />
      <line x1={P.x + 4} y1={INTERFACE} x2={WEIR_X} y2={INTERFACE} {...ink('media', WATER)} />

      {/* Weir: dashed when the vessel runs below its design retention. */}
      <line
        x1={WEIR_X} y1={BOTTOM} x2={WEIR_X} y2={SURFACE + 2}
        {...ink('detail', starved ? SOFT : INK)}
        strokeDasharray={starved ? '3 3' : undefined}
      />

      {/* Demister pad in the gas space, ahead of the gas outlet. */}
      <rect x={WEIR_X - 4} y={P.y + 3} width={14} height={6} rx={1}
            fill="none" {...ink('media', INK)} strokeDasharray="1.5 1.5" />

      <Nozzle x={P.x - 8} y={SURFACE - 4} dir="right" len={8} color={INK} />
      <Nozzle x={WEIR_X + 3} y={P.y} dir="up" len={7} color={GAS} />
      <Nozzle x={P.x + 34} y={BOTTOM} dir="down" len={6} color={WATER} />
      <Nozzle x={P.x + P.w - 12} y={BOTTOM} dir="down" len={6} color={OIL} />

      <title>
        {hasResults
          ? `Three-phase separator — ${flows}`
            + (starved ? `; liquid retention ${retention.toFixed(1)} min is below the ${rated} min design` : '')
            + '.'
          : 'Three-phase separator — no results yet.'}
      </title>
    </g>
  );
}

registerSymbol('three_phase_separator', ThreePhaseSeparatorSymbol);

export default ThreePhaseSeparatorSymbol;
