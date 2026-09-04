/**
 * #17 `sand_filter` — granular media filter   (spec §3.2 #17, §5.3 #11)
 * ─────────────────────────────────────────────────────────────────────────────
 * THE ONE GENUINELY SIMULATED RISING LEVEL IN THE ENGINE, and therefore the
 * showpiece of the whole animation catalogue.
 *
 * `granularFilter.js` computes all three head terms from Kozeny-Carman and the
 * influent solids load:
 *
 *     h_clean_bed_m  = kozenyCarman(anthracite) + kozenyCarman(sand)   (:131)
 *     TSS_load_kg_m2 = (inf.TSS/1000) x Q_m3_h x backwash_interval_h / area  (:135)
 *     h_clogged_m    = h_clean + 0.4 x TSS_load_kg_m2                  (:138)
 *     backwash_needed = h_clogged > h_limit_m                          (:139)
 *
 * `h_clogged_m` tracks INFLUENT TSS, so raising the solids reaching this filter
 * genuinely raises the water surface above the media. That is acceptance check
 * #3 in the spec and it is the one place on this canvas where a rising level is
 * not a lie.
 *
 * ── DRIVERS ──────────────────────────────────────────────────────────────────
 *   clog  = clamp((h_clogged_m - h_clean_bed_m) / max(h_limit_m - h_clean_bed_m,
 *           1e-6), 0, 1)                                     A — plant-driven
 *           -> freeboard `translateY`, a 420ms TRANSITION (never a loop, never
 *              the `height` attribute)
 *   shade = 0.15 + 0.4 x clamp(TSS_load_kg_m2/4, 0, 1)       A — STATIC encoder
 *           -> media bed tone
 *   backwash_needed === true                                 A — state
 *           -> amber watch ring + the internal pulses REVERSE and run upward at
 *              a FIXED 1.6s (`ws-flow` with a negative direction, i.e. the
 *              shared `.ws-pulse--rev` class — no new keyframe)
 *   filter_type (categorical)                                -> anthracite cap
 *
 * `HLR_m_h` is a VERBATIM ECHO of the parameter (granularFilter.js:204) and is
 * therefore never allowed to drive a rate or anything else here.
 *
 * Idle / no results -> clean-bed level, no band, no motion, empty outline.
 */

import { registerSymbol } from './index';
import { DEF_IDS, paint } from './defs';
import { Shell, Nozzle, GEO, ink, clamp } from './primitives';
import { getNodeSnapshot, num } from '../liveStore';

// ── Tokens ───────────────────────────────────────────────────────────────────
const INK = 'var(--ws-ink-700, #1E293B)';
const SOFT = 'var(--ws-ink-400, #94A3B8)';
const WATER = 'var(--ws-svc-water, #2E75B6)';
const OCHRE = 'var(--ws-svc-recycle, #B45309)';
const SAND = 'var(--ws-media-sand, #C9B79A)';
const CARBON = 'var(--ws-media-carbon, #3A3A3C)';
const WATCH = 'var(--ws-watch, #D97706)';
const ALARM = 'var(--ws-alarm, #DC2626)';

// ── Geometry (viewBox 0 0 144 60) ────────────────────────────────────────────
const SF = Object.freeze({
  x: GEO.rect.x, y: GEO.rect.y, w: GEO.rect.w, h: GEO.rect.h, // 30, 6, 84, 48
  inX: 31, inW: 82,          // interior, inset by half a shell stroke
  limitY: 12,                // red maximum-headloss hairline
  cleanY: 31,                // water surface over a CLEAN bed
  bedTop: 34,
  bedBot: 50,
  drainY: 52,
  floorY: 54,
});
/** The full simulated travel of the water surface, in viewBox px. */
const TRAVEL = SF.cleanY - SF.limitY;            // 19
const ROW = (SF.bedBot - SF.bedTop) / 3;         // 3-row stippled bed

/** Fixed backwash cadence. Not a rate — backwash is a STATE, so it gets one
 *  fixed period, exactly like the 1.0s alarm cadence. */
const BACKWASH_PERIOD = '1.60s';
const PULSE_X = [56, 72, 88];

/** SVG ids must be unique per instance; ReactFlow ids are sanitised into one. */
const uid = (id) => String(id ?? '').replace(/[^A-Za-z0-9_-]/g, '') || 'x';

export function SandFilterSymbol({ nodeId, state, snap }) {
  const s = snap || getNodeSnapshot(nodeId);
  const m = s?.metrics || {};
  const err = !!m.error || state === 'error';
  const motion = !!s?.live && !err && state !== 'off';
  const bowl = `wsFltBowl_${uid(nodeId)}`;

  // ── The genuinely simulated level ──────────────────────────────────────────
  const hClean = num(m.h_clean_bed_m);
  const hClog = num(m.h_clogged_m);
  const hLimit = num(m.h_limit_m);

  // Spec §5.3 #11 verbatim. `max(..., 1e-6)` is the spec's own guard, so a
  // limit at or below the clean-bed loss pins the surface to the top rather
  // than dividing by zero.
  const clog = (hClean != null && hClog != null && hLimit != null)
    ? clamp((hClog - hClean) / Math.max(hLimit - hClean, 1e-6), 0, 1)
    : null;

  // A null clog is the REST POSE (clean bed), never 0-as-a-number-we-invented.
  const drop = TRAVEL * (1 - (clog ?? 0));
  // Liquid is drawn only when the engine actually produced a level for it
  // (§2.4: "no results -> empty outline").
  const hasLevel = hClog != null;

  // ── Static encoders ───────────────────────────────────────────────────────
  const load = num(m.TSS_load_kg_m2);
  const shade = 0.15 + 0.4 * clamp((load ?? 0) / 4, 0, 1);
  const dual = m.filter_type === 'dual_media';
  const backwash = m.backwash_needed === true;

  return (
    <g aria-hidden="true" data-symbol="sand_filter">
      <Shell.Rect clipId={bowl} rx={2} />

      {/* ── Freeboard: the one honest rising level ──────────────────────────
          `translateY` on an anchored group (420ms via `.ws-freeboard`), never
          a geometry attribute. The body runs past the bed top so that at the
          clean-bed pose it is still continuous under the media. */}
      {hasLevel && (
        <g clipPath={`url(#${bowl})`}>
          <g
            className="ws-freeboard ws-origin-b"
            data-clog={clog == null ? '' : clog.toFixed(3)}
            style={{
              transformBox: 'fill-box',
              transformOrigin: '50% 100%',
              transform: `translateY(${drop.toFixed(2)}px)`,
            }}
          >
            <rect
              x={SF.inX} y={SF.limitY} width={SF.inW} height={SF.drainY - SF.limitY}
              fill={WATER} opacity={0.3}
            />
            {/* Solid surface line — a number backs this one (§3.3). */}
            <line
              className="ws-surface"
              x1={SF.inX} y1={SF.limitY} x2={SF.inX + SF.inW} y2={SF.limitY}
              {...ink('detail', WATER)}
            />
          </g>
        </g>
      )}

      {/* ── Media bed: 3 stippled rows, drawn OVER the liquid ───────────────── */}
      <g className="ws-media" clipPath={`url(#${bowl})`}>
        <rect x={SF.inX} y={SF.bedTop} width={SF.inW} height={SF.bedBot - SF.bedTop} fill={SAND} opacity={shade} />
        {dual && (
          <rect x={SF.inX} y={SF.bedTop} width={SF.inW} height={ROW} fill={CARBON} opacity={shade * 0.45} />
        )}
        <rect
          x={SF.inX} y={SF.bedTop} width={SF.inW} height={SF.bedBot - SF.bedTop}
          fill={paint(DEF_IDS.stippleSand)}
        />
        <line x1={SF.inX} y1={SF.bedTop + ROW} x2={SF.inX + SF.inW} y2={SF.bedTop + ROW} {...ink('media', SOFT)} opacity={0.7} />
        <line x1={SF.inX} y1={SF.bedTop + 2 * ROW} x2={SF.inX + SF.inW} y2={SF.bedTop + 2 * ROW} {...ink('media', SOFT)} opacity={0.7} />
        <line x1={SF.inX} y1={SF.bedTop} x2={SF.inX + SF.inW} y2={SF.bedTop} {...ink('detail', SOFT)} />
      </g>

      {/* ── Backwash pulses: mounted ONLY while the model says backwash is due.
          Drawn top -> bottom (the service direction) and reversed by
          `.ws-pulse--rev`, so they literally run UPWARD through the bed —
          "ws-flow with a negative direction", no new keyframe. ─────────────── */}
      {motion && backwash && PULSE_X.map((px) => (
        <line
          key={px}
          className="ws-anim ws-pulse ws-pulse--rev ws-detail"
          x1={px} y1={SF.bedTop - 18} x2={px} y2={SF.bedBot}
          style={{ '--ws-flow': BACKWASH_PERIOD }}
          {...ink('detail', OCHRE)}
        />
      ))}

      {/* ── Underdrain + backwash direction arrow ───────────────────────────── */}
      <g className="ws-internals">
        <line x1={SF.inX + 5} y1={SF.drainY} x2={SF.inX + SF.inW - 5} y2={SF.drainY} {...ink('detail', SOFT)} />
        {[0, 1, 2, 3, 4].map((i) => {
          const px = SF.inX + 12 + i * 14;
          return <line key={i} x1={px} y1={SF.drainY} x2={px} y2={SF.floorY} {...ink('media', SOFT)} />;
        })}
        <path
          d={`M 40 ${SF.bedBot - 1} L 40 ${SF.bedTop + 2} M 37 ${SF.bedTop + 5} L 40 ${SF.bedTop + 2} L 43 ${SF.bedTop + 5}`}
          {...ink('media', backwash ? WATCH : SOFT)}
        />
      </g>

      {/* ── The red limit hairline: the thing the rise is READ AGAINST ─────── */}
      {hLimit != null && (
        <line
          className="ws-limit"
          x1={SF.inX} y1={SF.limitY} x2={SF.inX + SF.inW} y2={SF.limitY}
          {...ink('media', ALARM)}
          opacity={0.9}
        />
      )}

      {/* ── Ports: the model returns `filtrate` and `backwash`, so exactly two
             outlets — never an `effluent` stub it does not produce. ───────── */}
      <Nozzle x={SF.x - 6} y={16} dir="right" color={INK} />
      <Nozzle x={SF.x + SF.w} y={14} dir="right" color={OCHRE} className="ws-port-backwash" />
      <Nozzle x={SF.x + SF.w} y={48} dir="right" color={WATER} className="ws-port-filtrate" />

      {/* ── Watch ring: static, never blinks (§2.4). ────────────────────────── */}
      {backwash && (
        <rect
          className="ws-ring ws-ring--watch"
          data-ring="watch"
          x={SF.x - 2} y={SF.y - 2} width={SF.w + 4} height={SF.h + 4} rx={3}
          {...ink('detail', WATCH)}
        />
      )}

      <title>
        {hasLevel
          ? `Granular filter — head loss ${hClog} m of ${hLimit ?? '?'} m limit${backwash ? '; backwash due' : ''}`
          : 'Granular filter — no results'}
      </title>
    </g>
  );
}

registerSymbol('sand_filter', SandFilterSymbol);
// Legacy alias carried on imported / seeded sheets (spec §3.2). Registering it
// explicitly means `hasSymbol('granular_filter')` is true, not merely aliased.
registerSymbol('granular_filter', SandFilterSymbol);

export default SandFilterSymbol;
