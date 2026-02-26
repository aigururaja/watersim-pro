/**
 * WaterSim Pro — Live Simulation Runner
 *
 * Pre-computes all dynamic simulation steps eagerly, then emits them
 * one-by-one via a WebSocket broadcast callback at a configurable pace.
 *
 * Speed is a real-time multiplier (1x–1000x).
 * At 100x, 1 simulated hour = 36 seconds wall-clock.
 * At 1000x, 1 simulated hour = 3.6 seconds wall-clock.
 *
 * Supports pause, resume, cancel, and speed changes mid-simulation.
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

class LiveSimulation {
  constructor({ flowsheetId, runId, steps, profile, speed, userId, broadcastFn }) {
    this.flowsheetId  = flowsheetId;
    this.runId        = runId;
    this.steps        = steps;          // Pre-computed step results array
    this.profile      = profile;
    this.totalSteps   = steps.length;
    this.currentStep  = 0;              // Next step index to emit
    this.speed        = speed;          // Real-time multiplier (1–1000)
    this.state        = 'running';      // running | paused | completed | cancelled
    this.timer        = null;           // setTimeout handle
    this.userId       = userId;
    this.broadcastFn  = broadcastFn;
  }

  /** Milliseconds between step emissions */
  get intervalMs() {
    return 3_600_000 / this.speed;
  }
}

// ── Pre-compute all steps ───────────────────────────────────────────────────

function preComputeSteps(canvasData, nodeParams, timeSeriesConfig) {
  const tsc             = timeSeriesConfig || {};
  const hoursToSimulate = Math.min(Math.max(tsc.hoursToSimulate ?? 24, 1), 48);
  const profile         = buildProfile(tsc.profile);

  const steps = [];
  for (let h = 0; h < hoursToSimulate; h++) {
    const stepEntry    = profile[h % 24];
    const scaledParams = scaleInletParams(canvasData, nodeParams, stepEntry, inletDefaults);
    const result       = runSteadyState(canvasData, { nodeParams: scaledParams });

    steps.push({
      hour:          h,
      stepEntry,
      streamResults: result.streamResults,
      unitResults:   result.unitResults,
      summary:       result.summary,
      warnings:      result.warnings,
    });
  }

  return { steps, profile: profile.slice(0, hoursToSimulate) };
}

// ── Emission loop ───────────────────────────────────────────────────────────

function emitStep(sim) {
  const step = sim.steps[sim.currentStep];
  sim.currentStep++;

  sim.broadcastFn(sim.flowsheetId, {
    type: 'sim:live:step',
    payload: {
      runId:      sim.runId,
      step,
      stepIndex:  sim.currentStep - 1,
      totalSteps: sim.totalSteps,
      progress:   sim.currentStep / sim.totalSteps,
    },
  });
}

function scheduleNext(sim, immediate) {
  if (sim.state !== 'running') return;

  if (sim.currentStep >= sim.totalSteps) {
    sim.state = 'completed';
    sim.broadcastFn(sim.flowsheetId, {
      type: 'sim:live:complete',
      payload: {
        runId:      sim.runId,
        totalSteps: sim.totalSteps,
        summary:    sim.steps[sim.totalSteps - 1]?.summary || null,
      },
    });
    persistResults(sim);
    activeSims.delete(sim.flowsheetId);
    return;
  }

  // Emit the first step immediately so the UI gets instant feedback
  if (immediate) {
    emitStep(sim);
    scheduleNext(sim, false);
    return;
  }

  sim.timer = setTimeout(() => {
    if (sim.state !== 'running') return;
    emitStep(sim);
    scheduleNext(sim, false);
  }, sim.intervalMs);
}

// ── Persistence ─────────────────────────────────────────────────────────────

async function persistResults(sim) {
  try {
    const emittedSteps = sim.steps.slice(0, sim.currentStep);
    const allWarn = [];
    for (const s of emittedSteps) {
      if (s.warnings?.length) {
        for (const w of s.warnings) {
          if (!allWarn.includes(w)) allWarn.push(w);
        }
      }
    }

    const results = {
      mode:        'dynamic',
      steps:       emittedSteps,
      profileUsed: sim.profile,
      stepCount:   emittedSteps.length,
      warnings:    allWarn,
    };

    const status = sim.state === 'completed' ? 'completed'
                 : sim.state === 'cancelled' ? 'cancelled'
                 : 'failed';

    await query(
      `UPDATE simulation_runs SET status = $1, results = $2, completed_at = NOW() WHERE id = $3`,
      [status, JSON.stringify(results), sim.runId]
    );
    logger.info('Live sim persisted', { runId: sim.runId, status, steps: emittedSteps.length });
  } catch (err) {
    logger.error('Failed to persist live sim results', { runId: sim.runId, error: err.message });
  }
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Start a live simulation for a flowsheet.
 * Pre-computes all steps, then begins timed emission via broadcastFn.
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

  const clampedSpeed = Math.min(Math.max(speed || 100, 1), 1000);

  // Pre-compute all steps (CPU-bound, typically < 3s for 48 steps)
  const { steps, profile } = preComputeSteps(canvasData, nodeParams || {}, timeSeriesConfig);

  const sim = new LiveSimulation({
    flowsheetId, runId, steps, profile,
    speed: clampedSpeed, userId, broadcastFn,
  });
  activeSims.set(flowsheetId, sim);

  logger.info('Live sim started', { flowsheetId, runId, steps: steps.length, speed: clampedSpeed });

  // Begin emission — first step emits immediately for instant feedback
  scheduleNext(sim, true);

  return { runId, totalSteps: steps.length };
}

/** Change playback speed mid-simulation. */
function setSpeed(flowsheetId, newSpeed) {
  const sim = activeSims.get(flowsheetId);
  if (!sim) return false;

  sim.speed = Math.min(Math.max(newSpeed || 100, 1), 1000);
  // Reschedule: clear current timer and re-queue with new interval
  if (sim.state === 'running') {
    clearTimeout(sim.timer);
    scheduleNext(sim, false);
  }
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
  scheduleNext(sim, true);  // emit next step immediately on resume
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
    totalSteps:  sim.totalSteps,
    speed:       sim.speed,
    userId:      sim.userId,
  };
}

module.exports = { startLiveSim, setSpeed, pauseSim, resumeSim, cancelSim, getStatus };
