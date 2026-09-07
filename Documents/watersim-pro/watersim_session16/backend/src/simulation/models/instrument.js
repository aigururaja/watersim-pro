/**
 * Field instrument — a flow meter, level transmitter or pH analyser.
 *
 * The ITC proposal schedules seventeen analogue inputs, and every one of them is
 * one of these three. Putting them on the canvas as nodes is what makes the
 * sheet match the P&ID: an operator looking for FT-201 finds it on the line it
 * measures, and a PLC binding attaches to the node that represents the actual
 * transmitter rather than to some unrelated unit's parameter.
 *
 * ── WHAT AN INSTRUMENT DOES TO THE WATER ────────────────────────────────────
 * Nothing. It is a pure passthrough: the stream leaves exactly as it arrived.
 * What it produces is a READING, and the reading is taken from the stream the
 * solver actually computed — so it cannot drift from the process:
 *
 *   flow   → Q, in m³/d and m³/hr
 *   level  → not a stream property; reported from the `level_pct` parameter,
 *            which is what a bound PLC tag writes into it
 *   pH     → the stream's pH
 *
 * `range_min` / `range_max` describe the transmitter's calibrated span. A
 * reading outside it is reported as `out_of_range` with a warning, because a
 * 4–20 mA loop that saturates reads as a plausible number on a SCADA screen
 * while telling you nothing.
 *
 * Parameters:
 *   measurement  'flow' | 'level' | 'pH'        default 'flow'
 *   level_pct    current level, when measuring level (%)   default 50
 *   range_min    calibrated span minimum        default 0
 *   range_max    calibrated span maximum, 0 = not ranged      default 0
 *   tag          instrument tag for the schedule (free text)
 *   measured     the transmitter's LIVE reading, written by a PLC binding.
 *                −1 (default) means nothing is bound and the modelled value is
 *                the reading; any value ≥ 0 replaces it, and the modelled
 *                value is reported beside it with their difference as
 *                `residual` — the seed of the twin's model-vs-measured view.
 */
'use strict';

const { Stream } = require('../stream');

const DEFAULTS = {
  measurement: 'flow',
  level_pct: 50,
  range_min: 0,
  // 0 means "not ranged yet" — see the span note in solve().
  range_max: 0,
  // −1 means "no live measurement bound" — see the parameter note above.
  measured: -1,
};

const KINDS = {
  flow: { label: 'Flow meter', unit: 'm³/d', signal: 'AI' },
  level: { label: 'Level transmitter', unit: '%', signal: 'AI' },
  pH: { label: 'pH analyser', unit: 'pH', signal: 'AI' },
};

const num = (v, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

/**
 * @param {{ influent: Stream, RAS?: Stream }} inputs
 * @param {object} params
 * @returns {{ effluent: Stream, metrics: object }}
 */
function solve(inputs, params = {}) {
  const p = { ...DEFAULTS, ...params };

  let feed = inputs.influent || new Stream();
  if (inputs.RAS && inputs.RAS.Q > 0) {
    feed = feed.Q > 0 ? Stream.mix([feed, inputs.RAS]) : inputs.RAS;
  }

  const kindKey = KINDS[p.measurement] ? p.measurement : DEFAULTS.measurement;
  const kind = KINDS[kindKey];

  let reading;
  if (kindKey === 'flow') reading = Math.max(0, num(feed.Q, 0));
  else if (kindKey === 'pH') reading = num(feed.pH, 7);
  else reading = Math.min(100, Math.max(0, num(p.level_pct, DEFAULTS.level_pct)));

  // A bound PLC point overrides the modelled reading — measured beats
  // modelled — but the modelled value is kept beside it, because the gap
  // between the two is what a digital twin is for.
  const modelled = reading;
  const measured = num(p.measured, DEFAULTS.measured);
  const hasMeasured = measured >= 0;
  if (hasMeasured) reading = measured;

  // A span is OPTIONAL. `range_max` at or below `range_min` means the loop has
  // not been ranged yet, which is a normal state on a sheet being drawn — it is
  // reported as "no span configured", not warned about. Only a span that IS set
  // and IS exceeded is a fault, because that is the case where a saturated
  // 4–20 mA loop shows a plausible number on the SCADA screen and means nothing.
  const rMin = num(p.range_min, DEFAULTS.range_min);
  const rMax = num(p.range_max, DEFAULTS.range_max);
  const hasSpan = rMax > rMin;
  const outOfRange = hasSpan && (reading < rMin || reading > rMax);

  const warnings = [];
  if (outOfRange) {
    warnings.push(
      `${kind.label} reading ${reading.toFixed(2)} ${kind.unit} is outside its ${rMin}–${rMax} calibrated span — the loop is saturated`
    );
  }

  const metrics = {
    measurement: kindKey,
    instrument: kind.label,
    signal_type: kind.signal,
    reading: +reading.toFixed(3),
    unit: kind.unit,
    range_min: rMin,
    range_max: rMax,
    span_configured: hasSpan,
    span_pct: hasSpan ? +(((reading - rMin) / (rMax - rMin)) * 100).toFixed(1) : null,
    out_of_range: outOfRange,
    source: hasMeasured ? 'measured' : 'modelled',
    modelled: +modelled.toFixed(3),
    residual: hasMeasured ? +(measured - modelled).toFixed(3) : null,
  };
  if (kindKey === 'flow') metrics.flow_m3_h = +(reading / 24).toFixed(2);
  if (p.tag) metrics.tag = String(p.tag);
  if (warnings.length) metrics.warnings = warnings;

  return { effluent: feed, metrics };
}

module.exports = { solve, DEFAULTS, KINDS };
