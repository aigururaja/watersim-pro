/**
 * WaterSim Pro — role dashboards
 *
 * Mounted at: /api/v1/dashboard
 *
 *   GET /dashboard — the home screen for the person who logged in. One call,
 *   assembled for their ROLE:
 *
 *     viewer     the plant at a glance: comms, drives, alarms, key readings
 *     operator   the console: active alarms, tripped and stopped drives, the
 *                tasks on their desk, live readings
 *     engineer   the desk: their tasks, the twin and its drift, PLC health,
 *                run hours and trips, projects and recent runs
 *     manager    the overview: tasks awaiting approval and overdue, alarm
 *                load and time-to-acknowledge, noisy rules, notifications,
 *                the team
 *     admin      administration: approvals, users and logins, API keys and
 *                webhooks, notification delivery, PLC connections, the twin,
 *                the audit trail, system health
 *
 *   The response names its `sections` in display order, so the client draws
 *   what the server decided this role gets — a role never sees a section it
 *   has no capability for, and the shell needs no second copy of that rule.
 *
 * The plant summary is the live snapshot (routes/live.js) reduced to numbers;
 * measured beats modelled throughout.
 */
'use strict';

const express = require('express');
const { query } = require('../db/pool');
const { authenticate, requireCapability } = require('../middleware/auth');
const { buildSnapshot } = require('./live');

const router = express.Router();
router.use(authenticate);
router.use(requireCapability('ops.view'));

const orgId = (req) => req.user.org || req.user.organisationId;
const userId = (req) => req.user.sub || req.user.id;
const num = (v) => (v == null ? null : Number(v));

const OPEN_STATES = ['open', 'assigned', 'in_progress', 'rejected'];
const PRIORITY_ORDER = `CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END`;

/** Which sections a role's dashboard carries, in display order. */
const SECTIONS = Object.freeze({
  viewer:   ['plant', 'alarms', 'readings'],
  operator: ['plant', 'alarms', 'equipment', 'myTasks', 'readings'],
  engineer: ['plant', 'alarms', 'myTasks', 'twin', 'plc', 'counters', 'projects', 'runs'],
  manager:  ['plant', 'approvals', 'alarms', 'myTasks', 'counters', 'notifications', 'team'],
  admin:    ['plant', 'approvals', 'team', 'integrations', 'notifications', 'plc', 'twin', 'audit', 'system'],
});

// ── Sections ─────────────────────────────────────────────────────────────────

function plantFrom(snap) {
  const drives = snap.equipment.filter((e) => e.opType !== 'valve');
  const valves = snap.equipment.filter((e) => e.opType === 'valve');
  return {
    at: snap.at,
    flowsheet: snap.flowsheets[0] || null,
    areas: snap.areas.length,
    bindings: snap.comms.bindings,
    connections: snap.comms.connections.map((c) => ({
      id: c.id, name: c.name, protocol: c.protocol, status: c.status, enabled: c.enabled, lastSeen: c.lastSeen, bindings: c.bindings, good: c.good,
    })),
    drives: {
      total: drives.length,
      running: drives.filter((e) => e.running === true).length,
      stopped: drives.filter((e) => e.running === false).length,
      tripped: drives.filter((e) => e.tripped === true).length,
    },
    valves: {
      total: valves.length,
      open: valves.filter((e) => e.opened === true).length,
      closed: valves.filter((e) => e.closed === true || (e.opened === false && e.closed == null)).length,
    },
    alarms: snap.alarms.counts,
    tasks: snap.tasks,
  };
}

async function alarmsFor(snap, org) {
  const [day, mtta, noisy] = await Promise.all([
    query(
      `SELECT COUNT(*) FILTER (WHERE severity = 'critical')::int AS critical,
              COUNT(*) FILTER (WHERE severity = 'warning')::int  AS warning,
              COUNT(*) FILTER (WHERE severity = 'info')::int     AS info,
              COUNT(*) FILTER (WHERE state = 'cleared')::int     AS cleared
         FROM alarm_events WHERE organisation_id = $1 AND triggered_at > NOW() - INTERVAL '24 hours'`,
      [org]
    ),
    query(
      `SELECT AVG(EXTRACT(EPOCH FROM (acknowledged_at - triggered_at))) / 60 AS mtta_min, COUNT(*)::int AS n
         FROM alarm_events
        WHERE organisation_id = $1 AND acknowledged_at IS NOT NULL AND triggered_at > NOW() - INTERVAL '7 days'`,
      [org]
    ),
    query(
      `SELECT r.id, r.name, r.severity, COUNT(*)::int AS n
         FROM alarm_events e JOIN alarm_rules r ON r.id = e.rule_id
        WHERE e.organisation_id = $1 AND e.triggered_at > NOW() - INTERVAL '7 days'
        GROUP BY r.id, r.name, r.severity ORDER BY n DESC, r.name LIMIT 5`,
      [org]
    ),
  ]);
  return {
    counts: snap.alarms.counts,
    active: snap.alarms.active.slice(0, 8),
    last24h: day.rows[0],
    mttaMinutes: mtta.rows[0].mtta_min == null ? null : Math.round(Number(mtta.rows[0].mtta_min) * 10) / 10,
    acknowledged7d: mtta.rows[0].n,
    noisy: noisy.rows.map((r) => ({ ruleId: r.id, name: r.name, severity: r.severity, n: r.n })),
  };
}

function equipmentFrom(snap) {
  const drives = snap.equipment.filter((e) => e.opType !== 'valve');
  const pick = (e) => ({ key: e.key, name: e.name, area: e.area, opType: e.opType, running: e.running, tripped: e.tripped, quality: e.quality, at: e.at, canStart: !!e.command });
  return {
    tripped: drives.filter((e) => e.tripped === true).map(pick),
    stopped: drives.filter((e) => e.running === false && e.tripped !== true).slice(0, 8).map(pick),
    running: drives.filter((e) => e.running === true).length,
    total: drives.length,
  };
}

const FN_RANK = { FT: 0, LT: 1, AT: 2, PT: 3, TT: 4 };
function readingsFrom(snap) {
  const items = snap.tags
    .filter((t) => t.signalType === 'AI')
    .sort((a, b) => (FN_RANK[a.fn] ?? 9) - (FN_RANK[b.fn] ?? 9) || a.area.localeCompare(b.area) || a.tag.localeCompare(b.tag))
    .slice(0, 8)
    .map((t) => ({ id: t.id, tag: t.tag, name: t.name, area: t.area, fn: t.fn, value: t.value, unit: t.engUnit || t.signal || '', quality: t.quality, at: t.at, rangeMin: t.rangeMin, rangeMax: t.rangeMax }));
  return { items, total: snap.tags.filter((t) => t.signalType === 'AI').length };
}

async function myTasksFor(org, req) {
  const me = userId(req);
  const role = req.user.role;
  const { rows } = await query(
    `SELECT t.id, t.number, t.title, t.priority, t.severity, t.state, t.due_at, t.assigned_to, t.assigned_role, t.created_at,
            f.name AS flowsheet_name, tg.tag
       FROM maintenance_tasks t
       LEFT JOIN flowsheets f ON f.id = t.flowsheet_id
       LEFT JOIN tags tg ON tg.id = t.tag_id
      WHERE t.organisation_id = $1 AND t.state = ANY($2::text[])
        AND (t.assigned_to = $3 OR (t.assigned_to IS NULL AND t.assigned_role = $4))
      ORDER BY ${PRIORITY_ORDER}, t.due_at NULLS LAST, t.created_at DESC`,
    [org, OPEN_STATES, me, role]
  );
  const now = Date.now();
  const items = rows.map((t) => ({
    id: t.id, number: Number(t.number), title: t.title, priority: t.priority, severity: t.severity, state: t.state,
    dueAt: t.due_at, overdue: !!(t.due_at && new Date(t.due_at).getTime() < now), mine: t.assigned_to === me,
    flowsheetName: t.flowsheet_name, tag: t.tag, createdAt: t.created_at,
  }));
  return { items: items.slice(0, 8), total: items.length, overdue: items.filter((t) => t.overdue).length, unassigned: items.filter((t) => !t.mine).length };
}

async function approvalsFor(org) {
  const [awaiting, overdue, counts] = await Promise.all([
    query(
      `SELECT t.id, t.number, t.title, t.priority, t.severity, t.completed_at, t.completion_note,
              a.first_name || ' ' || a.last_name AS assigned_to_name, f.name AS flowsheet_name
         FROM maintenance_tasks t
         LEFT JOIN users a ON a.id = t.assigned_to
         LEFT JOIN flowsheets f ON f.id = t.flowsheet_id
        WHERE t.organisation_id = $1 AND t.state = 'completed'
        ORDER BY t.completed_at ASC NULLS LAST LIMIT 8`,
      [org]
    ),
    query(
      `SELECT t.id, t.number, t.title, t.priority, t.state, t.due_at, t.assigned_role,
              a.first_name || ' ' || a.last_name AS assigned_to_name
         FROM maintenance_tasks t
         LEFT JOIN users a ON a.id = t.assigned_to
        WHERE t.organisation_id = $1 AND t.closed_at IS NULL AND t.due_at < NOW() AND t.state <> 'completed'
        ORDER BY t.due_at ASC LIMIT 8`,
      [org]
    ),
    query(
      `SELECT COUNT(*) FILTER (WHERE state = 'completed')::int AS awaiting,
              COUNT(*) FILTER (WHERE closed_at IS NULL AND due_at < NOW() AND state <> 'completed')::int AS overdue,
              COUNT(*) FILTER (WHERE state = ANY($2::text[]))::int AS open,
              COUNT(*) FILTER (WHERE state = 'approved' AND approved_at > NOW() - INTERVAL '7 days')::int AS approved7d,
              COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '7 days')::int AS created7d,
              COUNT(*) FILTER (WHERE state = 'rejected')::int AS rejected
         FROM maintenance_tasks WHERE organisation_id = $1`,
      [org, OPEN_STATES]
    ),
  ]);
  return {
    awaiting: awaiting.rows.map((t) => ({ id: t.id, number: Number(t.number), title: t.title, priority: t.priority, severity: t.severity, completedAt: t.completed_at, note: t.completion_note, assignedToName: t.assigned_to_name, flowsheetName: t.flowsheet_name })),
    overdue: overdue.rows.map((t) => ({ id: t.id, number: Number(t.number), title: t.title, priority: t.priority, state: t.state, dueAt: t.due_at, assignedToName: t.assigned_to_name, assignedRole: t.assigned_role })),
    counts: counts.rows[0],
  };
}

async function twinFor(org) {
  const { rows } = await query(
    `SELECT f.id, f.name, p.id AS project_id, p.name AS project_name, f.source_flowsheet_id,
            c.enabled, c.cadence_s, c.drift_z, s.solved_at, s.error, s.residuals, s.duration_ms,
            (SELECT COUNT(*)::int FROM alarm_events e WHERE e.flowsheet_id = COALESCE(f.source_flowsheet_id, f.id) AND e.state = 'active' AND e.source = 'simulation') AS drift_alarms
       FROM flowsheets f JOIN projects p ON p.id = f.project_id
       LEFT JOIN twin_config c ON c.flowsheet_id = f.id
       LEFT JOIN twin_state  s ON s.flowsheet_id = f.id
      WHERE p.organisation_id = $1 AND p.kind = 'twin' AND p.status = 'active' AND f.is_snapshot = false
      ORDER BY c.enabled DESC NULLS LAST, p.name, f.name LIMIT 6`,
    [org]
  );
  return {
    items: rows.map((r) => {
      const residuals = Array.isArray(r.residuals) ? r.residuals : [];
      const worst = residuals.reduce((w, x) => (x && Number.isFinite(Number(x.z)) && Math.abs(Number(x.z)) > Math.abs(w?.z ?? 0) ? { tag: x.tag, z: Number(x.z) } : w), null);
      return {
        flowsheetId: r.id, flowsheetName: r.name, projectId: r.project_id, projectName: r.project_name, imported: !!r.source_flowsheet_id,
        enabled: !!r.enabled, cadenceS: r.cadence_s, driftZ: num(r.drift_z), solvedAt: r.solved_at, error: r.error, durationMs: r.duration_ms,
        residuals: residuals.length, worst, driftAlarms: r.drift_alarms,
      };
    }),
  };
}

async function plcFor(snap, org) {
  const stale = await query(
    `SELECT t.tag, t.name, t.area, b.quality, b.last_read_at, c.name AS connection_name
       FROM plc_bindings b JOIN tags t ON t.id = b.tag_id JOIN plc_connections c ON c.id = b.connection_id
      WHERE t.organisation_id = $1 AND b.enabled = TRUE AND b.quality IN ('stale', 'bad')
      ORDER BY b.last_read_at NULLS FIRST LIMIT 8`,
    [org]
  );
  return {
    connections: snap.comms.connections,
    bindings: snap.comms.bindings,
    unhealthy: stale.rows.map((r) => ({ tag: r.tag, name: r.name, area: r.area, quality: r.quality, lastReadAt: r.last_read_at, connection: r.connection_name })),
  };
}

async function countersFor(org) {
  const { rows } = await query(
    `SELECT t.loop_tag, t.unit, t.name, t.area,
            SUM(c.run_hours)::float AS run_hours, SUM(c.starts)::int AS starts, SUM(c.trips)::int AS trips
       FROM equipment_counters c JOIN tags t ON t.id = c.tag_id
      WHERE t.organisation_id = $1 AND c.day >= CURRENT_DATE - 6
      GROUP BY t.loop_tag, t.unit, t.name, t.area
      ORDER BY run_hours DESC, trips DESC LIMIT 6`,
    [org]
  );
  return {
    days: 7,
    items: rows.map((r) => ({ key: `${r.loop_tag}${r.unit ? `/${r.unit}` : ''}`, name: r.name, area: r.area, runHours: Math.round(r.run_hours * 10) / 10, starts: r.starts, trips: r.trips })),
  };
}

async function projectsFor(org) {
  const { rows } = await query(
    `SELECT p.id, p.name, p.kind, p.updated_at, COUNT(f.id)::int AS flowsheet_count
       FROM projects p LEFT JOIN flowsheets f ON f.project_id = p.id AND f.is_snapshot = false
      WHERE p.organisation_id = $1 AND p.status = 'active'
      GROUP BY p.id ORDER BY p.updated_at DESC`,
    [org]
  );
  return {
    monitoring: rows.filter((p) => p.kind === 'monitoring').length,
    twin: rows.filter((p) => p.kind === 'twin').length,
    total: rows.length,
    recent: rows.slice(0, 4).map((p) => ({ id: p.id, name: p.name, kind: p.kind, updatedAt: p.updated_at, flowsheets: p.flowsheet_count })),
  };
}

async function runsFor(org) {
  const { rows } = await query(
    `SELECT r.id, r.status, r.mode, r.created_at, r.completed_at, f.id AS flowsheet_id, f.name AS flowsheet_name,
            p.id AS project_id, p.name AS project_name, p.kind
       FROM simulation_runs r JOIN flowsheets f ON f.id = r.flowsheet_id JOIN projects p ON p.id = f.project_id
      WHERE p.organisation_id = $1 ORDER BY r.created_at DESC LIMIT 5`,
    [org]
  );
  return { items: rows.map((r) => ({ id: r.id, status: r.status, mode: r.mode, createdAt: r.created_at, completedAt: r.completed_at, flowsheetId: r.flowsheet_id, flowsheetName: r.flowsheet_name, projectId: r.project_id, projectName: r.project_name, kind: r.kind })) };
}

async function notificationsFor(org) {
  const [outbox, subs] = await Promise.all([
    query(
      `SELECT COUNT(*) FILTER (WHERE state = 'sent')::int AS sent,
              COUNT(*) FILTER (WHERE state IN ('pending', 'sending'))::int AS pending,
              COUNT(*) FILTER (WHERE state = 'failed')::int AS failed,
              COUNT(*) FILTER (WHERE state = 'dead')::int AS dead,
              COUNT(*) FILTER (WHERE channel = 'email')::int AS email,
              COUNT(*) FILTER (WHERE channel = 'whatsapp')::int AS whatsapp,
              COUNT(*) FILTER (WHERE channel = 'webhook')::int AS webhook
         FROM notification_outbox WHERE organisation_id = $1 AND created_at > NOW() - INTERVAL '24 hours'`,
      [org]
    ),
    query(`SELECT COUNT(*)::int AS n, COUNT(*) FILTER (WHERE enabled)::int AS enabled FROM notification_subscriptions WHERE organisation_id = $1`, [org]),
  ]);
  return { last24h: outbox.rows[0], subscriptions: subs.rows[0] };
}

async function teamFor(org) {
  const [byRole, recent] = await Promise.all([
    query(`SELECT role, COUNT(*)::int AS n, COUNT(*) FILTER (WHERE is_active)::int AS active FROM users WHERE organisation_id = $1 GROUP BY role`, [org]),
    query(`SELECT id, first_name, last_name, role, last_login_at, is_active FROM users WHERE organisation_id = $1 ORDER BY last_login_at DESC NULLS LAST LIMIT 6`, [org]),
  ]);
  const roles = Object.fromEntries(byRole.rows.map((r) => [r.role, { total: r.n, active: r.active }]));
  return {
    byRole: roles,
    total: byRole.rows.reduce((n, r) => n + r.n, 0),
    active: byRole.rows.reduce((n, r) => n + r.active, 0),
    recentLogins: recent.rows.map((u) => ({ id: u.id, name: `${u.first_name} ${u.last_name}`, role: u.role, lastLoginAt: u.last_login_at, active: u.is_active })),
  };
}

async function integrationsFor(org) {
  const [keys, hooks] = await Promise.all([
    query(
      `SELECT COUNT(*) FILTER (WHERE revoked_at IS NULL AND (expires_at IS NULL OR expires_at > NOW()))::int AS active,
              COUNT(*)::int AS total, MAX(last_used_at) AS last_used_at
         FROM api_keys WHERE organisation_id = $1`,
      [org]
    ),
    query(
      `SELECT id, name, url, enabled, last_status, last_delivery_at, failures
         FROM webhook_endpoints WHERE organisation_id = $1 ORDER BY name LIMIT 6`,
      [org]
    ),
  ]);
  return {
    apiKeys: { active: keys.rows[0].active, total: keys.rows[0].total, lastUsedAt: keys.rows[0].last_used_at },
    webhooks: hooks.rows.map((h) => ({ id: h.id, name: h.name, url: h.url, enabled: h.enabled, lastStatus: h.last_status, lastDeliveryAt: h.last_delivery_at, failures: h.failures, healthy: h.enabled && h.failures === 0 && (h.last_status == null || h.last_status < 400) })),
  };
}

async function auditFor(org) {
  const { rows } = await query(
    `SELECT a.*, u.first_name, u.last_name, u.role AS actor_role
       FROM audit_logs a LEFT JOIN users u ON u.id = a.user_id
      WHERE a.organisation_id = $1 ORDER BY a.created_at DESC LIMIT 8`,
    [org]
  );
  return {
    items: rows.map((r) => ({
      id: r.id, action: r.action, entityType: r.entity_type ?? r.resource_type ?? null, entityId: r.entity_id ?? r.resource_id ?? null,
      actor: r.first_name ? `${r.first_name} ${r.last_name}` : (r.user_id ? 'Unknown' : 'System'), actorRole: r.actor_role, at: r.created_at,
    })),
  };
}

async function systemFor(org) {
  const [samples, jobs, partitions] = await Promise.all([
    query(`SELECT COUNT(*)::int AS n FROM tag_samples s JOIN tags t ON t.id = s.tag_id WHERE t.organisation_id = $1 AND s.ts > NOW() - INTERVAL '1 hour'`, [org]).catch(() => ({ rows: [{ n: null }] })),
    query(`SELECT name, watermark, last_run_at, last_error, rows_affected FROM historian_jobs ORDER BY name`).catch(() => ({ rows: [] })),
    query(`SELECT COUNT(*)::int AS n FROM pg_inherits WHERE inhparent = 'tag_samples'::regclass`).catch(() => ({ rows: [{ n: null }] })),
  ]);
  return {
    uptimeS: Math.round(process.uptime()),
    node: process.version,
    samplesLastHour: samples.rows[0].n,
    historian: jobs.rows.map((j) => ({ name: j.name, watermark: j.watermark, lastRunAt: j.last_run_at, lastError: j.last_error, rows: Number(j.rows_affected) })),
    partitions: partitions.rows[0].n,
  };
}

// ── GET /dashboard ───────────────────────────────────────────────────────────
router.get('/', async (req, res, next) => {
  try {
    const org = orgId(req);
    const role = req.user.role;
    const sections = SECTIONS[role] || SECTIONS.viewer;
    const snap = await buildSnapshot(org);
    const builders = {
      plant: async () => plantFrom(snap),
      alarms: () => alarmsFor(snap, org),
      equipment: async () => equipmentFrom(snap),
      readings: async () => readingsFrom(snap),
      myTasks: () => myTasksFor(org, req),
      approvals: () => approvalsFor(org),
      twin: () => twinFor(org),
      plc: () => plcFor(snap, org),
      counters: () => countersFor(org),
      projects: () => projectsFor(org),
      runs: () => runsFor(org),
      notifications: () => notificationsFor(org),
      team: () => teamFor(org),
      integrations: () => integrationsFor(org),
      audit: () => auditFor(org),
      system: () => systemFor(org),
    };
    const built = await Promise.all(sections.map((s) => builders[s]()));
    const body = { at: new Date().toISOString(), role, user: { id: userId(req), role }, sections };
    sections.forEach((s, i) => { body[s] = built[i]; });
    res.json(body);
  } catch (err) { next(err); }
});

module.exports = router;
module.exports.SECTIONS = SECTIONS;
