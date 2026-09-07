/**
 * `equalisation_tank` — EQT, INT-WT, SHT, Sintex, IRR-WT, FWT, SWT
 * ─────────────────────────────────────────────────────────────────────────────
 * Six of the ITC plant's vessels are this symbol, and the temptation with a
 * buffer tank is always the same: draw a level and let it move. This one does
 * not, and the reason is the same one `tank.jsx` gives — with a caveat that
 * makes this symbol MORE informative than that one, not less.
 *
 * ── WHAT THE ENGINE ACTUALLY COMPUTES ────────────────────────────────────────
 * `equalisationTank.js` returns HRT_h, turnovers_per_day, usable_volume_m3,
 * buffer_hours and peak_absorbed_h. Every one of those is a DURATION or a RATE.
 * None of them is a level. The steady-state solver has no accumulation term, so
 * a level drawn here would be a constant dressed as a measurement.
 *
 * What IS real and drawable is the vessel's WORKING BAND: the low- and
 * high-level setpoints are numbers the operator set and the plant's level
 * transmitters are wired against, so the two hairlines are honest geometry.
 * They are drawn SOLID because a setpoint is a fact, and the band between them
 * is tinted — but the band is a band, not a fill: it starts at the low
 * setpoint, not at the floor, so it can never be misread as a liquid depth.
 *
 * ── DRIVERS ──────────────────────────────────────────────────────────────────
 *   low_level_pct / high_level_pct   setpoints    → hairline positions
 *   peak_absorbed_h < 1              computed     → the surge chevron is drawn
 *                                                   hollow; the node's own
 *                                                   watch ring carries severity
 *   has_level_switch                 categorical  → a switch float instead of a
 *                                                   transmitter standpipe
 *   turnovers_per_day                computed     → printed in the footer only
 *
 * Nothing loops. Nothing here is a rate that could drive one.
 */

import { registerSymbol } from './index';
import { Shell, Nozzle, GEO, ink, clamp } from './primitives';
import { getNodeSnapshot, num } from '../liveStore';

const INK = 'var(--ws-ink-700, #1E293B)';
const SOFT = 'var(--ws-ink-400, #94A3B8)';
const WATER = 'var(--ws-svc-water, #2E75B6)';
const WATCH = 'var(--ws-watch, #D97706)';

const R = GEO.rect;                       // 30, 6, 84, 48
const IN_X = R.x + 1;
const IN_W = R.w - 2;
const FLOOR = R.y + R.h - 2;              // 52
const CEIL = R.y + 4;                     // 10
const SPAN = FLOOR - CEIL;                // 42

const uid = (id) => String(id ?? '').replace(/[^A-Za-z0-9_-]/g, '') || 'x';

/** Setpoint percentage → a y in the vessel interior. */
const yOf = (pct) => FLOOR - (clamp(pct, 0, 100) / 100) * SPAN;

export function EqualisationTankSymbol({ nodeId, data, snap }) {
  const s = snap || getNodeSnapshot(nodeId);
  const m = s?.metrics || {};
  const bowl = `wsEqBowl_${uid(nodeId)}`;

  const params = data?.params || {};
  const low = num(m.low_level_pct) ?? num(params.low_level_pct) ?? 20;
  const high = num(m.high_level_pct) ?? num(params.high_level_pct) ?? 90;
  const lowY = yOf(low);
  const highY = yOf(high);
  const bandTop = Math.min(lowY, highY);
  const bandH = Math.max(0, Math.abs(lowY - highY));

  const isSwitch = num(m.level_instrument) == null
    ? String(m.level_instrument || '').startsWith('Level switch') || !!num(params.has_level_switch)
    : false;

  const surge = num(m.peak_absorbed_h);
  const tight = surge != null && surge < 1;
  const turnovers = num(m.turnovers_per_day);
  const hrt = num(m.HRT_h);

  return (
    <g aria-hidden="true" data-symbol="equalisation_tank">
      <Shell.Rect clipId={bowl} rx={2} />

      {/* The WORKING BAND between the two setpoints. Not a level: it is bounded
          below by the low setpoint, so it never touches the floor. */}
      {bandH > 0 && (
        <g clipPath={`url(#${bowl})`}>
          <rect x={IN_X} y={bandTop} width={IN_W} height={bandH} fill={WATER} opacity={0.16} />
        </g>
      )}

      {/* Setpoint hairlines — solid, because a setpoint is a number. */}
      <line x1={IN_X} y1={highY} x2={IN_X + IN_W} y2={highY} {...ink('media', tight ? WATCH : SOFT)} />
      <line x1={IN_X} y1={lowY} x2={IN_X + IN_W} y2={lowY} {...ink('media', SOFT)} />

      {/* H / L marks, so the two hairlines are never ambiguous. */}
      <g className="ws-detail" fill={SOFT} stroke="none"
         style={{ font: '700 7px var(--ws-font-mono, ui-monospace, Menlo, Consolas, monospace)' }}>
        <text x={IN_X + 3} y={highY - 2}>H</text>
        <text x={IN_X + 3} y={lowY + 7}>L</text>
      </g>

      {/* Level instrument: a standpipe with a transmitter head, or a hung float
          switch when only a switch is fitted. The proposal wires both kinds. */}
      {isSwitch ? (
        <g className="ws-detail">
          <line x1={R.x + R.w - 14} y1={R.y + 1} x2={R.x + R.w - 14} y2={highY} {...ink('media', INK)} />
          <circle cx={R.x + R.w - 14} cy={highY + 2} r={2.4} {...ink('media', INK)} />
        </g>
      ) : (
        <g className="ws-detail">
          <line x1={R.x + R.w - 14} y1={R.y + 1} x2={R.x + R.w - 14} y2={FLOOR} {...ink('media', INK)} />
          <rect x={R.x + R.w - 19} y={R.y - 4} width={10} height={6} rx={1} {...ink('detail', INK)} />
        </g>
      )}

      {/* Surge chevron: filled when the tank can hold an hour of peak inflow,
          hollow when it cannot. A state, drawn once, never animated. */}
      <path
        d={`M ${R.x + 8} ${CEIL + 6} l 5 -5 l 5 5`}
        {...ink('detail', tight ? WATCH : SOFT)}
        fill={tight ? 'none' : SOFT}
      />

      <Nozzle x={R.x - 8} y={R.y + 10} dir="right" len={8} color={INK} />
      <Nozzle x={R.x + R.w} y={FLOOR - 4} dir="right" len={8} color={INK} />

      <title>
        {hrt != null
          ? `Buffer tank — ${hrt.toFixed(1)} h retention`
            + (turnovers != null ? `, ${turnovers.toFixed(2)} turnovers/day` : '')
            + (surge != null ? `, ${surge.toFixed(1)} h of surge capacity` : '')
            + '. The band shows the working level setpoints; no level is simulated.'
          : 'Buffer tank — the band shows the working level setpoints. No level is simulated.'}
      </title>
    </g>
  );
}

registerSymbol('equalisation_tank', EqualisationTankSymbol);

export default EqualisationTankSymbol;
