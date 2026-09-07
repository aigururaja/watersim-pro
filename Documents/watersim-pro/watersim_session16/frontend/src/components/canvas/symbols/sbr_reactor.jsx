/**
 * `sbr_reactor` — R1 and R2, the ITC plant's sequencing batch reactors
 * ─────────────────────────────────────────────────────────────────────────────
 * The hardest honesty problem in this catalogue, and worth stating plainly.
 *
 * An SBR is defined by its cycle: fill, aerate, settle, decant. The obvious
 * drawing is that cycle in motion — bubbles during aeration, a blanket forming
 * during settle, the decanter lowering. Every one of those would be a lie here,
 * because `runSteadyState` has no clock. It computes a cycle's DURATIONS and its
 * daily average, never a current phase. There is no "now" to animate.
 *
 * So the cycle is drawn as a BAR, not as a performance. The four segment widths
 * are the real computed durations, in proportion, and an engineer reads the
 * plant's whole timing regime off it in one glance — which is more than a
 * looping animation of an invented phase would ever tell them.
 *
 * ── DRIVERS ──────────────────────────────────────────────────────────────────
 *   cycle_h, fill_h, aerate/settle/decant   computed → phase-bar segment widths
 *   MLSS_mg_L                               computed → mixed-liquor tone
 *   capacity_utilisation_pct                computed → the fill mark on the bar
 *   backlog_m3_d > 0                        computed → the overflow chevron is
 *                                           drawn; the node's watch ring carries
 *                                           the severity
 *   decant_TSS_mg_L                         computed → the clear supernatant
 *                                           band above the blanket line
 *
 * The decanter arm is drawn PARKED at its raised position, always. It has a
 * real 45-minute travel in the narrative and no computed position here, and a
 * parked arm is the only pose that is true at every instant the model describes.
 */

import { registerSymbol } from './index';
import { Shell, Nozzle, GEO, ink, clamp } from './primitives';
import { getNodeSnapshot, num } from '../liveStore';

const INK = 'var(--ws-ink-700, #1E293B)';
const SOFT = 'var(--ws-ink-400, #94A3B8)';
const WATER = 'var(--ws-svc-water, #2E75B6)';
const SLUDGE = 'var(--ws-svc-sludge, #78350F)';
const AIR = 'var(--ws-svc-air, #0891B2)';
const WATCH = 'var(--ws-watch, #D97706)';

const R = GEO.rect;                    // 30, 6, 84, 48
const IN_X = R.x + 1;
const IN_W = R.w - 2;
const SURFACE = R.y + 8;               // 14
const BLANKET = R.y + 26;              // 32 — top of the settled sludge
const FLOOR = R.y + R.h - 9;           // 45 — above the phase bar

/** The phase bar occupies the bottom strip of the vessel. */
const BAR = Object.freeze({ y: R.y + R.h - 7, h: 5 });

const PHASE_TOKENS = {
  fill: WATER,
  aerate: AIR,
  settle: SOFT,
  decant: 'var(--ws-svc-permeate, #0D9488)',
};

const uid = (id) => String(id ?? '').replace(/[^A-Za-z0-9_-]/g, '') || 'x';

export function SbrReactorSymbol({ nodeId, data, snap }) {
  const s = snap || getNodeSnapshot(nodeId);
  const m = s?.metrics || {};
  const bowl = `wsSbrBowl_${uid(nodeId)}`;
  const params = data?.params || {};

  const cycle = num(m.cycle_h);
  const phases = [
    ['fill', num(m.fill_h) ?? num(params.fill_h)],
    ['aerate', num(params.aerate_h)],
    ['settle', num(params.settle_h)],
    ['decant', num(params.decant_h)],
  ];
  const totalPhase = phases.reduce((a, [, h]) => a + (h || 0), 0);
  const hasCycle = totalPhase > 0;

  const mlss = num(m.MLSS_mg_L);
  const hasResults = mlss != null || num(m.Q_treated_m3_d) != null;
  const blanketTone = 0.25 + 0.45 * clamp((mlss ?? 0) / 6000, 0, 1);

  const util = num(m.capacity_utilisation_pct);
  const backlog = num(m.backlog_m3_d);
  const over = backlog != null && backlog > 0.5;

  return (
    <g aria-hidden="true" data-symbol="sbr_reactor">
      <Shell.Rect clipId={bowl} rx={2} />

      <g clipPath={`url(#${bowl})`}>
        {hasResults && (
          <>
            {/* Clear supernatant — what the decanter draws off. */}
            <rect x={IN_X} y={SURFACE} width={IN_W} height={BLANKET - SURFACE}
                  fill={WATER} opacity={0.20} />
            {/* Settled mixed liquor, toned by MLSS. */}
            <rect x={IN_X} y={BLANKET} width={IN_W} height={FLOOR - BLANKET}
                  fill={SLUDGE} opacity={blanketTone} />
          </>
        )}
      </g>

      {hasResults && (
        <>
          <line x1={IN_X} y1={SURFACE} x2={IN_X + IN_W} y2={SURFACE} {...ink('media', WATER)} />
          {/* The blanket interface is what settling produces, so it is solid. */}
          <line x1={IN_X} y1={BLANKET} x2={IN_X + IN_W} y2={BLANKET} {...ink('media', SLUDGE)} />
        </>
      )}

      {/* Decanter: a weir trough on a raised arm. Parked, always — see header. */}
      <g className="ws-detail" data-decanter="parked">
        <line x1={R.x + 12} y1={R.y + 2} x2={R.x + 12} y2={SURFACE - 3} {...ink('media', INK)} />
        <path
          d={`M ${R.x + 6} ${SURFACE - 3} l 0 4 l 12 0 l 0 -4`}
          {...ink('detail', INK)}
        />
      </g>

      {/* Diffuser grid on the floor — hardware, drawn still. */}
      <g className="ws-detail">
        <line x1={IN_X + 6} y1={FLOOR - 1} x2={IN_X + IN_W - 6} y2={FLOOR - 1} {...ink('media', AIR)} />
        {[0.25, 0.5, 0.75].map((f) => (
          <line
            key={f}
            x1={IN_X + 6 + f * (IN_W - 12)} y1={FLOOR - 1}
            x2={IN_X + 6 + f * (IN_W - 12)} y2={FLOOR - 4}
            {...ink('media', AIR)}
          />
        ))}
      </g>

      {/* ── The cycle, as proportions ──────────────────────────────────────── */}
      {hasCycle ? (
        <g data-cycle-h={cycle == null ? '' : cycle.toFixed(2)}>
          {(() => {
            let x = IN_X;
            return phases.map(([key, hours]) => {
              const w = ((hours || 0) / totalPhase) * IN_W;
              const seg = (
                <rect
                  key={key} data-phase={key}
                  x={x} y={BAR.y} width={Math.max(0, w)} height={BAR.h}
                  fill={PHASE_TOKENS[key]} opacity={0.55}
                />
              );
              x += w;
              return seg;
            });
          })()}
          <rect x={IN_X} y={BAR.y} width={IN_W} height={BAR.h} rx={0.5} {...ink('media', SOFT)} />
          {/* Utilisation tick: how much of the cycle's capacity the feed uses. */}
          {util != null && (
            <line
              x1={IN_X + clamp(util, 0, 100) / 100 * IN_W} y1={BAR.y - 2}
              x2={IN_X + clamp(util, 0, 100) / 100 * IN_W} y2={BAR.y + BAR.h + 2}
              {...ink('detail', util > 100 ? WATCH : INK)}
            />
          )}
        </g>
      ) : (
        <rect x={IN_X} y={BAR.y} width={IN_W} height={BAR.h} rx={0.5}
              {...ink('media', SOFT)} strokeDasharray="3 3" />
      )}

      {/* Overflow chevron when the cycle cannot take the feed offered. */}
      {over && (
        <path d={`M ${R.x + R.w - 16} ${R.y + 8} l 5 -5 l 5 5`} {...ink('detail', WATCH)} fill="none" />
      )}

      <Nozzle x={R.x - 8} y={R.y + 12} dir="right" len={8} color={INK} />
      <Nozzle x={R.x + R.w} y={SURFACE + 4} dir="right" len={8} color={INK} />
      <Nozzle x={R.x + R.w} y={FLOOR - 3} dir="right" len={8} color={SLUDGE} />

      <title>
        {hasCycle
          ? `Sequencing batch reactor — ${cycle != null ? `${cycle.toFixed(2)} h cycle` : 'cycle'}: `
            + phases.map(([k, h]) => `${k} ${h}h`).join(', ')
            + (util != null ? `. Feed uses ${util.toFixed(0)} % of cycle capacity` : '')
            + (over ? `, with ${backlog.toFixed(0)} m³/d that has no cycle slot.` : '.')
            + ' The bar shows phase proportions — no phase is live, because steady state has no clock.'
          : 'Sequencing batch reactor — no cycle set.'}
      </title>
    </g>
  );
}

registerSymbol('sbr_reactor', SbrReactorSymbol);

export default SbrReactorSymbol;
