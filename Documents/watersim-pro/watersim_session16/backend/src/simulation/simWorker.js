/**
 * WaterSim Pro — Simulation worker entry (worker_threads)
 *
 * Runs one simulation and posts the result back to the parent.
 * The simulation engine is pure (no DB / express imports), so this file
 * requires the solvers directly and receives { mode, canvasData, config }
 * via workerData.
 */

'use strict';

const { parentPort, workerData } = require('worker_threads');
const { runSteadyState } = require('./solver');
const { runDynamic }     = require('./dynamicSolver');

try {
  const { mode, canvasData, config } = workerData || {};
  const result = mode === 'dynamic'
    ? runDynamic(canvasData, config || {})
    : runSteadyState(canvasData, config || {});
  parentPort.postMessage({ ok: true, result });
} catch (err) {
  parentPort.postMessage({ ok: false, error: (err && err.message) || String(err) });
}
