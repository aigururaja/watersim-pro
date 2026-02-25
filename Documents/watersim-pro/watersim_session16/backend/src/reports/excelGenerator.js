'use strict';

const { spawn } = require('child_process');
const path      = require('path');
const logger    = require('../utils/logger');

const PY_SCRIPT = path.join(__dirname, 'excel_report.py');

/**
 * Generate an Excel workbook buffer.
 * @param {object} payload — { mode: 'single', data: reportData }
 *                         or { mode: 'comparison', runs: [...reportData] }
 * @returns {Promise<Buffer>} raw .xlsx bytes
 */
function generateExcel(payload) {
  return new Promise((resolve, reject) => {
    const py = spawn('python3', [PY_SCRIPT], { stdio: ['pipe', 'pipe', 'pipe'] });

    const chunks   = [];
    const errChunks = [];

    py.stdout.on('data', c => chunks.push(c));
    py.stderr.on('data', c => errChunks.push(c));

    py.on('close', code => {
      if (code !== 0) {
        const msg = Buffer.concat(errChunks).toString('utf8');
        logger.error('Excel generator failed', { code, stderr: msg.slice(0, 500) });
        return reject(new Error(`Excel generation failed (exit ${code}): ${msg.slice(0, 200)}`));
      }
      resolve(Buffer.concat(chunks));
    });

    py.on('error', err =>
      reject(new Error(`Failed to spawn Python: ${err.message}`))
    );

    py.stdin.write(JSON.stringify(payload));
    py.stdin.end();
  });
}

module.exports = { generateExcel };
