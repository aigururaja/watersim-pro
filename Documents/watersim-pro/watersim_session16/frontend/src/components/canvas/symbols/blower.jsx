/**
 * blower — ISA rotary / Roots (spec §3.2 #5, §5.3 #3, §5.4)
 * ─────────────────────────────────────────────────────────────────────────────
 * "Circle containing two interlocked figure-8 Roots lobes, inlet silencer stub
 *  left, discharge up-right to a dotted air header."
 *
 * THERE IS NO BLOWER MODEL.
 *   `PALETTE_TYPE_MAP.blower = null` → passthrough → `metrics` is `{}`. Nothing
 *   in `metrics` can drive anything here, and inventing a duty would be exactly
 *   the kind of lie §0.2 forbids. So duty is DERIVED, in liveStore's one O(N+E)
 *   pass, from the O₂ demand of the aeration-family nodes this blower is
 *   adjacent to by any edge, either direction:
 *
 *     duty = drive(snap.derived.O2_served, 0, refs.O2ref)
 *     P    = clamp(1.9 − 1.55·duty, 0.35, 2.2)s, 5 buckets, 15% hysteresis
 *
 * AND THE REFUSAL THAT MAKES IT HONEST (spec §5.4, acceptance check #10):
 *   With NO adjacent aeration node the rotor DOES NOT TURN. It parks at 12°,
 *   the casing goes dashed `--ws-nomodel` slate, no air pulses are mounted, and
 *   the symbol reports `data-unlinked="true"` so the node footer can print the
 *   slate UNLINKED chip (§2.4 puts that chip in the FOOTER, which is why this
 *   file draws no text of its own — duplicating it inside the frame would say
 *   the same thing twice).
 *
 * The two lobes counter-rotate from ONE keyframe: the second carries
 * `.ws-rotor--rev` (`animation-direction: reverse`) and a static 90° pre-rotate
 * so they read as interlocked rather than as two copies of the same lobe.
 */

import { useRef } from 'react';
import { registerSymbol } from './index';
import { Rotor, ink, clamp } from './primitives';
import { num, drive, bucket, secs } from '../liveStore';

const EMPTY = Object.freeze({});
const INK = 'var(--ws-ink-700, #1E293B)';
const INK_SOFT = 'var(--ws-ink-400, #94A3B8)';
const ALARM = 'var(--ws-alarm, #DC2626)';
const AIR = 'var(--ws-svc-air, #0891B2)';
const NOMODEL = 'var(--ws-nomodel, #64748B)';

const CX = 56;
const CY = 30;
const R = 17;
const LOBE_A = [48, 30];
const LOBE_B = [64, 30];
const HEADER = 'M 68 18 L 84 10 L 138 10';
const DUTY_STEPS = 5;

/** A Roots lobe: a vertical peanut — two caps joined at a waist. */
function lobePath(x, y) {
  return `M ${x - 3} ${y - 7.5}`
    + ` Q ${x} ${y - 9.6} ${x + 3} ${y - 7.5}`
    + ` Q ${x + 1.5} ${y - 2.6} ${x + 1.5} ${y}`
    + ` Q ${x + 1.5} ${y + 2.6} ${x + 3} ${y + 7.5}`
    + ` Q ${x} ${y + 9.6} ${x - 3} ${y + 7.5}`
    + ` Q ${x - 1.5} ${y + 2.6} ${x - 1.5} ${y}`
    + ` Q ${x - 1.5} ${y - 2.6} ${x - 3} ${y - 7.5} Z`;
}

const PATH_A = lobePath(LOBE_A[0], LOBE_A[1]);
const PATH_B = lobePath(LOBE_B[0], LOBE_B[1]);

export function BlowerSymbol({ opType = 'blower', state, snap }) {
  const dutyBucket = useRef(undefined);

  const m = snap?.metrics || EMPTY;
  const derived = snap?.derived || EMPTY;
  const refs = snap?.refs || EMPTY;
  const live = !!snap?.live;
  const errored = state === 'error' || m.error != null;

  // ── Derived duty (§5.4). `servedCount` is seeded for EVERY blower, so 0 is
  //    "connected to nothing", not "no record". ──
  const servedCount = num(derived.servedCount) ?? 0;
  const served = num(derived.O2_served);
  const linked = servedCount > 0;
  const duty = linked ? drive(served, 0, num(refs.O2ref) ?? 1) : null;
  const spinning = linked && !errored && state !== 'off' && (served ?? 0) > 0;

  let dur = null;
  if (spinning) {
    const idx = bucket(duty, DUTY_STEPS, dutyBucket.current);
    dutyBucket.current = idx;
    dur = secs(clamp(1.9 - 1.55 * (idx / (DUTY_STEPS - 1)), 0.35, 2.2));
  }

  // Air pulses are meaningless without a duty: EXISTENCE-gated on live (§6.3b).
  const pulsing = spinning && live && dur != null;

  const shell = errored ? ALARM : linked ? INK : NOMODEL;
  const lobeInk = errored ? ALARM : linked ? INK : NOMODEL;
  const nodeState = errored ? 'error' : !linked ? 'nomodel' : 'rest';

  return (
    <g
      className="ws-sym ws-sym--blower"
      data-op={opType}
      data-state={nodeState}
      data-unlinked={linked ? undefined : 'true'}
      data-served={linked ? String(servedCount) : '0'}
      opacity={!linked && !errored ? 0.75 : undefined}
      aria-hidden="true"
    >
      <title>
        {linked
          ? `Blower — duty derived from ${servedCount} aeration basin${servedCount === 1 ? '' : 's'}`
          : 'Blower — no aeration basin connected, so the rotor does not turn'}
      </title>

      {/* inlet silencer + suction stub, on the symbol centreline */}
      <rect className="ws-detail" x={16} y={24} width={14} height={12} rx={1} {...ink('detail', shell)} />
      <line className="ws-detail" x1={30} y1={CY} x2={CX - R} y2={CY} {...ink('detail', shell)} />

      {/* baseplate */}
      <line className="ws-detail" x1={36} y1={50} x2={80} y2={50} {...ink('detail', INK_SOFT)} />

      {/* casing — DASHED slate when nothing is served (spec §3.3, §5.4) */}
      <circle
        className="ws-shell"
        cx={CX} cy={CY} r={R}
        {...ink('shell', shell)}
        strokeDasharray={linked ? undefined : '5 3'}
      />

      {/* discharge + dotted air header (`--ws-dash-air` is `1 4`) */}
      <path
        className="ws-detail"
        d={HEADER}
        {...ink('detail', linked ? AIR : NOMODEL)}
        strokeDasharray="1 4"
      />

      {/* Air pulses: same `d`, mounted only in live and only when a duty
          exists. Not mounted = zero layers when idle. */}
      {pulsing && (
        <path
          className="ws-anim ws-pulse ws-detail"
          d={HEADER}
          style={{ '--ws-flow': dur }}
          {...ink('detail', AIR)}
          data-air-pulse={dur}
        />
      )}

      {/* Two counter-rotating lobes — one keyframe, one reverse class. The
          second is pre-rotated 90° by a static parent transform so the pair
          reads as interlocked; `transform-box: fill-box` inside is unaffected. */}
      <Rotor dur={dur} parkedAt={12} className="ws-internals">
        <path d={PATH_A} {...ink('detail', lobeInk)} />
      </Rotor>
      <g transform={`rotate(90 ${LOBE_B[0]} ${LOBE_B[1]})`}>
        <Rotor dur={dur} parkedAt={12} reverse className="ws-internals">
          <path d={PATH_B} {...ink('detail', lobeInk)} />
        </Rotor>
      </g>
    </g>
  );
}

registerSymbol('blower', BlowerSymbol);

export default BlowerSymbol;
