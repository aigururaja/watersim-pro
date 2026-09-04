/**
 * StreamEdge — the process line (spec §4, §5.3 #1)
 * ─────────────────────────────────────────────────────────────────────────────
 * Extracted from the inline component that lived in CanvasPage.jsx.
 *
 * ── WHAT IS DELIBERATELY UNCHANGED ───────────────────────────────────────────
 * · `getStraightPath`. Switching to smoothstep would RE-ROUTE EVERY SAVED
 *   FLOWSHEET; straight runs are the P&ID convention and are what today's
 *   sheets were laid out against.
 * · ONE `useStore` subscription per edge — the same count as before. It now
 *   returns `{ zoom, srcOp }` behind an explicit equality function instead of a
 *   bare number, because `serviceOf()` needs the source node's op type and a
 *   second subscription would double the ~45 the sheet already carries.
 *   Consolidating those is explicitly out of scope.
 * · The `zoom >= 0.55` label gate, exactly.
 * · The ▲/▼ `streamDelta` badge, its `>= 0.5` deadband and its `#B45309` up /
 *   `#0E7490` down colours, verbatim.
 * The dead `const streamType = data?.streamType || 'stream'` is deleted; the
 * recycle test still reads `data.streamType !== 'stream'`.
 *
 * ── THREE PATHS ON THE SAME `d` (§4.2) ───────────────────────────────────────
 *   1. CASING  — paper-coloured, core + 3, so crossings read as over/under.
 *   2. CORE    — the service colour and dash. Its width is STATIC:
 *                `1.5 + 2.5·sqrt(Q/Qref)` clamped 1.5–4.0. This is the most
 *                valuable NON-animated change in the spec — the hydraulic
 *                profile becomes legible in a screenshot.
 *   3. PULSE   — the animated dash layer. Mounted ONLY in live view, only when
 *                `Q >= 0.5`, and only above zoom 0.35 where a 14px dash is not
 *                already sub-pixel.
 *
 * ── THE DEAD LINE ────────────────────────────────────────────────────────────
 * `Q` null or `< 0.5` → the core collapses to 1px `--ws-svc-dead` with dasharray
 * `2 4`, the casing is dropped and no pulse is mounted. A closed valve visibly
 * kills the pipe below it IN A STILL FRAME (acceptance check #4).
 *
 * ── RECYCLE RUNS BACKWARDS ───────────────────────────────────────────────────
 * A recycle line's pulses travel TARGET → SOURCE via `.ws-pulse--rev`
 * (`animation-direction: reverse`), so the RAS visibly runs backwards into the
 * aeration basin (acceptance check #16), plus a backward ISA triangle at
 * midspan for the still frame.
 */

import React, { useCallback, useRef } from 'react';
import {
  useStore, EdgeLabelRenderer, BaseEdge, getStraightPath,
} from 'reactflow';
import {
  num, drive, bucket, secs, resolveType, useLiveEdge, DOSING_TYPES,
} from './liveStore';

const DOSING = new Set(DOSING_TYPES);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const cxs = (...p) => p.filter(Boolean).join(' ');

// ═══════════════════════════════════════════════════════════════════════════
// §4.3 SERVICE CLASSES — colour AND dash pattern, so greyscale print and
// colour-vision deficiency both survive.
// ═══════════════════════════════════════════════════════════════════════════

export const SERVICES = Object.freeze({
  water:    { color: 'var(--ws-svc-water, #2E75B6)',    dash: null,      cap: 'butt',  label: 'Process water' },
  recycle:  { color: 'var(--ws-svc-recycle, #B45309)',  dash: null,      cap: 'butt',  label: 'Recycle / RAS' },
  sludge:   { color: 'var(--ws-svc-sludge, #78350F)',   dash: '10 4',    cap: 'butt',  label: 'Sludge' },
  air:      { color: 'var(--ws-svc-air, #0891B2)',      dash: '1 4',     cap: 'round', label: 'Air' },
  chemical: { color: 'var(--ws-svc-chem, #7C3AED)',     dash: '6 2 1 2', cap: 'butt',  label: 'Chemical' },
  permeate: { color: 'var(--ws-svc-permeate, #0D9488)', dash: null,      cap: 'butt',  label: 'Permeate' },
  dead:     { color: 'var(--ws-svc-dead, #94A3B8)',     dash: '2 4',     cap: 'butt',  label: 'Not simulated' },
});

/**
 * Classify a stream. Precedence, exactly as §4.3 states it:
 *
 *   recycle > air > chemical > sludge > permeate > water
 *
 * @param {object|null} data          edge.data
 * @param {object|null} stream        the Stream JSON for this edge
 * @param {string|null} sourceOpType  the SOURCE node's palette type
 * @returns {keyof SERVICES}
 */
export function serviceOf(data, stream, sourceOpType) {
  if (data?.isRecycle || (data?.streamType && data.streamType !== 'stream')) return 'recycle';

  const src = resolveType(sourceOpType);
  if (src === 'blower') return 'air';
  if (src && DOSING.has(src)) return 'chemical';

  const tss = num(stream?.TSS);
  if (tss != null && tss > 3000) return 'sludge';
  if ((src === 'ro_membrane' || src === 'uf_membrane') && tss != null && tss < 5) return 'permeate';
  return 'water';
}

// ═══════════════════════════════════════════════════════════════════════════
// §5.3 #1 — the pulse
// ═══════════════════════════════════════════════════════════════════════════

/** The seven periods the pulse may run at. Bucketed with 15% hysteresis so a
 *  jittering Q cannot retime — and therefore phase-jump — the dash every tick. */
export const PULSE_PERIODS = Object.freeze([0.55, 0.8, 1.2, 1.8, 2.6, 3.5, 4.5]);

/** A line below this carries no meaningful flow and is drawn DEAD. */
export const DEAD_Q = 0.5;

/** Below this zoom a 14px dash is sub-pixel: pulses are gated off entirely. */
export const PULSE_MIN_ZOOM = 0.35;

/**
 * `P = clamp(2.2 / max(v, 0.02), 0.55, 4.5)s`, then snapped to `PULSE_PERIODS`.
 * The snap runs through the shared `bucket()` helper so it inherits the same
 * 15% hysteresis every other rate on this canvas uses.
 *
 * @param {number|null} v      `drive(Q, 0, Qref)`
 * @param {number} [prevIdx]   the bucket currently in use
 * @returns {{dur:string, idx:number}|null}
 */
export function pulsePeriod(v, prevIdx) {
  if (v == null) return null;
  const lo = PULSE_PERIODS[0];
  const hi = PULSE_PERIODS[PULSE_PERIODS.length - 1];
  const p = clamp(2.2 / Math.max(v, 0.02), lo, hi);
  const idx = bucket((p - lo) / (hi - lo), PULSE_PERIODS.length, prevIdx);
  return { dur: secs(PULSE_PERIODS[idx]), idx };
}

/** STATIC core width — the hydraulic profile, legible with motion off. */
export const coreWidth = (v) => clamp(1.5 + 2.5 * Math.sqrt(v ?? 0), 1.5, 4);

// ═══════════════════════════════════════════════════════════════════════════
// The component
// ═══════════════════════════════════════════════════════════════════════════

const fmtQ = (q) => Number(q).toLocaleString('en-US', { maximumFractionDigits: 0 });

const StreamEdge = React.memo(function StreamEdge({
  id, source, sourceX, sourceY, targetX, targetY, data, style = {}, markerEnd, selected,
}) {
  // ONE subscription per edge — the zoom for the label gate plus the source
  // node's op type for `serviceOf`. The equality function keeps this from
  // firing on anything else in ReactFlow's store.
  const selector = useCallback(
    (s) => ({ zoom: s.transform[2], srcOp: s.nodeInternals.get(source)?.data?.opType ?? null }),
    [source]
  );
  const { zoom, srcOp } = useStore(
    selector,
    (a, b) => a.zoom === b.zoom && a.srcOp === b.srcOp
  );

  // The live frame for THIS edge. Falls back to the value already parked on
  // `edge.data` by `applyStreamResults`, so a manual run with Live off still
  // renders every static encoder (§6.1 — values always, motion only live).
  const snap = useLiveEdge(id);
  const pulseBucket = useRef(undefined);

  const [edgePath, labelX, labelY] = getStraightPath({ sourceX, sourceY, targetX, targetY });

  const stream = snap.stream || data?.streamResult || null;
  const isRecycle = !!(data?.isRecycle || (data?.streamType && data.streamType !== 'stream'));
  // Live-mode change indicator: Q delta vs the previous simulation
  const delta = typeof data?.streamDelta === 'number' ? data.streamDelta : null;

  const Q = num(stream?.Q);
  const dead = Q == null || Q < DEAD_Q;

  const svcKey = dead ? 'dead' : serviceOf(data, stream, srcOp);
  const svc = SERVICES[svcKey];

  const Qref = num(snap.refs?.Qref) ?? 1;
  const v = dead ? null : drive(Q, 0, Qref);

  const width = dead ? 1 : coreWidth(v);
  const period = dead ? null : pulsePeriod(v, pulseBucket.current);
  if (period) pulseBucket.current = period.idx;

  // EXISTENCE gate (§6.3b): a pulse path is not MOUNTED unless it has a rate to
  // show, the sheet is live, and the dash is bigger than a pixel. Zero layers
  // when idle — which is also what re-arms it cleanly on the way back in.
  const pulsing = !dead && !!snap.live && !!period && zoom >= PULSE_MIN_ZOOM;

  const coreColor = selected ? 'var(--ws-brand-900, #1F4E79)' : svc.color;

  const label = stream
    ? isRecycle
      ? `RAS: ${fmtQ(stream.Q)} m³/d`
      : `Q: ${fmtQ(stream.Q)} m³/d`
    : null;

  return (
    <>
      {/* 1. CASING — dropped on a dead line, which is what makes a killed pipe
             read as thinner AND flatter than a live one. */}
      {!dead && (
        <path
          className="ws-edge__casing"
          d={edgePath}
          fill="none"
          stroke="var(--ws-paper, #F7F8FA)"
          strokeWidth={width + 3}
          strokeLinecap="round"
          pointerEvents="none"
        />
      )}

      {/* 2. CORE — BaseEdge also supplies ReactFlow's hit area (the
             `react-flow__edge-interaction` path), so selection, click and
             delete keep working exactly as before. */}
      <BaseEdge
        id={id}
        path={edgePath}
        markerEnd={markerEnd}
        style={{
          stroke: coreColor,
          strokeWidth: selected ? width + 1 : width,
          strokeDasharray: dead ? SERVICES.dead.dash : (svc.dash || undefined),
          strokeLinecap: svc.cap,
          ...style,
        }}
      />

      {/* Backward ISA triangle at midspan: the recycle direction survives a
          still frame, a print and a reduced-motion session. */}
      {isRecycle && !dead && zoom >= 0.55 && (
        <path
          className="ws-edge__arrow"
          d={arrowAt(sourceX, sourceY, targetX, targetY)}
          fill={coreColor}
          stroke="none"
          pointerEvents="none"
        />
      )}

      {/* 3. PULSE — `stroke-dasharray: 14 120` and the -134px offset live in
             canvas-motion.css so the period and the pattern can never disagree.
             `ws-anim` is what the `.ws-live` play-state gate acts on. */}
      {pulsing && (
        <path
          className={cxs('ws-anim', 'ws-pulse', isRecycle && 'ws-pulse--rev')}
          d={edgePath}
          fill="none"
          stroke={svc.color}
          strokeWidth={Math.max(1.5, width - 0.5)}
          strokeLinecap="round"
          opacity={0.35 + 0.5 * (v ?? 0)}
          pointerEvents="none"
          style={{ '--ws-flow': period.dur }}
          data-flow-dur={period.dur}
        />
      )}

      {/* Drafting flow tag. The zoom gate is preserved EXACTLY. */}
      {label && zoom >= 0.55 && (
        <EdgeLabelRenderer>
          <div
            style={{
              position: 'absolute',
              transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)`,
              background: 'var(--ws-card, #FFFFFF)',
              border: '1px solid var(--ws-ink-200, #E2E8F0)',
              borderLeft: `2px solid ${svc.color}`,
              borderRadius: 'var(--ws-r-chip, 2px)',
              padding: '0 5px',
              lineHeight: '15px',
              fontFamily: "var(--ws-font-mono, ui-monospace, Menlo, Consolas, monospace)",
              fontVariantNumeric: 'var(--ws-num-variant, tabular-nums lining-nums)',
              fontSize: 'var(--ws-fs-edge, 9.5px)',
              fontWeight: 'var(--ws-fw-edge, 600)',
              color: 'var(--ws-ink-700, #1E293B)',
              pointerEvents: 'none',
              whiteSpace: 'nowrap',
            }}
            className="nodrag nopan"
          >
            {tagParts(label)}
            {delta !== null && (
              <span
                key={delta}
                className="ws-stamp"
                style={{
                  marginLeft: 5,
                  display: 'inline-block',
                  fontWeight: 700,
                  color: delta > 0 ? '#B45309' : '#0E7490',
                  '--ws-dur-stamp': '260ms',
                }}
              >
                {delta > 0 ? '▲' : '▼'}{Math.abs(delta) >= 10 ? Math.round(Math.abs(delta)) : Math.abs(delta).toFixed(1)}
              </span>
            )}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
});

/**
 * Split `Q: 12,400 m³/d` so the magnitude dominates and the unit is demoted to
 * 0.85em `--ws-ink-400` (§1.2). Falls back to the plain string if the shape
 * ever changes, so the tag can never disappear.
 */
function tagParts(label) {
  const i = label.indexOf(' m³/d');
  if (i < 0) return label;
  return (
    <>
      {label.slice(0, i)}
      <span style={{ fontSize: 'var(--ws-fs-unit, 0.85em)', color: 'var(--ws-ink-400, #94A3B8)' }}>
        {label.slice(i)}
      </span>
    </>
  );
}

/** A 5px ISA triangle at midspan, pointing back toward the SOURCE. */
function arrowAt(sx, sy, tx, ty) {
  const mx = (sx + tx) / 2;
  const my = (sy + ty) / 2;
  const dx = sx - tx;
  const dy = sy - ty;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const px = -uy;
  const py = ux;
  const tip = [mx + ux * 5, my + uy * 5];
  const a = [mx - ux * 2 + px * 3.5, my - uy * 2 + py * 3.5];
  const b = [mx - ux * 2 - px * 3.5, my - uy * 2 - py * 3.5];
  return `M ${tip[0]} ${tip[1]} L ${a[0]} ${a[1]} L ${b[0]} ${b[1]} Z`;
}

export default StreamEdge;
