/**
 * Inlet — pseudo unit operation
 *
 * Acts as the source node in the process graph.
 * Returns the user-defined influent stream with no transformation.
 *
 * Default parameters represent typical municipal wastewater influent.
 */

const { Stream } = require('../stream');

const DEFAULTS = {
  Q:    10000,   // m³/d
  TSS:  250,     // mg/L
  BOD:  200,     // mg/L
  COD:  400,     // mg/L
  TN:   45,      // mg/L
  NH4:  35,      // mg/L
  TP:   8,       // mg/L
  DO:   0,       // mg/L
  pH:   7.2,
  temp: 20,      // °C
};

/**
 * @param {object} inputs - Not used (inlet has no upstream connections).
 * @param {object} params - Influent quality overrides.
 * @returns {{ effluent: Stream, metrics: object }}
 */
function solve(inputs, params = {}) {
  const p = { ...DEFAULTS, ...params };
  const effluent = new Stream(p);
  return {
    effluent,
    metrics: {
      Q_in: effluent.Q,
    },
  };
}

module.exports = { solve, DEFAULTS };
