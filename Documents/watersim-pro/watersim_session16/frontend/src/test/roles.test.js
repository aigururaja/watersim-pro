/**
 * Roles — client/server parity.
 *
 * `frontend/src/auth/roles.js` is a deliberate copy of `backend/src/auth/roles.js`:
 * the shell has to gate itself before its first API call. A copy drifts, so this
 * test reads the backend module and asserts the two tables are identical — a
 * capability added on one side only is a failed build, not a surprise in
 * production where a button shows for a role the API then refuses.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import path from 'node:path';
import { ROLES, CAPABILITIES, ROLE_META, rank, can, capabilitiesOf } from '../auth/roles';

const require = createRequire(import.meta.url);
const BACKEND_ROLES = path.resolve(__dirname, '../../../backend/src/auth/roles.js');

describe('roles: client mirrors the server', () => {
  const server = require(BACKEND_ROLES);

  it('has the same role list in the same order', () => {
    expect([...ROLES]).toEqual([...server.ROLES]);
  });

  it('has the same capability → minimum-role table', () => {
    expect({ ...CAPABILITIES }).toEqual({ ...server.CAPABILITIES });
  });

  it('agrees with the server on every (role, capability) decision', () => {
    for (const role of [...ROLES, 'nobody', undefined, null]) {
      for (const cap of [...Object.keys(CAPABILITIES), 'no.such']) {
        expect(can(role, cap)).toBe(server.can(role, cap));
      }
    }
  });

  it('describes every role for the admin page', () => {
    for (const role of ROLES) {
      expect(ROLE_META[role]).toBeTruthy();
      expect(ROLE_META[role].label).toMatch(/\S/);
      expect(ROLE_META[role].desc).toMatch(/\S/);
    }
    expect(Object.keys(ROLE_META).sort()).toEqual([...ROLES].sort());
  });
});

describe('roles: hierarchy', () => {
  it('ranks viewer < operator < engineer < manager < admin', () => {
    expect(rank('viewer')).toBeLessThan(rank('operator'));
    expect(rank('operator')).toBeLessThan(rank('engineer'));
    expect(rank('engineer')).toBeLessThan(rank('manager'));
    expect(rank('manager')).toBeLessThan(rank('admin'));
    expect(rank('nobody')).toBe(-1);
  });

  it('a manager can do everything an engineer can, plus approvals', () => {
    const eng = new Set(capabilitiesOf('engineer'));
    const mgr = new Set(capabilitiesOf('manager'));
    for (const c of eng) expect(mgr.has(c)).toBe(true);
    expect(mgr.has('task.approve')).toBe(true);
    expect(eng.has('task.approve')).toBe(false);
    expect(mgr.has('audit.read')).toBe(false);
  });

  it('every surface is visible to a viewer; nothing is granted for an unknown verb or role', () => {
    expect(can('viewer', 'ops.view')).toBe(true);
    expect(can('viewer', 'twin.view')).toBe(true);
    expect(can('viewer', 'maintenance.view')).toBe(true);
    expect(can('admin', 'not.a.capability')).toBe(false);
    expect(can('superuser', 'ops.view')).toBe(false);
    expect(can(null, 'ops.view')).toBe(false);
  });
});
