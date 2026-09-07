/**
 * WaterSim Pro — Maintenance tasks: the state machine
 *
 *   open ─assign→ assigned ─start→ in_progress ─complete→ completed ─approve→ approved
 *                                       ▲                       │
 *                                       └──────── reject ───────┘   (→ rejected, then start again)
 *   any open state ─cancel→ cancelled · approved/cancelled ─reopen→ open
 *
 * transition() is the ONLY write path for `state`. It runs in one
 * transaction: lock the row, check the action is legal from the current
 * state and for the actor's role, apply it, write the task_transitions row,
 * write the audit row, then (after commit) notify. A task whose rule said
 * `task_requires_approval = false` closes itself on completion — the
 * transition row still says who completed it.
 *
 * A critical alarm's task also carries `requires_ack`: a manager must
 * ACKNOWLEDGE that the alarm was seen. That is recorded on the task and in
 * the transitions, does not move the state, and is separate from approving
 * the finished work (open question 8 — both acts are kept).
 *
 * Role rules (auth/roles.js capabilities):
 *   assign / create      task.create   (operator+)
 *   start / complete     task.work     (engineer+) — the assignee, or a manager+
 *   approve / reject /
 *   cancel / reopen      task.approve  (manager+)
 *   acknowledge          alarm.ack_critical (manager+)
 */
'use strict';

const { query, withTransaction, isSqlite } = require('../db/pool');
const { can, rank } = require('../auth/roles');
const { auditLog, auditSystem } = require('../utils/audit');
const { broadcastToRoom, broadcastToOrg } = require('../collab/wsServer');
const logger = require('../utils/logger');

const STATES = ['open', 'assigned', 'in_progress', 'completed', 'approved', 'rejected', 'cancelled'];
const OPEN_STATES = ['open', 'assigned', 'in_progress', 'completed', 'rejected'];
const PRIORITIES = ['low', 'medium', 'high', 'urgent'];

/** Which rule severities become which task priority and default due window. */
const SEVERITY_DEFAULTS = {
  critical: { priority: 'urgent', dueH: 4 },
  warning:  { priority: 'high',   dueH: 24 },
  info:     { priority: 'medium', dueH: 72 },
};

const ACTIONS = {
  assign:      { from: ['open', 'assigned', 'rejected'],           to: 'assigned',    cap: 'task.create' },
  start:       { from: ['open', 'assigned', 'rejected'],           to: 'in_progress', cap: 'task.work', assigneeOrManager: true },
  complete:    { from: ['in_progress'],                            to: 'completed',   cap: 'task.work', assigneeOrManager: true },
  approve:     { from: ['completed'],                              to: 'approved',    cap: 'task.approve' },
  reject:      { from: ['completed'],                              to: 'rejected',    cap: 'task.approve', noteRequired: true },
  cancel:      { from: ['open', 'assigned', 'in_progress', 'rejected', 'completed'], to: 'cancelled', cap: 'task.approve' },
  reopen:      { from: ['approved', 'cancelled'],                  to: 'open',        cap: 'task.approve' },
  acknowledge: { from: OPEN_STATES,                                to: null,          cap: 'alarm.ack_critical' },
};

class TaskError extends Error {
  constructor(message, status = 409) { super(message); this.status = status; this.isOperational = true; }
}

// ── Formatting ───────────────────────────────────────────────────────────────

const TASK_SELECT = `
  SELECT t.*,
         f.name  AS flowsheet_name,
         p.id    AS project_id,
         p.name  AS project_name,
         tg.tag  AS tag,
         tg.name AS tag_name,
         a.first_name || ' ' || a.last_name AS assigned_to_name,
         a.role  AS assigned_to_role,
         c.first_name || ' ' || c.last_name AS created_by_name,
         ap.first_name || ' ' || ap.last_name AS approved_by_name,
         ak.first_name || ' ' || ak.last_name AS acknowledged_by_name,
         e.state AS event_state, e.severity AS event_severity, e.message AS event_message,
         e.cleared_at AS event_cleared_at
    FROM maintenance_tasks t
    LEFT JOIN flowsheets   f  ON f.id = t.flowsheet_id
    LEFT JOIN projects     p  ON p.id = f.project_id
    LEFT JOIN tags         tg ON tg.id = t.tag_id
    LEFT JOIN users        a  ON a.id = t.assigned_to
    LEFT JOIN users        c  ON c.id = t.created_by
    LEFT JOIN users        ap ON ap.id = t.approved_by
    LEFT JOIN users        ak ON ak.id = t.acknowledged_by
    LEFT JOIN alarm_events e  ON e.id = t.source_event_id`;

const pad = (n) => `WO-${String(n).padStart(5, '0')}`;

function formatTask(r) {
  if (!r) return null;
  return {
    id: r.id,
    number: pad(r.number),
    title: r.title,
    description: r.description,
    priority: r.priority,
    severity: r.severity,
    state: r.state,
    requiresApproval: r.requires_approval,
    requiresAck: r.requires_ack,
    acknowledgedBy: r.acknowledged_by,
    acknowledgedByName: r.acknowledged_by_name || null,
    acknowledgedAt: r.acknowledged_at,
    assignedRole: r.assigned_role,
    assignedTo: r.assigned_to,
    assignedToName: r.assigned_to_name || null,
    assignedToRole: r.assigned_to_role || null,
    assignedAt: r.assigned_at,
    dueAt: r.due_at,
    overdue: !!(r.due_at && !r.closed_at && new Date(r.due_at) < new Date()),
    startedAt: r.started_at,
    completedAt: r.completed_at,
    completionNote: r.completion_note,
    approvedBy: r.approved_by,
    approvedByName: r.approved_by_name || null,
    approvedAt: r.approved_at,
    rejectedReason: r.rejected_reason,
    closedAt: r.closed_at,
    flowsheetId: r.flowsheet_id,
    flowsheetName: r.flowsheet_name || null,
    projectId: r.project_id || null,
    projectName: r.project_name || null,
    tagId: r.tag_id,
    tag: r.tag || null,
    tagName: r.tag_name || null,
    sourceEventId: r.source_event_id,
    sourceRuleId: r.source_rule_id,
    event: r.source_event_id ? {
      state: r.event_state, severity: r.event_severity, message: r.event_message, clearedAt: r.event_cleared_at,
    } : null,
    createdBy: r.created_by,
    createdByName: r.created_by_name || (r.created_source !== 'user' ? `system · ${r.created_source}` : null),
    createdSource: r.created_source,
    externalSystem: r.external_system || null,
    externalRef: r.external_ref || null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

async function getTask(taskId, orgId, run = query) {
  const { rows } = await run(`${TASK_SELECT} WHERE t.id = $1 AND t.organisation_id = $2`, [taskId, orgId]);
  return rows[0] || null;
}

// ── Assignment ───────────────────────────────────────────────────────────────

/**
 * The least-loaded active user holding `role` (or a higher one) in the org,
 * counting their open tasks. Returns a user row or null.
 */
async function pickAssignee(orgId, role, run = query) {
  const minRank = rank(role || 'engineer');
  const { rows } = await run(
    `SELECT u.id, u.first_name, u.last_name, u.role, u.email,
            (SELECT COUNT(*)::int FROM maintenance_tasks t
              WHERE t.assigned_to = u.id AND t.state IN ('assigned', 'in_progress', 'rejected')) AS load
       FROM users u
      WHERE u.organisation_id = $1 AND u.is_active = TRUE
      ORDER BY load ASC, u.created_at ASC`,
    [orgId]
  );
  // Prefer the exact role; fall back to anyone senior enough.
  const eligible = rows.filter((u) => rank(u.role) >= minRank);
  const exact = eligible.filter((u) => u.role === (role || 'engineer'));
  return (exact[0] || eligible[0]) || null;
}

// ── Creation ─────────────────────────────────────────────────────────────────

/**
 * Create a task. `actor` is { id, role } for a person, or null with
 * `source` = 'evaluator' | 'sweep' | 'cmms'. Auto-assigns to the least-loaded
 * holder of `assignedRole` unless `assignedTo` is given; stays 'open' when
 * nobody holds the role.
 */
async function createTask(input, { actor = null, source = 'user', req = null } = {}) {
  const {
    orgId, flowsheetId = null, tagId = null, sourceEventId = null, sourceRuleId = null,
    title, description = null, severity = null,
    requiresApproval = true, requiresAck = false, dueAt = null,
  } = input;
  const sev = SEVERITY_DEFAULTS[severity] || SEVERITY_DEFAULTS.info;
  const priority = PRIORITIES.includes(input.priority) ? input.priority : sev.priority;
  const assignedRole = input.assignedRole || 'engineer';

  const created = await withTransaction(async (client) => {
    const run = (sql, params) => client.query(sql, params);
    let assignee = null;
    if (input.assignedTo) {
      const u = await run('SELECT id, role FROM users WHERE id = $1 AND organisation_id = $2 AND is_active = TRUE', [input.assignedTo, orgId]);
      if (!u.rows[0]) throw new TaskError('Assignee is not an active member of this organisation', 422);
      assignee = u.rows[0];
    } else if (input.autoAssign !== false) {
      assignee = await pickAssignee(orgId, assignedRole, run);
    }
    const state = assignee ? 'assigned' : 'open';
    const ins = await run(
      `INSERT INTO maintenance_tasks
         (organisation_id, flowsheet_id, tag_id, source_event_id, source_rule_id, title, description,
          priority, severity, state, requires_approval, requires_ack, assigned_role, assigned_to, assigned_at,
          due_at, created_by, created_source${isSqlite ? ', number' : ''})
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,
               CASE WHEN $14::uuid IS NULL THEN NULL ELSE NOW() END,
               $15,$16,$17${isSqlite ? ', (SELECT COALESCE(MAX(number), 0) + 1 FROM maintenance_tasks)' : ''})
       ON CONFLICT (source_event_id) WHERE source_event_id IS NOT NULL DO NOTHING
       RETURNING *`,
      [orgId, flowsheetId, tagId, sourceEventId, sourceRuleId, String(title).slice(0, 200), description,
       priority, severity, state, requiresApproval, requiresAck, assignedRole, assignee ? assignee.id : null,
       dueAt, actor ? actor.id : null, source]
    );
    if (!ins.rows[0]) return null; // a task for this event already exists
    const task = ins.rows[0];
    await run(
      `INSERT INTO task_transitions (task_id, action, from_state, to_state, actor_id, actor_source, note, details)
       VALUES ($1, 'create', NULL, $2, $3, $4, $5, $6)`,
      [task.id, state, actor ? actor.id : null, actor ? 'user' : source,
       assignee ? `Assigned to ${assignedRole}` : `No active ${assignedRole} to assign — left open`,
       JSON.stringify({ assignedTo: assignee ? assignee.id : null, sourceEventId, sourceRuleId })]
    );
    return task;
  });

  if (!created) {
    const { rows } = await query('SELECT id FROM maintenance_tasks WHERE source_event_id = $1', [sourceEventId]);
    const existing = rows[0] ? await getTask(rows[0].id, orgId) : null;
    return { task: formatTask(existing), created: false };
  }

  const full = await getTask(created.id, orgId);
  if (req) auditLog(req, 'task.create', 'maintenance_task', created.id, { title, priority, state: created.state, sourceEventId });
  else auditSystem({ orgId, source, action: 'task.create', resourceType: 'maintenance_task', resourceId: created.id, details: { title, priority, state: created.state, sourceEventId } });

  publish(full, 'created');
  notify('task.created', full);
  if (full.assigned_to) notify('task.assigned', full);
  return { task: formatTask(full), created: true };
}

/**
 * Raise a task for an alarm event under its rule's policy. Called by the
 * evaluator on 'raised' (only when rule.create_task) and by the manual
 * "Create task" route (always). Returns { task, created }.
 */
async function createTaskFromEvent(event, rule, { actor = null, source = 'evaluator', req = null, overrides = {} } = {}) {
  const sev = SEVERITY_DEFAULTS[event.severity] || SEVERITY_DEFAULTS.info;
  const dueH = rule?.task_due_within_h || sev.dueH;
  const limit = event.limit_min != null && event.limit_max != null ? `${event.limit_min}–${event.limit_max}`
    : event.limit_max != null ? `max ${event.limit_max}` : event.limit_min != null ? `min ${event.limit_min}` : null;
  const description = [
    event.message,
    event.value != null ? `Value ${event.value}${limit ? ` (limit ${limit})` : ''}.` : null,
    `Raised ${new Date(event.triggered_at || Date.now()).toISOString()} from ${event.source === 'plc' ? 'live PLC data' : 'a simulation run'}.`,
    rule?.name ? `Rule: ${rule.name}.` : null,
  ].filter(Boolean).join(' ');

  return createTask({
    orgId: event.organisation_id,
    flowsheetId: event.flowsheet_id,
    tagId: rule?.tag_id || null,
    sourceEventId: event.id,
    sourceRuleId: rule?.id || event.rule_id || null,
    title: overrides.title || (rule?.name ? `Alarm: ${rule.name}` : `Alarm: ${event.message}`).slice(0, 200),
    description,
    priority: overrides.priority || rule?.task_priority || sev.priority,
    severity: event.severity,
    requiresApproval: rule?.task_requires_approval ?? true,
    requiresAck: event.severity === 'critical',
    assignedRole: overrides.assignedRole || rule?.task_assignee_role || 'engineer',
    assignedTo: overrides.assignedTo || null,
    dueAt: new Date(Date.now() + dueH * 3600_000),
  }, { actor, source, req });
}

// ── Transitions ──────────────────────────────────────────────────────────────

/**
 * Apply `action` to a task. `actor` = { id, role } (a person) or null with
 * `source` for a system actor (the sweep clearing, the CMMS closing).
 */
async function transition(taskId, orgId, action, { actor = null, source = 'system', note = null, assignedTo = null, req = null } = {}) {
  const spec = ACTIONS[action];
  if (!spec) throw new TaskError(`Unknown action "${action}" — one of ${Object.keys(ACTIONS).join(', ')}`, 422);
  if (spec.noteRequired && !(note && String(note).trim())) throw new TaskError(`"${action}" needs a note saying why`, 422);

  const result = await withTransaction(async (client) => {
    const run = (sql, params) => client.query(sql, params);
    const cur = await run('SELECT * FROM maintenance_tasks WHERE id = $1 AND organisation_id = $2 FOR UPDATE', [taskId, orgId]);
    const t = cur.rows[0];
    if (!t) throw new TaskError('Task not found', 404);
    if (!spec.from.includes(t.state)) throw new TaskError(`Cannot ${action} a task that is ${t.state.replace('_', ' ')}`, 409);

    // Who may do it.
    if (actor) {
      if (!can(actor.role, spec.cap)) throw new TaskError(`"${action}" needs ${spec.cap}`, 403);
      if (spec.assigneeOrManager && t.assigned_to && t.assigned_to !== actor.id && !can(actor.role, 'task.approve')) {
        throw new TaskError('Only the assignee or a manager can work this task', 403);
      }
    }

    const fields = [];
    const vals = [];
    let i = 1;
    const set = (col, v) => { fields.push(`${col} = $${i++}`); vals.push(v); };
    const details = {};
    let toState = spec.to;

    switch (action) {
      case 'assign': {
        if (!assignedTo) throw new TaskError('assign needs assignedTo', 422);
        const u = await run('SELECT id, role, first_name, last_name FROM users WHERE id = $1 AND organisation_id = $2 AND is_active = TRUE', [assignedTo, orgId]);
        if (!u.rows[0]) throw new TaskError('Assignee is not an active member of this organisation', 422);
        if (!can(u.rows[0].role, 'task.work')) throw new TaskError('Tasks are assigned to engineers or above', 422);
        set('assigned_to', assignedTo); set('assigned_at', new Date()); set('assigned_role', u.rows[0].role);
        details.assignedTo = assignedTo; details.assignedToName = `${u.rows[0].first_name} ${u.rows[0].last_name}`;
        break;
      }
      case 'start':
        set('started_at', t.started_at || new Date());
        if (!t.assigned_to && actor) { set('assigned_to', actor.id); set('assigned_at', new Date()); details.selfAssigned = true; }
        break;
      case 'complete':
        set('completed_at', new Date()); set('completion_note', note);
        if (!t.requires_approval) {
          toState = 'approved';
          set('approved_by', null); set('approved_at', new Date()); set('closed_at', new Date());
          details.autoApproved = true;
        }
        break;
      case 'approve':
        set('approved_by', actor ? actor.id : null); set('approved_at', new Date()); set('closed_at', new Date());
        break;
      case 'reject':
        set('rejected_reason', note); set('completed_at', null);
        break;
      case 'cancel':
        set('closed_at', new Date());
        break;
      case 'reopen':
        set('closed_at', null); set('approved_by', null); set('approved_at', null); set('completed_at', null);
        break;
      case 'acknowledge':
        if (t.acknowledged_at) throw new TaskError('Already acknowledged', 409);
        set('acknowledged_by', actor ? actor.id : null); set('acknowledged_at', new Date());
        toState = t.state;
        break;
      default: break;
    }
    if (toState !== t.state) set('state', toState);

    vals.push(taskId);
    const upd = await run(`UPDATE maintenance_tasks SET ${fields.join(', ')} WHERE id = $${i} RETURNING *`, vals);
    await run(
      `INSERT INTO task_transitions (task_id, action, from_state, to_state, actor_id, actor_source, note, details)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [taskId, action, t.state, toState, actor ? actor.id : null, actor ? 'user' : source, note, JSON.stringify(details)]
    );
    return { before: t, after: upd.rows[0], details };
  });

  const full = await getTask(taskId, orgId);
  const auditDetails = { action, from: result.before.state, to: result.after.state, note, ...result.details };
  if (req) auditLog(req, `task.${action}`, 'maintenance_task', taskId, auditDetails);
  else auditSystem({ orgId, source, action: `task.${action}`, resourceType: 'maintenance_task', resourceId: taskId, details: auditDetails });

  publish(full, action);
  const EVENT_OF = { assign: 'task.assigned', complete: 'task.completed', approve: 'task.approved', reject: 'task.rejected', acknowledge: 'task.acknowledged', cancel: 'task.cancelled' };
  if (EVENT_OF[action]) notify(EVENT_OF[action], full, { note });
  if (action === 'complete' && result.after.state === 'approved') notify('task.approved', full, { note: 'closed without approval (rule policy)' });
  return formatTask(full);
}

// ── Side channels ────────────────────────────────────────────────────────────

/** The flowsheet's WS room and the organisation's live room hear every task change. */
function publish(taskRow, action) {
  if (!taskRow) return;
  try {
    const message = { type: 'task:event', payload: { task: formatTask(taskRow), action } };
    if (taskRow.flowsheet_id) broadcastToRoom(taskRow.flowsheet_id, message);
    broadcastToOrg(taskRow.organisation_id, message);
  } catch (err) {
    logger.debug('Task broadcast failed', { err: err.message });
  }
}

// Lazily required: notifications → templates → nothing here, but keeping the
// require inside the function keeps the module graph acyclic if that changes.
function notify(eventType, taskRow, extra = {}) {
  try {
    const { emit } = require('../notifications');
    const t = formatTask(taskRow);
    emit(eventType, {
      orgId: taskRow.organisation_id,
      severity: taskRow.severity || 'warning',
      flowsheetId: taskRow.flowsheet_id,
      subject: `${t.number} · ${t.title}`,
      payload: { task: t, ...extra },
      dedupeKey: `${eventType}|${taskRow.id}|${taskRow.state}|${taskRow.updated_at ? new Date(taskRow.updated_at).getTime() : ''}`,
      // The assignee always hears about their own task, whatever the policy says.
      alsoUsers: eventType === 'task.assigned' && taskRow.assigned_to ? [taskRow.assigned_to] : [],
    }).catch((err) => logger.warn('Task notification failed', { err: err.message }));
  } catch (err) {
    logger.warn('Task notification skipped', { err: err.message });
  }
}

module.exports = {
  STATES, OPEN_STATES, PRIORITIES, ACTIONS, SEVERITY_DEFAULTS,
  TASK_SELECT, formatTask, getTask, pickAssignee,
  createTask, createTaskFromEvent, transition, TaskError,
};
