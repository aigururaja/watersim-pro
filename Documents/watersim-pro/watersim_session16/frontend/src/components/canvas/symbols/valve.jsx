/**
 * valve — ISA bow-tie (spec §3.2 #4, §5.3 #5)
 * ─────────────────────────────────────────────────────────────────────────────
 * "Two triangles meeting at a point, stem up to handwheel bar, actuator box,
 *  disc bar across the throat."
 *
 * DRIVERS
 *   ANGLE   metrics.opening_pct (valve.js:76) → `90 − 0.9·pct` degrees.
 *           0% = square across the throat, 100% = edge-on. `opening_pct` is a
 *           Class-C ECHO, and this is the SECOND of the two places §0.2 rule 2
 *           permits one to drive a geometry: the setpoint IS the disc angle.
 *   STATIC  throat fill width = `opening_pct`% of the run — readable with
 *           motion off, in print, and at 0.5×.
 *   CHATTER metrics.status === 'THROTTLED' → a nested INNER <g> loop:
 *           P = clamp(3.2 − 0.024·pct, 0.8, 3.0)s,
 *           amplitude = 0.5 + 1.5·(1 − pct/100) deg.
 *
 * TWO TRANSFORMS, TWO GROUPS, ONE RULE:
 *   The disc TRAVEL is a `transition: transform 220ms` (`.ws-disc`) and is
 *   deliberately permitted OUTSIDE live view — it is a state change, and a
 *   teleporting valve disc is worse UX than a moving one. The CHATTER is a
 *   loop and lives on a separate inner group carrying `.ws-anim`, so live-gating
 *   the loop can never freeze the disc at the wrong angle.
 *
 * ── SPEC DEVIATION, declared ────────────────────────────────────────────────
 * The chatter wants an ANGULAR shudder, but `canvas-motion.css` ships no
 * `ws-chatter` keyframe and this lane may not add one. The nearest legal reuse
 * is `ws-throb` (scale), which is applied here at the exact catalogue PERIOD.
 * The computed amplitude is still emitted as `--ws-chatter-amp` so adding
 *   @keyframes ws-chatter { 0%,100%{transform:rotate(calc(var(--ws-chatter-amp)*-1deg))}
 *                           50%    {transform:rotate(calc(var(--ws-chatter-amp)*1deg))} }
 * later is a stylesheet-only change with no edit to this file.
 */

import { registerSymbol } from './index';
import { ink, clamp } from './primitives';
import { DEF_IDS, paint } from './defs';
import { num } from '../liveStore';
import { isControlOn, controlPct } from '../controlState';

const EMPTY = Object.freeze({});
const INK = 'var(--ws-ink-700, #1E293B)';
const INK_SOFT = 'var(--ws-ink-400, #94A3B8)';
const ALARM = 'var(--ws-alarm, #DC2626)';
const WATER = 'var(--ws-svc-water, #2E75B6)';

const CY = 30;
const RUN_X = 16;                 // process run start
const RUN_W = 112;                // process run length
const RUN_H = 7;                  // throat bore
const RUN_Y = CY - RUN_H / 2;     // 26.5
/* Bow-tie: two triangles meeting at the throat point (72, 30). */
const BOWTIE = 'M 52 19 L 72 30 L 52 41 Z M 92 19 L 72 30 L 92 41 Z';

const cxs = (...p) => p.filter(Boolean).join(' ');

export function ValveSymbol({ opType = 'valve', data, state, snap }) {
  const m = snap?.metrics || EMPTY;
  const params = data?.params || EMPTY;
  const errored = state === 'error' || m.error != null;

  // Status: the solver's own word, else the model's exact coercion.
  const pct = num(m.opening_pct) ?? controlPct(params.opening_pct);
  const rawStatus = typeof m.status === 'string' ? m.status : null;
  const openParam = isControlOn(params.open);
  const status = state === 'off'
    ? 'CLOSED'
    : rawStatus || (!openParam ? 'CLOSED' : pct < 100 ? 'THROTTLED' : 'OPEN');

  const closed = status === 'CLOSED';
  const throttled = status === 'THROTTLED' && !errored;

  // ── Disc angle: 0% across the throat, 100% edge-on ──
  const angle = closed ? 90 : clamp(90 - 0.9 * pct, 0, 90);

  // ── Static throat fill ──
  const fillW = closed ? 0 : (RUN_W * clamp(pct, 0, 100)) / 100;

  // ── Chatter (loop) ──
  const chatterDur = throttled ? clamp(3.2 - 0.024 * pct, 0.8, 3.0) : null;
  const chatterAmp = throttled ? clamp(0.5 + 1.5 * (1 - pct / 100), 0.5, 2.0) : null;

  const shell = errored || closed ? ALARM : INK;
  const nodeState = errored ? 'error' : closed ? 'off' : 'rest';

  const discStyle = {
    transformBox: 'view-box',
    transformOrigin: '72px 30px',
    '--ws-origin': '72px 30px',
    transform: `rotate(${angle}deg)`,
  };

  return (
    <g
      className="ws-sym ws-sym--valve"
      data-op={opType}
      data-state={nodeState}
      data-status={status}
      opacity={closed && !errored ? 0.45 : undefined}
      aria-hidden="true"
    >
      <title>
        {closed ? 'Valve closed' : `Valve ${pct.toFixed(0)}% open`}
      </title>

      {/* ── Process run: two hairlines + the STATIC opening fill. A closed
             valve visibly empties the bore in a still frame. ── */}
      {fillW > 0 && (
        <rect
          className="ws-media ws-throat-fill"
          x={RUN_X} y={RUN_Y} width={fillW} height={RUN_H}
          fill={WATER} opacity={0.32}
          data-fill-pct={clamp(pct, 0, 100).toFixed(0)}
        />
      )}
      {closed && (
        <rect
          className="ws-media ws-hatch"
          x={RUN_X} y={RUN_Y} width={RUN_W} height={RUN_H}
          fill={paint(DEF_IDS.hatch)} opacity={0.6}
        />
      )}
      <line className="ws-media" x1={RUN_X} y1={RUN_Y} x2={RUN_X + RUN_W} y2={RUN_Y} {...ink('media', INK_SOFT)} />
      <line className="ws-media" x1={RUN_X} y1={RUN_Y + RUN_H} x2={RUN_X + RUN_W} y2={RUN_Y + RUN_H} {...ink('media', INK_SOFT)} />

      {/* ── Actuator: box, stem, handwheel bar ── */}
      <rect className="ws-detail" x={64} y={3} width={16} height={9} rx={1} {...ink('detail', shell)} />
      <line className="ws-detail" x1={72} y1={12} x2={72} y2={30} {...ink('detail', shell)} />
      <line className="ws-detail" x1={62} y1={15} x2={82} y2={15} {...ink('detail', shell)} />

      {/* ── Bow-tie body ── */}
      <path className="ws-shell" d={BOWTIE} {...ink('shell', shell)} />

      {/* ── Disc. OUTER group = the 220ms travel transition (a state change,
             legal outside live). INNER group = the chatter LOOP, `.ws-anim`
             only. Two transforms, two groups — they can never fight. ── */}
      <g className="ws-disc ws-origin-v ws-internals" style={discStyle} data-angle={angle.toFixed(1)}>
        <g
          className={cxs(throttled && 'ws-anim', throttled && 'ws-throb', 'ws-origin-c')}
          style={throttled
            ? {
              transformBox: 'fill-box',
              transformOrigin: '50% 50%',
              '--ws-throb': `${chatterDur.toFixed(2)}s`,
              '--ws-chatter-amp': chatterAmp.toFixed(2),
            }
            : { transformBox: 'fill-box', transformOrigin: '50% 50%' }}
          data-chatter={throttled ? `${chatterDur.toFixed(2)}s` : undefined}
        >
          <rect
            className="ws-disc-bar"
            x={63} y={28.75} width={18} height={2.5} rx={1}
            fill={closed ? ALARM : shell}
          />
        </g>
      </g>
    </g>
  );
}

registerSymbol('valve', ValveSymbol);

export default ValveSymbol;
