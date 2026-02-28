/**
 * WaterSim Pro — OPC Write Model
 *
 * Pass-through unit that records which simulation stream values should
 * be written to an OPC-UA server. The actual OPC write is triggered by
 * the frontend after simulation completes, using the /opc/write API.
 *
 * params.tagMappings: [{ streamVar: 'Q', opcTag: 'ns=2;s=Flow.SP' }]
 */

'use strict';

const { Stream } = require('../stream');

const DEFAULTS = {
  endpointUrl: '',
  mode: 'sync',      // 'sync' | 'async'
  intervalSec: 5,
  tagMappings: [],    // [{ streamVar, opcTag }]
};

const VALID_STREAM_VARS = ['Q', 'TSS', 'BOD', 'COD', 'TN', 'NH4', 'NO3', 'NO2', 'TP', 'DO', 'pH', 'temp'];

function solve(inputs, params = {}) {
  const p   = { ...DEFAULTS, ...params };
  const inf = inputs.influent || new Stream();

  // Pass-through — no transformation
  const effluent = inf.clone();

  // Build write payload from current stream values
  const writePayload = [];
  if (Array.isArray(p.tagMappings)) {
    for (const mapping of p.tagMappings) {
      if (!mapping.streamVar || !VALID_STREAM_VARS.includes(mapping.streamVar)) continue;
      if (!mapping.opcTag) continue;

      writePayload.push({
        opcTag: mapping.opcTag,
        streamVar: mapping.streamVar,
        value: inf[mapping.streamVar] ?? null,
      });
    }
  }

  return {
    effluent,
    metrics: {
      source: 'opc_write',
      endpointUrl: p.endpointUrl || '(not configured)',
      mode: p.mode,
      intervalSec: p.mode === 'sync' ? p.intervalSec : null,
      mappedTags: writePayload.length,
      writePayload,
    },
  };
}

module.exports = { solve, DEFAULTS };
