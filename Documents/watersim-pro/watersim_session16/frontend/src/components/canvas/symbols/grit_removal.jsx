/**
 * grit_removal — §3.2 #7, §5.3 #6
 * ─────────────────────────────────────────────────────────────────────────────
 * The cone shell with a TANGENTIAL INLET SPIRAL, three settling dots, the
 * hopper V and a classifier screw stub off the bottom-right. The spiral and the
 * dots are what tell it apart from a clarifier at a glance; the turbine paddle
 * is the moving member.
 *
 * ── THE PADDLE ONLY EXISTS ON A VORTEX CHAMBER ───────────────────────────────
 * `metrics.chamberType` is 'vortex' | 'aerated' | 'horizontal' (grit.js:23). A
 * horizontal or aerated grit channel has no rotating turbine, so the paddle is
 * drawn PARKED at 45° for those — the same rest pose the rake uses. Only a
 * vortex chamber turns.
 *
 * ── THE DRIVER — Class A, and scale-invariant ────────────────────────────────
 * §5.3 #6 names a driver for the primary (`sludge_Q_m3_d`) and the secondary
 * (`RAS_Q_m3_d`) but not for grit, and grit returns neither. It also must not
 * borrow `sludgeRef`: that reference is a maximum over m³/d underflow FLOWS,
 * while grit's only solids output is `grit_removed_kg_d`, a MASS rate. Feeding
 * kg/d into a m³/d scale would be an apples-to-oranges normalisation whose
 * result means nothing.
 *
 * So the loading intensity is used instead, built exactly like the aeration
 * band in §5.3 #2 — a computed rate over a computed volume:
 *
 *   `grit = drive(grit_removed_kg_d / max(chamber_volume_m3, 1), 0.5, 30)`
 *
 * `grit_removed_kg_d = Q·TSS·r/1000` (grit.js:41) and
 * `chamber_volume_m3 = Q/1440 · HRT_min` (:45) are both computed from the plant
 * flow. Their ratio cancels Q, which makes the band scale-invariant — a package
 * plant and a large works read on the same scale — and leaves it tracking the
 * TSS actually arriving at the chamber, which is genuinely plant-driven. A
 * default sheet (TSS 250 mg/L, vortex, HRT 3 min) lands at 14.4 kg/m³/d, mid
 * band. THIS IS A LANE-D DERIVATION, not a mapping the spec supplied.
 *
 * `TSS_removal_pct` is returned as a STRING by this model — `num()`/`drive()`
 * parse strings first, so nothing here does arithmetic on one by accident.
 */

import { drive, num, useLiveNode } from '../liveStore';
import { registerSymbol } from './index';
import {
  hasValues, isInert, primeDelayOf, throughputQ, useWaveDur,
} from './activated_sludge';
import { ClarifierBase, rakeRunning, useRakeDur } from './primary_clarifier';

const EMPTY = Object.freeze({});

/** kg grit / m³ chamber / d. Verified against grit.js's own defaults. */
export const GRIT_BAND = Object.freeze([0.5, 30]);

export default function GritRemovalSymbol(props) {
  const { nodeId, snap, state } = props;
  const liveSnap = useLiveNode(nodeId);
  const s = snap || liveSnap;
  const m = (s && s.metrics) || EMPTY;

  const inert = isInert(s, state);
  const vals = hasValues(s);

  // ── #6 turbine — Class A loading intensity, vortex chambers only ──────────
  const grit = num(m.grit_removed_kg_d);
  const vol = Math.max(num(m.chamber_volume_m3) ?? 0, 1);
  const load = grit == null ? null : drive(grit / vol, GRIT_BAND[0], GRIT_BAND[1]);
  const vortex = m.chamberType == null || m.chamberType === 'vortex';
  const rakeDur = useRakeDur(load, vortex && rakeRunning(s, inert));

  // ── #9 wave — Class A (throughput) ────────────────────────────────────────
  const qref = num(s?.refs?.Qref) ?? 1;
  const v = drive(throughputQ(s), 0, qref);
  const waveDur = useWaveDur(v);

  return (
    <ClarifierBase
      tag="grit_removal"
      vals={vals}
      prime={!inert && vals}
      primeDelay={primeDelayOf(props)}
      waveDur={inert ? null : waveDur}
      waveAmp={1 + 2 * (v ?? 0)}
      arms={1}
      rakeDur={rakeDur}
      blanket={null}
      spiral
      settlingDots
      screwStub
    />
  );
}

registerSymbol('grit_removal', GritRemovalSymbol);
