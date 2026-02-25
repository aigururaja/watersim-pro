/**
 * WaterSim Pro — PDF Report Generator
 *
 * Generates a professional engineering report PDF from a completed simulation run.
 * Uses child_process to invoke a Python script (reportlab) since Node.js lacks
 * a first-class PDF layout engine.
 *
 * The Python script is at: backend/src/reports/pdf_report.py
 * It reads JSON from stdin and writes PDF bytes to stdout.
 */

'use strict';

const { spawn } = require('child_process');
const path      = require('path');
const logger    = require('../utils/logger');

const PY_SCRIPT = path.join(__dirname, 'pdf_report.py');

/**
 * Generate a PDF report buffer from report data.
 * @param {object} reportData — structured report object (see buildReportData)
 * @returns {Promise<Buffer>} — raw PDF bytes
 */
function generatePdf(reportData) {
  return new Promise((resolve, reject) => {
    const py = spawn('python3', [PY_SCRIPT], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const chunks = [];
    const errChunks = [];

    py.stdout.on('data', (chunk) => chunks.push(chunk));
    py.stderr.on('data', (chunk) => errChunks.push(chunk));

    py.on('close', (code) => {
      if (code !== 0) {
        const errMsg = Buffer.concat(errChunks).toString('utf8');
        logger.error('PDF generator script failed', { code, stderr: errMsg.slice(0, 500) });
        return reject(new Error(`PDF generation failed (exit ${code}): ${errMsg.slice(0, 200)}`));
      }
      resolve(Buffer.concat(chunks));
    });

    py.on('error', (err) => {
      reject(new Error(`Failed to spawn Python: ${err.message}. Ensure python3 is installed.`));
    });

    // Send report data as JSON to stdin
    py.stdin.write(JSON.stringify(reportData));
    py.stdin.end();
  });
}

module.exports = { generatePdf };
