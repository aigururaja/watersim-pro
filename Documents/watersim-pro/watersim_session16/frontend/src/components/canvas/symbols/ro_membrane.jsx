/**
 * #23 `ro_membrane` / #24 `uf_membrane` — pressure-vessel membranes
 * (spec §3.2 #23/#24, §5.3 #14)
 * ─────────────────────────────────────────────────────────────────────────────
 * ONE implementation, two specialisations, because the two units share a
 * capsule shell, a feed nozzle and a two-way split and differ only in their
 * internals — and, crucially, in WHICH MODEL ACTUALLY RUNS behind them:
 *
 *   ro_membrane -> `roMembrane.js`  (PALETTE_TYPE_MAP.ro_membrane = 'ro')
 *   uf_membrane -> `screen.js`      (PALETTE_TYPE_MAP.uf_membrane = 'screen')
 *
 * That is not a detail. A UF drawn here has NO `pressure_bar` and NO
 * `recovery_pct` in its metrics, because the screen model does not return them.
 * So the UF gets no gauge (which §3.2 #24 already required) and no shimmer —
 * not because we chose restraint, but because there is no number to encode.
 * Inventing one would be exactly the failure this spec exists to prevent.
 *
 * ── DRIVERS (RO) ─────────────────────────────────────────────────────────────
 *   pressure_bar  C — ECHO (roMembrane.js:77). Drives an ANGLE, never a loop:
 *                 needle = -120deg + 240deg x (pressure_bar/80), a 500ms
 *                 TRANSITION on `.ws-needle`. Labelled a setpoint.
 *   recovery_pct  C — ECHO (roMembrane.js:76). Drives the shimmer's OPACITY
 *                 (0.10 + 0.25 x pct/100). The shimmer's PERIOD is a FIXED 3s;
 *                 an echo may never set a period.
 *   amber when `recovery_pct > 85 || pressure_bar > 70`.
 *
 * ── THE RECOVERY SPLIT ANIMATES ITSELF, FOR FREE ─────────────────────────────
 * `perm_Q_m3_d` and `conc_Q_m3_d` (roMembrane.js:78-79, both Class A) reach the
 * canvas as the Q of the two EDGES leaving this vessel, and the edge component
 * takes each pulse rate from its own Q. So a 75% recovery shows as two visibly
 * different pulse rates leaving one shell with no code here at all. Our only
 * job is to make the two stubs unmistakable: permeate TEAL on the centreline,
 * concentrate OCHRE off the bottom-right, per the service palette.
 *
 * ── DRIVERS (UF) ─────────────────────────────────────────────────────────────
 *   headloss_m    C — ECHO (screen.js:78). Amber above 0.45, the same static
 *                 threshold §5.3 #12 uses for this same metric on this same
 *                 model. Static only; it never drives anything that moves.
 */

import { registerSymbol } from './index';
import { Shell, Nozzle, GEO, ink, clamp } from './primitives';
import { getNodeSnapshot, num } from '../liveStore';

const INK = 'var(--ws-ink-700, #1E293B)';
const SOFT = 'var(--ws-ink-400, #94A3B8)';
const PERMEATE = 'var(--ws-svc-permeate, #0D9488)';
const OCHRE = 'var(--ws-svc-recycle, #B45309)';
const WATCH = 'var(--ws-watch, #D97706)';

const P = GEO.pill;                     // x 28..116, y 12..48
const GAUGE = Object.freeze({ cx: 94, cy: 6, r: 5 });

/** Fixed 3s — an indicator, never a rate (§5.3 #14). Must translate exactly
 *  one `ws-drift` period (40px) so frame 100% == frame 0% under the
 *  reduced-motion snap (§6.5). */
const SHIMMER_PERIOD = '3.00s';
const SHIMMER_PITCH = 40;
const SHIMMER_X = [-12, 28, 68, 108, 148];

/**
 * Archimedean spiral glyph — the ISA mark that says "spiral-wound element".
 * Built ONCE at module scope: it is a constant, not per-render work.
 */
const SPIRAL_D = (() => {
  const cx = 44, cy = 30, tMax = 2.5 * 2 * Math.PI, a = 10 / tMax;
  let d = '';
  for (let t = 0; t <= tMax + 1e-9; t += 0.35) {
    const r = a * t;
    d += `${d ? ' L ' : 'M '}${(cx + r * Math.cos(t)).toFixed(2)} ${(cy + r * Math.sin(t)).toFixed(2)}`;
  }
  return d;
})();

/** Needle angle, spec verbatim. `null` pressure -> the ZERO mark, not 0deg. */
export function needleAngle(pressureBar) {
  const p = num(pressureBar);
  if (p == null) return -120;
  return clamp(-120 + 240 * (p / 80), -120, 120);
}

const uid = (id) => String(id ?? '').replace(/[^A-Za-z0-9_-]/g, '') || 'x';

/**
 * @param {'ro'|'uf'} variant  which model actually runs behind this symbol
 */
export function MembraneSymbol({ nodeId, state, snap, variant = 'ro' }) {
  const s = snap || getNodeSnapshot(nodeId);
  const m = s?.metrics || {};
  const err = !!m.error || state === 'error';
  const isRo = variant !== 'uf';
  const bore = `wsMemBore_${uid(nodeId)}`;

  const pressure = isRo ? num(m.pressure_bar) : null;
  const recovery = isRo ? num(m.recovery_pct) : null;
  const headloss = isRo ? null : num(m.headloss_m);

  const angle = needleAngle(pressure);

  // Shimmer: opacity is the setpoint encoder, period is fixed. With no
  // recovery figure there is nothing to encode, so nothing mounts.
  const motion = !!s?.live && !err && state !== 'off' && recovery != null;
  const shimmerO = recovery == null ? 0 : clamp(0.10 + 0.25 * (recovery / 100), 0.10, 0.35);

  const watch = isRo
    ? ((recovery != null && recovery > 85) || (pressure != null && pressure > 70))
    : (headloss != null && headloss > 0.45);

  // Idle -> needle at zero, no shimmer, ink 45% (§5.3 #14). The SHELL stays at
  // full ink so the glyph is still legible as a 24x18 palette legend chip.
  const idleInk = s?.hasResults && !err ? 1 : 0.45;

  return (
    <g aria-hidden="true" data-symbol={isRo ? 'ro_membrane' : 'uf_membrane'}>
      <Shell.Pill clipId={bore} />

      {/* ── Shimmer: translateX inside the shell clipPath, fixed 3s ───────── */}
      {motion && (
        <g clipPath={`url(#${bore})`}>
          <g
            className="ws-anim ws-wave ws-internals"
            data-shimmer="1"
            style={{ '--ws-drift': SHIMMER_PERIOD }}
            opacity={shimmerO}
          >
            {SHIMMER_X.map((x) => (
              <rect key={x} x={x} y={P.y + 1} width={7} height={P.h - 2} fill={PERMEATE} />
            ))}
            {/* bbox anchor: pins the group's box to a whole number of pitches */}
            <rect x={-12} y={P.y} width={SHIMMER_X.length * SHIMMER_PITCH} height={P.h} fill="none" stroke="none" />
          </g>
        </g>
      )}

      {/* ── Internals ───────────────────────────────────────────────────────── */}
      <g className="ws-internals" opacity={idleInk}>
        {isRo ? (
          <>
            {/* two element divisions */}
            <line x1={57} y1={P.y + 2} x2={57} y2={P.y + P.h - 2} {...ink('detail', SOFT)} />
            <line x1={86} y1={P.y + 2} x2={86} y2={P.y + P.h - 2} {...ink('detail', SOFT)} />
            <path className="ws-detail" d={SPIRAL_D} {...ink('media', SOFT)} />
          </>
        ) : (
          <g className="ws-detail">
            {/* five hollow-fibre lines + potting end plates, and NO gauge */}
            {[18, 24, 30, 36, 42].map((y) => (
              <line key={y} x1={36} y1={y} x2={108} y2={y} {...ink('media', SOFT)} />
            ))}
            <line x1={34} y1={P.y + 3} x2={34} y2={P.y + P.h - 3} {...ink('detail', SOFT)} />
            <line x1={110} y1={P.y + 3} x2={110} y2={P.y + P.h - 3} {...ink('detail', SOFT)} />
          </g>
        )}
      </g>

      {/* ── Pressure gauge on the crown — RO only ───────────────────────────── */}
      {isRo && (
        <g className="ws-detail" data-gauge="pressure">
          <line x1={GAUGE.cx} y1={GAUGE.cy + GAUGE.r} x2={GAUGE.cx} y2={P.y} {...ink('media', SOFT)} />
          <circle cx={GAUGE.cx} cy={GAUGE.cy} r={GAUGE.r} {...ink('detail', INK)} fill="var(--ws-card, #FFFFFF)" />
          {[-120, 0, 120].map((t) => {
            const rad = (t * Math.PI) / 180;
            const dx = Math.sin(rad), dy = -Math.cos(rad);
            return (
              <line
                key={t}
                x1={GAUGE.cx + dx * 3.0} y1={GAUGE.cy + dy * 3.0}
                x2={GAUGE.cx + dx * 4.3} y2={GAUGE.cy + dy * 4.3}
                {...ink('media', SOFT)}
              />
            );
          })}
          {/* A TRANSITION, not a loop — 500ms via `.ws-needle`. An echo may
              move a needle; it may never set a period. */}
          <g
            className="ws-needle ws-origin-v"
            data-angle={angle.toFixed(1)}
            style={{
              transformBox: 'view-box',
              transformOrigin: `${GAUGE.cx}px ${GAUGE.cy}px`,
              '--ws-origin': `${GAUGE.cx}px ${GAUGE.cy}px`,
              transform: `rotate(${angle.toFixed(1)}deg)`,
            }}
          >
            <line x1={GAUGE.cx} y1={GAUGE.cy} x2={GAUGE.cx} y2={GAUGE.cy - 3.6} {...ink('detail', INK)} />
          </g>
        </g>
      )}

      {/* ── Ports: feed, permeate (teal, centreline), concentrate (ochre,
             bottom-right). Two different services, two different colours, two
             different exits — so the two pulse rates read as one split. ───── */}
      <Nozzle x={P.x - 6} y={30} dir="right" color={INK} />
      <g data-port="permeate">
        <Nozzle x={P.x + P.w} y={30} dir="right" len={8} color={PERMEATE} className="ws-port-permeate" />
      </g>
      <g data-port="concentrate">
        <Nozzle x={96} y={P.y + P.h} dir="down" len={7} color={OCHRE} className="ws-port-concentrate" />
      </g>

      {watch && (
        <rect
          className="ws-ring ws-ring--watch"
          data-ring="watch"
          x={P.x - 3} y={P.y - 3} width={P.w + 6} height={P.h + 6} rx={(P.h + 6) / 2}
          {...ink('detail', WATCH)}
        />
      )}

      <title>
        {isRo
          ? `RO element — ${pressure == null ? 'no' : `${pressure} bar`} feed pressure (setpoint), ${recovery == null ? 'no' : `${recovery}%`} recovery`
          : `UF element — ${headloss == null ? 'no' : `${headloss} m`} head loss (setpoint)`}
      </title>
    </g>
  );
}

export function RoMembraneSymbol(props) {
  return <MembraneSymbol {...props} variant="ro" />;
}

registerSymbol('ro_membrane', RoMembraneSymbol);

export default RoMembraneSymbol;
