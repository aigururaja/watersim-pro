/**
 * WaterSim Pro — Live Simulation Runner  (continuous mode)
 *
 * Computes steady-state snapshots using the latest nodeParams (including
 * OPC-polled values received via params:update).
 *
 * Speed multiplier (1x, 5x, 10x, 100x, 1000x) controls how many solver
 * steps are computed per tick. The UI update interval is always
 * max(compute_time, 5 seconds) — never faster than 5 s real-time.
 * OPC polling is independent and always runs at its own rate (default 5 s).
 *
 * At 10x speed: 10 solver steps are computed, results sent as a batch,
 * then the runner waits the remaining time until 5 s have passed.
 * At 1000x: 1000 steps computed; if that takes 8 s, the next tick fires
 * immediately (no wait).
 *
 * The diurnal profile wraps with `stepIndex % 24` so inlet scaling
 * still cycles if the user runs for a long time.
 *
 * Supports pause, resume, cancel, and mid-sim speed changes.
 * Only one active simulation per flowsheet at a time.
 */

'use strict';

const { runSteadyState }  = require('./solver');
const { buildProfile, scaleInletParams } = require('./dynamicSolver');
const { DEFAULTS: inletDefaults } = require('./models/inlet');
const { query }   = require('../db/pool');
const logger      = require('../utils/logger');

// ── In-memory registry: flowsheetId → LiveSimulation ────────────────────────
const activeSims = new Map();

/** Minimum real-time interval between UI updates (ms). */
const UI_UPDATE_INTERVAL_MS = 5_000;

class LiveSimulation {
  constructor({ flowsheetId, runId, canvasData, nodeParams, profile, speed, userId, broadcastFn }) {
    this.flowsheetId  = flowsheetId;
    this.runId        = runId;
    this.canvasData   = canvasData;
    this.nodeParams   = nodeParams;       // Mutable — updated by params:update events
    this.profile      = profile;
    this.speed        = speed || 1;       // Steps per tick (1, 5, 10, 100, 1000)
    this.currentStep  = 0;                // Running step counter (no upper limit)
    this.startTime    = Date.now();       // Wall-clock start for elapsed display
    this.state        = 'running';        // running | paused | cancelled
    this.timer        = null;             // setTimeout handle
    this.userId       = userId;
    this.broadcastFn  = broadcastFn;
    this.emittedSteps = [];               // Accumulated results for persistence
  }
}

// ── Compute a single solver step (no emit) ──────────────────────────────────

function computeStep(sim) {
  const stepIndex = sim.currentStep;
  const stepEntry = sim.profile[stepIndex % 24];
  const elapsedMs = Date.now() - sim.startTime;

  const scaledParams = scaleInletParams(sim.canvasData, sim.nodeParams, stepEntry, inletDefaults);
  const result       = runSteadyState(sim.canvasData, { nodeParams: scaledParams });

  const step = {
    tick:          stepIndex,
    elapsedSec:    Math.round(elapsedMs / 1000),
    stepEntry,
    streamResults: result.streamResults,
    unitResults:   result.unitResults,
    summary:       result.summary,
    warnings:      result.warnings,
  };

  sim.emittedSteps.push(step);
  sim.currentStep++;
  return step;
}

// ── Batch tick: compute N steps, emit, schedule next ────────────────────────

function executeTick(sim) {
  if (sim.state !== 'running') return;

  const tickStart = Date.now();
  const stepsToCompute = sim.speed;
  const batch = [];

  for (let i = 0; i < stepsToCompute; i++) {
    if (sim.state !== 'running') break;
    batch.push(computeStep(sim));
  }

  // Send batch to all clients
  if (batch.length > 0) {
    sim.broadcastFn(sim.flowsheetId, {
      type: 'sim:live:steps',
      payload: {
        runId: sim.runId,
        steps: batch,
      },
    });
  }

  // Wait at least UI_UPDATE_INTERVAL_MS between ticks
  const computeTime = Date.now() - tickStart;
  const remaining = Math.max(0, UI_UPDATE_INTERVAL_MS - computeTime);

  sim.timer = setTimeout(() => executeTick(sim), remaining);
}

// ── Persistence ─────────────────────────────────────────────────────────────

async function persistResults(sim) {
  try {
    const allWarn = [];
    for (const s of sim.emittedSteps) {
      if (s.warnings?.length) {
        for (const w of s.warnings) {
          if (!allWarn.includes(w)) allWarn.push(w);
        }
      }
    }

    const results = {
      mode:        'live',
      steps:       sim.emittedSteps,
      profileUsed: sim.profile,
      stepCount:   sim.emittedSteps.length,
      warnings:    allWarn,
    };

    const status = sim.state === 'cancelled' ? 'cancelled' : 'failed';

    await query(
      `UPDATE simulation_runs SET status = $1, results = $2, completed_at = NOW() WHERE id = $3`,
      [status, JSON.stringify(results), sim.runId]
    );
    logger.info('Live sim persisted', { runId: sim.runId, status, steps: sim.emittedSteps.length });
  } catch (err) {
    logger.error('Failed to persist live sim results', { runId: sim.runId, error: err.message });
  }
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Start a continuous live simulation for a flowsheet.
 * @param {number} speed — Steps per tick (1, 5, 10, 100, 1000). Default 1.
 */
function startLiveSim({ flowsheetId, runId, canvasData, nodeParams, timeSeriesConfig, speed, userId, broadcastFn }) {
  // Cancel any existing sim for this flowsheet
  if (activeSims.has(flowsheetId)) {
    const old = activeSims.get(flowsheetId);
    clearTimeout(old.timer);
    old.state = 'cancelled';
    persistResults(old);
    activeSims.delete(flowsheetId);
  }

  const tsc     = timeSeriesConfig || {};
  const profile = buildProfile(tsc.profile);

  const sim = new LiveSimulation({
    flowsheetId, runId, canvasData,
    nodeParams: nodeParams || {},
    profile, speed, userId, broadcastFn,
  });
  activeSims.set(flowsheetId, sim);

  logger.info('Live sim started (continuous)', {
    flowsheetId, runId, speed: sim.speed, uiIntervalMs: UI_UPDATE_INTERVAL_MS,
  });

  // First tick fires immediately for instant feedback
  executeTick(sim);

  return { runId, speed: sim.speed };
}

/**
 * Merge updated node params into the active simulation.
 * Called when the frontend sends params:update (e.g. from OPC polling).
 * The next step computation will use these updated values.
 */
function updateNodeParams(flowsheetId, { nodeId, params }) {
  const sim = activeSims.get(flowsheetId);
  if (!sim) return false;

  if (!nodeId || !params) return false;

  sim.nodeParams[nodeId] = { ...(sim.nodeParams[nodeId] || {}), ...params };
  return true;
}

/**
 * Change the speed multiplier mid-simulation.
 * @param {number} newSpeed — Steps per tick (1, 5, 10, 100, 1000)
 */
function setSpeed(flowsheetId, newSpeed) {
  const sim = activeSims.get(flowsheetId);
  if (!sim) return false;

  const clamped = Math.max(1, Math.min(10_000, Math.round(Number(newSpeed) || 1)));
  sim.speed = clamped;

  logger.info('Live sim speed changed', { flowsheetId, speed: clamped });
  return true;
}

/** Pause step emission. */
function pauseSim(flowsheetId) {
  const sim = activeSims.get(flowsheetId);
  if (!sim || sim.state !== 'running') return false;

  clearTimeout(sim.timer);
  sim.state = 'paused';
  return true;
}

/** Resume step emission from where it was paused. */
function resumeSim(flowsheetId) {
  const sim = activeSims.get(flowsheetId);
  if (!sim || sim.state !== 'paused') return false;

  sim.state = 'running';
  executeTick(sim);  // resume immediately
  return true;
}

/** Cancel simulation and persist partial results. */
function cancelSim(flowsheetId) {
  const sim = activeSims.get(flowsheetId);
  if (!sim) return false;

  clearTimeout(sim.timer);
  sim.state = 'cancelled';
  persistResults(sim);
  activeSims.delete(flowsheetId);
  return true;
}

/** Get current status for a flowsheet (for reconnecting clients). */
function getStatus(flowsheetId) {
  const sim = activeSims.get(flowsheetId);
  if (!sim) return null;

  return {
    runId:       sim.runId,
    state:       sim.state,
    currentStep: sim.currentStep,
    speed:       sim.speed,
    userId:      sim.userId,
  };
}

module.exports = { startLiveSim, setSpeed, pauseSim, resumeSim, cancelSim, getStatus, updateNodeParams };
