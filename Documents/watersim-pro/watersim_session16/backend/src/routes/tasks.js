/**
 * WaterSim Pro — Maintenance tasks API
 *
 * Mounted at: /api/v1/tasks
 *
 *   GET    /tasks                  — list, filterable; counts by state
 *   GET    /tasks/assignees        — who can be assigned (engineer and above), with their load
 *   GET    /tasks/:id              — one task with its transitions and comments
 *   POST   /tasks                  — create by hand                          (operator+ · task.create)
 *   PATCH  /tasks/:id              — edit title / description / priority / due (assignee, creator or manager+)
 *   POST   /tasks/:id/transition   — { action, note?, assignedTo? }         (per action — see maintenance/tasks.js)
 *   POST   /tasks/:id/comments     — add a comment                          (operator+)
 *
 * The state machine lives in maintenance/tasks.js; this file only validates,
 * authorises the obvious (a viewer can look, not touch) and formats. Every
 * transition is audited there, not here.
 */
'use strict';

const express = require('express');
const { body, param, query: qv, validationResult } = require('express-validator');
const { query } = require('../db/pool');
const { authenticate, requireCapability } = require('../middleware/auth');
const { can } = require('../auth/roles');
const { auditLog } = require('../utils/audit');
const tasks = require('../maintenance/tasks');

const router = express.Router();
router.use(authenticate);
router.use(requireCapability('maintenance.view'));

const orgId = (req) => req.user.org || req.user.organisationId;
const userId = (req) => req.user.sub || req.user.id;
const actorOf = (req) => ({ id: userId(req), role: req.user.role });

function vErr(req, res) {
  const e = validationResult(req);
  if (!e.isEmpty()) { res.status(422).json({ error: 'Validation failed', details: e.array() }); return true; }
  return false;
}

const sendTaskError = (res, err) => {
  if (err instanceof tasks.TaskError || (err.isOperational && err.status)) return res.status(err.status || 409).json({ error: err.message });
  return null;
};

// ── GET /tasks ───────────────────────────────────────────────────────────────
router.get('/', [
  qv('state').optional().isString().trim(),
  qv('open').optional().isBoolean().toBoolean(),
  qv('assignedTo').optional().isString().trim().isLength({ max: 40 }),
  qv('priority').optional().isIn(tasks.PRIORITIES),
  qv('flowsheetId').optional().isUUID(),
  qv('q').optional().isString().trim().isLength({ max: 80 }),
  qv('limit').optional().isInt({ min: 1, max: 500 }).toInt(),
  qv('offset').optional().isInt({ min: 0 }).toInt(),
], async (req, res, next) => {
  if (vErr(req, res)) return;
  try {
    const where = ['t.organisation_id = $1'];
    const params = [orgId(req)];
    const add = (sql, v) => { params.push(v); where.push(sql.replace('?', `$${params.length}`)); };
    if (req.query.state) {
      const states = String(req.query.state).split(',').map((s) => s.trim()).filter((s) => tasks.STATES.includes(s));
      if (states.length) add('t.state = ANY(?::text[])', states);
    }
    if (req.query.open) add('t.state = ANY(?::text[])', tasks.OPEN_STATES);
    if (req.query.assignedTo) add('t.assigned_to = ?', req.query.assignedTo === 'me' ? userId(req) : req.query.assignedTo);
    if (req.query.priority) add('t.priority = ?', req.query.priority);
    if (req.query.flowsheetId) add('t.flowsheet_id = ?', req.query.flowsheetId);
    if (req.query.q) { params.push(`%${req.query.q}%`); const n = params.length; where.push(`(t.title ILIKE $${n} OR t.description ILIKE $${n} OR tg.tag ILIKE $${n})`); }

    const limit = req.query.limit ?? 100;
    const offset = req.query.offset ?? 0;
    const [{ rows }, { rows: [{ count }] }, { rows: counts }] = await Promise.all([
      query(`${tasks.TASK_SELECT} WHERE ${where.join(' AND ')}
              ORDER BY CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
                       t.due_at NULLS LAST, t.created_at DESC
              LIMIT ${limit} OFFSET ${offset}`, params),
      query(`SELECT COUNT(*)::int AS count FROM maintenance_tasks t LEFT JOIN tags tg ON tg.id = t.tag_id WHERE ${where.join(' AND ')}`, params),
      query(`SELECT state, COUNT(*)::int AS n FROM maintenance_tasks WHERE organisation_id = $1 GROUP BY state`, [orgId(req)]),
    ]);
    res.json({
      total: count,
      counts: Object.fromEntries(tasks.STATES.map((s) => [s, counts.find((c) => c.state === s)?.n || 0])),
      tasks: rows.map(tasks.formatTask),
    });
  } catch (err) { next(err); }
});

// ── GET /tasks/assignees ─────────────────────────────────────────────────────
router.get('/assignees', async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT u.id, u.first_name, u.last_name, u.role, u.email,
              (SELECT COUNT(*)::int FROM maintenance_tasks t
                WHERE t.assigned_to = u.id AND t.state IN ('assigned', 'in_progress', 'rejected')) AS open_tasks
         FROM users u WHERE u.organisation_id = $1 AND u.is_active = TRUE
        ORDER BY u.role, u.first_name`,
      [orgId(req)]
    );
    res.json({
      assignees: rows.filter((u) => can(u.role, 'task.work')).map((u) => ({
        id: u.id, name: `${u.first_name} ${u.last_name}`, role: u.role, email: u.email, openTasks: u.open_tasks,
      })),
    });
  } catch (err) { next(err); }
});

// ── GET /tasks/:id ───────────────────────────────────────────────────────────
router.get('/:id', [param('id').isUUID()], async (req, res, next) => {
  if (vErr(req, res)) return;
  try {
    const row = await tasks.getTask(req.params.id, orgId(req));
    if (!row) return res.status(404).json({ error: 'Task not found' });
    const [tr, cm] = await Promise.all([
      query(`SELECT x.*, u.first_name || ' ' || u.last_name AS actor_name, u.role AS actor_role
               FROM task_transitions x LEFT JOIN users u ON u.id = x.actor_id
              WHERE x.task_id = $1 ORDER BY x.created_at`, [req.params.id]),
      query(`SELECT c.*, u.first_name || ' ' || u.last_name AS author_name, u.role AS author_role
               FROM task_comments c LEFT JOIN users u ON u.id = c.author_id
              WHERE c.task_id = $1 ORDER BY c.created_at`, [req.params.id]),
    ]);
    const t = tasks.formatTask(row);
    const me = actorOf(req);
    const allowed = Object.entries(tasks.ACTIONS)
      .filter(([, spec]) => spec.from.includes(row.state) && can(me.role, spec.cap)
        && !(spec.assigneeOrManager && row.assigned_to && row.assigned_to !== me.id && !can(me.role, 'task.approve')))
      .map(([a]) => a)
      .filter((a) => !(a === 'acknowledge' && (!row.requires_ack || row.acknowledged_at)));
    res.json({
      ...t,
      allowedActions: allowed,
      transitions: tr.rows.map((x) => ({
        id: x.id, action: x.action, fromState: x.from_state, toState: x.to_state,
        actorId: x.actor_id, actorName: x.actor_name || (x.actor_source !== 'user' ? `system · ${x.actor_source}` : null),
        actorRole: x.actor_role || null, actorSource: x.actor_source, note: x.note, details: x.details, createdAt: x.created_at,
      })),
      comments: cm.rows.map((c) => ({ id: c.id, authorId: c.author_id, authorName: c.author_name, authorRole: c.author_role, body: c.body, createdAt: c.created_at })),
    });
  } catch (err) { next(err); }
});

// ── POST /tasks ──────────────────────────────────────────────────────────────
router.post('/', requireCapability('task.create'), [
  body('title').isString().trim().isLength({ min: 3, max: 200 }).withMessage('title is required (3–200 chars)'),
  body('description').optional({ nullable: true }).isString().trim().isLength({ max: 4000 }),
  body('priority').optional().isIn(tasks.PRIORITIES),
  body('flowsheetId').optional({ nullable: true }).isUUID(),
  body('tagId').optional({ nullable: true }).isUUID(),
  body('assignedTo').optional({ nullable: true }).isUUID(),
  body('assignedRole').optional({ nullable: true }).isIn(['operator', 'engineer', 'manager']),
  body('dueAt').optional({ nullable: true }).isISO8601(),
  body('requiresApproval').optional().isBoolean().toBoolean(),
  body('autoAssign').optional().isBoolean().toBoolean(),
], async (req, res, next) => {
  if (vErr(req, res)) return;
  try {
    if (req.body.flowsheetId) {
      const f = await query(`SELECT f.id FROM flowsheets f JOIN projects p ON p.id = f.project_id WHERE f.id = $1 AND p.organisation_id = $2`, [req.body.flowsheetId, orgId(req)]);
      if (!f.rows[0]) return res.status(422).json({ error: 'Validation failed', details: [{ msg: 'flowsheet is not in your organisation', path: 'flowsheetId' }] });
    }
    const { task, created } = await tasks.createTask({
      orgId: orgId(req), flowsheetId: req.body.flowsheetId || null, tagId: req.body.tagId || null,
      title: req.body.title, description: req.body.description || null, priority: req.body.priority,
      assignedTo: req.body.assignedTo || null, assignedRole: req.body.assignedRole || 'engineer',
      dueAt: req.body.dueAt ? new Date(req.body.dueAt) : null,
      requiresApproval: req.body.requiresApproval ?? true,
      autoAssign: req.body.autoAssign ?? !req.body.assignedTo,
    }, { actor: actorOf(req), source: 'user', req });
    res.status(created ? 201 : 200).json(task);
  } catch (err) { if (!sendTaskError(res, err)) next(err); }
});

// ── PATCH /tasks/:id ─────────────────────────────────────────────────────────
router.patch('/:id', [
  param('id').isUUID(),
  body('title').optional().isString().trim().isLength({ min: 3, max: 200 }),
  body('description').optional({ nullable: true }).isString().trim().isLength({ max: 4000 }),
  body('priority').optional().isIn(tasks.PRIORITIES),
  body('dueAt').optional({ nullable: true }).isISO8601(),
], async (req, res, next) => {
  if (vErr(req, res)) return;
  try {
    const row = await tasks.getTask(req.params.id, orgId(req));
    if (!row) return res.status(404).json({ error: 'Task not found' });
    const me = actorOf(req);
    const mine = row.assigned_to === me.id || row.created_by === me.id;
    if (!(mine && can(me.role, 'task.create')) && !can(me.role, 'task.approve')) {
      return res.status(403).json({ error: 'Only the assignee, the creator or a manager can edit a task' });
    }
    if (row.closed_at) return res.status(409).json({ error: 'A closed task cannot be edited — reopen it first' });

    const fields = []; const vals = []; let i = 1;
    if (req.body.title !== undefined)       { fields.push(`title = $${i++}`);       vals.push(req.body.title); }
    if (req.body.description !== undefined) { fields.push(`description = $${i++}`); vals.push(req.body.description); }
    if (req.body.priority !== undefined)    { fields.push(`priority = $${i++}`);    vals.push(req.body.priority); }
    if (req.body.dueAt !== undefined)       { fields.push(`due_at = $${i++}`);      vals.push(req.body.dueAt ? new Date(req.body.dueAt) : null); }
    if (!fields.length) return res.status(422).json({ error: 'No fields to update' });
    vals.push(req.params.id);
    await query(`UPDATE maintenance_tasks SET ${fields.join(', ')} WHERE id = $${i}`, vals);
    auditLog(req, 'task.update', 'maintenance_task', req.params.id, { fields: Object.keys(req.body) });
    res.json(tasks.formatTask(await tasks.getTask(req.params.id, orgId(req))));
  } catch (err) { next(err); }
});

// ── POST /tasks/:id/transition ───────────────────────────────────────────────
router.post('/:id/transition', [
  param('id').isUUID(),
  body('action').isIn(Object.keys(tasks.ACTIONS)).withMessage(`action must be one of ${Object.keys(tasks.ACTIONS).join(', ')}`),
  body('note').optional({ nullable: true }).isString().trim().isLength({ max: 4000 }),
  body('assignedTo').optional({ nullable: true }).isUUID(),
], async (req, res, next) => {
  if (vErr(req, res)) return;
  try {
    const task = await tasks.transition(req.params.id, orgId(req), req.body.action, {
      actor: actorOf(req), note: req.body.note || null, assignedTo: req.body.assignedTo || null, req,
    });
    res.json(task);
  } catch (err) { if (!sendTaskError(res, err)) next(err); }
});

// ── POST /tasks/:id/comments ─────────────────────────────────────────────────
router.post('/:id/comments', requireCapability('task.create'), [
  param('id').isUUID(),
  body('body').isString().trim().isLength({ min: 1, max: 4000 }).withMessage('body is required'),
], async (req, res, next) => {
  if (vErr(req, res)) return;
  try {
    const row = await tasks.getTask(req.params.id, orgId(req));
    if (!row) return res.status(404).json({ error: 'Task not found' });
    const { rows } = await query(
      `INSERT INTO task_comments (task_id, author_id, body) VALUES ($1, $2, $3) RETURNING *`,
      [req.params.id, userId(req), req.body.body]
    );
    auditLog(req, 'task.comment', 'maintenance_task', req.params.id, { commentId: rows[0].id });
    res.status(201).json({ id: rows[0].id, authorId: rows[0].author_id, body: rows[0].body, createdAt: rows[0].created_at });
  } catch (err) { next(err); }
});

module.exports = router;
