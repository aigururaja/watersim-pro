/**
 * WaterSim Pro — Hardened Python subprocess runner
 *
 * Shared by pdfGenerator.js and excelGenerator.js. Hardening:
 *   - PYTHON_BIN env override (default 'python3'; 'python' on Windows, where
 *     the python3 shim usually doesn't exist)
 *   - wall-clock timeout (default 30s, PY_REPORT_TIMEOUT_MS env) that kills
 *     the child
 *   - 50MB stdout cap — a runaway script can't balloon process memory
 *   - shared concurrency semaphore of 2 — report generation can't fork-bomb
 *     the host under a burst of export requests
 *
 * The child reads a JSON payload on stdin and writes raw bytes to stdout.
 */

'use strict';

const { spawn } = require('child_process');
const logger    = require('../utils/logger');

const PYTHON_BIN = process.env.PYTHON_BIN
  || (process.platform === 'win32' ? 'python' : 'python3');

const TIMEOUT_MS       = Math.max(1000, parseInt(process.env.PY_REPORT_TIMEOUT_MS || '30000', 10) || 30000);
const MAX_STDOUT_BYTES = 50 * 1024 * 1024; // 50MB
const MAX_CONCURRENT   = 2;

// ── Tiny FIFO semaphore ──────────────────────────────────────────────────────
let active = 0;
const waiters = [];

function acquire() {
  if (active < MAX_CONCURRENT) {
    active += 1;
    return Promise.resolve();
  }
  return new Promise((resolve) => waiters.push(resolve));
}

function release() {
  const next = waiters.shift();
  if (next) {
    next(); // hand the slot straight to the next waiter (active unchanged)
  } else {
    active -= 1;
  }
}

/**
 * Run a Python script with a JSON payload on stdin; resolve with its stdout.
 * @param {string} scriptPath — absolute path to the .py script
 * @param {object} payload    — JSON-serialised onto stdin
 * @param {string} label      — for log lines ('PDF', 'Excel', ...)
 * @returns {Promise<Buffer>}
 */
async function runPython(scriptPath, payload, label = 'python') {
  await acquire();
  try {
    return await new Promise((resolve, reject) => {
      const py = spawn(PYTHON_BIN, [scriptPath], { stdio: ['pipe', 'pipe', 'pipe'] });

      const chunks    = [];
      const errChunks = [];
      let stdoutBytes = 0;
      let settled     = false;
      let killedFor   = null; // 'timeout' | 'stdout-cap'

      const fail = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      };

      const timer = setTimeout(() => {
        killedFor = 'timeout';
        logger.error(`${label} generator timed out — killing child`, { timeoutMs: TIMEOUT_MS });
        py.kill('SIGKILL');
      }, TIMEOUT_MS);
      timer.unref();

      py.stdout.on('data', (chunk) => {
        stdoutBytes += chunk.length;
        if (stdoutBytes > MAX_STDOUT_BYTES) {
          killedFor = 'stdout-cap';
          logger.error(`${label} generator exceeded 50MB stdout cap — killing child`);
          py.kill('SIGKILL');
          return;
        }
        chunks.push(chunk);
      });
      py.stderr.on('data', (chunk) => {
        if (errChunks.reduce((n, c) => n + c.length, 0) < 64 * 1024) errChunks.push(chunk);
      });

      py.on('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (killedFor === 'timeout') {
          return reject(new Error(`${label} generation timed out after ${Math.round(TIMEOUT_MS / 1000)}s`));
        }
        if (killedFor === 'stdout-cap') {
          return reject(new Error(`${label} generation aborted: output exceeded the 50MB limit`));
        }
        if (code !== 0) {
          const errMsg = Buffer.concat(errChunks).toString('utf8');
          logger.error(`${label} generator script failed`, { code, stderr: errMsg.slice(0, 500) });
          return reject(new Error(`${label} generation failed (exit ${code}): ${errMsg.slice(0, 200)}`));
        }
        resolve(Buffer.concat(chunks));
      });

      py.on('error', (err) => {
        fail(new Error(`Failed to spawn ${PYTHON_BIN}: ${err.message}. Set PYTHON_BIN if Python lives elsewhere.`));
      });

      py.stdin.on('error', () => { /* child died before reading stdin — close handler reports it */ });
      py.stdin.write(JSON.stringify(payload));
      py.stdin.end();
    });
  } finally {
    release();
  }
}

module.exports = { runPython, PYTHON_BIN };
