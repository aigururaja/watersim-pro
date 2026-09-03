/**
 * WaterSim Pro — PDF Report Generator
 *
 * Generates a professional engineering report PDF from a completed simulation
 * run. Delegates to a Python script (reportlab) via the hardened runner in
 * pySpawn.js (PYTHON_BIN override, 30s timeout, 50MB output cap, shared
 * concurrency semaphore).
 *
 * The Python script is at: backend/src/reports/pdf_report.py
 * It reads JSON from stdin and writes PDF bytes to stdout.
 */

'use strict';

const path = require('path');
const { runPython } = require('./pySpawn');

const PY_SCRIPT = path.join(__dirname, 'pdf_report.py');

/**
 * Generate a PDF report buffer from report data.
 * @param {object} reportData — structured report object (see buildReportData)
 * @returns {Promise<Buffer>} — raw PDF bytes
 */
function generatePdf(reportData) {
  return runPython(PY_SCRIPT, reportData, 'PDF');
}

module.exports = { generatePdf };
