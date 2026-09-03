/**
 * WaterSim Pro — Valid alarm targets
 *
 * Alarm limits can only be placed on parameters that actually exist. This
 * module derives the complete set of legal targets from a flowsheet's
 * canvas_data using the SAME resolution the solver uses (resolveNodeType +
 * each model's DEFAULTS), so the rule "limits only on valid parameters" is
 * enforced against reality, not a hand-maintained list:
 *
 *   'param'       — a numeric model parameter of a canvas node (string-enum
 *                   settings like screenType/chamberType are excluded: a
 *                   min/max threshold on them is meaningless)
 *   'node_output' — a Stream quality field of the water leaving a node
 *                   (unitResults[nodeId].outputs.effluent.<field>)
 *   'effluent'    — a Stream quality field of the plant discharge
 *                   (summary.effluent.<field>; node_id is NULL)
 */
'use strict';

const { MODELS, resolveNodeType } = require('../simulation/solver');

/** Stream quality fields (see src/simulation/stream.js). */
const STREAM_FIELDS = ['Q', 'TSS', 'BOD', 'COD', 'TN', 'NH4', 'NO3', 'NO2', 'TP', 'DO', 'pH', 'temp'];

const nodeLabelOf = (node) =>
  (node.data && typeof node.data.label === 'string' && node.data.label.trim()) || node.id;

/** Numeric-valued model parameter keys for a resolved node type ([] when none). */
function numericParamKeys(node) {
  const type = resolveNodeType(node);
  const defaults = MODELS[type] && MODELS[type].DEFAULTS;
  if (!defaults) return [];
  return Object.keys(defaults).filter(
    (k) => typeof defaults[k] === 'number' && Number.isFinite(defaults[k])
  );
}

/**
 * Every legal alarm target for a canvas.
 * @param {object} canvasData — { nodes, edges }
 * @returns {Array<{targetType, nodeId, nodeLabel, paramKey, label, kind}>}
 */
function listValidTargets(canvasData) {
  const nodes = Array.isArray(canvasData && canvasData.nodes) ? canvasData.nodes : [];
  const targets = [];

  for (const node of nodes) {
    if (!node || typeof node.id !== 'string') continue;
    const nodeLabel = nodeLabelOf(node);

    for (const key of numericParamKeys(node)) {
      targets.push({
        targetType: 'param',
        nodeId:     node.id,
        nodeLabel,
        paramKey:   key,
        label:      `${nodeLabel} · ${key}`,
        kind:       'parameter',
      });
    }

    for (const field of STREAM_FIELDS) {
      targets.push({
        targetType: 'node_output',
        nodeId:     node.id,
        nodeLabel,
        paramKey:   field,
        label:      `${nodeLabel} outflow · ${field}`,
        kind:       'quality',
      });
    }
  }

  for (const field of STREAM_FIELDS) {
    targets.push({
      targetType: 'effluent',
      nodeId:     null,
      nodeLabel:  'Plant effluent',
      paramKey:   field,
      label:      `Plant effluent · ${field}`,
      kind:       'quality',
    });
  }

  return targets;
}

/**
 * Is { targetType, nodeId, paramKey } a legal alarm target for this canvas?
 * Uses the same derivation as listValidTargets (never a separate allowlist).
 */
function isValidTarget(canvasData, { targetType, nodeId, paramKey } = {}) {
  if (typeof paramKey !== 'string' || !paramKey) return false;

  if (targetType === 'effluent') {
    return (nodeId == null) && STREAM_FIELDS.includes(paramKey);
  }

  if (targetType !== 'param' && targetType !== 'node_output') return false;
  if (typeof nodeId !== 'string' || !nodeId) return false;

  const nodes = Array.isArray(canvasData && canvasData.nodes) ? canvasData.nodes : [];
  const node = nodes.find((n) => n && n.id === nodeId);
  if (!node) return false;

  if (targetType === 'node_output') return STREAM_FIELDS.includes(paramKey);
  return numericParamKeys(node).includes(paramKey);
}

/** nodeId → display label map for message building. */
function buildNodeLabels(canvasData) {
  const nodes = Array.isArray(canvasData && canvasData.nodes) ? canvasData.nodes : [];
  const labels = {};
  for (const node of nodes) {
    if (node && typeof node.id === 'string') labels[node.id] = nodeLabelOf(node);
  }
  return labels;
}

module.exports = { listValidTargets, isValidTarget, buildNodeLabels, STREAM_FIELDS };
