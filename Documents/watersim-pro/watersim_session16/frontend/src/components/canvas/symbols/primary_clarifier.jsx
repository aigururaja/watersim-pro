/**
 * Clarifier family base + primary_clarifier
 * (spec §3.2 #7–#9, §5.3 rows 6, 8, 9, 10)
 * ─────────────────────────────────────────────────────────────────────────────
 * `ClarifierBase` is the one drawing behind four palette types —
 * primary_clarifier, secondary_clarifier, grit_removal and thickener — which
 * differ only by which internals are switched on. Those three import it from
 * here.
 *
 * ── THE RAKE, AND THE ECHO THAT WOULD HAVE FROZEN IT ─────────────────────────
 * The rake period is NOT `SOR_m3_m2_d`. `SOR_m3_m2_d` is returned verbatim from
 * the user's parameter (primaryClarifier.js:114, secondaryClarifier.js:95) — it
 * is a design setpoint, it is not a rate, and driving the arm from it would
 * have produced an arm that never once changed speed in response to the plant.
 * §5.3 #6 corrects it:
 *
 *   secondary → `RAS_Q_m3_d`      (secondaryClarifier.js:50, `inf.Q·R/(1+R)`)
 *   primary   → `sludge_Q_m3_d`   (primaryClarifier.js:69,  `f(Q, TSS)`)
 *
 * Both are computed from the plant's own flow and solids, so both are Class A
 * and legal as a rate. `P = clamp(26 − 18·load, 8, 26)s`, bucketed to only FOUR
 * steps [8, 14, 20, 26] with hysteresis: retiming a running loop causes a phase
 * jump, which is invisible on a repeating dash pattern but glaring on a single
 * visible rake arm.
 *
 * ── THE PRIMARY SLUDGE BLANKET ───────────────────────────────────────────────
 * NOT `sludge_TSS_mg_L` — that is a verbatim echo of the underflow
 * concentration the user set (primaryClarifier.js:120). §5.3 #8:
 *   `f = sludge_Q_m3_d / (sludge_Q_m3_d + effluent Q)`
 *   `h = clamp(0.06 + 0.54·drive(f, 0, 0.02), 0.06, 0.60)` of vessel depth.
 * Both terms are computed flows, so the band genuinely responds to the plant.
 *
 * Height is `scaleY` on a bottom-anchored group with a 420ms transition — never
 * the `height` attribute, which does not transition and forces layout.
 */

import { drive, num, secs, useLiveNode } from '../liveStore';
import { registerSymbol } from './index';
import {
  Blanket, Fill, GEO, Nozzle, Rotor, Shell, Wave, clamp, ink,
} from './primitives';
import {
  hasValues, isInert, primeDelayOf, throughputQ, useBucketed, useUid, useWaveDur,
} from './activated_sludge';

const EMPTY = Object.freeze({});

// ═══════════════════════════════════════════════════════════════════════════
// GEOMETRY — GEO.cone: circle d40 at (72, 24) with a 12px hopper V
// ═══════════════════════════════════════════════════════════════════════════
//
// §3.2 asks for a d56 circle. The symbol frame is 60px tall and the hopper V
// adds 12px below the springline, so d56 + hopper = 68px and cannot be drawn.
// Phase B's GEO.cone (r 20) is the largest circle that fits with the hopper and
// the 4px service band, and it is what every other lane's cone shell uses.

const C = GEO.cone;                                  // cx 72, cy 24, r 20
const SPRING = C.cy + C.r / Math.SQRT2;              // 38.14
const APEX = SPRING + C.hopper;                      // 50.14
const TOP = C.cy - C.r;                              // 4
const LEFT = C.cx - C.r;                             // 52
const VESSEL_H = APEX - TOP;                         // 46.14
const LEVEL = 0.90;                                  // FIXED — full to the weir
const SURFACE = APEX - LEVEL * VESSEL_H;             // 8.6
const FLOOR_Y = 50;
const MAX_BLANKET = 40;

const WATER = 'var(--ws-svc-water, #2E75B6)';
const SLUDGE = 'var(--ws-svc-sludge, #78350F)';
const SOFT = 'var(--ws-ink-400, #94A3B8)';
const WATCH = 'var(--ws-watch, #D97706)';
const ALARM = 'var(--ws-alarm, #DC2626)';

/** §5.3 #6 — four buckets, and these are the only four periods that exist. */
export const RAKE_PERIODS = Object.freeze([26, 20, 14, 8]);

/**
 * Rake period from a 0..1 load normal.
 * `running === false` (or a null load) means PARKED at 45°, not a slow spin —
 * "not raking" and "raking very slowly" are different facts.
 */
export function useRakeDur(load, running) {
  const idx = useBucketed(load, 4);
  if (!running || load == null) return null;
  return secs(RAKE_PERIODS[idx]);
}

/** Inbound flow gate (§5.3 #6): `Q < 0.5` → rake parked, blanket still drawn. */
export function rakeRunning(snap, inert) {
  const q = throughputQ(snap);
  return !inert && q != null && q >= 0.5;
}

// ═══════════════════════════════════════════════════════════════════════════
// INTERNALS — this is what separates four units sharing one shell
// ═══════════════════════════════════════════════════════════════════════════

/** One rake arm: a radial beam with two angled scraper blades (§3.2 #8). */
function RakeArm({ angle }) {
  const rad = (angle * Math.PI) / 180;
  const dx = Math.cos(rad), dy = Math.sin(rad);
  const tip = C.r - 2;
  const blades = [9, 15].map((rr) => {
    const bx = C.cx + dx * rr, by = C.cy + dy * rr;
    return (
      <line
        key={rr}
        x1={bx - dy * 2.6 - dx * 1.8} y1={by + dx * 2.6 - dy * 1.8}
        x2={bx + dy * 2.6 + dx * 1.8} y2={by - dx * 2.6 + dy * 1.8}
      />
    );
  });
  return (
    <g>
      <line x1={C.cx} y1={C.cy} x2={C.cx + dx * tip} y2={C.cy + dy * tip} />
      {blades}
    </g>
  );
}

/** Dashed V-notch weir ring at r−4 with 8 teeth (§3.2 #8). */
function WeirRing() {
  const r = C.r - 4;
  const teeth = [];
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    const dx = Math.cos(a), dy = Math.sin(a);
    teeth.push(
      <line key={i} x1={C.cx + dx * r} y1={C.cy + dy * r} x2={C.cx + dx * (r + 2.4)} y2={C.cy + dy * (r + 2.4)} />,
    );
  }
  return (
    <g className="ws-detail" data-ws="weir" {...ink('media', SOFT)}>
      <circle cx={C.cx} cy={C.cy} r={r} strokeDasharray="3 2.5" />
      {teeth}
    </g>
  );
}

/** Scum baffle — a short concentric arc. Primary clarifiers only (§3.2 #8). */
function ScumBaffle() {
  const r = C.r - 7;
  const a0 = Math.PI * 1.08, a1 = Math.PI * 1.55;
  const p = (a) => `${(C.cx + Math.cos(a) * r).toFixed(2)} ${(C.cy + Math.sin(a) * r).toFixed(2)}`;
  return (
    <path
      className="ws-detail" data-ws="scum-baffle"
      d={`M ${p(a0)} A ${r} ${r} 0 0 1 ${p(a1)}`}
      {...ink('detail', SOFT)}
    />
  );
}

/** Tangential inlet spiral — the grit chamber's distinguishing mark (§3.2 #7). */
function InletSpiral() {
  let d = `M ${(C.cx - C.r - 6).toFixed(2)} 16 L ${(C.cx - C.r + 2).toFixed(2)} 16`;
  for (let i = 0; i <= 26; i++) {
    const t = i / 26;
    const a = Math.PI + t * Math.PI * 2.1;
    const r = 16 - t * 11;
    d += ` L ${(C.cx + Math.cos(a) * r).toFixed(2)} ${(C.cy + Math.sin(a) * r).toFixed(2)}`;
  }
  return <path className="ws-detail" data-ws="spiral" d={d} {...ink('detail', SOFT)} />;
}

/** Classifier / thickener screw conveyor stub off the hopper (§3.2 #7). */
function ScrewStub() {
  const ticks = [];
  for (let i = 0; i < 4; i++) {
    const t = 0.18 + i * 0.22;
    const x = C.cx + 6 + t * 18, y = SPRING + 2 + t * 8;
    ticks.push(<line key={i} x1={x - 1.6} y1={y - 2.6} x2={x + 1.6} y2={y + 2.6} />);
  }
  return (
    <g className="ws-detail" data-ws="screw" {...ink('media', SOFT)}>
      <line x1={C.cx + 6} y1={SPRING + 2} x2={C.cx + 26} y2={SPRING + 11} />
      {ticks}
    </g>
  );
}

/** Three settling dots — grit only (§3.2 #7). */
function SettlingDots() {
  return (
    <g className="ws-media" data-ws="grit-dots" fill={SOFT} opacity={0.8}>
      <circle cx={C.cx - 6} cy={C.cy + 8} r={1.1} />
      <circle cx={C.cx} cy={C.cy + 11} r={1.3} />
      <circle cx={C.cx + 6} cy={C.cy + 8} r={1.1} />
    </g>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// THE SHARED BASE
// ═══════════════════════════════════════════════════════════════════════════

/**
 * @param {number}  arms          0, 1 or 2 rake arms at 180°
 * @param {?string} rakeDur       `secs()` output; null → PARKED at 45°
 * @param {?number} blanket       0..1 fraction of vessel depth; null → no band
 * @param {?string} warn          'watch' | 'alarm' | null — survives a still
 */
export function ClarifierBase({
  vals, level = LEVEL, prime, primeDelay = 0,
  waveDur = null, waveAmp = 1.5,
  arms = 1, rakeDur = null, blanket = null, blanketColor = SLUDGE,
  weirRing = false, scumBaffle = false, spiral = false, screwStub = false,
  settlingDots = false, centreWell = true, warn = null, tag, children,
}) {
  const uid = useUid('cl');
  const clipId = `${uid}-in`;
  const armAngles = arms >= 2 ? [0, 180] : arms === 1 ? [0] : [];

  return (
    <g aria-hidden="true" data-ws-symbol={tag}>
      <Shell.Cone clipId={clipId} />

      {vals && (
        <>
          <Fill
            x={LEFT} y={TOP} w={C.r * 2} h={VESSEL_H} level={level} clipId={clipId}
            color={WATER} opacity={0.28} prime={prime} primeDelay={primeDelay}
          />
          <Wave
            x={LEFT} w={C.r * 2} y={SURFACE} amp={waveAmp}
            dur={waveDur} clipId={clipId} color={WATER} opacity={0.85}
          />
        </>
      )}

      {/* Sludge blanket — bottom-anchored scaleY, 420ms transition, clipped to
          the hopper so the band takes the vessel's own shape. */}
      {blanket != null && (
        <Blanket
          x={LEFT} w={C.r * 2} floorY={FLOOR_Y} maxDepth={MAX_BLANKET}
          height={blanket} clipId={clipId} color={blanketColor} opacity={0.5}
          className="ws-clarifier-blanket"
        />
      )}

      {spiral && <InletSpiral />}
      {settlingDots && <SettlingDots />}
      {weirRing && <WeirRing />}
      {scumBaffle && <ScumBaffle />}
      {children}

      {centreWell && (
        <circle
          className="ws-detail" data-ws="centre-well"
          cx={C.cx} cy={C.cy} r={5} {...ink('detail', SOFT)}
        />
      )}

      {armAngles.length > 0 && (
        <Rotor dur={rakeDur} channel="rake" parkedAt={45} origin={[C.cx, C.cy]} className="ws-clarifier-rake">
          <g data-ws="rake" {...ink('detail', SOFT)}>
            {armAngles.map((a) => <RakeArm key={a} angle={a} />)}
          </g>
        </Rotor>
      )}

      {screwStub && <ScrewStub />}

      {/* State ring — static in a still frame, so it survives a screenshot. */}
      {warn && (
        <circle
          data-ws="warn" data-level={warn}
          cx={C.cx} cy={C.cy} r={C.r + 3.5}
          {...ink('detail', warn === 'alarm' ? ALARM : WATCH)}
        />
      )}

      {/* PORTS — inlet, clarified effluent, underflow draw off the hopper. */}
      <Nozzle x={LEFT - 8} y={16} dir="right" color={SOFT} />
      <Nozzle x={C.cx + C.r - 1} y={16} dir="right" color={SOFT} />
      <Nozzle x={C.cx} y={APEX} dir="down" len={6} color={SOFT} />
    </g>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// primary_clarifier
// ═══════════════════════════════════════════════════════════════════════════

export default function PrimaryClarifierSymbol(props) {
  const { nodeId, snap, state } = props;
  const liveSnap = useLiveNode(nodeId);
  const s = snap || liveSnap;
  const m = (s && s.metrics) || EMPTY;

  const inert = isInert(s, state);
  const vals = hasValues(s);

  // ── #6 rake — Class A. sludge_Q_m3_d, NEVER SOR_m3_m2_d. ─────────────────
  const sludgeRef = num(s?.refs?.sludgeRef) ?? 1;
  const sludgeQ = num(m.sludge_Q_m3_d);
  const load = drive(sludgeQ, 0, sludgeRef);
  const rakeDur = useRakeDur(load, rakeRunning(s, inert));

  // ── #8 blanket — Class A. The UNDERFLOW SPLIT, never sludge_TSS_mg_L. ─────
  const effQ = num(s?.outputs?.effluent?.Q);
  const denom = (sludgeQ ?? 0) + (effQ ?? 0);
  const f = (sludgeQ != null && effQ != null && denom > 0) ? sludgeQ / denom : null;
  const fN = drive(f, 0, 0.02);
  const blanket = fN == null ? null : clamp(0.06 + 0.54 * fN, 0.06, 0.60);

  // ── #9 wave — Class A (throughput) ────────────────────────────────────────
  const qref = num(s?.refs?.Qref) ?? 1;
  const v = drive(throughputQ(s), 0, qref);
  const waveDur = useWaveDur(v);

  return (
    <ClarifierBase
      tag="primary_clarifier"
      vals={vals}
      prime={!inert && vals}
      primeDelay={primeDelayOf(props)}
      waveDur={inert ? null : waveDur}
      waveAmp={1 + 2 * (v ?? 0)}
      arms={1}
      rakeDur={rakeDur}
      blanket={vals ? blanket : null}
      weirRing
      scumBaffle
    />
  );
}

registerSymbol('primary_clarifier', PrimaryClarifierSymbol);
