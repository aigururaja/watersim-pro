/**
 * #15 `uv_disinfection` — UV channel   (spec §3.2 #15, §5.3 #13, §5.4)
 * ─────────────────────────────────────────────────────────────────────────────
 * Two encoders that look alike and are NOT alike, which is the whole point of
 * this symbol:
 *
 *   SLEEVE COUNT is Class A.  `lamp_count = max(1, ceil(Q_m3_h / rating))`
 *   (uvDisinfection.js:72) is genuinely flow-driven — raise the plant flow and
 *   the drawn bank grows. Clamped to 2..6 for the frame.
 *
 *   GLOW OPACITY is Class B, and STATIC.  `fluence / required` reduces
 *   algebraically to `sqrt(UVT_pct / 65)` (uvDisinfection.js:80-84) — the flow
 *   cancels completely. It is a SETPOINT, so it may set an opacity and may
 *   never set a rate, and the ⓘ copy ships verbatim:
 *     "Lamp brightness shows dose adequacy from your UV transmittance
 *      setpoint. It does not change with flow; the number of lamp sleeves does."
 *
 * The breathe period is a FIXED 1.8s — a powered indicator, not a rate.
 *
 * `compliant === false` -> RED and THE BREATHE STOPS. A dark reactor is the
 * correct picture for a UV not achieving its dose; a cheerfully pulsing lamp
 * bank on a non-compliant unit would be the single most dangerous animation on
 * this canvas.
 *
 * The glow is a <radialGradient> (`DEF_IDS.uvGlow`). NO SVG <filter>, no blur,
 * no drop-shadow — here or anywhere else on this canvas (§7).
 */

import { registerSymbol } from './index';
import { DEF_IDS, paint } from './defs';
import { Shell, Nozzle, GEO, ink, clamp } from './primitives';
import { getNodeSnapshot, num } from '../liveStore';

const INK = 'var(--ws-ink-700, #1E293B)';
const SOFT = 'var(--ws-ink-400, #94A3B8)';
const UV = 'var(--ws-svc-chem, #7C3AED)';
const WATCH = 'var(--ws-watch, #D97706)';
const ALARM = 'var(--ws-alarm, #DC2626)';

// Horizontal channel capsule: x 28..116, y 12..48 (spec §3.2 #15).
const P = GEO.pill;
const BANK = Object.freeze({ x0: 40, x1: 104, top: 17, bot: 43, w: 5 });

/** A powered indicator, not a rate — fixed everywhere (§5.3 #13). */
const BREATHE_OK = '1.80s';
/** The one exception: a dose deficit quickens it, exactly like a watch state. */
const BREATHE_DEFICIT = '0.90s';

const uid = (id) => String(id ?? '').replace(/[^A-Za-z0-9_-]/g, '') || 'x';

export function UvDisinfectionSymbol({ nodeId, state, snap }) {
  const s = snap || getNodeSnapshot(nodeId);
  const m = s?.metrics || {};
  const err = !!m.error || state === 'error';
  const bore = `wsUvBore_${uid(nodeId)}`;

  // ── Class A: the sleeve count really does follow the flow ─────────────────
  const lamps = num(m.lamp_count);
  const n = lamps == null ? 2 : clamp(Math.round(lamps), 2, 6);

  // ── Class B: dose adequacy, a SETPOINT, static only ───────────────────────
  const fl = num(m.fluence_mJ_cm2);
  const req = num(m.required_fluence_mJ_cm2);
  const ratio = (fl != null && req != null && req > 0)
    ? clamp(fl / req, 0.15, 1.0)
    : null;

  const deficit = num(m.log_deficit);
  const compliant = m.compliant;
  const bad = compliant === false;
  const watch = !bad && deficit != null && deficit > 0;

  // A dark reactor is the correct picture for a UV not achieving dose.
  const motion = !!s?.live && !err && !bad && state !== 'off' && ratio != null;
  const amp = ratio == null ? 0 : 0.10 + 0.15 * ratio;
  const lo = ratio == null ? null : clamp(ratio - amp / 2, 0, 1);
  const hi = ratio == null ? null : clamp(ratio + amp / 2, 0, 1);

  const lampInk = bad ? ALARM : (ratio == null ? SOFT : UV);
  const pitch = (BANK.x1 - BANK.x0) / n;

  return (
    <g aria-hidden="true" data-symbol="uv_disinfection" data-lamps={n}>
      <Shell.Pill clipId={bore} />

      {/* ── Glow: ONE rect painted by the shared <radialGradient>. ───────────
          Mounted whenever a dose ratio exists (values always, §6.1) but only
          given the breathe classes when motion is allowed, so `live: false`
          and `compliant: false` both leave a still, correctly-lit reactor. */}
      {ratio != null && (
        <g className="ws-internals" clipPath={`url(#${bore})`}>
          <rect
            className={motion ? 'ws-anim ws-breathe' : undefined}
            data-glow="uv"
            x={P.x + 1} y={P.y + 1} width={P.w - 2} height={P.h - 2}
            fill={paint(DEF_IDS.uvGlow)}
            opacity={motion ? undefined : ratio}
            style={motion ? {
              '--ws-breathe': watch ? BREATHE_DEFICIT : BREATHE_OK,
              '--ws-glow-lo': lo,
              '--ws-glow-hi': hi,
            } : undefined}
          />
        </g>
      )}

      {/* ── Lamp sleeves: N inner capsules. Empty outlines when idle. ──────── */}
      <g className="ws-detail" data-sleeves={n}>
        {Array.from({ length: n }, (_, i) => {
          const cx = BANK.x0 + pitch * (i + 0.5);
          return (
            <rect
              key={i}
              className="ws-sleeve"
              x={cx - BANK.w / 2} y={BANK.top}
              width={BANK.w} height={BANK.bot - BANK.top}
              rx={BANK.w / 2}
              fill={ratio == null ? 'none' : UV}
              fillOpacity={ratio == null ? 0 : 0.18}
              {...ink('detail', lampInk)}
            />
          );
        })}
        {/* Quartz collar — the header the sleeves hang from. */}
        <line x1={BANK.x0 - 4} y1={BANK.top - 2} x2={BANK.x1 + 4} y2={BANK.top - 2} {...ink('media', SOFT)} />
        {/* End plates. */}
        <line x1={34} y1={P.y + 3} x2={34} y2={P.y + P.h - 3} {...ink('detail', SOFT)} />
        <line x1={110} y1={P.y + 3} x2={110} y2={P.y + P.h - 3} {...ink('detail', SOFT)} />
      </g>

      {/* ── Radiating tick rays — the ISA "this emits" mark. ────────────────── */}
      <g className="ws-media">
        {[48, 64, 80, 96].map((rx) => (
          <line key={rx} x1={rx} y1={P.y - 1} x2={rx} y2={P.y - 5} {...ink('media', lampInk)} opacity={ratio ?? 0.4} />
        ))}
      </g>

      <Nozzle x={P.x - 6} y={30} dir="right" color={INK} />
      <Nozzle x={P.x + P.w} y={30} dir="right" color={INK} />

      {/* Static ring — severity is colour, never tempo (§5.3 #19). */}
      {(bad || watch) && (
        <rect
          className={`ws-ring ws-ring--${bad ? 'alarm' : 'watch'}`}
          data-ring={bad ? 'alarm' : 'watch'}
          x={P.x - 3} y={P.y - 3} width={P.w + 6} height={P.h + 6} rx={(P.h + 6) / 2}
          {...ink('detail', bad ? ALARM : WATCH)}
        />
      )}

      <title>
        {ratio == null
          ? 'UV reactor — no results'
          : `UV reactor — ${n} lamp sleeves (flow-driven); dose adequacy ${(ratio * 100).toFixed(0)}% (UVT setpoint)${bad ? '; NOT COMPLIANT' : ''}`}
      </title>
    </g>
  );
}

registerSymbol('uv_disinfection', UvDisinfectionSymbol);

export default UvDisinfectionSymbol;
