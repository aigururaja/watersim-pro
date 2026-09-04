/**
 * Aeration family — ONE implementation behind four palette types
 * (spec §3.2 #10–#13, §5.3 rows 2, 2b, 9, 10)
 * ─────────────────────────────────────────────────────────────────────────────
 *   activated_sludge      plain basin + floor diffuser header
 *   membrane_bioreactor   + a 3-line membrane leaf stack in the right third
 *   uct_reactor           3 zones, MLR arc landing on ZONE 2
 *   jhb_reactor           3 zones, RAS arc landing on ZONE 1
 *
 * The other three files import `AerationSymbol` from here and specialise it;
 * there is exactly one drawing and one driver table.
 *
 * ── THE DRIVERS, AND WHY THEY ARE THESE AND NOT THE OBVIOUS ONES ─────────────
 *
 * #2  BUBBLE COLUMNS — RATE, and it must be Class A.
 *     `aer = drive(O2_demand_kg_d / max(volume_m3, 1), 0.1, 2.0)` kg O₂/m³/d.
 *     The original proposal normalised against `volume_m3 x 0.06`, which is
 *     ~20x too low: a worked default gives ≈1.3 kg O₂/m³/d, so every basin on
 *     every sheet would have pinned at full bubbles and the animation would
 *     have carried no information at all. `O2_demand_kg_d` is computed from
 *     Q, dBOD, biomass yield and the nitrified NH4 (aerationBasin.js:102) —
 *     genuinely plant-driven, which is what makes it legal as a rate. Dividing
 *     by the basin volume makes the band scale-invariant, so a 500 m³ package
 *     plant and a 50 000 m³ works read on the same scale.
 *
 * #9  LIQUID DENSITY — STATIC, because `MLSS_mg_L` is a verbatim echo of the
 *     user's setpoint (aerationBasin.js:174, 281, 396). Legal as an opacity
 *     and an ochre shift; ILLEGAL as any kind of rate. The ⓘ copy says
 *     "Mixed-liquor density shows your MLSS setpoint, not a simulated solids
 *     concentration."  The LEVEL is fixed at 88% — an in-service basin is full
 *     to the weir, and pretending otherwise would invent a state variable.
 *
 * #9  SURFACE WAVE — RATE, from the vessel's own throughput (the sum of its
 *     computed output flows, which by water balance IS the inlet flow). No
 *     inlet flow → a FLAT surface line and no motion, never a slow wave.
 *
 * #10 PRIME — a one-shot VIEW TRANSITION on entering live view, not a filling
 *     simulation, re-armed by React MOUNTING the liquid group on `live`.
 */

import { useId, useRef } from 'react';
import { drive, bucket, num, secs, useLiveNode } from '../liveStore';
import { registerSymbol } from './index';
import { Bubbles, Fill, GEO, Nozzle, Shell, Wave, clamp, ink } from './primitives';

// ═══════════════════════════════════════════════════════════════════════════
// LANE-D SHARED HELPERS
// (the clarifier base and the digester import these — one implementation)
// ═══════════════════════════════════════════════════════════════════════════

const EMPTY = Object.freeze({});

/**
 * Bucket a 0..1 normal with 15% hysteresis, remembering the previous index in
 * a ref so a value jittering on a boundary does not retime — and therefore
 * PHASE-JUMP — the loop on every tick.
 *
 * `bucket()` is idempotent (`bucket(v, n, bucket(v, n, p)) === bucket(v, n, p)`)
 * so writing the ref during render is safe under StrictMode double-invocation.
 * No effect, no rAF, no interval.
 */
export function useBucketed(norm, steps) {
  const ref = useRef(0);
  const idx = bucket(norm, steps, ref.current);
  ref.current = idx;
  return idx;
}

/** A bucket is represented by its CENTRE, so a ladder is evenly spread. */
export const bucketCentre = (idx, steps) => (idx + 0.5) / steps;

/**
 * The flow through this vessel, in m³/d — the sum of its own computed output
 * streams, which by water balance is the inlet flow. This is the only
 * plant-driven flow a NodeSnapshot carries (it has no inbound edge), and every
 * output Q in the engine is computed, so it is Class A.
 *
 * @returns {number|null} null when the solver produced nothing (→ rest pose)
 */
export function throughputQ(snap) {
  const outs = snap?.outputs;
  if (!outs || typeof outs !== 'object') return null;
  let total = null;
  for (const k of Object.keys(outs)) {
    const q = num(outs[k]?.Q);
    if (q != null) total = (total ?? 0) + q;
  }
  return total;
}

/**
 * §5.3 #10 stagger: `--ws-x = clamp(0, node.position.x / 4, 400)`, consumed by
 * `animation-delay: calc(var(--ws-x) * 1ms)` so the head works primes first.
 * Zero when the host does not supply a position (palette rail, contact sheet).
 */
export function primeDelayOf(props) {
  const explicit = num(props?.primeDelay);
  if (explicit != null) return Math.round(clamp(explicit, 0, 400));
  const x = num(props?.position?.x);
  if (x == null) return 0;
  return Math.round(clamp(x / 4, 0, 400));
}

/** A DOM-safe unique suffix for this instance's clipPath ids. */
export function useUid(prefix) {
  return `${prefix}${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
}

/**
 * Surface-wave period (§5.3 #9): `P = clamp(3.2 / v, 1.6, 6)s`, bucketed to 5
 * steps. `v == null` or zero flow → null → a FLAT line and no motion, which is
 * the honest picture for a vessel with nothing coming in.
 */
export function useWaveDur(v) {
  const idx = useBucketed(v, 5);
  if (v == null || !(v > 0)) return null;
  return secs(clamp(3.2 / bucketCentre(idx, 5), 1.6, 6));
}

/** Motion is suppressed entirely when not live, or on a model throw. */
export function isInert(snap, state) {
  return !snap?.live || !!snap?.metrics?.error || state === 'error';
}

/** Values render whenever the solver produced some; otherwise: empty outline. */
export function hasValues(snap) {
  return !!snap?.hasResults && !snap?.metrics?.error;
}

// ═══════════════════════════════════════════════════════════════════════════
// GEOMETRY — one basin, four variants
// ═══════════════════════════════════════════════════════════════════════════

const B = GEO.rect;                    // x 30, y 6, w 84, h 48
const FLOOR = B.y + B.h;               // 54
const LEVEL = 0.88;                    // FIXED — full to the weir (§5.3 #9)
const SURFACE = FLOOR - LEVEL * B.h;   // 11.76
const HEADER_Y = 50;                   // floor diffuser header
const BUBBLE_FLOOR = 48;
const FREEBOARD_Y = 8.4;               // DASHED — the engine computes no freeboard

const WATER = 'var(--ws-svc-water, #2E75B6)';
const OCHRE = 'var(--ws-svc-recycle, #B45309)';
const AIR = 'var(--ws-svc-air, #0891B2)';
const SOFT = 'var(--ws-ink-400, #94A3B8)';

/** Which drawing each palette type gets. */
const VARIANT = Object.freeze({
  activated_sludge: 'plain',
  membrane_bioreactor: 'mbr',
  uct_reactor: 'uct',
  jhb_reactor: 'jhb',
});

const ZONED = (v) => v === 'uct' || v === 'jhb';

/**
 * §5.3 #2b zone geometry.
 *
 * `zone_volumes_m3` exists ONLY on the UCT / JHB solver paths
 * (aerationBasin.js:192, 300). A `uct_reactor` node whose params never set
 * `ebpr_config` runs the generic path, so we fall back to
 * `denitrification` / `anoxic_fraction`, and finally to the model's own
 * DEFAULTS so an idle basin still draws its zones (spec: "Idle → zones drawn,
 * nothing moves").
 *
 * JHB returns FOUR volumes (pre_anoxic | anaerobic | main_anoxic | aerobic) but
 * §3.2 #13 draws three zones at this size — 84px across four cells is illegible.
 * The pre-anoxic cell is folded into the head-end unaerated zone: neither is
 * aerated and both carry the same mixer sweep, so the drawing loses nothing.
 */
function zonesOf(m) {
  const zv = m?.zone_volumes_m3;
  let anaer = 0, anox = 0, aer = 0;
  if (zv && typeof zv === 'object') {
    anaer = (num(zv.anaerobic) ?? 0) + (num(zv.pre_anoxic) ?? 0);
    anox = (num(zv.anoxic) ?? 0) + (num(zv.main_anoxic) ?? 0);
    aer = num(zv.aerobic) ?? 0;
  }
  let total = anaer + anox + aer;
  if (!(total > 0)) {
    anaer = num(m?.anaerobic_fraction) ?? 0.15;
    anox = m?.denitrification === true
      ? (num(m?.anoxic_fraction) ?? 0.30)
      : (num(m?.anoxic_fraction) ?? 0.25);
    aer = Math.max(0.05, 1 - anaer - anox);
    total = anaer + anox + aer;
  }
  const a = clamp(anaer / total, 0.10, 0.45);
  const b = clamp(anox / total, 0.10, 0.45);
  return [
    { kind: 'anaerobic', f: a },
    { kind: 'anoxic', f: b },
    { kind: 'aerobic', f: Math.max(0.10, 1 - a - b) },
  ];
}

/** Zone x-extents in frame coordinates. */
function zoneBounds(zones) {
  const out = [];
  let x = B.x;
  for (const z of zones) {
    const w = B.w * z.f;
    out.push({ ...z, x, w });
    x += w;
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════
// INTERNALS
// ═══════════════════════════════════════════════════════════════════════════

/** Floor diffuser header — a horizontal line with 7 down-ticks (§3.2 #10). */
function Diffuser({ x, w, aerating }) {
  const ticks = [];
  for (let i = 0; i < 7; i++) {
    const tx = x + (w * (i + 0.5)) / 7;
    ticks.push(<line key={i} x1={tx} y1={HEADER_Y} x2={tx} y2={HEADER_Y + 3} />);
  }
  return (
    <g
      className="ws-detail"
      data-ws="diffuser"
      {...ink('detail', aerating ? AIR : SOFT)}
      opacity={aerating ? 1 : 0.45}
    >
      <line x1={x} y1={HEADER_Y} x2={x + w} y2={HEADER_Y} />
      {ticks}
    </g>
  );
}

/**
 * §5.3 #2b — the unaerated zones get NO bubbles. A slow horizontal mixer wash
 * instead, clipped to the zone.
 *
 * It reuses the `.ws-wave` shorthand (`ws-drift`: translateX 0 → -40px) with
 * the motif repeated at exactly the 40px keyframe pitch, so frame 100% is
 * identical to frame 0% and the reduced-motion snap-to-end leaves it in place.
 * ZERO new keyframes.
 *
 * The sweep RATE is fixed, not driven: the engine models no mixer, and there is
 * no Class-A quantity that is a mixing rate. A fixed cadence says "this zone is
 * mixed, not aerated" without inventing a number — the same choice the UV
 * breathe makes (§5.3 #13, "a powered indicator, not a rate").
 */
const MIX_PERIOD = 40;   // must match the -40px in @keyframes ws-drift
const MIX_DUR = '6.00s';

function MixerSweep({ x, w, clipId, moving }) {
  // Two copies are enough for a zone no wider than one 40px period: when the
  // group has travelled the full -40px, copy 1 is exactly where copy 0 was.
  const strokes = [];
  const reps = Math.ceil(w / MIX_PERIOD) + 1;
  for (let r = 0; r < reps; r++) {
    const ox = x + r * MIX_PERIOD;
    strokes.push(
      <g key={r}>
        <line x1={ox + 4} y1={34} x2={ox + 16} y2={34} />
        <line x1={ox + 9} y1={39} x2={ox + 23} y2={39} />
        <line x1={ox + 2} y1={44} x2={ox + 13} y2={44} />
      </g>,
    );
  }
  return (
    <g clipPath={clipId ? `url(#${clipId})` : undefined}>
      <g
        className={[moving && 'ws-anim', 'ws-wave', 'ws-detail'].filter(Boolean).join(' ')}
        data-ws="mixer"
        style={moving ? { '--ws-drift': MIX_DUR } : undefined}
        {...ink('media', SOFT)}
        opacity={0.85}
      >
        {strokes}
      </g>
    </g>
  );
}

/** UCT / JHB: 2 baffles with 8px floor gaps, plus the zone clips. */
function Zones({ bounds, uid, moving }) {
  return (
    <>
      <defs>
        {bounds.map((z, i) => (
          <clipPath key={i} id={`${uid}-z${i}`}>
            <rect x={z.x} y={B.y} width={z.w} height={B.h} />
          </clipPath>
        ))}
      </defs>
      {bounds.slice(0, -1).map((z, i) => (
        <line
          key={i}
          className="ws-detail"
          data-ws="baffle"
          x1={z.x + z.w} y1={B.y + 2} x2={z.x + z.w} y2={FLOOR - 8}
          {...ink('detail', SOFT)}
        />
      ))}
      {bounds.map((z, i) => (
        z.kind === 'aerobic' ? null : (
          <MixerSweep key={i} x={z.x} w={z.w} clipId={`${uid}-z${i}`} moving={moving} />
        )
      ))}
    </>
  );
}

/** MBR only — a 3-line membrane leaf stack in the right third (§3.2 #11). */
function LeafStack() {
  const xs = [93, 99, 105];
  return (
    <g className="ws-detail" data-ws="leaves" {...ink('detail', SOFT)}>
      <line x1={91} y1={17} x2={107} y2={17} />
      {xs.map((x) => <line key={x} x1={x} y1={17} x2={x} y2={46} />)}
    </g>
  );
}

/**
 * Mixed-liquor recycle arc over the top of the basin.
 * UCT lands on ZONE 2 (the anoxic cell); JHB comes off the RAS line at the
 * frame edge and lands on ZONE 1. That is the only thing that tells the two
 * apart at a glance, and it is exactly the process difference.
 */
function RecycleArc({ variant, bounds }) {
  const target = variant === 'jhb' ? bounds[0] : bounds[1];
  const tx = target.x + target.w / 2;
  const sx = variant === 'jhb' ? 126 : bounds[2].x + bounds[2].w / 2;
  return (
    <g className="ws-detail" data-ws="recycle-arc" {...ink('detail', OCHRE)}>
      <path d={`M ${sx} 5 C ${sx} 0, ${tx} 0, ${tx} 5`} />
      <path d={`M ${tx - 2.5} 2.6 L ${tx} 5.4 L ${tx + 2.5} 2.6`} />
    </g>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// THE SYMBOL
// ═══════════════════════════════════════════════════════════════════════════

/**
 * @param {object}  props
 * @param {string}  props.nodeId    ReactFlow node id (read from liveStore)
 * @param {string}  props.opType    resolved palette type
 * @param {object}  [props.snap]    a pre-read NodeSnapshot (Phase F supplies it)
 * @param {string}  [props.state]   'rest' | 'watch' | 'alarm' | 'error' | …
 * @param {number}  [props.primeDelay]  ms; else derived from `position.x / 4`
 */
export function AerationSymbol(props) {
  const { nodeId, opType, snap, state, variant } = props;
  const liveSnap = useLiveNode(nodeId);
  const s = snap || liveSnap;
  const m = (s && s.metrics) || EMPTY;

  const kind = variant || VARIANT[opType] || 'plain';
  const uid = useUid('as');
  const clipId = `${uid}-in`;

  const inert = isInert(s, state);
  const vals = hasValues(s);

  // ── #2 aeration intensity — Class A, scale-invariant ──────────────────────
  const o2 = num(m.O2_demand_kg_d);
  const vol = Math.max(num(m.volume_m3) ?? 0, 1);
  // "null or < 1 kg/d" is NOT aerating: no bubbles mounted at all, header grey.
  const aerating = o2 != null && o2 >= 1;
  const aer = aerating ? drive(o2 / vol, 0.1, 2.0) : null;
  const aerIdx = useBucketed(aer, 5);

  // ── #9 surface wave — Class A (throughput), bucketed to 5 ─────────────────
  const qref = num(s?.refs?.Qref) ?? 1;
  const v = drive(throughputQ(s), 0, qref);
  const waveDur = useWaveDur(v);

  // ── #9 density — STATIC, MLSS is a verbatim echo (labelled a setpoint) ────
  const mlssN = drive(m.MLSS_mg_L, 1500, 5000);
  const density = 0.30 + 0.55 * (mlssN ?? 0);
  const ochre = 0.28 * (mlssN ?? 0);

  const columns = aer == null ? 0 : (aer >= 0.45 ? 6 : aer >= 0.15 ? 4 : 2);
  const bubbleDur = (aer == null || inert)
    ? null
    : secs(clamp(2.6 - 1.7 * bucketCentre(aerIdx, 5), 0.9, 3.5));
  const bubbleOpacity = 0.25 + 0.45 * (aer ?? 0);
  // Cyan when the basin is nitrifying; otherwise plain grey air.
  const bubbleColor = m.nitrification === true ? AIR : SOFT;

  const zoned = ZONED(kind);
  const bounds = zoned ? zoneBounds(zonesOf(m)) : null;

  // Bubbles live in the AEROBIC zone only (§5.3 #2b); MBR keeps the right
  // third clear for the membrane leaves.
  let left = B.x + 8;
  let right = B.x + B.w - 8;
  if (zoned) {
    const aerobic = bounds[2];
    left = aerobic.x + 5;
    right = aerobic.x + aerobic.w - 5;
  } else if (kind === 'mbr') {
    right = B.x + B.w * 0.60;
  }
  const span = Math.max(0, right - left);
  const gap = columns > 1 ? span / (columns - 1) : 0;
  const x0 = columns > 1 ? left : (left + right) / 2;

  const amp = 1 + 2 * (v ?? 0) + (o2 != null && o2 > 0 ? 2 : 0);
  const prime = !inert && vals;
  const pd = primeDelayOf(props);

  return (
    <g aria-hidden="true" data-ws-symbol={kind}>
      <Shell.Rect clipId={clipId} />

      {/* FILL — level FIXED at 88%; only the DENSITY carries a value, and it
          is a setpoint encoder, never a rate. */}
      {vals && (
        <>
          <Fill
            x={B.x} y={B.y} w={B.w} h={B.h} level={LEVEL} clipId={clipId}
            color={WATER} opacity={density} prime={prime} primeDelay={pd}
          />
          {ochre > 0.01 && (
            <Fill
              x={B.x} y={B.y} w={B.w} h={B.h} level={LEVEL} clipId={clipId}
              color={OCHRE} opacity={ochre} surface={false}
              prime={prime} primeDelay={pd} className="ws-as-tint"
            />
          )}
          <Wave
            x={B.x} w={B.w} y={SURFACE} amp={amp}
            dur={inert ? null : waveDur} clipId={clipId} color={WATER} opacity={0.9}
          />
        </>
      )}

      {/* Freeboard — the engine computes no freeboard, so it is DASHED and it
          never moves (§3.3). */}
      <line
        className="ws-detail" data-ws="freeboard"
        x1={B.x + 3} y1={FREEBOARD_Y} x2={B.x + B.w - 3} y2={FREEBOARD_Y}
        {...ink('media', SOFT)} strokeDasharray="3 3" opacity={0.9}
      />

      {zoned && <Zones bounds={bounds} uid={uid} moving={!inert} />}
      {kind === 'mbr' && <LeafStack />}

      <Diffuser
        x={zoned ? bounds[2].x + 3 : B.x + 4}
        w={zoned ? bounds[2].w - 6 : B.w - 8}
        aerating={aerating}
      />

      <Bubbles
        columns={columns} dur={bubbleDur}
        x0={x0} gap={gap} floorY={BUBBLE_FLOOR} perColumn={3} r={1.6}
        opacity={bubbleOpacity} color={bubbleColor} clipId={clipId}
      />

      {zoned && <RecycleArc variant={kind} bounds={bounds} />}

      {/* PORTS — one stub per real output port of the model (effluent, WAS). */}
      <Nozzle x={B.x - 6} y={18} dir="right" color={SOFT} />
      <Nozzle x={B.x + B.w} y={18} dir="right" color={SOFT} />
      <Nozzle x={B.x + B.w - 12} y={FLOOR} dir="down" len={5} color={SOFT} />
    </g>
  );
}

export default function ActivatedSludgeSymbol(props) {
  return <AerationSymbol {...props} variant="plain" />;
}

registerSymbol('activated_sludge', ActivatedSludgeSymbol);
