/**
 * anaerobic_digester — §3.2 #14, §5.3 #15
 * ─────────────────────────────────────────────────────────────────────────────
 * Tall cylinder, floating-cover trapezoid cap, gas dome above the liquid,
 * central draft tube + stirrer paddle, sludge in/out nozzles, gas take-off
 * elbow top-right.
 *
 * ── THE REFUSAL, SHIPPED ─────────────────────────────────────────────────────
 * THE FLOATING COVER DOES NOT MOVE.
 *
 * `biogas.volume_m3_d` is a PRODUCTION RATE (m³/d), not a stored volume. A
 * gasholder cover rises and falls with the gas INVENTORY, and this engine holds
 * no inventory: `anaerobicDigester.js` is a steady-state snapshot with no
 * accumulation term, and `dynamicSolver.js` runs independent snapshots whose
 * results never reach the canvas. Animating the cover from a production rate
 * would manufacture a state variable out of a flow and dress it as a
 * measurement — a lie shaped exactly like a level.
 *
 * So the cover is drawn static, carries no animation class and no duration
 * custom property at any gas rate, and the ⓘ copy ships verbatim:
 *
 *   "Gas production is a rate, not a stored volume, so the gasholder cover does
 *    not move. Production is shown by the bubbles, the take-off pulses and the
 *    readout."
 *
 * The test suite asserts the absence, not just the presence.
 *
 * ── WHAT DOES MOVE ───────────────────────────────────────────────────────────
 * `g = drive(biogas.volume_m3_d, 0, gasRef)` — note `biogas` lives OUTSIDE
 * `metrics`, directly on the snapshot (anaerobicDigester.js:248, and
 * liveStore's `gasRef` reads `u.biogas?.volume_m3_d` for the same reason).
 * It is computed from the COD destroyed, so it is Class A.
 *
 *   bubbles      `P = clamp(4.6 − 3.4·g, 1.2, 5.0)s`
 *   draft mixer  `P = clamp(4.0 − 2.8·g, 1.2, 4.0)s`
 *   take-off     pulses at the bubble period
 *
 * `stable === false` → amber ring and the mixer runs 2.5x slower (a sour
 * digester is mixed, not stirred). `pH_out < 6.6` → red.
 *
 * Three animations, ZERO new keyframes: `ws-bubble`, `ws-spin`, `ws-flow`.
 * `CH4_pct` is `p.biogas_CH4_frac·100` — a verbatim echo, printed in the
 * footer readout by Phase F and never used to time anything here.
 */

import { drive, num, secs, useLiveNode } from '../liveStore';
import { registerSymbol } from './index';
import { Bubbles, Fill, Nozzle, Rotor, Shell, clamp, ink } from './primitives';
import {
  bucketCentre, hasValues, isInert, primeDelayOf, useBucketed, useUid,
} from './activated_sludge';

const EMPTY = Object.freeze({});

// ═══════════════════════════════════════════════════════════════════════════
// GEOMETRY
// ═══════════════════════════════════════════════════════════════════════════

const V = Object.freeze({ x: 46, w: 52, top: 6, bottom: 54, ry: 5 });
const CX = V.x + V.w / 2;                       // 72
const LEVEL = 0.72;                             // liquid; the rest is gas dome
const BODY_H = V.bottom - V.top;                // 48
const SURFACE = V.bottom - LEVEL * BODY_H;      // 19.44
const MIX_Y = 42;
const BUBBLE_FLOOR = 46;

const SLUDGE = 'var(--ws-svc-sludge, #78350F)';
const GAS = 'var(--ws-gas, #F0C24B)';
const SOFT = 'var(--ws-ink-400, #94A3B8)';
const WATCH = 'var(--ws-watch, #D97706)';
const ALARM = 'var(--ws-alarm, #DC2626)';

/** The gas take-off: cover crown → header → down-leg → port. */
const TAKEOFF_D = `M ${CX + 18} 7 L 110 7 L 110 18`;

/**
 * The floating cover.
 *
 * Deliberately a bare `<path>`: no className that any stylesheet animates, no
 * `style` object, and therefore no `--ws-*` duration to write. It is impossible
 * to make this element move without editing this line, which is the point.
 */
function FloatingCover() {
  return (
    <path
      data-ws="cover"
      d={`M ${V.x + 4} ${V.top + V.ry} L ${V.x + 12} ${V.top - 2} L ${V.x + V.w - 12} ${V.top - 2} L ${V.x + V.w - 4} ${V.top + V.ry}`}
      {...ink('detail', SOFT)}
    />
  );
}

/** Central draft tube — two verticals, the mixer sits inside the throat. */
function DraftTube() {
  return (
    <g className="ws-detail" data-ws="draft-tube" {...ink('detail', SOFT)}>
      <line x1={CX - 6} y1={SURFACE + 3} x2={CX - 6} y2={MIX_Y + 6} />
      <line x1={CX + 6} y1={SURFACE + 3} x2={CX + 6} y2={MIX_Y + 6} />
    </g>
  );
}

/** Four-blade stirrer on the draft-tube shaft. */
function Paddle() {
  return (
    <g data-ws="mixer" {...ink('detail', SOFT)}>
      <line x1={CX - 5.5} y1={MIX_Y} x2={CX + 5.5} y2={MIX_Y} />
      <line x1={CX} y1={MIX_Y - 5.5} x2={CX} y2={MIX_Y + 5.5} />
      <line x1={CX - 3.9} y1={MIX_Y - 3.9} x2={CX + 3.9} y2={MIX_Y + 3.9} />
      <line x1={CX - 3.9} y1={MIX_Y + 3.9} x2={CX + 3.9} y2={MIX_Y - 3.9} />
    </g>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// THE SYMBOL
// ═══════════════════════════════════════════════════════════════════════════

export default function AnaerobicDigesterSymbol(props) {
  const { nodeId, snap, state } = props;
  const liveSnap = useLiveNode(nodeId);
  const s = snap || liveSnap;
  const m = (s && s.metrics) || EMPTY;

  const uid = useUid('ad');
  const clipId = `${uid}-in`;

  const inert = isInert(s, state);
  const vals = hasValues(s);

  // ── #15 gas rate — `biogas` lives OUTSIDE `metrics` ──────────────────────
  const gasRef = num(s?.refs?.gasRef) ?? 1;
  const gasQ = num(s?.biogas?.volume_m3_d);
  const producing = gasQ != null && gasQ > 0;
  const g = producing ? drive(gasQ, 0, gasRef) : null;
  const gIdx = useBucketed(g, 5);
  const gC = bucketCentre(gIdx, 5);

  const stable = m.stable !== false;
  const pH = num(m.pH_out);
  const warn = (pH != null && pH < 6.6) ? 'alarm' : (m.stable === false ? 'watch' : null);

  const moving = !inert && g != null;
  const bubbleDur = moving ? secs(clamp(4.6 - 3.4 * gC, 1.2, 5.0)) : null;
  // A sour digester is mixed, not stirred: 2.5x slower, and still capped.
  const mixerBase = clamp(4.0 - 2.8 * gC, 1.2, 4.0);
  const mixerDur = moving ? secs(clamp(mixerBase * (stable ? 1 : 2.5), 1.2, 10)) : null;

  const pd = primeDelayOf(props);

  return (
    <g aria-hidden="true" data-ws-symbol="anaerobic_digester">
      <Shell.Cyl
        x={V.x} w={V.w} top={V.top} bottom={V.bottom} ry={V.ry} cap clipId={clipId}
      />

      {vals && (
        <>
          {/* Gas dome — the space above the liquid. Static: the engine holds no
              gas inventory, so nothing about it may be animated. */}
          <g clipPath={`url(#${clipId})`}>
            <rect
              data-ws="gas-dome"
              x={V.x} y={V.top} width={V.w} height={SURFACE - V.top}
              fill={GAS} opacity={0.22}
            />
          </g>
          <Fill
            x={V.x} y={V.top} w={V.w} h={BODY_H} level={LEVEL} clipId={clipId}
            color={SLUDGE} opacity={0.34} prime={!inert} primeDelay={pd}
          />
        </>
      )}

      <FloatingCover />
      <DraftTube />

      <Bubbles
        columns={producing ? 3 : 0} dur={bubbleDur}
        x0={CX - 17} gap={17} floorY={BUBBLE_FLOOR} perColumn={3} r={1.5}
        opacity={0.25 + 0.45 * (g ?? 0)} color={GAS} clipId={clipId}
      />

      <Rotor dur={mixerDur} channel="spin" parkedAt={12} origin={[CX, MIX_Y]}>
        <Paddle />
      </Rotor>

      {/* Gas take-off elbow: a static line that ALWAYS renders, plus a pulse
          overlay that is mounted only in live and vanishes under reduced
          motion — so the pipe never disappears, only its contents. */}
      <g className="ws-detail" data-ws="takeoff">
        <path d={TAKEOFF_D} {...ink('detail', SOFT)} />
        {moving && (
          <path
            className="ws-anim ws-pulse" data-ws="takeoff-pulse"
            style={{ '--ws-flow': bubbleDur }}
            d={TAKEOFF_D} {...ink('detail', GAS)}
          />
        )}
      </g>

      {warn && (
        <rect
          data-ws="warn" data-level={warn}
          x={V.x - 5} y={1} width={V.w + 10} height={57} rx={3}
          {...ink('detail', warn === 'alarm' ? ALARM : WATCH)}
        />
      )}

      {/* PORTS — sludge feed, digestate draw, biogas. */}
      <Nozzle x={V.x - 6} y={28} dir="right" color={SOFT} />
      <Nozzle x={CX} y={V.bottom} dir="down" len={5} color={SOFT} />
      <Nozzle x={110} y={18} dir="right" color={SOFT} />
    </g>
  );
}

registerSymbol('anaerobic_digester', AnaerobicDigesterSymbol);
