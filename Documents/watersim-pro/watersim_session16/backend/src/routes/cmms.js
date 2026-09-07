/**
 * WaterSim Pro — Inbound from the CMMS (Phase 5)
 *
 * Mounted at: /api/v1/cmms · API key with scope workorders:write
 *
 *   POST /cmms/work-orders/link                       { taskId, externalId, system? }
 *   POST /cmms/work-orders/:externalId/status         { status, note?, taskId?, system? }
 *
 * A work order the CMMS holds for one of our tasks reports its status here;
 * the status becomes a task transition by the system actor 'cmms':
 *
 *   in_progress → start          completed → complete
 *   closed      → approve        cancelled → cancel
 *
 * A work order closed in the CMMS closes the task here. `taskId` on the first
 * call links the two; after that the external id alone is enough.
 */
'use strict';

const express = require('express');
const { body, param, validationResult } = require('express-validator');
const { query } = require('../db/pool');
const { authenticateService, requireScope } = require('../middleware/serviceAuth');
const { auditSystem } = require('../utils/audit');
const tasks = require('../maintenance/tasks');

const router = express.Router();
router.use(authenticateService);
router.use(requireScope('workorders:write'));

const orgId = (req) => req.user.org;
const STATUS_ACTION = { open: null, assigned: null, in_progress: 'start', completed: 'complete', closed: 'approve', cancelled: 'cancel' };

function vErr(req, res) {
  const e = validationResult(req);
  if (!e.isEmpty()) { res.status(422).json({ error: 'Validation failed', details: e.array() }); return true; }
  return false;
}

/**
 * Link a task to a work order. A task keeps ONE external reference: linking
 * it to a different one is refused (409) rather than silently re-pointed,
 * because the first work order is still open somewhere.
 */
async function link(orgIdValue, taskId, system, externalId) {
  const cur = await query('SELECT external_system, external_ref FROM maintenance_tasks WHERE id = $1 AND organisation_id = $2', [taskId, orgIdValue]);
  if (!cur.rows[0]) return false;
  const c = cur.rows[0];
  if (c.external_ref && (c.external_ref !== externalId || c.external_system !== system)) {
    const err = new Error(`Task is already linked to ${c.external_system} work order ${c.external_ref}`);
    err.code = '23505';
    throw err;
  }
  const r = await query(
    `UPDATE maintenance_tasks SET external_system = $3, external_ref = $4 WHERE id = $1 AND organisation_id = $2 RETURNING id`,
    [taskId, orgIdValue, system, externalId]
  );
  return !!r.rows[0];
}

router.post('/work-orders/link', [
  body('taskId').isUUID(), body('externalId').isString().trim().isLength({ min: 1, max: 120 }),
  body('system').optional().isString().trim().isLength({ min: 1, max: 40 }),
], async (req, res, next) => {
  if (vErr(req, res)) return;
  try {
    const system = req.body.system || 'cmms';
    const ok = await link(orgId(req), req.body.taskId, system, req.body.externalId);
    if (!ok) return res.status(404).json({ error: 'Task not found' });
    auditSystem({ orgId: orgId(req), source: 'cmms', action: 'task.link', resourceType: 'maintenance_task', resourceId: req.body.taskId, details: { system, externalId: req.body.externalId, apiKey: req.service.name } });
    res.json({ taskId: req.body.taskId, system, externalId: req.body.externalId });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: err.message.startsWith('Task is already') ? err.message : 'That external id is already linked to another task' });
    next(err);
  }
});

router.post('/work-orders/:externalId/status', [
  param('externalId').isString().trim().isLength({ min: 1, max: 120 }),
  body('status').isIn(Object.keys(STATUS_ACTION)).withMessage(`status must be one of ${Object.keys(STATUS_ACTION).join(', ')}`),
  body('note').optional({ nullable: true }).isString().trim().isLength({ max: 2000 }),
  body('taskId').optional().isUUID(),
  body('system').optional().isString().trim().isLength({ min: 1, max: 40 }),
], async (req, res, next) => {
  if (vErr(req, res)) return;
  try {
    const system = req.body.system || 'cmms';
    let row = (await query(`SELECT id, state FROM maintenance_tasks WHERE organisation_id = $1 AND external_system = $2 AND external_ref = $3`, [orgId(req), system, req.params.externalId])).rows[0];
    if (!row && req.body.taskId) {
      try {
        const ok = await link(orgId(req), req.body.taskId, system, req.params.externalId);
        if (ok) row = (await query('SELECT id, state FROM maintenance_tasks WHERE id = $1', [req.body.taskId])).rows[0];
      } catch (err) {
        if (err.code === '23505') return res.status(409).json({ error: err.message });
        throw err;
      }
    }
    if (!row) return res.status(404).json({ error: 'No task is linked to that work order — send taskId once to link it' });

    const action = STATUS_ACTION[req.body.status];
    if (!action) {
      auditSystem({ orgId: orgId(req), source: 'cmms', action: 'task.external_status', resourceType: 'maintenance_task', resourceId: row.id, details: { status: req.body.status, externalId: req.params.externalId } });
      return res.json(tasks.formatTask(await tasks.getTask(row.id, orgId(req))));
    }
    // Idempotent: a status the task already reflects is answered, not refused.
    const already = { start: ['in_progress'], complete: ['completed', 'approved'], approve: ['approved'], cancel: ['cancelled'] }[action];
    if (already.includes(row.state)) return res.json(tasks.formatTask(await tasks.getTask(row.id, orgId(req))));
    // Approval from the CMMS needs a completed task: complete first if it is still in progress.
    if (action === 'approve' && ['open', 'assigned', 'in_progress', 'rejected'].includes(row.state)) {
      if (['open', 'assigned', 'rejected'].includes(row.state)) await tasks.transition(row.id, orgId(req), 'start', { source: 'cmms', note: 'started by the CMMS work order' });
      await tasks.transition(row.id, orgId(req), 'complete', { source: 'cmms', note: req.body.note || `completed in the CMMS (${req.params.externalId})` });
    }
    if (action === 'complete' && ['open', 'assigned', 'rejected'].includes(row.state)) {
      await tasks.transition(row.id, orgId(req), 'start', { source: 'cmms', note: 'started by the CMMS work order' });
    }
    const task = await tasks.transition(row.id, orgId(req), action, { source: 'cmms', note: req.body.note || `${req.body.status} in the CMMS (${req.params.externalId})` });
    res.json(task);
  } catch (err) {
    if (err instanceof tasks.TaskError) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

module.exports = router;
