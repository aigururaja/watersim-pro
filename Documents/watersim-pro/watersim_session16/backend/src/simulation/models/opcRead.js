/**
 * WaterSim Pro — OPC Read Model
 *
 * Reads live values from an OPC-UA server and injects them into the
 * simulation stream. During simulation, uses cached lastValue from
 * each tag mapping to override the corresponding stream parameter.
 *
 * params.tagMappings: [{ streamVar: 'Q', opcTag: 'ns=2;s=Flow.PV', lastValue: 10000 }]
 */

'use strict';

const { Stream } = require('../stream');

const DEFAULTS = {
  endpointUrl: '',
  mode: 'sync',      // 'sync' | 'async'
  intervalSec: 5,
  tagMappings: [],    // [{ streamVar, opcTag, lastValue }]
};

const VALID_STREAM_VARS = ['Q', 'TSS', 'BOD', 'COD', 'TN', 'NH4', 'NO3', 'NO2', 'TP', 'DO', 'pH', 'temp'];

function solve(inputs, params = {}) {
  const p   = { ...DEFAULTS, ...params };
  const inf = inputs.influent || new Stream();

  // Start with a clone of the influent
  const overrides = {};
  const mappedTags = [];
  let overrideCount = 0;

  if (Array.isArray(p.tagMappings)) {
    for (const mapping of p.tagMappings) {
      if (!mapping.streamVar || !VALID_STREAM_VARS.includes(mapping.streamVar)) continue;
      if (mapping.lastValue == null) continue;

      const val = Number(mapping.lastValue);
      if (isNaN(val)) continue;

      overrides[mapping.streamVar] = val;
      overrideCount++;
      mappedTags.push({
        streamVar: mapping.streamVar,
        opcTag: mapping.opcTag,
        value: val,
      });
    }
  }

  const effluent = inf.clone(overrides);

  return {
    effluent,
    metrics: {
      source: 'opc_read',
      endpointUrl: p.endpointUrl || '(not configured)',
      mode: p.mode,
      intervalSec: p.mode === 'sync' ? p.intervalSec : null,
      mappedTags: overrideCount,
      tagDetails: mappedTags,
    },
  };
}

module.exports = { solve, DEFAULTS };
