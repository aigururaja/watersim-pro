/**
 * WaterSim Pro — Stream (process connection)
 *
 * A Stream carries the state of a process connection between unit operations.
 * All concentrations are mg/L, flows are m³/d, temperatures are °C.
 *
 * Water quality parameters:
 *   Q    – volumetric flow rate (m³/d)
 *   TSS  – total suspended solids (mg/L)
 *   BOD  – 5-day biochemical oxygen demand (mg/L)
 *   COD  – chemical oxygen demand (mg/L)
 *   TN   – total nitrogen (mg/L)
 *   TP   – total phosphorus (mg/L)
 *   NH4  – ammonia-nitrogen (mg/L)
 *   NO3  – nitrate-nitrogen (mg/L)
 *   NO2  – nitrite-nitrogen (mg/L)
 *   DO   – dissolved oxygen (mg/L)
 *   pH   – dimensionless
 *   temp – temperature (°C)
 */

class Stream {
  constructor(props = {}) {
    this.Q    = props.Q    ?? 0;       // m³/d
    this.TSS  = props.TSS  ?? 0;       // mg/L
    this.BOD  = props.BOD  ?? 0;       // mg/L
    this.COD  = props.COD  ?? 0;       // mg/L
    this.TN   = props.TN   ?? 0;       // mg/L
    this.NH4  = props.NH4  ?? 0;       // mg/L
    this.NO3  = props.NO3  ?? 0;       // mg/L
    this.NO2  = props.NO2  ?? 0;       // mg/L
    this.TP   = props.TP   ?? 0;       // mg/L
    this.DO   = props.DO   ?? 0;       // mg/L
    this.pH   = props.pH   ?? 7.0;     // -
    this.temp = props.temp ?? 20;      // °C
  }

  /**
   * Mix multiple streams into one (flow-weighted average for concentrations).
   */
  static mix(streams) {
    if (!streams || streams.length === 0) return new Stream();
    const totalQ = streams.reduce((s, st) => s + st.Q, 0);
    if (totalQ === 0) return new Stream({ ...streams[0], Q: 0 });

    const conc = (key) =>
      streams.reduce((s, st) => s + st[key] * st.Q, 0) / totalQ;

    return new Stream({
      Q:    totalQ,
      TSS:  conc('TSS'),
      BOD:  conc('BOD'),
      COD:  conc('COD'),
      TN:   conc('TN'),
      NH4:  conc('NH4'),
      NO3:  conc('NO3'),
      NO2:  conc('NO2'),
      TP:   conc('TP'),
      DO:   conc('DO'),
      pH:   conc('pH'),
      temp: conc('temp'),
    });
  }

  /** Return a plain object (safe to JSON.stringify into DB). */
  toJSON() {
    return {
      Q:    round(this.Q,   2),
      TSS:  round(this.TSS, 2),
      BOD:  round(this.BOD, 2),
      COD:  round(this.COD, 2),
      TN:   round(this.TN,  2),
      NH4:  round(this.NH4, 2),
      NO3:  round(this.NO3, 2),
      NO2:  round(this.NO2, 2),
      TP:   round(this.TP,  2),
      DO:   round(this.DO,  2),
      pH:   round(this.pH,  2),
      temp: round(this.temp,1),
    };
  }

  clone(overrides = {}) {
    return new Stream({ ...this, ...overrides });
  }
}

function round(v, dp) {
  const f = 10 ** dp;
  return Math.round(v * f) / f;
}

module.exports = { Stream };
