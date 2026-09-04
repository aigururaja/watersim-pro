/**
 * chemical_dosing — and the shared body of the whole dosing family
 * (spec §3.2 #18–#21, §5.3 #16)
 * ─────────────────────────────────────────────────────────────────────────────
 * "Trapezoidal day-tank pot on a stand + dip pipe + injection quill into the
 *  process line", distinguished only by the MARK on the pot:
 *
 *   #18 chemical_dosing  plain drum mark
 *   #19 coagulant_dosing hex crystal   (Al / Fe)
 *   #20 polymer_dosing   coiled chain
 *   #21 ph_adjustment    half-filled pH bar + up/down arrow
 *
 * `coagulant_dosing.jsx`, `polymer_dosing.jsx` and `ph_adjustment.jsx` import
 * `DosingSymbol` from here and pass a `variant`. One drawing, four marks — the
 * four types share one model (`chemicalDosing.js`), so they must share one
 * symbol or they will drift apart.
 *
 * THE DRIVER IS `dose_kg_d`, NOT `dose_mg_L`.
 *   `chemicalDosing.js:143` returns `dose_mg_L: +dose.toFixed(2)` — a VERBATIM
 *   ECHO of the parameter. `dose_kg_d` (`:108`, `Q × dose / 1000`) is the
 *   plant-driven one: it moves when the flow reaching the quill moves, which is
 *   what a falling droplet is claiming.
 *
 *     d = drive(dose_kg_d, 0, refs.doseRef)              ← Class A
 *     P = clamp(3.0 − 2.5·d, 0.5, 3.0)s, 5 buckets, 15% hysteresis
 *
 * REFUSAL: `dose_mg_L === 0`, or `dose_kg_d` null or zero → NO DROPLET IS
 * MOUNTED and the stinger is capped grey. "Dosing very slowly" and "not dosing"
 * must not look the same.
 *
 * ph_adjustment additionally tints the RECEIVING liquid — the process line
 * downstream of the quill — from the COMPUTED `pH_out` on a litmus ramp, and
 * flags watch when |pH_out − pH_in| > 1.5.
 *
 * DROPLET MECHANICS: `.ws-droplet` is wired to the shared `ws-bubble` keyframe,
 * which travels −34px (upward, for aeration). A droplet must FALL, and this
 * lane may not add a keyframe, so the droplet lives in a group carrying a
 * static `scale(k, −k)`: the flip turns the rise into a fall and the uniform
 * scale maps the keyframe's fixed 34px onto the 11px stinger. The child is a
 * circle, so the flip is invisible. Zero new keyframes, zero JS timing.
 */

import { useRef } from 'react';
import { registerSymbol } from './index';
import { ink, clamp } from './primitives';
import { num, drive, bucket, secs } from '../liveStore';

const EMPTY = Object.freeze({});
const INK_SOFT = 'var(--ws-ink-400, #94A3B8)';
const ALARM = 'var(--ws-alarm, #DC2626)';
const WATCH = 'var(--ws-watch, #D97706)';
const WATER = 'var(--ws-svc-water, #2E75B6)';
const CHEM = 'var(--ws-svc-chem, #7C3AED)';
const NOMODEL = 'var(--ws-nomodel, #64748B)';

const QUILL_X = 67;
const LINE_Y = 30;
const DROP_TOP = 18;
const DROP_BOT = 29;
const DROP_TRAVEL = DROP_BOT - DROP_TOP;       // 11px on screen
const KEYFRAME_TRAVEL = 34;                    // the fixed -34px of ws-bubble
const K = DROP_TRAVEL / KEYFRAME_TRAVEL;       // uniform flip-scale
const DROP_R = 2 / K;                          // so it renders at r = 2
const POT = 'M 44 3 L 90 3 L 84 17 L 50 17 Z';
const DOSE_STEPS = 5;

/* Litmus ramp anchored on the design tokens' own literals — acidic
   `--ws-alarm`, neutral `--ws-ok`, alkaline `--ws-svc-chem`. This is a STATIC
   data encoding, not an animated value, so §1.1's "no animated value may be an
   inline hard-coded colour" does not apply; interpolating var() is not
   possible without color-mix(), which we do not depend on. */
const LITMUS = [
  [4, [220, 38, 38]],
  [7, [21, 128, 61]],
  [10, [124, 58, 237]],
];

function litmus(ph) {
  const v = clamp(ph, LITMUS[0][0], LITMUS[LITMUS.length - 1][0]);
  for (let i = 1; i < LITMUS.length; i++) {
    const [x1, c1] = LITMUS[i - 1];
    const [x2, c2] = LITMUS[i];
    if (v <= x2) {
      const t = (v - x1) / (x2 - x1);
      const r = Math.round(c1[0] + (c2[0] - c1[0]) * t);
      const g = Math.round(c1[1] + (c2[1] - c1[1]) * t);
      const b = Math.round(c1[2] + (c2[2] - c1[2]) * t);
      return `rgb(${r}, ${g}, ${b})`;
    }
  }
  return WATER;
}

const HEX = 'M 78 10.5 L 75.25 15.26 L 69.75 15.26 L 67 10.5 L 69.75 5.74 L 75.25 5.74 Z';
const COIL = 'M 65 12.5 q 2.5 -7 5 0 q 2.5 7 5 0 q 2.5 -7 5 0';

/** The one thing that differs between the four dosing types. */
function Mark({ variant, color, phOut, phIn }) {
  if (variant === 'coagulant_dosing') {
    return <path className="ws-internals" d={HEX} {...ink('detail', color)} />;
  }
  if (variant === 'polymer_dosing') {
    return <path className="ws-internals" d={COIL} {...ink('detail', color)} />;
  }
  if (variant === 'ph_adjustment') {
    const frac = phOut == null ? 0.5 : clamp(phOut / 14, 0, 1);
    const h = 9 * frac;
    const up = phOut != null && phIn != null && phOut >= phIn;
    return (
      <g className="ws-internals" data-ph={phOut == null ? undefined : phOut.toFixed(2)}>
        <rect x={62} y={6} width={12} height={9} rx={1} {...ink('detail', color)} />
        <rect x={62} y={15 - h} width={12} height={h} fill={color} opacity={0.45} />
        <path
          d={up ? 'M 80 15 L 80 6 M 77.5 8.5 L 80 6 L 82.5 8.5' : 'M 80 6 L 80 15 M 77.5 12.5 L 80 15 L 82.5 12.5'}
          {...ink('detail', color)}
        />
      </g>
    );
  }
  // #18 — plain drum mark
  return (
    <g className="ws-internals">
      <rect x={66} y={6} width={12} height={9} rx={1.5} {...ink('detail', color)} />
      <line x1={66} y1={9} x2={78} y2={9} {...ink('media', color)} />
      <line x1={66} y1={12} x2={78} y2={12} {...ink('media', color)} />
    </g>
  );
}

export function DosingSymbol({ variant = 'chemical_dosing', state, snap }) {
  const doseBucket = useRef(undefined);

  const m = snap?.metrics || EMPTY;
  const refs = snap?.refs || EMPTY;
  const live = !!snap?.live;
  const errored = state === 'error' || m.error != null;

  // ── RATE — Class A. `dose_mg_L` is an echo and never touches a duration. ──
  const doseKg = num(m.dose_kg_d);
  const doseMg = num(m.dose_mg_L);
  const capped = doseKg == null || doseKg <= 0 || doseMg === 0;
  const d = capped ? null : drive(doseKg, 0, num(refs.doseRef) ?? 1);

  const dosing = !capped && d != null && !errored && state !== 'off';
  let dropDur = null;
  if (dosing) {
    const idx = bucket(d, DOSE_STEPS, doseBucket.current);
    doseBucket.current = idx;
    dropDur = secs(clamp(3.0 - 2.5 * (idx / (DOSE_STEPS - 1)), 0.5, 3.0));
  }
  // Existence gate (§6.3b): a droplet is meaningless without values.
  const dripping = dosing && live && dropDur != null;

  // ── ph_adjustment only: the receiving liquid's hue, from the COMPUTED pH ──
  const isPh = variant === 'ph_adjustment';
  const phOut = num(m.pH_out);
  const phIn = num(m.pH_in);
  const phWatch = isPh && phOut != null && phIn != null && Math.abs(phOut - phIn) > 1.5;
  const receiving = isPh && phOut != null ? litmus(phOut) : WATER;

  const watch = phWatch && !errored;
  const shell = errored ? ALARM : watch ? WATCH : CHEM;
  const stinger = capped ? NOMODEL : shell;
  const nodeState = errored ? 'error' : watch ? 'watch' : capped ? 'nomodel' : 'rest';

  return (
    <g
      className={`ws-sym ws-sym--dosing ws-sym--${variant}`}
      data-op={variant}
      data-state={nodeState}
      data-watch={watch ? 'true' : undefined}
      data-capped={capped ? 'true' : undefined}
      aria-hidden="true"
    >
      <title>
        {capped
          ? 'Chemical dosing — not dosing'
          : isPh && phOut != null
            ? `pH adjustment — pH out ${phOut.toFixed(2)}`
            : `Chemical dosing — ${doseKg.toFixed(1)} kg/d`}
      </title>

      {/* ── Process line. The downstream half is the RECEIVING liquid, which
             ph_adjustment tints from the computed pH_out. ── */}
      <line className="ws-detail" x1={4} y1={LINE_Y} x2={QUILL_X} y2={LINE_Y} {...ink('detail', WATER)} />
      <line
        className="ws-detail ws-receiving"
        x1={QUILL_X} y1={LINE_Y} x2={140} y2={LINE_Y}
        {...ink('detail', receiving)}
        data-receiving={isPh ? receiving : undefined}
      />

      {/* ── Day-tank pot on a stand ── */}
      <path className="ws-shell" d={POT} {...ink('shell', shell)} />
      {/* DASHED: §3.3 — the engine computes no day-tank level, so this surface
          is never drawn solid and is never animated. */}
      <line className="ws-media" x1={48} y1={11.5} x2={86} y2={11.5} {...ink('media', shell)} strokeDasharray="3 3" opacity={0.7} />
      <line className="ws-media" x1={57} y1={5} x2={57} y2={19} {...ink('media', shell)} />
      <line className="ws-detail" x1={54} y1={17} x2={54} y2={22} {...ink('media', INK_SOFT)} />
      <line className="ws-detail" x1={80} y1={17} x2={80} y2={22} {...ink('media', INK_SOFT)} />

      <Mark variant={variant} color={shell} phOut={phOut} phIn={phIn} />

      {/* ── Stinger + injection quill. Capped grey when not dosing. ── */}
      <line className="ws-detail" x1={QUILL_X} y1={17} x2={QUILL_X} y2={LINE_Y} {...ink('detail', stinger)} />
      {capped
        ? <line className="ws-detail ws-cap" x1={QUILL_X - 4} y1={LINE_Y - 3} x2={QUILL_X + 4} y2={LINE_Y - 3} {...ink('detail', NOMODEL)} />
        : <rect className="ws-detail" x={QUILL_X - 2.5} y={22} width={5} height={6} rx={1} {...ink('media', stinger)} />}

      {/* ── The droplet. Static flip-scale group turns ws-bubble's rise into a
             fall and maps its fixed 34px onto the 11px stinger. ── */}
      {dripping && (
        <g transform={`translate(${QUILL_X}, ${DROP_BOT}) scale(${K.toFixed(4)}, ${(-K).toFixed(4)})`}>
          <circle
            className="ws-anim ws-droplet"
            cx={0} cy={KEYFRAME_TRAVEL} r={DROP_R.toFixed(2)}
            fill={CHEM}
            style={{ '--ws-droplet-dur': dropDur, '--ws-bubble-o': 0.9 }}
            data-drop-dur={dropDur}
          />
        </g>
      )}
    </g>
  );
}

function ChemicalDosingSymbol(props) {
  return <DosingSymbol {...props} variant="chemical_dosing" />;
}

registerSymbol('chemical_dosing', ChemicalDosingSymbol);

export default ChemicalDosingSymbol;
