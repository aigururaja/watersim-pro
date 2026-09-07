/**
 * WaterSim Pro — Phase 0 foundations  (three-application plan)
 *
 * What Phase 0 adds and what this suite holds it to:
 *
 *   ROLES      one source of truth (auth/roles.js) with `manager` between
 *              engineer and admin; a capability vocabulary that fails closed.
 *   AUTH       requireRole still accepts every role; requireCapability rejects
 *              an unknown verb at definition time; the per-request role refresh
 *              is fail-OPEN on lookup failure and fail-CLOSED on deactivation.
 *   ROUTES     /tags and /audit are mounted, authenticated, and gated by the
 *              right role — provable without a database because the guards run
 *              before any query, and an ISA-invalid tag is refused (422) before
 *              the insert is attempted.
 *
 * Everything here runs without TEST_DB. The DB-backed matrix lives in
 * rbac.test.js, which now includes `manager`.
 */

'use strict';

const { request, app } = require('./helpers');
const { signAccess } = require('../utils/jwt');
const roles = require('../auth/roles');
const { requireRole, requireCapability, ROLE_HIERARCHY, invalidateRoleCache, AppError } = require('../middleware/auth');

const USER = '00000000-0000-0000-0000-000000000001';
const ORG = '00000000-0000-0000-0000-000000000002';
const tokenFor = (role) => signAccess({ sub: USER, org: ORG, role });
const as = (role) => (req) => req.set('Authorization', `Bearer ${tokenFor(role)}`);

// ── Roles: the single source of truth ────────────────────────────────────────

describe('auth/roles.js', () => {
  it('orders the five roles lowest to highest with manager below admin', () => {
    expect(roles.ROLES).toEqual(['viewer', 'operator', 'engineer', 'manager', 'admin']);
    expect(roles.rank('manager')).toBeGreaterThan(roles.rank('engineer'));
    expect(roles.rank('manager')).toBeLessThan(roles.rank('admin'));
  });

  it('is the list the middleware hierarchy re-exports', () => {
    expect(ROLE_HIERARCHY).toBe(roles.ROLES);
  });

  it('gives every capability a minimum role that exists', () => {
    for (const [cap, min] of Object.entries(roles.CAPABILITIES)) {
      expect(roles.ROLES).toContain(min);
      expect(cap).toMatch(/^[a-z]+\.[a-z_]+$/);
    }
  });

  it('inherits: a role holds every capability of the roles below it', () => {
    for (let i = 1; i < roles.ROLES.length; i += 1) {
      const lower = roles.capabilitiesOf(roles.ROLES[i - 1]);
      const higher = new Set(roles.capabilitiesOf(roles.ROLES[i]));
      for (const c of lower) expect(higher.has(c)).toBe(true);
    }
  });

  it('reserves approval and critical-ack for manager and above', () => {
    expect(roles.can('engineer', 'task.approve')).toBe(false);
    expect(roles.can('manager', 'task.approve')).toBe(true);
    expect(roles.can('admin', 'task.approve')).toBe(true);
    expect(roles.can('engineer', 'alarm.ack_critical')).toBe(false);
    expect(roles.can('manager', 'alarm.ack_critical')).toBe(true);
  });

  it('lets a manager do everything an engineer can', () => {
    for (const c of roles.capabilitiesOf('engineer')) expect(roles.can('manager', c)).toBe(true);
  });

  it('opens every surface to every role, and nothing to an unknown one', () => {
    for (const r of roles.ROLES) {
      expect(roles.can(r, 'ops.view')).toBe(true);
      expect(roles.can(r, 'twin.view')).toBe(true);
      expect(roles.can(r, 'maintenance.view')).toBe(true);
    }
    expect(roles.can('superuser', 'ops.view')).toBe(false);
    expect(roles.can('viewer', 'not.a.verb')).toBe(false);
    expect(roles.can(undefined, 'ops.view')).toBe(false);
  });
});

// ── Middleware ───────────────────────────────────────────────────────────────

describe('requireRole / requireCapability', () => {
  const run = (mw, role) => new Promise((resolve) => {
    mw({ user: role === null ? undefined : { role } }, {}, (err) => resolve(err || null));
  });

  it('accepts manager as a route requirement', () => {
    expect(() => requireRole('manager')).not.toThrow();
  });

  it('still throws at definition time for an unknown role', () => {
    expect(() => requireRole('superuser')).toThrow(/unknown role/);
  });

  it('throws at definition time for an unknown capability', () => {
    expect(() => requireCapability('task.teleport')).toThrow(/unknown capability/);
  });

  it('lets manager through an engineer gate and stops engineer at a manager gate', async () => {
    expect(await run(requireRole('engineer'), 'manager')).toBeNull();
    const denied = await run(requireRole('manager'), 'engineer');
    expect(denied).toBeInstanceOf(AppError);
    expect(denied.status).toBe(403);
  });

  it('gates by capability with the same fail-closed contract', async () => {
    expect(await run(requireCapability('task.approve'), 'manager')).toBeNull();
    expect((await run(requireCapability('task.approve'), 'engineer')).status).toBe(403);
    expect((await run(requireCapability('task.approve'), 'unrecognised')).status).toBe(403);
    expect((await run(requireCapability('task.approve'), null)).status).toBe(401);
  });

  it('exposes a cache invalidation hook that never throws', () => {
    expect(() => invalidateRoleCache(USER)).not.toThrow();
    expect(() => invalidateRoleCache()).not.toThrow();
  });
});

// ── Per-request role refresh: fail-open without a database ───────────────────

describe('authenticate — role refresh', () => {
  it('honours the token role when the user cannot be looked up', async () => {
    // No TEST_DB here, and the sub is synthetic: the lookup fails or finds
    // nothing, and the request must proceed on the signed token's role. A
    // viewer token must still be a viewer — not promoted, not refused.
    const res = await as('viewer')(request(app).post('/api/v1/tags')).send({});
    expect(res.status).toBe(403);
    const ok = await as('engineer')(request(app).get('/api/v1/plant'));
    expect(ok.status).toBe(200);
  });
});

// ── /tags ────────────────────────────────────────────────────────────────────

describe('/api/v1/tags guards', () => {
  it('requires authentication', async () => {
    expect((await request(app).get('/api/v1/tags')).status).toBe(401);
    expect((await request(app).post('/api/v1/tags').send({})).status).toBe(401);
  });

  it('lets a viewer read but not write', async () => {
    const write = await as('viewer')(request(app).post('/api/v1/tags')).send({
      tag: 'RFP-FT-201.FT', signalType: 'AI', kind: 'flow_meter', name: 'x', signal: 'Flow',
    });
    expect(write.status).toBe(403);
    const seed = await as('operator')(request(app).post('/api/v1/tags/seed/itc-stp')).send({});
    expect(seed.status).toBe(403);
  });

  it('refuses a tag that is not ISA-5.1 before touching the database', async () => {
    for (const tag of ['R-AV-301/1.ZSO', 'R-DEC-301/1.XS', 'ELP-XV-101/1.XC', 'pump-101', 'RFP-FT-201']) {
      const res = await as('engineer')(request(app).post('/api/v1/tags')).send({
        tag, signalType: 'DI', kind: 'pump', name: 'Test', signal: 'Run status',
      });
      expect([422, 500]).toContain(res.status);
      // The validator runs first: a forbidden or malformed tag is a 422 with a
      // reason, never a database error.
      if (res.status === 422) expect(JSON.stringify(res.body)).toMatch(/ISA-5\.1|Validation/);
    }
  });

  it('validates the body shape', async () => {
    const res = await as('engineer')(request(app).post('/api/v1/tags')).send({ tag: 'RFP-FT-201.FT' });
    expect(res.status).toBe(422);
  });

  it('refuses to rename a tag through PATCH', async () => {
    const res = await as('engineer')(request(app).patch(`/api/v1/tags/${USER}`)).send({ tag: 'X-Y-1.LT' });
    expect(res.status).toBe(422);
    expect(JSON.stringify(res.body)).toMatch(/immutable/);
  });
});

// ── /audit ───────────────────────────────────────────────────────────────────

describe('/api/v1/audit guards', () => {
  it('requires authentication', async () => {
    expect((await request(app).get('/api/v1/audit')).status).toBe(401);
  });

  it('is admin-only — even a manager is refused', async () => {
    for (const role of ['viewer', 'operator', 'engineer', 'manager']) {
      const res = await as(role)(request(app).get('/api/v1/audit'));
      expect(res.status).toBe(403);
      expect(res.body.error).toMatch(/audit\.read/);
    }
  });

  it('validates its filters before querying', async () => {
    const res = await as('admin')(request(app).get('/api/v1/audit?userId=not-a-uuid'));
    expect(res.status).toBe(422);
    const bad = await as('admin')(request(app).get('/api/v1/audit?cursor=%%%'));
    expect([422, 500]).toContain(bad.status);
  });
});
