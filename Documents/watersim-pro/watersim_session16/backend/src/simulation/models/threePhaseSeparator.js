/**
 * Three-phase separator — a pressurised gas / oil / water vessel.
 *
 * The horizontal separator on a produced-fluids P&ID: feed enters, gas flashes
 * off the top through a demister, oil spills over a weir into its own bucket
 * and water is drawn from below the interface. Three outlets, each on its own
 * level or pressure control loop.
 *
 * ── WHAT IS AND IS NOT COMPUTED ─────────────────────────────────────────────
 * This solver's streams carry water quality (TSS, BOD, COD, N, P), not phases,
 * so the separator is an honest FLOW SPLIT with named outlets, not a flash or
 * phase-equilibrium calculation. The feed's Q is the total volumetric flow at
 * operating conditions and the phase fractions are parameters:
 *
 *   gas   = Q × gas_fraction_pct
 *   oil   = Q × oil_fraction_pct, plus the water it carries (water_in_oil_pct,
 *           the BS&W), minus the oil lost to the water outlet
 *   water = the rest
 *
 * Separation quality is governed by liquid retention time. When a liquid
 * volume is given:
 *
 *   retention_min = liquid_volume_m3 / ((oil + water) / 1440)
 *
 * and a vessel running short of its rated retention carries more oil into the
 * water outlet, in proportion (capped at ten times the design figure).
 *
 * Oil-in-water is not a Stream field, so — as `oilGreaseTrap.js` does with
 * FOG — it is a metric. The water outlet keeps the feed's water quality; the
 * gas and oil outlets carry flow, pH and temperature only, because nothing
 * downstream in this solver can treat them as water.
 *
 * Outputs: `effluent` (water, the primary forward stream), `oil`, `gas`.
 *
 * Parameters:
 *   gas_fraction_pct        share of feed volume leaving as gas (%)    default 10
 *   oil_fraction_pct        share of feed volume that is oil (%)       default 30
 *   water_in_oil_pct        water carried out with the oil, BS&W (%)   default 2
 *   oil_in_water_mg_L       oil left in the water at design retention  default 500
 *   liquid_volume_m3        liquid hold-up; 0 = not known, no check    default 0
 *   rated_retention_min     liquid retention the vessel is sized for   default 5
 *   operating_pressure_barg operating pressure, reported only          default 5
 */
'use strict';

const { Stream } = require('../stream');

const DEFAULTS = {
  gas_fraction_pct: 10,
  oil_fraction_pct: 30,
  water_in_oil_pct: 2,
  oil_in_water_mg_L: 500,
  liquid_volume_m3: 0,
  rated_retention_min: 5,
  operating_pressure_barg: 5,
};

/** Crude oil at ~0.85 t/m³: mg of oil per litre of pure oil. */
const OIL_mg_L = 850000;
/** A starved vessel's oil carry-over is capped at this multiple of design. */
const MAX_CARRYOVER_FACTOR = 10;

const num = (v, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};
const pct = (v, fallback) => Math.min(100, Math.max(0, num(v, fallback))) / 100;

/**
 * @param {{ influent: Stream }} inputs
 * @param {object} params
 * @returns {{ effluent: Stream, oil: Stream, gas: Stream, metrics: object }}
 */
function solve(inputs, params = {}) {
  const p = { ...DEFAULTS, ...params };
  const feed = inputs.influent || new Stream();
  const Q = Math.max(0, num(feed.Q, 0));
  const warnings = [];

  let gasFrac = pct(p.gas_fraction_pct, DEFAULTS.gas_fraction_pct);
  let oilFrac = pct(p.oil_fraction_pct, DEFAULTS.oil_fraction_pct);
  if (gasFrac + oilFrac > 1) {
    const sum = gasFrac + oilFrac;
    warnings.push(
      `Gas and oil fractions add up to ${(sum * 100).toFixed(0)} % of the feed — scaled down to 100 %, leaving no water`);
    gasFrac /= sum;
    oilFrac /= sum;
  }

  const gasQ = Q * gasFrac;
  const oilTrueQ = Q * oilFrac;
  const waterTrueQ = Math.max(0, Q - gasQ - oilTrueQ);
  const liquidQ = oilTrueQ + waterTrueQ;

  const volume = Math.max(0, num(p.liquid_volume_m3, 0));
  const rated = Math.max(0.1, num(p.rated_retention_min, DEFAULTS.rated_retention_min));
  const retention = volume > 0 && liquidQ > 0 ? volume / (liquidQ / 1440) : null;
  const carryover = retention != null && retention < rated
    ? Math.min(MAX_CARRYOVER_FACTOR, rated / retention)
    : 1;

  const oiwDesign = Math.max(0, num(p.oil_in_water_mg_L, DEFAULTS.oil_in_water_mg_L));
  const oiw = Math.min(OIL_mg_L, oiwDesign * carryover);

  // Water carried out with the oil (BS&W), never more water than there is.
  const bsw = Math.min(0.99, pct(p.water_in_oil_pct, DEFAULTS.water_in_oil_pct));
  const waterInOilQ = Math.min(waterTrueQ, bsw > 0 ? (oilTrueQ * bsw) / (1 - bsw) : 0);
  const waterOutQ = waterTrueQ - waterInOilQ;
  // Oil lost to the water outlet, never more oil than there is.
  const oilLostQ = Math.min(oilTrueQ, (waterOutQ * oiw) / OIL_mg_L);
  const oilOutQ = oilTrueQ - oilLostQ + waterInOilQ;

  const effluent = feed.clone({ Q: waterOutQ + oilLostQ });
  const phase = (q) => new Stream({ Q: q, pH: feed.pH, temp: feed.temp });
  const oil = phase(oilOutQ);
  const gas = phase(gasQ);

  if (retention != null && retention < rated) {
    warnings.push(
      `Liquid retention is ${retention.toFixed(1)} min against a ${rated} min design — oil carry-over into the water raised ${carryover.toFixed(1)}×`);
  }
  if (Q > 0 && waterTrueQ <= 0) {
    warnings.push('No water phase in the feed — the water outlet carries no flow');
  }

  const metrics = {
    Q_in_m3_d: +Q.toFixed(1),
    gas_m3_d: +gasQ.toFixed(1),
    oil_m3_d: +oilOutQ.toFixed(1),
    water_m3_d: +effluent.Q.toFixed(1),
    gas_fraction_pct: +(gasFrac * 100).toFixed(1),
    oil_fraction_pct: +(oilFrac * 100).toFixed(1),
    retention_min: retention == null ? null : +retention.toFixed(1),
    rated_retention_min: rated,
    oil_in_water_mg_L: +oiw.toFixed(0),
    water_in_oil_pct: +(bsw * 100).toFixed(1),
    oil_recovery_pct: oilTrueQ > 0 ? +((1 - oilLostQ / oilTrueQ) * 100).toFixed(2) : null,
    operating_pressure_barg: num(p.operating_pressure_barg, DEFAULTS.operating_pressure_barg),
  };
  if (warnings.length) metrics.warnings = warnings;

  return { effluent, oil, gas, metrics };
}

module.exports = { solve, DEFAULTS };
