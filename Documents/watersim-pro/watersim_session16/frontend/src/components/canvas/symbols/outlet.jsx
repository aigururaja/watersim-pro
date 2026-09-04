/**
 * outlet — ISA off-page sink + the compliance stamp (spec §3.2 #2, §5.3 #18)
 * ─────────────────────────────────────────────────────────────────────────────
 * "Home-plate pentagon pointing right, outfall lip, receiving-water squiggle
 *  beneath, compliance stamp area above."
 *
 * DRIVERS — both Class A, both from `outlet.js:63-71`
 *   metrics.compliant          boolean
 *   metrics.permit_violations  [{ param, value, limit, unit }]
 *
 * THE RULE THAT GOVERNS THIS FILE (spec §5.3 #18, §6.1):
 *   "Violation chips and the red ring render whenever RESULTS exist — live or
 *    not, and in print. A permit violation must survive a screenshot."
 * So the ring and the chips are gated on `metrics.compliant === false`, NEVER
 * on `live`. Only the 1.0s blink and the one-shot stamp are live-gated.
 *
 * THE ONE-SHOT, AND WHY IT IS NOT `key={seq}` ON EVERY TICK:
 *   The stamp fires ONLY on a TRANSITION to compliant. A previous-value ref
 *   records the tick (`snap.changedSeq`) at which compliance flipped false →
 *   true; the `ws-stamp` class is applied only while the current
 *   `changedSeq` still equals that tick. Keying the element on every tick
 *   would replay the stamp forever, which is exactly the bug the spec calls
 *   out. The stamp GRAPHIC itself is static and always drawn when compliant,
 *   so the good news also survives a screenshot.
 */

import { useRef } from 'react';
import { registerSymbol } from './index';
import { ink } from './primitives';
import { num } from '../liveStore';

const EMPTY = Object.freeze({});
const EMPTY_ARR = Object.freeze([]);
const INK = 'var(--ws-ink-700, #1E293B)';
const INK_SOFT = 'var(--ws-ink-400, #94A3B8)';
const WATER = 'var(--ws-svc-water, #2E75B6)';
const ALARM = 'var(--ws-alarm, #DC2626)';
const OK = 'var(--ws-ok, #15803D)';

/* Home-plate pentagon — CLOSED (a sink), where the inlet flag is open. */
const PLATE = 'M 14 18 L 58 18 L 74 32 L 58 46 L 14 46 Z';
const LIP = 'M 74 32 L 86 38';
const RECEIVING = 'M 60 51 q 6 -4 12 0 q 6 4 12 0 q 6 -4 12 0 q 6 4 12 0';
const CHECK = 'M 88 29 L 94 35.5 L 106 22.5';

const CHIP_X = 78;
const CHIP_Y = [13, 25, 37];
const cxs = (...p) => p.filter(Boolean).join(' ');

/** Short, tabular. `−` for a value the solver could not produce. */
const fmt = (n) => (n == null ? '—' : Math.abs(n) >= 100 ? n.toFixed(0) : n.toFixed(1));

/** `TN 14.2 > 10` — and `<` for a pH MINIMUM breach, which is a floor. */
function chipText(v) {
  const p = typeof v?.param === 'string' ? v.param : '?';
  const cmp = typeof v?.unit === 'string' && v.unit.indexOf('min') >= 0 ? '<' : '>';
  return `${p} ${fmt(num(v?.value))} ${cmp} ${fmt(num(v?.limit))}`;
}

export function OutletSymbol({ opType = 'outlet', state, snap }) {
  const stampRef = useRef({ prev: null, seq: 0 });

  const m = snap?.metrics || EMPTY;
  const live = !!snap?.live;
  const seq = snap?.changedSeq ?? 0;
  const errored = state === 'error' || m.error != null;

  const compliant = m.compliant === true ? true : m.compliant === false ? false : null;
  const violations = Array.isArray(m.permit_violations) ? m.permit_violations : EMPTY_ARR;
  const shown = violations.slice(0, 3);
  const extra = violations.length - shown.length;

  // One-shot arming: record the tick compliance flipped INTO true.
  // Idempotent, so a StrictMode double-render cannot double-fire.
  if (compliant === true && stampRef.current.prev === false) stampRef.current.seq = seq;
  if (compliant !== stampRef.current.prev) stampRef.current.prev = compliant;
  const stampSeq = stampRef.current.seq;
  const stamping = live && !errored && stampSeq !== 0 && stampSeq === seq;

  const bad = compliant === false;
  const shell = errored || bad ? ALARM : INK;
  const nodeState = errored ? 'error' : bad ? 'alarm' : 'rest';

  return (
    <g
      className="ws-sym ws-sym--outlet"
      data-op={opType}
      data-state={nodeState}
      data-compliant={compliant == null ? undefined : String(compliant)}
      aria-hidden="true"
    >
      <title>
        {bad
          ? `Outlet — NOT COMPLIANT (${violations.length} permit violation${violations.length === 1 ? '' : 's'})`
          : compliant === true ? 'Outlet — permit compliant' : 'Outlet'}
      </title>

      {/* receiving water — decorative, never animated: the engine models no
          receiving body, so this is drawn once and left alone */}
      <path className="ws-media" d={RECEIVING} {...ink('media', WATER)} opacity={0.7} />

      {/* inbound nozzle on the symbol centreline */}
      <line className="ws-detail" x1={2} y1={32} x2={14} y2={32} {...ink('detail', INK_SOFT)} />

      <path className="ws-shell" d={PLATE} {...ink('shell', shell)} />
      <path className="ws-detail" d={LIP} {...ink('detail', shell)} />

      {/* ── ALARM: static ring + chips. Rendered from RESULTS, never from
             `live` — this is the half of the symbol that must survive a
             screenshot and a print. The 1.0s blink is the `.ws-anim` half. ── */}
      {bad && (
        <>
          <rect
            className="ws-anim ws-alarm ws-ring"
            x={8} y={12} width={72} height={40} rx={2}
            {...ink('detail', ALARM)}
          />
          <g className="ws-internals ws-chips" data-chips={String(violations.length)}>
            {shown.map((v, i) => (
              <text
                key={`${v?.param ?? '?'}-${i}`}
                x={CHIP_X} y={CHIP_Y[i]}
                fill={ALARM}
                fontSize="9"
                fontWeight="600"
                fontFamily="var(--ws-font-mono, ui-monospace, Menlo, Consolas, monospace)"
                style={{ fontVariantNumeric: 'tabular-nums lining-nums' }}
              >
                {chipText(v)}
              </text>
            ))}
            {extra > 0 && (
              <text
                x={CHIP_X} y={49}
                fill={ALARM}
                fontSize="9"
                fontWeight="600"
                fontFamily="var(--ws-font-mono, ui-monospace, Menlo, Consolas, monospace)"
              >
                {`+${extra}`}
              </text>
            )}
          </g>
        </>
      )}

      {/* ── COMPLIANT: the stamp. Drawn statically whenever compliant; the
             700ms one-shot is added ONLY on the tick compliance flipped. ── */}
      {compliant === true && (
        <g
          key={`stamp-${stampSeq}`}
          className={cxs('ws-internals', 'ws-origin-c', stamping && 'ws-stamp')}
          style={{ transformBox: 'fill-box', transformOrigin: '50% 50%' }}
          data-stamp={stamping ? 'fire' : 'still'}
        >
          <rect x={80} y={16} width={52} height={26} rx={2} {...ink('detail', OK)} />
          <path d={CHECK} {...ink('detail', OK)} />
        </g>
      )}
    </g>
  );
}

registerSymbol('outlet', OutletSymbol);

export default OutletSymbol;
