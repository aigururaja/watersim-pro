/**
 * screening — inclined bar rack + rake + skip (spec §3.2 #6, §5.3 #12)
 * ─────────────────────────────────────────────────────────────────────────────
 * "Parallelogram leaning 15°, vertical bars (4 coarse / 7 fine / stipple micro
 *  from `screenType`), rake tooth on a track, screenings chute up-right to a
 *  skip."
 *
 * THE DRIVER IS `screenings_kg_d`, NOT `headloss_m`.
 *   `screen.js:78` returns `headloss_m: p.headloss_m` — a VERBATIM ECHO of the
 *   parameter. Driving the rake from it (as the original proposal did) would
 *   freeze the rake forever: the value can never change unless a human edits
 *   the setpoint, so the animation would be permanently inert and would be
 *   claiming a plant response it does not have.
 *
 *     s = drive(screenings_kg_d, 0, refs.screenRef)      ← Class A, screen.js:41
 *     P = clamp(9 − 6.5·s, 2.5, 9)s, 5 buckets, 15% hysteresis
 *
 * STATIC encoders (all labelled as setpoint-derived in the ⓘ copy):
 *   · skip fill        = the same `s`                              — Class A
 *   · blinding opacity = clamp(headloss_m / 0.30, 0, 1)            — Class C
 *   · up/downstream level differential = 10px × that same clamp    — Class C
 *   · amber watch when `headloss_m > 0.45`
 * Class C may drive a HEIGHT or an OPACITY. It may never drive a rate.
 *
 * `TSS_removal_pct` IS A STRING (`screen.js:73` — `(TSS_r*100).toFixed(1)`).
 * It goes through `num()` before any arithmetic; `Number` alone would turn ''
 * into 0 and silently pick the wrong rack.
 *
 * GEOMETRY NOTE: the rack, its bars and the rake carriage are ALL drawn inside
 * one `rotate(15 …)` group, so the carriage's translate is automatically along
 * the rack axis. The `ws-rake` keyframe climbs exactly 30px; the rack is 40
 * tall with the carriage parked at y=44, so the climb lands at the head of the
 * rack with no per-node JS and no bespoke keyframe.
 */

import { useRef } from 'react';
import { registerSymbol } from './index';
import { Fill, ink, clamp } from './primitives';
import { DEF_IDS, paint } from './defs';
import { num, drive, bucket, secs } from '../liveStore';

const EMPTY = Object.freeze({});
const INK = 'var(--ws-ink-700, #1E293B)';
const INK_SOFT = 'var(--ws-ink-400, #94A3B8)';
const ALARM = 'var(--ws-alarm, #DC2626)';
const WATCH = 'var(--ws-watch, #D97706)';
const WATER = 'var(--ws-svc-water, #2E75B6)';
const SLUDGE = 'var(--ws-svc-sludge, #78350F)';

/* Rack, in the rotated frame: 26 wide x 40 tall, centred on (59, 30). */
const RACK = { x: 46, y: 10, w: 26, h: 40, cx: 59, cy: 30, lean: 15 };
const CARRIAGE_Y = 44;            // parked at the foot; ws-rake climbs 30px
const SKIP = { x: 96, y: 20, w: 36, h: 26 };
const BAR_COUNT = { coarse: 4, fine: 7, micro: 7 };
const RAKE_STEPS = 5;

const cxs = (...p) => p.filter(Boolean).join(' ');

export function ScreeningSymbol({ opType = 'screening', data, state, snap }) {
  const rakeBucket = useRef(undefined);

  const m = snap?.metrics || EMPTY;
  const refs = snap?.refs || EMPTY;
  const params = data?.params || EMPTY;
  const errored = state === 'error' || m.error != null;

  // ── RATE — Class A, and the whole point of this file ──
  const s = drive(num(m.screenings_kg_d), 0, num(refs.screenRef) ?? 1);
  const raking = s != null && s > 0 && !errored && state !== 'off';
  let rakeDur = null;
  if (raking) {
    const idx = bucket(s, RAKE_STEPS, rakeBucket.current);
    rakeBucket.current = idx;
    rakeDur = secs(clamp(9 - 6.5 * (idx / (RAKE_STEPS - 1)), 2.5, 9));
  }

  // ── STATIC, Class C. `headloss_m` is an echo: opacity and height only ──
  const hl = num(m.headloss_m);
  const hn = hl == null ? null : clamp(hl / 0.30, 0, 1);
  const diff = hn == null ? 0 : 10 * hn;
  const blind = hn == null ? 0 : clamp(0.10 + 0.30 * hn, 0, 0.45);
  const watch = hl != null && hl > 0.45 && !errored;

  // `TSS_removal_pct` is a STRING — parse before comparing (num() does).
  const removal = num(m.TSS_removal_pct);
  const screenType = typeof m.screenType === 'string' ? m.screenType
    : typeof params.screenType === 'string' ? params.screenType
      : removal == null ? 'coarse' : removal >= 25 ? 'micro' : removal >= 10 ? 'fine' : 'coarse';
  const bars = BAR_COUNT[screenType] ?? BAR_COUNT.coarse;

  const shell = errored ? ALARM : watch ? WATCH : INK;
  const nodeState = errored ? 'error' : watch ? 'watch' : 'rest';

  const barLines = [];
  for (let i = 0; i < bars; i++) {
    const x = RACK.x + ((i + 0.5) * RACK.w) / bars;
    barLines.push(
      <line key={i} x1={x} y1={RACK.y + 1} x2={x} y2={RACK.y + RACK.h - 1} {...ink('media', INK_SOFT)} />
    );
  }

  return (
    <g
      className="ws-sym ws-sym--screening"
      data-op={opType}
      data-state={nodeState}
      data-watch={watch ? 'true' : undefined}
      data-screen-type={screenType}
      aria-hidden="true"
    >
      <title>
        {`Bar screen (${screenType})${hl != null ? ` — headloss setpoint ${hl} m` : ''}`}
      </title>

      {/* ── Up/downstream levels. DASHED: the engine computes no water level
             here at all, and §3.3 says an uncomputed surface is never drawn
             solid. The 10px differential is the headloss SETPOINT. ── */}
      <line
        className="ws-media" x1={4} y1={36 - diff} x2={43} y2={36 - diff}
        {...ink('media', WATER)} strokeDasharray="3 3" opacity={0.85}
      />
      <line
        className="ws-media" x1={72} y1={36} x2={92} y2={36}
        {...ink('media', WATER)} strokeDasharray="3 3" opacity={0.85}
      />

      {/* ── Skip + its STATIC screenings fill ── */}
      <path
        className="ws-detail"
        d={`M ${SKIP.x} ${SKIP.y} L ${SKIP.x} ${SKIP.y + SKIP.h} L ${SKIP.x + SKIP.w} ${SKIP.y + SKIP.h} L ${SKIP.x + SKIP.w} ${SKIP.y}`}
        {...ink('detail', shell)}
      />
      <Fill
        x={SKIP.x + 1} y={SKIP.y + 2} w={SKIP.w - 2} h={SKIP.h - 3}
        level={s} color={SLUDGE} opacity={0.5} className="ws-skip-fill"
      />

      {/* chute from the head of the rack to the skip */}
      <line className="ws-detail" x1={77} y1={14} x2={93} y2={19} {...ink('detail', INK_SOFT)} />

      {/* ── The rack. Everything inside leans together, so the carriage's
             translate runs along the rack axis for free. ── */}
      <g transform={`rotate(${RACK.lean} ${RACK.cx} ${RACK.cy})`}>
        {/* blinding — a Class-C opacity, never a rate */}
        {blind > 0 && (
          <rect
            className="ws-media ws-blinding"
            x={RACK.x} y={RACK.y} width={RACK.w} height={RACK.h}
            fill={watch ? WATCH : INK_SOFT} opacity={blind}
            data-blinding={blind.toFixed(2)}
          />
        )}
        {screenType === 'micro' && (
          <rect
            className="ws-media"
            x={RACK.x} y={RACK.y} width={RACK.w} height={RACK.h}
            fill={paint(DEF_IDS.stippleFloc)} opacity={0.6}
          />
        )}
        <g className="ws-media">{barLines}</g>
        <rect
          className="ws-shell"
          x={RACK.x} y={RACK.y} width={RACK.w} height={RACK.h}
          {...ink('shell', shell)}
        />
        {/* rake carriage — parked at the foot when there is nothing to rake */}
        <g
          className={cxs('ws-detail', raking && 'ws-anim', raking && 'ws-rake-travel')}
          style={raking ? { '--ws-rake-dur': rakeDur } : undefined}
          data-rake={rakeDur || 'parked'}
        >
          <rect x={RACK.x + 1} y={CARRIAGE_Y} width={RACK.w - 2} height={3.5} rx={1} fill={SLUDGE} opacity={0.85} />
          <line
            x1={RACK.x + 1} y1={CARRIAGE_Y} x2={RACK.x + RACK.w - 1} y2={CARRIAGE_Y}
            {...ink('detail', shell)}
          />
        </g>
      </g>
    </g>
  );
}

registerSymbol('screening', ScreeningSymbol);

export default ScreeningSymbol;
