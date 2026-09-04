/**
 * secondary_clarifier — §3.2 #9, §5.3 rows 6, 7, 9, 10
 * ─────────────────────────────────────────────────────────────────────────────
 * The primary clarifier's shell with TWO rake arms at 180°, a RAS hopper cone,
 * a sludge-blanket band at the floor and no scum baffle.
 *
 * ── RAKE — Class A ───────────────────────────────────────────────────────────
 * `load = drive(RAS_Q_m3_d, 0, sludgeRef)`, `P` bucketed to [26, 20, 14, 8]s.
 * `RAS_Q_m3_d = inf.Q·R/(1+R)` (secondaryClarifier.js:50) is computed from the
 * converged plant flow, so it is a legal rate driver. `SOR_m3_m2_d` is NOT: it
 * is `p.SOR_m3_m2_d` returned verbatim (:95) and an arm timed from it would
 * never once change speed. Acceptance check #12 pins exactly this.
 *
 * ── BLANKET — Class B, STATIC, and it says so ────────────────────────────────
 * `h = clamp(SLR_kg_m2_d / 144, 0.06, 0.60)` of vessel depth. 144 kg/m²/d is
 * the classic 6 kg/m²/h limit expressed per day.
 *
 * `SLR = solids_in / area = (Q·MLSS/1000) / (Q/SOR) = MLSS·SOR/1000`
 * (secondaryClarifier.js:61) — THE FLOW CANCELS EXACTLY. This band is a design
 * loading indicator, not a simulated blanket depth, and it does not respond to
 * flow. The ⓘ copy ships that sentence verbatim. Being Class B it may drive a
 * height and nothing else; it may never drive a rate.
 *
 * ── THE AMBER RING, AND THE TRAP ─────────────────────────────────────────────
 * Amber when `SLR_kg_m2_d > 144 || RAS_TSS_mg_L > 12000`.
 *
 * It must NEVER come from `metrics.warnings.length`. The model tests
 * `if (SLR > 6.0)` (secondaryClarifier.js:78) against a value expressed per DAY
 * — the defaults give SLR ≈ 48 — so that warning fires on essentially every
 * sheet, and wiring the ring to the array would leave every plant permanently
 * amber and the state colour would carry no information at all. Acceptance
 * check #13 pins it; so does the test suite.
 */

import { drive, num, useLiveNode } from '../liveStore';
import { registerSymbol } from './index';
import { GEO, clamp, ink } from './primitives';
import {
  hasValues, isInert, primeDelayOf, throughputQ, useWaveDur,
} from './activated_sludge';
import { ClarifierBase, rakeRunning, useRakeDur } from './primary_clarifier';

const EMPTY = Object.freeze({});
const C = GEO.cone;
const SPRING = C.cy + C.r / Math.SQRT2;
const SOFT = 'var(--ws-ink-400, #94A3B8)';

/** The classic 6 kg/m²/h solids loading limit, expressed per day. */
export const SLR_LIMIT = 144;
export const RAS_TSS_LIMIT = 12000;

/** RAS draw cone inside the hopper — the mark that says "return sludge". */
function RasHopper() {
  const k = 7;
  return (
    <path
      className="ws-detail" data-ws="ras-hopper"
      d={`M ${C.cx - k} ${SPRING + 1} L ${C.cx} ${SPRING + C.hopper - 1} L ${C.cx + k} ${SPRING + 1}`}
      {...ink('media', SOFT)}
    />
  );
}

export default function SecondaryClarifierSymbol(props) {
  const { nodeId, snap, state } = props;
  const liveSnap = useLiveNode(nodeId);
  const s = snap || liveSnap;
  const m = (s && s.metrics) || EMPTY;

  const inert = isInert(s, state);
  const vals = hasValues(s);

  // ── #6 rake — RAS_Q_m3_d, never SOR_m3_m2_d ──────────────────────────────
  const sludgeRef = num(s?.refs?.sludgeRef) ?? 1;
  const load = drive(m.RAS_Q_m3_d, 0, sludgeRef);
  const rakeDur = useRakeDur(load, rakeRunning(s, inert));

  // ── #7 blanket — SLR / 144, a labelled SETPOINT indicator ─────────────────
  const slr = num(m.SLR_kg_m2_d);
  const blanket = slr == null ? null : clamp(slr / SLR_LIMIT, 0.06, 0.60);

  // ── The ring: SLR and RAS TSS only. NOT warnings.length. ─────────────────
  const rasTss = num(m.RAS_TSS_mg_L);
  const warn = ((slr != null && slr > SLR_LIMIT) || (rasTss != null && rasTss > RAS_TSS_LIMIT))
    ? 'watch'
    : null;

  // ── #9 wave — Class A (throughput) ────────────────────────────────────────
  const qref = num(s?.refs?.Qref) ?? 1;
  const v = drive(throughputQ(s), 0, qref);
  const waveDur = useWaveDur(v);

  return (
    <ClarifierBase
      tag="secondary_clarifier"
      vals={vals}
      prime={!inert && vals}
      primeDelay={primeDelayOf(props)}
      waveDur={inert ? null : waveDur}
      waveAmp={1 + 2 * (v ?? 0)}
      arms={2}
      rakeDur={rakeDur}
      blanket={vals ? blanket : null}
      weirRing
      warn={warn}
    >
      <RasHopper />
    </ClarifierBase>
  );
}

registerSymbol('secondary_clarifier', SecondaryClarifierSymbol);
