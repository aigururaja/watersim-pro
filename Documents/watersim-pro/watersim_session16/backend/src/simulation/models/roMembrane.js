/**
 * RO Membrane — Reverse Osmosis unit operation
 *
 * High-pressure membrane separation producing permeate (product) and concentrate.
 *
 * Parameters:
 *   recovery_pct     water recovery (%)            default 75
 *   salt_rejection   salt/TDS rejection fraction   default 0.97
 *   TN_rejection     TN rejection fraction         default 0.85
 *   TP_rejection     TP rejection fraction         default 0.98
 *   BOD_rejection    BOD rejection fraction        default 0.99
 *   TSS_rejection    TSS rejection fraction        default 1.00
 *   pressure_bar     operating pressure (bar)      default 15
 */

const { Stream } = require('../stream');

const DEFAULTS = {
  recovery_pct:   75,
  salt_rejection: 0.97,
  TN_rejection:   0.85,
  TP_rejection:   0.98,
  BOD_rejection:  0.99,
  TSS_rejection:  1.00,
  pressure_bar:   15,
};

/**
 * @param {{ influent: Stream }} inputs
 * @param {object} params
 * @returns {{ permeate: Stream, concentrate: Stream, metrics: object }}
 */
function solve(inputs, params = {}) {
  const p   = { ...DEFAULTS, ...params };
  const inf = inputs.influent || new Stream();

  const recovery = p.recovery_pct / 100;
  const perm_Q   = inf.Q * recovery;
  const conc_Q   = inf.Q * (1 - recovery);

  const cf = 1 / (1 - recovery); // concentration factor in reject

  const permeate = new Stream({
    Q:    perm_Q,
    TSS:  0,
    BOD:  inf.BOD  * (1 - p.BOD_rejection),
    COD:  inf.COD  * (1 - p.BOD_rejection * 0.95),
    TN:   inf.TN   * (1 - p.TN_rejection),
    NH4:  inf.NH4  * (1 - p.TN_rejection),
    TP:   inf.TP   * (1 - p.TP_rejection),
    DO:   inf.DO,
    pH:   inf.pH,
    temp: inf.temp,
  });

  const concentrate = new Stream({
    Q:    conc_Q,
    TSS:  inf.TSS  * cf * (1 - (1 - p.TSS_rejection) * recovery),
    BOD:  inf.BOD  * cf * p.BOD_rejection,
    COD:  inf.COD  * cf * p.BOD_rejection * 0.95,
    TN:   inf.TN   * cf * p.TN_rejection,
    NH4:  inf.NH4  * cf * p.TN_rejection,
    TP:   inf.TP   * cf * p.TP_rejection,
    DO:   0,
    pH:   inf.pH + 0.3,
    temp: inf.temp,
  });

  // Energy estimate: 0.5 kWh/m³ permeate at 15 bar (rough)
  const energy_kWh_d = perm_Q * (p.pressure_bar / 15) * 0.5;

  return {
    permeate,
    concentrate,
    metrics: {
      recovery_pct:       p.recovery_pct,
      pressure_bar:       p.pressure_bar,
      perm_Q_m3_d:        +perm_Q.toFixed(1),
      conc_Q_m3_d:        +conc_Q.toFixed(1),
      concentration_factor: +cf.toFixed(2),
      energy_kWh_d:       +energy_kWh_d.toFixed(1),
      BOD_permeate_mg_L:  +(inf.BOD * (1 - p.BOD_rejection)).toFixed(2),
      TN_permeate_mg_L:   +(inf.TN  * (1 - p.TN_rejection)).toFixed(2),
    },
  };
}

module.exports = { solve, DEFAULTS };
