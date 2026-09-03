/**
 * WaterSim Pro — PLC binding API
 * Mounted at /api/v1/projects/:projectId/flowsheets/:flowsheetId (same base
 * as simulate), so the paths are:
 *
 *   GET    .../plc-bindings                  — bindings + connection name/protocol
 *   POST   .../plc-bindings                  — upsert on (flowsheet, node, param) (engineer+)
 *   PATCH  .../plc-bindings/:bindingId       — partial update (engineer+)
 *   DELETE .../plc-bindings/:bindingId       — delete (engineer+)
 *   GET    .../plc-values                    — latest sampled values
 *   POST   .../plc-bindings/:bindingId/write — write a value to the PLC (operator+)
 *
 * Values are engineering units: reported value = raw * scale + offset_val;
 * a write sends (value - offset_val) / scale to the device.
 */
'use strict';

const express = require('express');
const { body, param, validationResult } = require('express-validator');
const { query } = require('../db/pool');
const { authenticate, requireRole } = require('../middleware/auth');
const { auditLog } = require('../utils/audit');
const logger = require('../utils/logger');
const { getDriver } = require('../plc/registry');

const router = express.Router({ mergeParams: true }); // inherits :projectId + :flowsheetId
router.use(authenticate);

function vErr(req, res) {
  const e = validationResult(req);
  if (!e.isEmpty()) { res.status(422).json({ error: 'Validation failed', details: e.array() }); return true; }
  return false;
}

const orgId = (req) => req.user.org || req.user.organisationId;

/** Verify the flowsheet belongs to the org (via projects join); 404 otherwise. */
async function checkFlowsheet(req, res) {
  const r = await query(
    `SELECT f.id FROM flowsheets f
     JOIN projects p ON p.id = f.project_id
     WHERE f.id = $1 AND f.project_id = $2 AND p.organisation_id = $3 AND p.status != 'deleted'`,
    [req.params.flowsheetId, req.params.projectId, orgId(req)]
  );
  if (!r.rows[0]) { res.status(404).json({ error: 'Flowsheet not found' }); return false; }
  return true;
}

/** Verify the connection belongs to the org; returns the row or null (404 sent). */
async function loadConnection(connectionId, organisationId, res) {
  const r = await query(
    `SELECT * FROM plc_connections WHERE id = $1 AND organisation_id = $2`,
    [connectionId, organisationId]
  );
  if (!r.rows[0]) { res.status(404).json({ error: 'PLC connection not found' }); return null; }
  return r.rows[0];
}

const flowsheetParams = [
  param('projectId').isUUID(),
  param('flowsheetId').isUUID(),
];

// ── GET /plc-bindings ────────────────────────────────────────────────────────
router.get('/plc-bindings', flowsheetParams, async (req, res, next) => {
  if (vErr(req, res)) return;
  try {
    if (!await checkFlowsheet(req, res)) return;
    const r = await query(
      `SELECT b.*, c.name AS connection_name, c.protocol AS connection_protocol,
              c.status AS connection_status
       FROM plc_bindings b
       JOIN plc_connections c ON c.id = b.connection_id
       WHERE b.flowsheet_id = $1 AND b.organisation_id = $2
       ORDER BY b.node_id, b.param_key`,
      [req.params.flowsheetId, orgId(req)]
    );
    res.json(r.rows);
  } catch (err) { next(err); }
});

// ── POST /plc-bindings — upsert (engineer+) ──────────────────────────────────
router.post('/plc-bindings', requireRole('engineer'), [
  ...flowsheetParams,
  body('nodeId').isString().trim().isLength({ min: 1, max: 80 }).withMessage('nodeId is required (max 80 chars)'),
  body('paramKey').isString().trim().isLength({ min: 1, max: 80 }).withMessage('paramKey is required (max 80 chars)'),
  body('connectionId').isUUID().withMessage('connectionId must be a UUID'),
  body('address').isString().trim().isLength({ min: 1, max: 200 }).withMessage('address is required (max 200 chars)'),
  body('direction').optional().isIn(['read', 'write', 'read_write']),
  body('scale').optional().isFloat().toFloat().custom((v) => { if (v === 0) throw new Error('scale must not be 0'); return true; }),
  body('offset').optional().isFloat().toFloat(),
  body('pollIntervalMs').optional({ nullable: true }).isInt({ min: 100, max: 3600000 }).toInt(),
  body('enabled').optional().isBoolean().toBoolean(),
], async (req, res, next) => {
  if (vErr(req, res)) return;
  try {
    if (!await checkFlowsheet(req, res)) return;
    const conn = await loadConnection(req.body.connectionId, orgId(req), res);
    if (!conn) return;

    // Validate the address against the driver when it can check locally.
    const driver = getDriver(conn.protocol);
    const addrError = driver?.validateAddress ? driver.validateAddress(req.body.address) : null;
    if (addrError) {
      return res.status(422).json({ error: 'Validation failed', details: [{ msg: addrError, path: 'address' }] });
    }

    const r = await query(
      `INSERT INTO plc_bindings
         (organisation_id, flowsheet_id, node_id, param_key, connection_id, address,
          direction, scale, offset_val, poll_interval_ms, enabled)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (flowsheet_id, node_id, param_key) DO UPDATE SET
         connection_id    = EXCLUDED.connection_id,
         address          = EXCLUDED.address,
         direction        = EXCLUDED.direction,
         scale            = EXCLUDED.scale,
         offset_val       = EXCLUDED.offset_val,
         poll_interval_ms = EXCLUDED.poll_interval_ms,
         enabled          = EXCLUDED.enabled
       RETURNING *`,
      [orgId(req), req.params.flowsheetId, req.body.nodeId, req.body.paramKey,
       req.body.connectionId, req.body.address,
       req.body.direction || 'read',
       req.body.scale !== undefined ? req.body.scale : 1,
       req.body.offset !== undefined ? req.body.offset : 0,
       req.body.pollIntervalMs !== undefined ? req.body.pollIntervalMs : null,
       req.body.enabled !== undefined ? req.body.enabled : true]
    );
    auditLog(req, 'plc_binding.create', 'plc_binding', r.rows[0].id, {
      flowsheetId: req.params.flowsheetId,
      nodeId: req.body.nodeId,
      paramKey: req.body.paramKey,
      connectionId: req.body.connectionId,
      address: req.body.address,
    });
    res.status(201).json(r.rows[0]);
  } catch (err) { next(err); }
});

// ── PATCH /plc-bindings/:bindingId (engineer+) ──────────────────────────────
router.patch('/plc-bindings/:bindingId', requireRole('engineer'), [
  ...flowsheetParams,
  param('bindingId').isUUID(),
  body('connectionId').optional().isUUID(),
  body('address').optional().isString().trim().isLength({ min: 1, max: 200 }),
  body('direction').optional().isIn(['read', 'write', 'read_write']),
  body('scale').optional().isFloat().toFloat().custom((v) => { if (v === 0) throw new Error('scale must not be 0'); return true; }),
  body('offset').optional().isFloat().toFloat(),
  body('pollIntervalMs').optional({ nullable: true }).custom((v) => {
    if (v === null) return true;
    if (!Number.isInteger(Number(v)) || v < 100 || v > 3600000) throw new Error('pollIntervalMs must be 100–3600000 or null');
    return true;
  }),
  body('enabled').optional().isBoolean().toBoolean(),
], async (req, res, next) => {
  if (vErr(req, res)) return;
  try {
    if (!await checkFlowsheet(req, res)) return;
    if (req.body.connectionId !== undefined) {
      const conn = await loadConnection(req.body.connectionId, orgId(req), res);
      if (!conn) return;
    }

    const fields = []; const vals = []; let i = 1;
    if (req.body.connectionId   !== undefined) { fields.push(`connection_id = $${i++}`);    vals.push(req.body.connectionId); }
    if (req.body.address        !== undefined) { fields.push(`address = $${i++}`);          vals.push(req.body.address); }
    if (req.body.direction      !== undefined) { fields.push(`direction = $${i++}`);        vals.push(req.body.direction); }
    if (req.body.scale          !== undefined) { fields.push(`scale = $${i++}`);            vals.push(req.body.scale); }
    if (req.body.offset         !== undefined) { fields.push(`offset_val = $${i++}`);       vals.push(req.body.offset); }
    if (req.body.pollIntervalMs !== undefined) { fields.push(`poll_interval_ms = $${i++}`); vals.push(req.body.pollIntervalMs); }
    if (req.body.enabled        !== undefined) { fields.push(`enabled = $${i++}`);          vals.push(req.body.enabled); }
    if (!fields.length) return res.status(422).json({ error: 'No fields to update' });

    vals.push(req.params.bindingId, req.params.flowsheetId, orgId(req));
    const r = await query(
      `UPDATE plc_bindings SET ${fields.join(', ')}
       WHERE id = $${i} AND flowsheet_id = $${i + 1} AND organisation_id = $${i + 2}
       RETURNING *`,
      vals
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'Binding not found' });
    auditLog(req, 'plc_binding.update', 'plc_binding', req.params.bindingId, { fields: Object.keys(req.body) });
    res.json(r.rows[0]);
  } catch (err) { next(err); }
});

// ── DELETE /plc-bindings/:bindingId (engineer+) ──────────────────────────────
router.delete('/plc-bindings/:bindingId', requireRole('engineer'), [
  ...flowsheetParams,
  param('bindingId').isUUID(),
], async (req, res, next) => {
  if (vErr(req, res)) return;
  try {
    if (!await checkFlowsheet(req, res)) return; // enforces p.status != 'deleted' too
    const r = await query(
      `DELETE FROM plc_bindings
       WHERE id = $1 AND flowsheet_id = $2 AND organisation_id = $3
       RETURNING id, node_id, param_key`,
      [req.params.bindingId, req.params.flowsheetId, orgId(req)]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'Binding not found' });
    auditLog(req, 'plc_binding.delete', 'plc_binding', req.params.bindingId, {
      flowsheetId: req.params.flowsheetId,
      nodeId: r.rows[0].node_id,
      paramKey: r.rows[0].param_key,
    });
    res.json({ message: 'Binding deleted' });
  } catch (err) { next(err); }
});

// ── GET /plc-values — latest sampled values ──────────────────────────────────
router.get('/plc-values', flowsheetParams, async (req, res, next) => {
  if (vErr(req, res)) return;
  try {
    if (!await checkFlowsheet(req, res)) return;
    const r = await query(
      `SELECT id, node_id, param_key, last_value, quality, last_read_at
       FROM plc_bindings
       WHERE flowsheet_id = $1 AND organisation_id = $2
       ORDER BY node_id, param_key`,
      [req.params.flowsheetId, orgId(req)]
    );
    res.json(r.rows.map((row) => ({
      bindingId:  row.id,
      nodeId:     row.node_id,
      paramKey:   row.param_key,
      value:      row.last_value,
      quality:    row.quality,
      lastReadAt: row.last_read_at,
    })));
  } catch (err) { next(err); }
});

// ── POST /plc-bindings/:bindingId/write (operator+) ──────────────────────────
router.post('/plc-bindings/:bindingId/write', requireRole('operator'), [
  ...flowsheetParams,
  param('bindingId').isUUID(),
  body('value').isFloat().withMessage('value must be a number').toFloat(),
], async (req, res, next) => {
  if (vErr(req, res)) return;
  try {
    if (!await checkFlowsheet(req, res)) return; // enforces p.status != 'deleted' too
    const r = await query(
      `SELECT b.*, c.protocol, c.config, c.enabled AS connection_enabled
       FROM plc_bindings b
       JOIN plc_connections c ON c.id = b.connection_id
       WHERE b.id = $1 AND b.flowsheet_id = $2 AND b.organisation_id = $3`,
      [req.params.bindingId, req.params.flowsheetId, orgId(req)]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'Binding not found' });
    const binding = r.rows[0];

    if (!['write', 'read_write'].includes(binding.direction)) {
      return res.status(400).json({ error: 'Binding is read-only — set direction to write or read_write' });
    }
    if (!binding.connection_enabled) {
      return res.status(400).json({ error: 'PLC connection is disabled' });
    }

    const driver = getDriver(binding.protocol);
    if (!driver) return res.status(422).json({ error: `Unknown protocol "${binding.protocol}"` });

    const scale = Number(binding.scale) || 1;
    const offset = Number(binding.offset_val) || 0;
    const raw = (req.body.value - offset) / scale;

    let client;
    try {
      client = driver.createClient(binding.config || {}, {
        connectionId:   binding.connection_id,
        organisationId: binding.organisation_id,
      });
      await client.connect();
      await client.writeTag(binding.address, raw);
    } catch (err) {
      logger.warn('PLC write failed', { bindingId: binding.id, err: err.message });
      return res.status(502).json({ error: `PLC write failed: ${err.message}` });
    } finally {
      if (client) await client.disconnect().catch(() => {});
    }

    // Reflect the write in the latest-value columns so /plc-values shows it
    // immediately (the poller will refresh read_write bindings anyway).
    await query(
      `UPDATE plc_bindings SET last_value = $1, quality = 'good', last_read_at = NOW() WHERE id = $2`,
      [req.body.value, binding.id]
    );

    auditLog(req, 'plc_binding.write', 'plc_binding', binding.id, {
      flowsheetId: req.params.flowsheetId,
      nodeId: binding.node_id,
      paramKey: binding.param_key,
      address: binding.address,
      value: req.body.value,
      rawValue: raw,
    });
    res.json({ ok: true, bindingId: binding.id, value: req.body.value, rawValue: raw });
  } catch (err) { next(err); }
});

module.exports = router;
