/**
 * WaterSim Pro — Simulation runner (worker-thread execution)
 *
 * Runs solver executions off the event loop in worker threads so a heavy
 * flowsheet can never freeze the HTTP server. Design:
 *
 *   - one fresh worker per run (no warm pool to leak state between runs)
 *   - a concurrency cap (default 4) with a FIFO queue in front of it
 *   - a wall-clock timeout (default 60s, SIMULATION_TIMEOUT_MS env) that
 *     terminates the worker; callers mark the run 'failed'
 *
 * The HTTP contract stays synchronous: routes simply `await runSimulation(...)`.
 *
 * Rejection contract:
 *   err.timedOut    === true → the wall-clock limit was hit (worker terminated)
 *   err.solverError === true → the engine itself threw (bad flowsheet, etc.)
 *   otherwise                → infrastructure failure (worker crashed, ...)
 */

'use strict';

const path = require('path');
const { Worker } = require('worker_threads');
const logger = require('../utils/logger');

const WORKER_PATH = path.join(__dirname, 'simWorker.js');

const MAX_CONCURRENT     = Math.max(1, parseInt(process.env.SIMULATION_MAX_CONCURRENT || '4', 10) || 4);
const DEFAULT_TIMEOUT_MS = Math.max(1000, parseInt(process.env.SIMULATION_TIMEOUT_MS || '60000', 10) || 60000);

let active = 0;
const queue = [];

function drainQueue() {
  while (active < MAX_CONCURRENT && queue.length > 0) {
    const job = queue.shift();
    active += 1;
    executeJob(job)
      .then(job.resolve, job.reject)
      .finally(() => {
        active -= 1;
        drainQueue();
      });
  }
}

function executeJob({ mode, canvasData, config, timeoutMs }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const worker = new Worker(WORKER_PATH, {
      workerData: { mode, canvasData, config },
      // Don't inherit parent execArgv (e.g. test-runner flags) into the worker.
      execArgv: [],
    });

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      const err = new Error(
        `Simulation exceeded the ${Math.round(timeoutMs / 1000)}s wall-clock limit and was terminated`
      );
      err.timedOut = true;
      logger.warn('Simulation worker timed out — terminating', { mode, timeoutMs });
      worker.terminate().catch(() => {});
      reject(err);
    }, timeoutMs);
    timer.unref();

    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(arg);
      // Worker exits on its own after postMessage; terminate defensively.
      worker.terminate().catch(() => {});
    };

    worker.once('message', (msg) => {
      if (msg && msg.ok) {
        finish(resolve, msg.result);
      } else {
        const err = new Error((msg && msg.error) || 'Simulation solver failed');
        err.solverError = true;
        finish(reject, err);
      }
    });

    worker.once('error', (err) => {
      logger.error('Simulation worker crashed', { error: err.message });
      finish(reject, new Error(`Simulation worker error: ${err.message}`));
    });

    worker.once('exit', (code) => {
      if (!settled && code !== 0) {
        finish(reject, new Error(`Simulation worker exited unexpectedly (code ${code})`));
      }
    });
  });
}

/**
 * Run a simulation in a worker thread.
 * @param {object} opts
 * @param {'steady_state'|'dynamic'} [opts.mode]
 * @param {object} opts.canvasData — { nodes, edges }
 * @param {object} [opts.config]  — { nodeParams, timeSeriesConfig, permitLimits, unitCosts }
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<object>} solver result
 */
function runSimulation({ mode = 'steady_state', canvasData, config = {}, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  return new Promise((resolve, reject) => {
    queue.push({ mode, canvasData, config, timeoutMs, resolve, reject });
    drainQueue();
  });
}

/** Introspection (used by tests / diagnostics). */
function runnerStats() {
  return { active, queued: queue.length, maxConcurrent: MAX_CONCURRENT, defaultTimeoutMs: DEFAULT_TIMEOUT_MS };
}

module.exports = { runSimulation, runnerStats, DEFAULT_TIMEOUT_MS, MAX_CONCURRENT };
