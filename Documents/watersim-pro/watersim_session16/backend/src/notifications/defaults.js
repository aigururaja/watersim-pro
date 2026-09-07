/**
 * WaterSim Pro — Default notification policy
 *
 * One row per (role, event) so that every kind of user hears what their role
 * needs from the first day, on the phone as well as by email where a message
 * is worth a buzz at night. Installed by the ITC seed and by "Install the
 * default policy for every role" under Settings → Notifications. A plant's own
 * tuning survives: an existing (role, event) row is never overwritten.
 *
 * Role rows name the role exactly (a manager does not inherit the engineer
 * rows), so each role appears here in its own right. Task assignees always
 * hear about their own assignment whatever this table says.
 */
'use strict';

const { query } = require('../db/pool');

const DEFAULT_POLICY = Object.freeze([
  // viewer — management and visitors: the plant-wide emergencies only, by email.
  { role: 'viewer',   eventType: 'alarm.raised',   minSeverity: 'critical', channels: ['email'] },
  // operator — on the floor: every alarm event from warning up, on the phone too;
  // a critical alarm's task on the phone so the shift knows work has been raised.
  { role: 'operator', eventType: 'alarm.',         minSeverity: 'warning',  channels: ['email', 'whatsapp'] },
  { role: 'operator', eventType: 'task.created',   minSeverity: 'critical', channels: ['whatsapp'] },
  // engineer — owns the process: alarms from warning up, the fate of their work, twin drift.
  { role: 'engineer', eventType: 'alarm.raised',   minSeverity: 'warning',  channels: ['email', 'whatsapp'] },
  { role: 'engineer', eventType: 'alarm.cleared',  minSeverity: 'critical', channels: ['email'] },
  { role: 'engineer', eventType: 'task.rejected',  minSeverity: 'info',     channels: ['email', 'whatsapp'] },
  { role: 'engineer', eventType: 'task.approved',  minSeverity: 'info',     channels: ['email'] },
  { role: 'engineer', eventType: 'twin.drift',     minSeverity: 'warning',  channels: ['email'] },
  // manager — approves and acknowledges: critical alarms, work awaiting sign-off.
  { role: 'manager',  eventType: 'alarm.raised',   minSeverity: 'critical', channels: ['email', 'whatsapp'] },
  { role: 'manager',  eventType: 'task.completed', minSeverity: 'info',     channels: ['email', 'whatsapp'] },
  { role: 'manager',  eventType: 'task.created',   minSeverity: 'critical', channels: ['email'] },
  { role: 'manager',  eventType: 'twin.drift',     minSeverity: 'critical', channels: ['email'] },
  // admin — keeps the platform running: critical alarms raised and cleared.
  { role: 'admin',    eventType: 'alarm.raised',   minSeverity: 'critical', channels: ['email', 'whatsapp'] },
  { role: 'admin',    eventType: 'alarm.cleared',  minSeverity: 'critical', channels: ['email'] },
]);

/**
 * Add every default row the organisation does not have yet (matched on role
 * and event type). Idempotent.
 * @returns {Promise<{ added: number, existing: number, total: number, missing: string[] }>}
 */
async function installDefaultPolicy(orgId, createdBy = null) {
  let added = 0;
  const existing = [];
  for (const d of DEFAULT_POLICY) {
    const r = await query(
      `INSERT INTO notification_subscriptions (organisation_id, role, event_type, min_severity, channels, created_by)
       SELECT $1, $2, $3, $4, $5::text[], $6
        WHERE NOT EXISTS (SELECT 1 FROM notification_subscriptions
                           WHERE organisation_id = $1 AND role = $2 AND event_type = $3)`,
      [orgId, d.role, d.eventType, d.minSeverity, d.channels, createdBy]
    );
    if (r.rowCount) added += 1; else existing.push(`${d.role}:${d.eventType}`);
  }
  return { added, existing: existing.length, total: DEFAULT_POLICY.length };
}

/** The default rows an organisation's policy does not carry (by role and event type). */
function missingDefaults(rows) {
  const have = new Set((rows || []).filter((s) => s.role).map((s) => `${s.role}:${s.event_type || s.eventType}`));
  return DEFAULT_POLICY.filter((d) => !have.has(`${d.role}:${d.eventType}`));
}

module.exports = { DEFAULT_POLICY, installDefaultPolicy, missingDefaults };
