/**
 * thickener — §3.2 legacy note, §5.3 rows 6, 8, 9, 10
 * ─────────────────────────────────────────────────────────────────────────────
 * "cone shell as #9 minus the second arm plus a screw stub". So: the clarifier
 * shell, ONE rake arm, the sludge-blanket band, the weir ring, and the screw
 * conveyor stub off the hopper.
 *
 * `thickener` is a first-class symbol, not an alias — registering it here means
 * `resolveSymbolType('thickener')` stops falling back to `secondary_clarifier`
 * and a thickener stops drawing a second rake arm it does not have.
 *
 * ── THE DRIVERS, AND THE TWO METRICS THAT LOOK USABLE AND ARE NOT ────────────
 * `SLR_kg_m2_d` here is NOT the secondary clarifier's computed loading. It is
 * `p.SLR_kg_m2_d ?? TYPE_DEFAULTS[type].SLR_kg_m2_d` (sludgeThickener.js:44) —
 * a pure setpoint. And `solids_in_kg_d / area_m2` reduces to that same setpoint
 * exactly, because the area is BACK-CALCULATED from it (:49). Both are dead
 * ends: one is an echo, the other is algebraically the echo.
 *
 * What is genuinely computed is the underflow split, so the blanket reuses the
 * primary clarifier's #8 construction with a band suited to a thickener (an
 * underflow fraction one order of magnitude larger than a primary's):
 *
 *   `f = thickened_Q_m3_d / (thickened_Q_m3_d + filtrate Q)`
 *   `h = clamp(0.06 + 0.54·drive(f, 0, 0.30), 0.06, 0.60)`
 *
 * and the rake takes `thickened_Q_m3_d` — an m³/d underflow flow, the same
 * quantity and the same units as the primary's `sludge_Q_m3_d` and the
 * secondary's `RAS_Q_m3_d`, so `sludgeRef` normalises all three coherently.
 * Both are computed from `inf.Q · inf.TSS`, hence Class A. THIS IS A LANE-D
 * DERIVATION: §5.3 lists the thickener under the rake row but supplies no
 * mapping for it.
 */

import { drive, num, useLiveNode } from '../liveStore';
import { registerSymbol } from './index';
import { clamp } from './primitives';
import {
  hasValues, isInert, primeDelayOf, throughputQ, useWaveDur,
} from './activated_sludge';
import { ClarifierBase, rakeRunning, useRakeDur } from './primary_clarifier';

const EMPTY = Object.freeze({});

/** Thickener underflow fractions run ~10x a primary clarifier's. */
export const UNDERFLOW_BAND = 0.30;

export default function ThickenerSymbol(props) {
  const { nodeId, snap, state } = props;
  const liveSnap = useLiveNode(nodeId);
  const s = snap || liveSnap;
  const m = (s && s.metrics) || EMPTY;

  const inert = isInert(s, state);
  const vals = hasValues(s);

  // ── #6 rake — Class A underflow flow, normalised on the shared sludgeRef ──
  const sludgeRef = num(s?.refs?.sludgeRef) ?? 1;
  const thickQ = num(m.thickened_Q_m3_d);
  const load = drive(thickQ, 0, sludgeRef);
  const rakeDur = useRakeDur(load, rakeRunning(s, inert));

  // ── #8-style blanket — the computed underflow split ───────────────────────
  const filtQ = num(s?.outputs?.filtrate?.Q);
  const denom = (thickQ ?? 0) + (filtQ ?? 0);
  const f = (thickQ != null && filtQ != null && denom > 0) ? thickQ / denom : null;
  const fN = drive(f, 0, UNDERFLOW_BAND);
  const blanket = fN == null ? null : clamp(0.06 + 0.54 * fN, 0.06, 0.60);

  // ── #9 wave — Class A (throughput) ────────────────────────────────────────
  const qref = num(s?.refs?.Qref) ?? 1;
  const v = drive(throughputQ(s), 0, qref);
  const waveDur = useWaveDur(v);

  return (
    <ClarifierBase
      tag="thickener"
      vals={vals}
      prime={!inert && vals}
      primeDelay={primeDelayOf(props)}
      waveDur={inert ? null : waveDur}
      waveAmp={1 + 2 * (v ?? 0)}
      arms={1}
      rakeDur={rakeDur}
      blanket={vals ? blanket : null}
      weirRing
      screwStub
    />
  );
}

registerSymbol('thickener', ThickenerSymbol);
