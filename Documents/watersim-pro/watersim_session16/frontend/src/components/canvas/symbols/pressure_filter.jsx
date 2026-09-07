/**
 * `multigrade_filter` / `activated_carbon_filter` / `micron_filter`
 * ─────────────────────────────────────────────────────────────────────────────
 * Three registry entries, one drawing. The ITC plant's ACF, MGF and micron
 * filter are the same pressure vessel on the same 80 mm CPVC frontal header;
 * what differs is the media, and the media is exactly what the drawing varies:
 * carbon stipple, sand stipple, or a pleated cartridge.
 *
 * Sharing one symbol is deliberate. `pressureFilter.js` is one model with a
 * `media` parameter, so three near-identical files would be three places for
 * the same drawing to drift apart.
 *
 * ── DRIVERS ──────────────────────────────────────────────────────────────────
 *   media                  categorical → bed stipple and cartridge geometry
 *   TSS_removal_pct        computed    → bed tone (static encoder)
 *   derate_pct < 100       computed    → the frontal valve nest goes hollow and
 *                          the bed is drawn dashed at its top: the vessel is
 *                          passing more than it is rated for
 *   backwash_m3_d          computed    → the backwash take-off nozzle is drawn;
 *                          absent when the model computes no backwash at all
 *   dechlorination_pct     computed    → the Cl₂ strike-through, carbon only
 *
 * No loop. The model computes a daily average removal and a daily backwash
 * volume — neither is an instantaneous rate, so neither may drive motion.
 */

import { registerSymbol } from './index';
import { DEF_IDS, paint } from './defs';
import { Shell, Nozzle, GEO, ink, clamp } from './primitives';
import { getNodeSnapshot, num } from '../liveStore';

const INK = 'var(--ws-ink-700, #1E293B)';
const SOFT = 'var(--ws-ink-400, #94A3B8)';
const WATER = 'var(--ws-svc-water, #2E75B6)';
const WATCH = 'var(--ws-watch, #D97706)';

const C = GEO.cyl;                       // x 50, w 44, top 5, bottom 55
const RIGHT = C.x + C.w;                 // 94
const BED_TOP = 22;
const BED_BOT = 48;

const uid = (id) => String(id ?? '').replace(/[^A-Za-z0-9_-]/g, '') || 'x';

/** Which media this instance is drawing, from the metric or the palette type. */
function mediaOf(m, opType) {
  if (m && typeof m.media === 'string') return m.media;
  if (opType === 'activated_carbon_filter') return 'carbon';
  if (opType === 'micron_filter') return 'micron';
  return 'multigrade';
}

export function PressureFilterSymbol({ nodeId, opType, snap }) {
  const s = snap || getNodeSnapshot(nodeId);
  const m = s?.metrics || {};
  const shell = `wsPfBowl_${uid(nodeId)}`;

  const media = mediaOf(m, opType);
  const removal = num(m.TSS_removal_pct);
  const derate = num(m.derate_pct);
  const backwash = num(m.backwash_m3_d);
  const dechlor = num(m.dechlorination_pct);
  const hlr = num(m.HLR_m_h);

  const hasResults = removal != null;
  const overloaded = derate != null && derate < 100;
  const bedTone = 0.30 + 0.45 * clamp((removal ?? 0) / 100, 0, 1);

  const stipple = media === 'carbon' ? DEF_IDS.stippleCarbon : DEF_IDS.stippleSand;

  return (
    <g aria-hidden="true" data-symbol="pressure_filter" data-media={media}>
      <Shell.Cyl clipId={shell} />

      <g clipPath={`url(#${shell})`}>
        {/* Freeboard above the bed. */}
        {hasResults && (
          <rect x={C.x} y={C.top + 3} width={C.w} height={BED_TOP - C.top - 3}
                fill={WATER} opacity={0.18} />
        )}

        {media === 'micron' ? (
          /* A cartridge, not a bed: pleats down the vessel axis. */
          <g className="ws-media">
            <rect x={C.x + 12} y={BED_TOP - 4} width={C.w - 24} height={BED_BOT - BED_TOP + 6}
                  fill={WATER} opacity={hasResults ? 0.22 : 0.10} />
            {[0, 1, 2, 3, 4].map((i) => (
              <line
                key={i}
                x1={C.x + 13 + i * ((C.w - 26) / 4)} y1={BED_TOP - 4}
                x2={C.x + 13 + i * ((C.w - 26) / 4)} y2={BED_BOT + 2}
                {...ink('media', SOFT)}
              />
            ))}
          </g>
        ) : (
          <>
            <rect x={C.x} y={BED_TOP} width={C.w} height={BED_BOT - BED_TOP}
                  fill={paint(stipple)} opacity={bedTone} />
            {/* Support gravel under a graded bed. */}
            <rect x={C.x} y={BED_BOT - 4} width={C.w} height={4} fill={SOFT} opacity={0.35} />
          </>
        )}
      </g>

      {/* Bed surface — dashed when the vessel is running over its rating, which
          is exactly when the bed is not doing what the drawing implies. */}
      {media !== 'micron' && (
        <line
          x1={C.x} y1={BED_TOP} x2={RIGHT} y2={BED_TOP}
          {...ink('media', overloaded ? WATCH : SOFT)}
          strokeDasharray={overloaded ? '3 3' : undefined}
        />
      )}

      {/* Frontal valve nest — the five actuated valves each vessel carries.
          Hollow when overloaded, so the state reads at palette-chip scale. */}
      <g className="ws-detail">
        {[16, 28, 40].map((y) => (
          <g key={y}>
            <line x1={C.x - 14} y1={y} x2={C.x} y2={y} {...ink('media', INK)} />
            <path
              d={`M ${C.x - 11} ${y - 3} L ${C.x - 11} ${y + 3} L ${C.x - 6} ${y} Z`}
              {...ink('media', INK)}
              fill={overloaded ? 'none' : INK}
            />
          </g>
        ))}
      </g>

      {/* Cl₂ strike-through: carbon's job on this plant is to take the chlorine
          back out before the UF membranes see it. */}
      {media === 'carbon' && dechlor > 0 && (
        <g className="ws-detail" data-dechlorination={dechlor}>
          <text
            x={RIGHT + 4} y={20} fill={SOFT} stroke="none"
            style={{ font: '700 7px var(--ws-font-mono, ui-monospace, Menlo, Consolas, monospace)' }}
          >Cl</text>
          <line x1={RIGHT + 3} y1={21} x2={RIGHT + 14} y2={14} {...ink('media', SOFT)} />
        </g>
      )}

      <Nozzle x={C.x - 12} y={10} dir="right" len={12} color={INK} />
      <Nozzle x={RIGHT} y={BED_BOT + 4} dir="right" len={12} color={INK} />
      {backwash > 0 && <Nozzle x={C.x + C.w / 2} y={C.top} dir="up" len={7} color={WATCH} />}

      <title>
        {hasResults
          ? `${m.media_label || 'Pressure filter'} — ${removal.toFixed(0)} % TSS removal`
            + (hlr != null ? ` at ${hlr.toFixed(1)} m/h` : '')
            + (overloaded ? `, derated to ${derate.toFixed(0)} % of clean-bed by overloading` : '')
            + (backwash > 0 ? `. Backwash ${backwash.toFixed(1)} m³/d.` : '.')
          : 'Pressure filter — no results yet.'}
      </title>
    </g>
  );
}

registerSymbol('multigrade_filter', PressureFilterSymbol);
registerSymbol('activated_carbon_filter', PressureFilterSymbol);
registerSymbol('micron_filter', PressureFilterSymbol);

export default PressureFilterSymbol;
