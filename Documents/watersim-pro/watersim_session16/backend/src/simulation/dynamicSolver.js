/**
 * WaterSim Pro — Dynamic (Time-Series) Solver  (Session 5 — Step 24)
 *
 * Wraps the steady-state solver in a time-step loop.
 * At each time step the inlet node's parameters are scaled by
 * per-parameter multipliers defined in a 24-hour diurnal profile.
 *
 * Profile format (timeSeriesConfig.profile):
 *   Array of time-step objects:
 *   { hour: 0-23, Q_scale: 1.0, BOD_scale: 1.0, TN_scale: 1.0, TP_scale: 1.0, TSS_scale: 1.0 }
 *
 * If fewer than 24 entries are provided the last value is forward-filled.
 * The solver re-runs steady-state at each time step (pseudo-transient —
 * appropriate for slow biological processes where HRT << simulation period).
 *
 * Returns:
 *   {
 *     mode: 'dynamic',
 *     steps: [{ hour, streamResults, unitResults, summary, warnings }],
 *     profileUsed: [...],
 *     stepCount: number,
 *     warnings: string[],
 *   }
 */

'use strict';

const { runSteadyState } = require('./solver');

/** Default diurnal profile — typical municipal WW loading pattern */
const DEFAULT_DIURNAL_PROFILE = [
  { hour:  0, Q_scale: 0.60, BOD_scale: 0.55, TN_scale: 0.60, TP_scale: 0.60, TSS_scale: 0.55 },
  { hour:  1, Q_scale: 0.55, BOD_scale: 0.50, TN_scale: 0.55, TP_scale: 0.55, TSS_scale: 0.50 },
  { hour:  2, Q_scale: 0.52, BOD_scale: 0.48, TN_scale: 0.52, TP_scale: 0.52, TSS_scale: 0.48 },
  { hour:  3, Q_scale: 0.50, BOD_scale: 0.46, TN_scale: 0.50, TP_scale: 0.50, TSS_scale: 0.46 },
  { hour:  4, Q_scale: 0.52, BOD_scale: 0.48, TN_scale: 0.52, TP_scale: 0.52, TSS_scale: 0.48 },
  { hour:  5, Q_scale: 0.58, BOD_scale: 0.55, TN_scale: 0.58, TP_scale: 0.58, TSS_scale: 0.55 },
  { hour:  6, Q_scale: 0.80, BOD_scale: 0.80, TN_scale: 0.80, TP_scale: 0.80, TSS_scale: 0.80 },
  { hour:  7, Q_scale: 1.10, BOD_scale: 1.10, TN_scale: 1.10, TP_scale: 1.10, TSS_scale: 1.10 },
  { hour:  8, Q_scale: 1.30, BOD_scale: 1.30, TN_scale: 1.30, TP_scale: 1.30, TSS_scale: 1.30 },
  { hour:  9, Q_scale: 1.40, BOD_scale: 1.40, TN_scale: 1.35, TP_scale: 1.35, TSS_scale: 1.35 },
  { hour: 10, Q_scale: 1.45, BOD_scale: 1.45, TN_scale: 1.40, TP_scale: 1.40, TSS_scale: 1.40 },
  { hour: 11, Q_scale: 1.50, BOD_scale: 1.50, TN_scale: 1.45, TP_scale: 1.45, TSS_scale: 1.45 },
  { hour: 12, Q_scale: 1.45, BOD_scale: 1.45, TN_scale: 1.40, TP_scale: 1.40, TSS_scale: 1.40 },
  { hour: 13, Q_scale: 1.35, BOD_scale: 1.35, TN_scale: 1.30, TP_scale: 1.30, TSS_scale: 1.30 },
  { hour: 14, Q_scale: 1.25, BOD_scale: 1.25, TN_scale: 1.20, TP_scale: 1.20, TSS_scale: 1.20 },
  { hour: 15, Q_scale: 1.20, BOD_scale: 1.20, TN_scale: 1.15, TP_scale: 1.15, TSS_scale: 1.15 },
  { hour: 16, Q_scale: 1.20, BOD_scale: 1.20, TN_scale: 1.15, TP_scale: 1.15, TSS_scale: 1.15 },
  { hour: 17, Q_scale: 1.25, BOD_scale: 1.25, TN_scale: 1.20, TP_scale: 1.20, TSS_scale: 1.20 },
  { hour: 18, Q_scale: 1.30, BOD_scale: 1.30, TN_scale: 1.25, TP_scale: 1.25, TSS_scale: 1.25 },
  { hour: 19, Q_scale: 1.25, BOD_scale: 1.25, TN_scale: 1.20, TP_scale: 1.20, TSS_scale: 1.20 },
  { hour: 20, Q_scale: 1.10, BOD_scale: 1.10, TN_scale: 1.05, TP_scale: 1.05, TSS_scale: 1.05 },
  { hour: 21, Q_scale: 0.95, BOD_scale: 0.95, TN_scale: 0.90, TP_scale: 0.90, TSS_scale: 0.90 },
  { hour: 22, Q_scale: 0.80, BOD_scale: 0.80, TN_scale: 0.75, TP_scale: 0.75, TSS_scale: 0.75 },
  { hour: 23, Q_scale: 0.68, BOD_scale: 0.65, TN_scale: 0.65, TP_scale: 0.65, TSS_scale: 0.65 },
];

/**
 * Build a 24-entry profile array from user-supplied partial profile.
 * Missing hours are forward-filled from the previous value.
 */
function buildProfile(userProfile) {
  if (!userProfile || userProfile.length === 0) return DEFAULT_DIURNAL_PROFILE;

  // Build a map from hour → entry; fill gaps
  const byHour = {};
  for (const entry of userProfile) {
    if (entry.hour >= 0 && entry.hour <= 23) {
      byHour[entry.hour] = entry;
    }
  }

  const profile = [];
  let last = { Q_scale: 1, BOD_scale: 1, TN_scale: 1, TP_scale: 1, TSS_scale: 1 };
  for (let h = 0; h < 24; h++) {
    if (byHour[h]) last = byHour[h];
    profile.push({ ...last, hour: h });  // ensure hour field is the correct index
  }
  return profile;
}

/**
 * Apply scaling factors to all inlet nodes in nodeParams.
 *
 * For each inlet node: scales Q, BOD, TN, TP, TSS by the profile multipliers.
 * The base values come from nodeParams first, falling back to inlet DEFAULTS.
 */
function scaleInletParams(canvasData, nodeParams, stepEntry, inletDefaults) {
  const scaledParams = JSON.parse(JSON.stringify(nodeParams)); // deep copy

  for (const node of canvasData.nodes || []) {
    const opType = node.data?.opType || node.data?.type;
    if (opType !== 'inlet') continue;

    const base = scaledParams[node.id] || {};
    scaledParams[node.id] = {
      ...base,
      Q:   (base.Q   ?? inletDefaults.Q)   * (stepEntry.Q_scale   ?? 1),
      BOD: (base.BOD ?? inletDefaults.BOD) * (stepEntry.BOD_scale  ?? 1),
      TN:  (base.TN  ?? inletDefaults.TN)  * (stepEntry.TN_scale   ?? 1),
      TP:  (base.TP  ?? inletDefaults.TP)  * (stepEntry.TP_scale   ?? 1),
      TSS: (base.TSS ?? inletDefaults.TSS) * (stepEntry.TSS_scale  ?? 1),
      // NH4 scales with TN by default (proportional)
      NH4: (base.NH4 ?? inletDefaults.NH4) * (stepEntry.TN_scale   ?? 1),
    };
  }

  return scaledParams;
}

/**
 * Run a 24-hour dynamic simulation.
 *
 * @param {object} canvasData  - flowsheet canvas_data (nodes + edges)
 * @param {object} config      - { nodeParams, timeSeriesConfig }
 *   timeSeriesConfig: {
 *     profile: [{hour, Q_scale, BOD_scale, TN_scale, TP_scale, TSS_scale}],
 *     hoursToSimulate: 24  (default 24, max 48 for ±1 day)
 *   }
 */
function runDynamic(canvasData, config = {}) {
  const nodeParams       = config.nodeParams || {};
  const tsc              = config.timeSeriesConfig || {};
  const hoursToSimulate  = Math.min(Math.max(tsc.hoursToSimulate ?? 24, 1), 48);
  const profile          = buildProfile(tsc.profile);
  // Forward run-level config the route passes through (previously dropped):
  const permitLimits     = config.permitLimits ?? tsc.permitLimits ?? null;
  const unitCosts        = config.unitCosts ?? null;

  // Grab inlet defaults to use as base values
  const { DEFAULTS: inletDefaults } = require('./models/inlet');

  const steps   = [];
  const allWarn = [];
  let prevStreamResults = null; // warm-start each hour's recycles from the last converged hour

  for (let h = 0; h < hoursToSimulate; h++) {
    const stepEntry    = profile[h % 24];
    const scaledParams = scaleInletParams(canvasData, nodeParams, stepEntry, inletDefaults);

    const result = runSteadyState(canvasData, {
      nodeParams:            scaledParams,
      permitLimits,
      unitCosts,
      initialRecycleStreams: prevStreamResults,
    });
    prevStreamResults = result.streamResults;

    steps.push({
      hour:          h,
      stepEntry,
      streamResults: result.streamResults,
      unitResults:   result.unitResults,
      summary:       result.summary,
      warnings:      result.warnings,
      converged:     result.converged,
      degraded:      result.degraded,
    });

    if (result.warnings?.length) {
      // Deduplicate — only push first occurrence of each warning
      for (const w of result.warnings) {
        if (!allWarn.includes(w)) allWarn.push(w);
      }
    }
  }

  return {
    mode:        'dynamic',
    steps,
    profileUsed: profile.slice(0, hoursToSimulate),
    stepCount:   hoursToSimulate,
    warnings:    allWarn,
  };
}

module.exports = { runDynamic, DEFAULT_DIURNAL_PROFILE };
