/**
 * WaterSim Pro — Flowsheet alarm API
 * Mounted at /api/v1/projects/:projectId/flowsheets/:flowsheetId (same base as
 * simulate and plc-bindings), so the paths are:
 *
 *   GET    .../alarm-targets            — every legal alarm target for the canvas
 *   GET    .../alarms                   — rules on this flowsheet
 *   POST   .../alarms                   — create a rule (engineer+)
 *   PATCH  .../alarms/:id               — partial update (engineer+)
 *   DELETE .../alarms/:id               — delete (engineer+)
 *   GET    .../alarm-events             — event history for this flowsheet
 *
 * "Limits only on valid parameters" is enforced against the flowsheet's own
 * canvas via src/alarms/validTargets.js — the same derivation the target list
 * serves — so a rule can never point at a node that isn't there or at a
 * string-enum setting (screenType/chamberType) where a min/max is meaningless.
 */
'use strict';

const express = require('express');
const { body, param, query: qv, validationResult } = require('express-validator');
const { query } = require('../db/pool');
const { authenticate, requireRole } = require('../middleware/auth');
const { auditLog } = require('../utils/audit');
const { listValidTargets, isValidTarget, STREAM_FIELDS } = require('../alarms/validTargets');
const { invalidateRuleCache } = require('../alarms/evaluator');
const { MODELS, resolveNodeType } = require('../simulation/solver');

const router = express.Router({ mergeParams: true }); // inherits :projectId + :flowsheetId
router.use(authenticate);

function vErr(req, res) {
  const e = validationResult(req);
  if (!e.isEmpty()) { res.status(422).json({ error: 'Validation failed', details: e.array() }); return true; }
  return false;
}

/** 422 in the same shape express-validator produces. */
function unprocessable(res, msg, path) {
  res.status(422).json({ error: 'Validation failed', details: [{ msg, path }] });
}

const orgId = (req) => req.user.org || req.user.organisationId;

/**
 * Verify the flowsheet belongs to the org (via projects join) and is not in a
 * deleted project; returns the row (with canvas_data) or null (404 sent).
 */
async function checkFlowsheet(req, res) {
  const r = await query(
    `SELECT f.id, f.canvas_data FROM flowsheets f
     JOIN projects p ON p.id = f.project_id
     WHERE f.id = $1 AND f.project_id = $2 AND p.organisation_id = $3 AND p.status != 'deleted'`,
    [req.params.flowsheetId, req.params.projectId, orgId(req)]
  );
  if (!r.rows[0]) { res.status(404).json({ error: 'Flowsheet not found' }); return null; }
  return r.rows[0];
}

// ── Target validation messages ───────────────────────────────────────────────

/** Human names for resolved model types (used in "not a numeric parameter of a …"). */
const TYPE_LABELS = {
  inlet:            'Inlet',
  outlet:           'Outlet',
  screen:           'Screen',
  grit:             'Grit Chamber',
  prim_clarifier:   'Primary Clarifier',
  aeration:         'Aeration Basin',
  sec_clarifier:    'Secondary Clarifier',
  thickener:        'Sludge Thickener',
  ro:               'RO Membrane',
  chemical_dosing:  'Chemical Dosing',
  uv_disinfection:  'UV Disinfection',
  granular_filter:  'Granular Filter',
  anaerobic_digest: 'Anaerobic Digester',
  pump:             'Pump',
  valve:            'Valve',
  passthrough:      'pass-through node',
};

const findNode = (canvasData, nodeId) =>
  (Array.isArray(canvasData && canvasData.nodes) ? canvasData.nodes : [])
    .find((n) => n && n.id === nodeId) || null;

/** Numeric (thresholdable) parameter keys of a canvas node. */
function numericParamKeys(node) {
  const model = MODELS[resolveNodeType(node)];
  const defaults = model && model.DEFAULTS;
  if (!defaults) return [];
  return Object.keys(defaults).filter(
    (k) => typeof defaults[k] === 'number' && Number.isFinite(defaults[k])
  );
}

/**
 * Explain why { targetType, nodeId, paramKey } is not a legal target for this
 * canvas, or null when it is. isValidTarget() stays the authority — this only
 * turns a rejection into a message that names what is wrong.
 */
function targetError(canvasData, target) {
  if (isValidTarget(canvasData, target)) return null;
  const { targetType, nodeId, paramKey } = target;

  if (targetType === 'effluent') {
    return `'${paramKey}' is not a plant effluent quality field (expected one of ${STREAM_FIELDS.join(', ')})`;
  }

  const node = findNode(canvasData, nodeId);
  if (!node) return `node '${nodeId}' is not on this flowsheet`;

  if (targetType === 'node_output') {
    return `'${paramKey}' is not a stream quality field (expected one of ${STREAM_FIELDS.join(', ')})`;
  }

  const type    = resolveNodeType(node);
  const label   = TYPE_LABELS[type] || type;
  const numeric = numericParamKeys(node);
  const valid   = numeric.length ? ` (valid: ${numeric.join(', ')})` : ' (this node has no numeric parameters)';
  return `'${paramKey}' is not a numeric parameter of a ${label}${valid}`;
}

/** Explain why the min/max pair is unusable, or null when it is fine. */
function limitError(minValue, maxValue) {
  const hasMin = minValue != null && Number.isFinite(Number(minValue));
  const hasMax = maxValue != null && Number.isFinite(Number(maxValue));
  if (!hasMin && !hasMax) return 'At least one of minValue / maxValue must be a finite number';
  if (hasMin && hasMax && Number(minValue) >= Number(maxValue)) return 'minValue must be less than maxValue';
  return null;
}

/** undefined/null/'' → null; anything else → Number (NaN is caught by limitError). */
const toLimit = (v) => (v === undefined || v === null || v === '' ? null : Number(v));

const flowsheetParams = [
  param('projectId').isUUID(),
  param('flowsheetId').isUUID(),
];

// ── GET /alarm-targets — legal targets derived from the canvas ───────────────
router.get('/alarm-targets', flowsheetParams, async (req, res, next) => {
  if (vErr(req, res)) return;
  try {
    const flowsheet = await checkFlowsheet(req, res);
    if (!flowsheet) return;
    res.json(listValidTargets(flowsheet.canvas_data));
  } catch (err) { next(err); }
});

// ── GET /alarms — rules on this flowsheet ────────────────────────────────────
router.get('/alarms', flowsheetParams, async (req, res, next) => {
  if (vErr(req, res)) return;
  try {
    if (!await checkFlowsheet(req, res)) return;
    const r = await query(
      `SELECT * FROM alarm_rules
       WHERE flowsheet_id = $1 AND organisation_id = $2
       ORDER BY created_at DESC`,
      [req.params.flowsheetId, orgId(req)]
    );
    res.json(r.rows);
  } catch (err) { next(err); }
});

// ── POST /alarms — create a rule (engineer+) ─────────────────────────────────
router.post('/alarms', requireRole('engineer'), [
  ...flowsheetParams,
  body('name').isString().trim().isLength({ min: 1, max: 120 }).withMessage('name is required (max 120 chars)'),
  body('targetType').isIn(['param', 'node_output', 'effluent'])
    .withMessage('targetType must be param, node_output or effluent'),
  body('nodeId').optional({ nullable: true }).isString().trim().isLength({ min: 1, max: 200 }),
  body('paramKey').isString().trim().isLength({ min: 1, max: 80 }).withMessage('paramKey is required (max 80 chars)'),
  body('minValue').optional({ nullable: true }).isFloat().withMessage('minValue must be a number').toFloat(),
  body('maxValue').optional({ nullable: true }).isFloat().withMessage('maxValue must be a number').toFloat(),
  body('severity').optional().isIn(['info', 'warning', 'critical']),
  body('enabled').optional().isBoolean().toBoolean(),
], async (req, res, next) => {
  if (vErr(req, res)) return;
  try {
    const flowsheet = await checkFlowsheet(req, res);
    if (!flowsheet) return;

    // Effluent rules are plant-wide — the schema requires node_id IS NULL.
    const targetType = req.body.targetType;
    const nodeId     = targetType === 'effluent' ? null : (req.body.nodeId ?? null);
    const paramKey   = req.body.paramKey;

    const tErr = targetError(flowsheet.canvas_data, { targetType, nodeId, paramKey });
    if (tErr) return unprocessable(res, tErr, 'target');

    const minValue = toLimit(req.body.minValue);
    const maxValue = toLimit(req.body.maxValue);
    const lErr = limitError(minValue, maxValue);
    if (lErr) return unprocessable(res, lErr, 'limits');

    const r = await query(
      `INSERT INTO alarm_rules
         (organisation_id, flowsheet_id, name, target_type, node_id, param_key,
          min_value, max_value, severity, enabled, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING *`,
      [orgId(req), req.params.flowsheetId, req.body.name, targetType, nodeId, paramKey,
       minValue, maxValue,
       req.body.severity || 'warning',
       req.body.enabled !== undefined ? req.body.enabled : true,
       req.user.sub || req.user.id]
    );

    invalidateRuleCache(req.params.flowsheetId);
    auditLog(req, 'alarm_rule.create', 'alarm_rule', r.rows[0].id, {
      flowsheetId: req.params.flowsheetId,
      name: req.body.name, targetType, nodeId, paramKey, minValue, maxValue,
      severity: r.rows[0].severity,
    });
    res.status(201).json(r.rows[0]);
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'An alarm rule already exists for this target' });
    }
    next(err);
  }
});

// ── PATCH /alarms/:id — partial update (engineer+) ───────────────────────────
router.patch('/alarms/:id', requireRole('engineer'), [
  ...flowsheetParams,
  param('id').isUUID(),
  body('name').optional().isString().trim().isLength({ min: 1, max: 120 }),
  body('targetType').optional().isIn(['param', 'node_output', 'effluent']),
  body('nodeId').optional({ nullable: true }).isString().trim().isLength({ min: 1, max: 200 }),
  body('paramKey').optional().isString().trim().isLength({ min: 1, max: 80 }),
  body('minValue').optional({ nullable: true }).isFloat().withMessage('minValue must be a number').toFloat(),
  body('maxValue').optional({ nullable: true }).isFloat().withMessage('maxValue must be a number').toFloat(),
  body('severity').optional().isIn(['info', 'warning', 'critical']),
  body('enabled').optional().isBoolean().toBoolean(),
], async (req, res, next) => {
  if (vErr(req, res)) return;
  try {
    const flowsheet = await checkFlowsheet(req, res);
    if (!flowsheet) return;

    const cur = await query(
      `SELECT * FROM alarm_rules WHERE id = $1 AND flowsheet_id = $2 AND organisation_id = $3`,
      [req.params.id, req.params.flowsheetId, orgId(req)]
    );
    if (!cur.rows[0]) return res.status(404).json({ error: 'Alarm rule not found' });
    const row = cur.rows[0];

    // Re-validate the target whenever any part of it moves — a PATCH must not
    // be able to smuggle in a target POST would have rejected.
    const targetTouched = ['targetType', 'nodeId', 'paramKey'].some((k) => req.body[k] !== undefined);
    const targetType = req.body.targetType !== undefined ? req.body.targetType : row.target_type;
    let nodeId = req.body.nodeId !== undefined ? req.body.nodeId : row.node_id;
    if (targetType === 'effluent') nodeId = null;             // schema: node_id IS NULL
    else if (nodeId == null) nodeId = row.node_id;
    const paramKey = req.body.paramKey !== undefined ? req.body.paramKey : row.param_key;

    if (targetTouched) {
      const tErr = targetError(flowsheet.canvas_data, { targetType, nodeId, paramKey });
      if (tErr) return unprocessable(res, tErr, 'target');
    }

    // Limits are always re-checked against the MERGED row, so clearing one
    // limit can never leave a rule with no threshold or an inverted window.
    const minValue = req.body.minValue !== undefined ? toLimit(req.body.minValue) : row.min_value;
    const maxValue = req.body.maxValue !== undefined ? toLimit(req.body.maxValue) : row.max_value;
    const lErr = limitError(minValue, maxValue);
    if (lErr) return unprocessable(res, lErr, 'limits');

    const fields = []; const vals = []; let i = 1;
    if (req.body.name     !== undefined) { fields.push(`name = $${i++}`);        vals.push(req.body.name); }
    if (targetTouched)                   { fields.push(`target_type = $${i++}`); vals.push(targetType);
                                           fields.push(`node_id = $${i++}`);     vals.push(nodeId);
                                           fields.push(`param_key = $${i++}`);   vals.push(paramKey); }
    if (req.body.minValue !== undefined) { fields.push(`min_value = $${i++}`);   vals.push(minValue); }
    if (req.body.maxValue !== undefined) { fields.push(`max_value = $${i++}`);   vals.push(maxValue); }
    if (req.body.severity !== undefined) { fields.push(`severity = $${i++}`);    vals.push(req.body.severity); }
    if (req.body.enabled  !== undefined) { fields.push(`enabled = $${i++}`);     vals.push(req.body.enabled); }
    if (!fields.length) return res.status(422).json({ error: 'No fields to update' });

    vals.push(req.params.id, req.params.flowsheetId, orgId(req));
    const r = await query(
      `UPDATE alarm_rules SET ${fields.join(', ')}
       WHERE id = $${i} AND flowsheet_id = $${i + 1} AND organisation_id = $${i + 2}
       RETURNING *`,
      vals
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'Alarm rule not found' });

    invalidateRuleCache(req.params.flowsheetId);
    auditLog(req, 'alarm_rule.update', 'alarm_rule', req.params.id, {
      flowsheetId: req.params.flowsheetId, fields: Object.keys(req.body),
    });
    res.json(r.rows[0]);
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'An alarm rule already exists for this target' });
    }
    next(err);
  }
});

// ── DELETE /alarms/:id (engineer+) ───────────────────────────────────────────
router.delete('/alarms/:id', requireRole('engineer'), [
  ...flowsheetParams,
  param('id').isUUID(),
], async (req, res, next) => {
  if (vErr(req, res)) return;
  try {
    if (!await checkFlowsheet(req, res)) return; // enforces p.status != 'deleted' too
    const r = await query(
      `DELETE FROM alarm_rules
       WHERE id = $1 AND flowsheet_id = $2 AND organisation_id = $3
       RETURNING id, name, target_type, node_id, param_key`,
      [req.params.id, req.params.flowsheetId, orgId(req)]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'Alarm rule not found' });

    invalidateRuleCache(req.params.flowsheetId);
    auditLog(req, 'alarm_rule.delete', 'alarm_rule', req.params.id, {
      flowsheetId: req.params.flowsheetId,
      name:       r.rows[0].name,
      targetType: r.rows[0].target_type,
      nodeId:     r.rows[0].node_id,
      paramKey:   r.rows[0].param_key,
    });
    res.json({ message: 'Alarm rule deleted' });
  } catch (err) { next(err); }
});

// ── GET /alarm-events — event history for this flowsheet ─────────────────────
router.get('/alarm-events', [
  ...flowsheetParams,
  qv('state').optional().isIn(['active', 'cleared']),
  qv('severity').optional().isIn(['info', 'warning', 'critical']),
  qv('limit').optional().isInt({ min: 1, max: 200 }).toInt(),
], async (req, res, next) => {
  if (vErr(req, res)) return;
  try {
    if (!await checkFlowsheet(req, res)) return;

    const params = [req.params.flowsheetId, orgId(req)];
    let sql = `
      SELECT e.*, r.name AS rule_name
      FROM alarm_events e
      JOIN alarm_rules r ON r.id = e.rule_id
      WHERE e.flowsheet_id = $1 AND e.organisation_id = $2`;
    let i = 3;
    if (req.query.state)    { sql += ` AND e.state = $${i++}`;    params.push(req.query.state); }
    if (req.query.severity) { sql += ` AND e.severity = $${i++}`; params.push(req.query.severity); }

    sql += ` ORDER BY e.triggered_at DESC, e.id DESC LIMIT $${i}`;
    params.push(req.query.limit || 50);

    const r = await query(sql, params);
    res.json(r.rows);
  } catch (err) { next(err); }
});

module.exports = router;
