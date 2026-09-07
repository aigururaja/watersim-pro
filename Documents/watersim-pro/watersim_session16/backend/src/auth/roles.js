/**
 * WaterSim Pro — roles and capabilities: the ONE source of truth.
 *
 * Four places used to carry their own copy of the role list — the DB enum,
 * `ROLE_HIERARCHY` in middleware/auth.js, `VALID_ROLES` in the admin
 * controller, and the frontend's `ROLES` — and the inventory that preceded the
 * three-application plan named the drift between them as the thing that breaks
 * invites. Every backend consumer now reads this file. The frontend keeps a
 * mirror in `frontend/src/auth/roles.js`, and `roles.test.js` asserts the two
 * are identical, so a role added here without its twin fails the build.
 *
 * ── THE HIERARCHY ────────────────────────────────────────────────────────────
 * Linear and index-based, exactly as before: each role inherits everything
 * below it. `manager` sits between engineer and admin because the two things
 * it exists to do — approve maintenance tasks and acknowledge critical alarms —
 * are supervisory, and a supervisor who could not also do an engineer's work
 * would be an odd construction on a small plant. If a site needs managers who
 * may approve but may NOT edit process models, that is a deny-capability, and
 * it belongs in `CAPABILITIES` below — not in a second hierarchy.
 *
 * ── CAPABILITIES ─────────────────────────────────────────────────────────────
 * A capability is a named verb mapped to the minimum role that holds it.
 * `requireRole('engineer')` on a route still works and still means "engineer or
 * above"; `requireCapability('task.approve')` reads the same table by name, so
 * a route can say what it protects rather than who. New verbs go here; existing
 * `requireRole` call sites are left alone until they have a reason to move.
 */
'use strict';

/** Lowest to highest. Index is rank. */
const ROLES = Object.freeze(['viewer', 'operator', 'engineer', 'manager', 'admin']);

/**
 * verb → minimum role. Grouped by the surface that owns the verb; the three
 * `*.view` capabilities are what gate the application shell.
 */
const CAPABILITIES = Object.freeze({
  // Surfaces — who may open each application at all
  'ops.view': 'viewer',
  'twin.view': 'viewer',
  'maintenance.view': 'viewer',

  // Operations Monitor & Control
  'alarm.ack': 'operator',
  'control.write': 'operator',
  'task.create': 'operator',
  'model.edit': 'engineer',
  'alarm.configure': 'engineer',
  'tags.edit': 'engineer',
  'task.work': 'engineer',
  'task.approve': 'manager',
  'alarm.ack_critical': 'manager',
  'notify.policy': 'manager',

  // Digital Twin
  'scenario.run': 'operator',
  'twin.configure': 'engineer',
  'twin.commission': 'engineer',

  // Administration
  'audit.read': 'admin',
  'users.manage': 'admin',
  'plc.manage': 'admin',
  'cmms.manage': 'admin',
});

/** Rank of a role, or -1 for anything unrecognised (fail closed). */
const rank = (role) => ROLES.indexOf(role);

/** True when a role holds a capability. Unknown role or verb → false. */
function can(role, capability) {
  const min = CAPABILITIES[capability];
  if (!min) return false;
  const r = rank(role);
  return r !== -1 && r >= rank(min);
}

/** Every capability a role holds, for the client shell. */
function capabilitiesOf(role) {
  return Object.keys(CAPABILITIES).filter((c) => can(role, c));
}

module.exports = { ROLES, CAPABILITIES, rank, can, capabilitiesOf };
