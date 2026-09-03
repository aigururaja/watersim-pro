'use strict';

const path = require('path');
const { runPython } = require('./pySpawn');

const PY_SCRIPT = path.join(__dirname, 'excel_report.py');

/**
 * Generate an Excel workbook buffer via the hardened Python runner in
 * pySpawn.js (PYTHON_BIN override, 30s timeout, 50MB output cap, shared
 * concurrency semaphore).
 *
 * @param {object} payload — { mode: 'single', data: reportData }
 *                         or { mode: 'comparison', runs: [...reportData] }
 * @returns {Promise<Buffer>} raw .xlsx bytes
 */
function generateExcel(payload) {
  return runPython(PY_SCRIPT, payload, 'Excel');
}

module.exports = { generateExcel };
