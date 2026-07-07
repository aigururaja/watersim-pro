/**
 * On/Off Valve (Isolation Valve) — unit operation
 *
 * A binary shutoff valve. When OPEN it passes the stream through unchanged.
 * When CLOSED it stops flow completely (downstream flow Q = 0), which lets you
 * model isolating a line, taking a train out of service, etc.
 *
 * Water quality (concentrations) are left untouched — a valve does not treat
 * water; closing it simply drops the flow it delivers downstream to zero.
 *
 * Parameters:
 *   state   'open' | 'closed'   (default: 'open')
 */

const { Stream } = require('../stream');

const DEFAULTS = {
  state: 'open',
};

/**
 * @param {{ influent: Stream }} inputs
 * @param {object} params
 * @returns {{ effluent: Stream, metrics: object }}
 */
function solve(inputs, params = {}) {
  const p   = { ...DEFAULTS, ...params };
  const inf = inputs.influent || new Stream();

  const isOpen = String(p.state).toLowerCase() !== 'closed';

  // Closed → deliver zero flow downstream (concentrations kept for reference).
  const effluent = isOpen ? inf.clone() : inf.clone({ Q: 0 });

  return {
    effluent,
    metrics: {
      state:      isOpen ? 'open' : 'closed',
      passing:    isOpen,
      Q_in_m3_d:  +inf.Q.toFixed(1),
      Q_out_m3_d: +effluent.Q.toFixed(1),
    },
  };
}

module.exports = { solve, DEFAULTS };
