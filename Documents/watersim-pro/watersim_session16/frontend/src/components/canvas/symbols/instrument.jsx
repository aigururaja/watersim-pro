/**
 * `instrument` — a flow meter, level transmitter or pH analyser
 * ─────────────────────────────────────────────────────────────────────────────
 * The ISA balloon, drawn as an instrument engineer expects it: a circle on the
 * line, split by a horizontal bar, with the function letters above and the loop
 * number below. FT for flow, LT for level, AT for an analyser. Anyone who has
 * read a P&ID reads this without a legend, which is the whole argument for
 * putting the plant's seventeen analogue inputs on the canvas as nodes.
 *
 * ── DRIVERS ──────────────────────────────────────────────────────────────────
 *   measurement       categorical → the function letters
 *   reading           computed    → printed in the title; NEVER drawn as a dial
 *                     position, because the model has no dial and a needle would
 *                     imply a span the instrument may not have been given
 *   span_configured   computed    → an unranged loop draws its balloon dashed:
 *                     the reading exists but nothing scales it
 *   out_of_range      computed    → the balloon fills; the node's own alarm ring
 *                     carries the severity, so the symbol only has to be legible
 *
 * The connecting line through the balloon is drawn solid: the instrument really
 * is on the pipe, and that line is geometry, not a value.
 */

import { registerSymbol } from './index';
import { ink } from './primitives';
import { getNodeSnapshot, num } from '../liveStore';

const INK = 'var(--ws-ink-700, #1E293B)';
const SOFT = 'var(--ws-ink-400, #94A3B8)';
const WATER = 'var(--ws-svc-water, #2E75B6)';
const ALARM = 'var(--ws-alarm, #DC2626)';

const CX = 72;
const CY = 30;
const RAD = 15;

/** ISA function letters by what the transmitter measures. */
const LETTERS = { flow: 'FT', level: 'LT', pH: 'AT' };

/** The loop tag's numeric part, when the node carries one. */
function loopNumber(tag) {
  const match = /(\d{3,4})\s*$/.exec(String(tag || ''));
  return match ? match[1] : null;
}

export function InstrumentSymbol({ nodeId, data, snap }) {
  const s = snap || getNodeSnapshot(nodeId);
  const m = s?.metrics || {};
  const params = data?.params || {};

  const measurement = m.measurement || params.measurement || 'flow';
  const letters = LETTERS[measurement] || 'IT';
  const tag = m.tag || params.tag || data?.label;
  const loop = loopNumber(tag);

  const reading = num(m.reading);
  const unit = m.unit;
  const spanned = m.span_configured === true;
  const bad = m.out_of_range === true;
  const hasResults = reading != null;

  const outline = bad ? ALARM : hasResults ? INK : SOFT;

  return (
    <g aria-hidden="true" data-symbol="instrument" data-measurement={measurement}>
      {/* The process line the instrument sits on. */}
      <line x1={16} y1={CY} x2={128} y2={CY} {...ink('detail', hasResults ? WATER : SOFT)} />

      {/* Impulse line from the pipe up to the balloon — the ISA convention for
          a locally mounted transmitter. */}
      <line x1={CX} y1={CY} x2={CX} y2={CY} {...ink('media', outline)} />

      {/* The balloon. Dashed when the loop has no calibrated span. */}
      <circle
        cx={CX} cy={CY} r={RAD}
        fill={bad ? ALARM : 'var(--ws-paper, #FFFFFF)'}
        fillOpacity={bad ? 0.12 : 1}
        {...ink('shell', outline)}
        strokeDasharray={hasResults && !spanned ? '3 3' : undefined}
      />
      <line x1={CX - RAD} y1={CY} x2={CX + RAD} y2={CY} {...ink('media', outline)} />

      <text
        x={CX} y={CY - 3} textAnchor="middle" fill={outline} stroke="none"
        style={{ font: '700 10px var(--ws-font-mono, ui-monospace, Menlo, Consolas, monospace)', letterSpacing: '0.04em' }}
      >{letters}</text>
      {loop && (
        <text
          x={CX} y={CY + 11} textAnchor="middle" fill={SOFT} stroke="none"
          style={{ font: '700 8px var(--ws-font-mono, ui-monospace, Menlo, Consolas, monospace)' }}
        >{loop}</text>
      )}

      <title>
        {hasResults
          ? `${m.instrument || 'Field instrument'}${tag ? ` ${tag}` : ''} — reading ${reading.toFixed(2)}${unit ? ` ${unit}` : ''}`
            + (spanned ? `, span ${m.range_min}–${m.range_max}` : ', no calibrated span set')
            + (bad ? '. The loop is saturated: the reading is outside its span.' : '.')
          : `${LETTERS[measurement] ? 'Field instrument' : 'Instrument'}${tag ? ` ${tag}` : ''} — no results yet.`}
      </title>
    </g>
  );
}

registerSymbol('instrument', InstrumentSymbol);

export default InstrumentSymbol;
