/**
 * Control Valve (Modulating Valve) — unit operation
 *
 * A throttling valve that modulates how much flow passes downstream, set by a
 * percentage opening (0 = fully shut, 100 = fully open). Useful for modelling
 * flow control / split-range points where an operator or controller regulates
 * the delivered flow.
 *
 * Flow scales linearly with the opening; concentrations pass through unchanged
 * (throttling changes how much water goes through, not how dirty it is).
 *
 * Parameters:
 *   opening_pct   0–100  (default: 100)
 */

const { Stream } = require('../stream');

const DEFAULTS = {
  opening_pct: 100,
};

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * @param {{ influent: Stream }} inputs
 * @param {object} params
 * @returns {{ effluent: Stream, metrics: object }}
 */
function solve(inputs, params = {}) {
  const p   = { ...DEFAULTS, ...params };
  const inf = inputs.influent || new Stream();

  const opening = clamp(Number(p.opening_pct) || 0, 0, 100);
  const frac    = opening / 100;

  const effluent = inf.clone({ Q: inf.Q * frac });

  return {
    effluent,
    metrics: {
      opening_pct: opening,
      Q_in_m3_d:   +inf.Q.toFixed(1),
      Q_out_m3_d:  +effluent.Q.toFixed(1),
      throttled_m3_d: +(inf.Q - effluent.Q).toFixed(1),
    },
  };
}

module.exports = { solve, DEFAULTS };
