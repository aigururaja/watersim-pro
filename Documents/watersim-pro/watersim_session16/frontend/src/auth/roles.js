/**
 * WaterSim Pro — roles and capabilities (client mirror).
 *
 * This is a copy of `backend/src/auth/roles.js`, kept identical by
 * `frontend/src/test/roles.test.js`, which reads the backend file and asserts
 * the two tables match. The duplication is deliberate: the client must be able
 * to render the shell and gate controls before its first API call, and a
 * capability the server does not agree with is caught at build time, not in a
 * user's browser.
 *
 * The server is the authority. `can()` here decides what to SHOW; every write
 * is re-checked by `requireRole` / `requireCapability` on the API.
 */

/** Lowest to highest. Index is rank. */
export const ROLES = Object.freeze(['viewer', 'operator', 'engineer', 'manager', 'admin']);

/** verb → minimum role. Same table as the server. */
export const CAPABILITIES = Object.freeze({
  // Surfaces
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

/** Display metadata for the Admin page and the shell. */
export const ROLE_META = Object.freeze({
  viewer:   { label: 'Viewer',   desc: 'Read-only: dashboards, trends, tasks and the twin' },
  operator: { label: 'Operator', desc: 'Acknowledge alarms, run what-if scenarios, raise tasks, control with confirmation' },
  engineer: { label: 'Engineer', desc: 'Edit process models, alarm rules and tags; be assigned and complete tasks' },
  manager:  { label: 'Manager',  desc: 'Everything an engineer can, plus approve tasks, acknowledge critical alarms, set notification policy' },
  admin:    { label: 'Admin',    desc: 'Full access: users, PLC connections, API keys, audit trail' },
});

export const rank = (role) => ROLES.indexOf(role);

export function can(role, capability) {
  const min = CAPABILITIES[capability];
  if (!min) return false;
  const r = rank(role);
  return r !== -1 && r >= rank(min);
}

export function capabilitiesOf(role) {
  return Object.keys(CAPABILITIES).filter((c) => can(role, c));
}
