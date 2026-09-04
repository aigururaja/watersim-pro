/**
 * inlet — ISA off-page connector (spec §3.2 #1)
 * ─────────────────────────────────────────────────────────────────────────────
 * "Right-pointing flag pentagon, open left edge, approach-channel floor line,
 *  3 entry chevrons."
 *
 * DRIVERS
 *   metrics.Q_in (inlet.js:36 — `effluent.Q`, Class A) → STATIC chevron
 *   opacity `0.35 + 0.5 · drive(Q_in, 0, Qref)`. Magnitude only; the inlet has
 *   no row in the §5.3 animation catalogue and therefore NOTHING here moves.
 *   The flow itself is shown by the outbound edge's pulse (catalogue #1).
 *
 * With no results the chevrons render at a neutral 0.55 — an outline, never a
 * fabricated number.
 */

import { registerSymbol } from './index';
import { ink, clamp } from './primitives';
import { num, drive } from '../liveStore';

const EMPTY = Object.freeze({});
const INK_SOFT = 'var(--ws-ink-400, #94A3B8)';
const WATER = 'var(--ws-svc-water, #2E75B6)';
const ALARM = 'var(--ws-alarm, #DC2626)';

/* Flag pentagon: open on the LEFT edge (that is what makes it an off-page
   source rather than a box), point on the right at the symbol centreline. */
const FLAG = 'M 44 14 L 98 14 L 114 30 L 98 46 L 44 46';
const CHEVRONS = [12, 22, 32];

export function InletSymbol({ opType = 'inlet', data, state, snap }) {
  const m = snap?.metrics || EMPTY;
  const refs = snap?.refs || EMPTY;
  const errored = state === 'error' || m.error != null;

  // Class A: `Q_in` is the stream the source actually emits.
  const q = drive(num(m.Q_in), 0, num(refs.Qref) ?? 1);
  const flow = q == null ? 0.55 : clamp(0.35 + 0.5 * q, 0.35, 0.85);
  const shell = errored ? ALARM : 'var(--ws-ink-700, #1E293B)';

  return (
    <g
      className="ws-sym ws-sym--inlet"
      data-op={opType}
      data-state={errored ? 'error' : 'rest'}
      aria-hidden="true"
    >
      <title>{data?.label ? `Inlet — ${data.label}` : 'Inlet'}</title>

      {/* approach-channel floor */}
      <line className="ws-detail" x1={8} y1={52} x2={116} y2={52} {...ink('detail', INK_SOFT)} />

      {/* 3 entry chevrons — opacity is the static flow encoder */}
      <g className="ws-internals">
        {CHEVRONS.map((x) => (
          <path
            key={x}
            d={`M ${x} 22 L ${x + 8} 30 L ${x} 38`}
            {...ink('detail', WATER)}
            opacity={flow}
          />
        ))}
      </g>

      {/* flag pentagon */}
      <path className="ws-shell" d={FLAG} {...ink('shell', shell)} />

      {/* discharge nozzle at the tip, on the symbol centreline */}
      <line className="ws-detail" x1={114} y1={30} x2={126} y2={30} {...ink('detail', shell)} />
    </g>
  );
}

registerSymbol('inlet', InletSymbol);

export default InletSymbol;
