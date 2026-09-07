/**
 * Outlet — pseudo unit operation  (Session 6 — Step 32)
 *
 * Acts as the sink node in the process graph.
 * Passes the incoming stream through unchanged and reports it as final effluent.
 *
 * ── DISCHARGE TYPE (Session 18) ──────────────────────────────────────────────
 * A plant has more boundaries than it has permitted discharges. The ITC works
 * ends in five: three product waters (cooling tower, irrigation, flushing) and
 * two waste exports (dewatered cake to a skip, softener regeneration to reject).
 * Grading a 180,000 mg/L cake against a 30 mg/L TSS water permit is meaningless,
 * and mixing it into the plant effluent poisons every downstream number.
 *
 * `discharge_type` says which kind of boundary this is:
 *   'water'   a permitted water discharge — graded, and counted in the plant
 *             effluent mix. THE DEFAULT, so every existing sheet is unchanged.
 *   'solids'  a dewatered-solids export — reported, never graded
 *   'reject'  a process reject or regeneration waste — reported, never graded
 *
 * Only 'water' outlets carry `compliant` / `permit_violations`; the others
 * report `graded: false` and say why, so nothing is silently skipped.
 *
 * Permit limits are now configurable via the `permitLimits` param.
 * Falls back to built-in defaults if none are provided.
 *
 * Default limits (US EPA secondary treatment typical):
 *   BOD ≤ 30 mg/L, TSS ≤ 30 mg/L, TN ≤ 10 mg/L, TP ≤ 1 mg/L, NH4 ≤ 5 mg/L
 *
 * `permitLimits` object may specify any combination of:
 *   { BOD, TSS, TN, TP, NH4, NO3, pH_min, pH_max }
 *   (all in mg/L except pH which is unitless)
 */

const { Stream } = require('../stream');

const DEFAULT_LIMITS = {
  BOD:     30,   // mg/L
  TSS:     30,   // mg/L
  TN:      10,   // mg/L
  TP:       1,   // mg/L
  NH4:      5,   // mg/L
  NO3:    null,  // not regulated by default
  pH_min:  6.0,
  pH_max:  9.0,
};

/** Boundary kinds an outlet can represent. Only 'water' is graded. */
const DISCHARGE_TYPES = {
  water:  { label: 'Permitted water discharge', graded: true },
  solids: { label: 'Dewatered solids export',   graded: false,
            reason: 'A solids export is weighed and hauled, not sampled against a water permit.' },
  reject: { label: 'Process reject / regeneration waste', graded: false,
            reason: 'A reject line is returned or tankered, not discharged under the water permit.' },
};

/**
 * @param {{ influent: Stream }} inputs
 * @param {{ permitLimits?: object, discharge_type?: string }} params
 * @returns {{ effluent: Stream, metrics: object }}
 */
function solve(inputs, params = {}) {
  const inf      = inputs.influent || new Stream();
  const effluent = inf.clone();

  const typeKey = DISCHARGE_TYPES[params.discharge_type] ? params.discharge_type : 'water';
  const dischargeType = DISCHARGE_TYPES[typeKey];

  // Merge org permit template over defaults
  const limits = { ...DEFAULT_LIMITS, ...(params.permitLimits || {}) };

  if (!dischargeType.graded) {
    return {
      effluent,
      metrics: {
        Q_out:          effluent.Q,
        discharge_type: typeKey,
        discharge_label: dischargeType.label,
        graded:         false,
        not_graded_because: dischargeType.reason,
        compliant:      null,
        permit_violations: [],
      },
    };
  }

  // Effluent quality compliance check
  const flags = [];

  if (limits.BOD  != null && effluent.BOD  > limits.BOD)
    flags.push({ param: 'BOD',  value: +effluent.BOD.toFixed(2),  limit: limits.BOD,  unit: 'mg/L' });
  if (limits.TSS  != null && effluent.TSS  > limits.TSS)
    flags.push({ param: 'TSS',  value: +effluent.TSS.toFixed(2),  limit: limits.TSS,  unit: 'mg/L' });
  if (limits.TN   != null && effluent.TN   > limits.TN)
    flags.push({ param: 'TN',   value: +effluent.TN.toFixed(2),   limit: limits.TN,   unit: 'mg/L' });
  if (limits.TP   != null && effluent.TP   > limits.TP)
    flags.push({ param: 'TP',   value: +effluent.TP.toFixed(2),   limit: limits.TP,   unit: 'mg/L' });
  if (limits.NH4  != null && effluent.NH4  > limits.NH4)
    flags.push({ param: 'NH4',  value: +effluent.NH4.toFixed(2),  limit: limits.NH4,  unit: 'mg/L' });
  if (limits.NO3  != null && effluent.NO3  > limits.NO3)
    flags.push({ param: 'NO3',  value: +effluent.NO3.toFixed(2),  limit: limits.NO3,  unit: 'mg/L' });
  if (limits.pH_min != null && effluent.pH < limits.pH_min)
    flags.push({ param: 'pH',   value: +effluent.pH.toFixed(2),   limit: limits.pH_min, unit: '(min)' });
  if (limits.pH_max != null && effluent.pH > limits.pH_max)
    flags.push({ param: 'pH',   value: +effluent.pH.toFixed(2),   limit: limits.pH_max, unit: '(max)' });

  return {
    effluent,
    metrics: {
      Q_out:             effluent.Q,
      discharge_type:    typeKey,
      discharge_label:   dischargeType.label,
      graded:            true,
      compliant:         flags.length === 0,
      permit_violations: flags,
      limits_applied:    limits,
    },
  };
}

module.exports = { solve, DEFAULT_LIMITS, DISCHARGE_TYPES };
