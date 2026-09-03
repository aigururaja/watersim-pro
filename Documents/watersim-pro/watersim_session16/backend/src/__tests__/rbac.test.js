/**
 * RBAC matrix tests — role × endpoint allow/deny.
 *
 * Creates one org with a user of each role (admin registers, then invites the
 * others via the admin API) and asserts the write-gating matrix:
 *
 *   endpoint            admin  engineer  operator  viewer
 *   create project        ✓       ✓         ✗        ✗
 *   patch project         ✓       ✓         ✗        ✗
 *   delete project        ✓       ✓         ✗        ✗
 *   create flowsheet      ✓       ✓         ✗        ✗
 *   patch flowsheet       ✓       ✓         ✗        ✗
 *   run simulation        ✓       ✓         ✓        ✗
 *   list projects         ✓       ✓         ✓        ✓
 *
 * Requires a running PostgreSQL database (skipped gracefully otherwise).
 */
const { request, app } = require('./helpers');
const { requireRole } = require('../middleware/auth');

const SKIP = process.env.CI !== 'true' && !process.env.DATABASE_URL && !process.env.TEST_DATABASE_URL;

const ts = Date.now();
const ORG_SLUG = `rbac-${ts}`;
const PASSWORD = 'RbacPass123!';
const ROLES = ['admin', 'engineer', 'operator', 'viewer'];

const emails = {
  admin:    `rbac-admin-${ts}@test.example`,
  engineer: `rbac-eng-${ts}@test.example`,
  operator: `rbac-op-${ts}@test.example`,
  viewer:   `rbac-view-${ts}@test.example`,
};

const tokens = {};
let projectId;
let flowsheetId;

const authed = (method, url, token) =>
  request(app)[method](url).set('Authorization', `Bearer ${token}`);

async function login(email) {
  const res = await request(app)
    .post('/api/v1/auth/login')
    .send({ email, password: PASSWORD, orgSlug: ORG_SLUG });
  if (res.status !== 200) throw new Error(`login failed for ${email}: ${JSON.stringify(res.body)}`);
  return res.body.data.accessToken;
}

async function setupOrg() {
  const reg = await request(app).post('/api/v1/auth/register').send({
    orgName: 'RBAC Test Org', orgSlug: ORG_SLUG, email: emails.admin,
    password: PASSWORD, firstName: 'Rbac', lastName: 'Admin',
  });
  if (reg.status !== 201) throw new Error(`register failed: ${JSON.stringify(reg.body)}`);
  tokens.admin = await login(emails.admin);

  for (const role of ['engineer', 'operator', 'viewer']) {
    const inv = await authed('post', '/api/v1/admin/members', tokens.admin).send({
      email: emails[role], firstName: 'Rbac', lastName: role, role, password: PASSWORD,
    });
    if (inv.status !== 201) throw new Error(`invite ${role} failed: ${JSON.stringify(inv.body)}`);
    tokens[role] = await login(emails[role]);
  }

  const proj = await authed('post', '/api/v1/projects', tokens.admin)
    .send({ name: 'RBAC Shared Project', projectType: 'wastewater' });
  if (proj.status !== 201) throw new Error(`project create failed: ${JSON.stringify(proj.body)}`);
  projectId = proj.body.id;

  const fs = await authed('post', `/api/v1/projects/${projectId}/flowsheets`, tokens.admin)
    .send({ name: 'RBAC Shared Flowsheet' });
  if (fs.status !== 201) throw new Error(`flowsheet create failed: ${JSON.stringify(fs.body)}`);
  flowsheetId = fs.body.id;
}

// ── Pure unit tests (no DB): requireRole fails closed ────────────────────────

describe('requireRole (unit)', () => {
  it('throws at definition time for unknown role names', () => {
    expect(() => requireRole('superuser')).toThrow(/unknown role/);
  });

  it('denies a user whose token carries an unrecognisable role', () => {
    const mw = requireRole('viewer');
    const req = { user: { sub: 'x', role: 'ghost' } };
    let captured = null;
    mw(req, {}, (err) => { captured = err; });
    expect(captured).toBeTruthy();
    expect(captured.status).toBe(403);
  });

  it('allows a role above the minimum', () => {
    const mw = requireRole('operator');
    let captured = 'unset';
    mw({ user: { sub: 'x', role: 'engineer' } }, {}, (err) => { captured = err; });
    expect(captured).toBeUndefined();
  });
});

// ── Role × endpoint matrix (DB required) ─────────────────────────────────────

const MATRIX = [
  {
    name: 'create project',
    allowed: ['admin', 'engineer'],
    exec: (token, role) => authed('post', '/api/v1/projects', token)
      .send({ name: `rbac-create-${role}-${Date.now()}`, projectType: 'wastewater' }),
  },
  {
    name: 'patch project',
    allowed: ['admin', 'engineer'],
    exec: (token) => authed('patch', `/api/v1/projects/${projectId}`, token)
      .send({ description: 'rbac patch' }),
  },
  {
    name: 'delete project',
    allowed: ['admin', 'engineer'],
    exec: async (token, role, isAllowed) => {
      // Allowed roles delete a throwaway project; denied roles target the
      // shared project (the 403 must fire before anything is touched).
      let target = projectId;
      if (isAllowed) {
        const p = await authed('post', '/api/v1/projects', tokens.admin)
          .send({ name: `rbac-del-${role}-${Date.now()}`, projectType: 'wastewater' });
        if (p.status !== 201) throw new Error(`fixture project failed: ${JSON.stringify(p.body)}`);
        target = p.body.id;
      }
      return authed('delete', `/api/v1/projects/${target}`, token);
    },
  },
  {
    name: 'create flowsheet',
    allowed: ['admin', 'engineer'],
    exec: (token, role) => authed('post', `/api/v1/projects/${projectId}/flowsheets`, token)
      .send({ name: `rbac-fs-${role}-${Date.now()}` }),
  },
  {
    name: 'patch flowsheet',
    allowed: ['admin', 'engineer'],
    exec: (token) => authed('patch', `/api/v1/projects/${projectId}/flowsheets/${flowsheetId}`, token)
      .send({ description: 'rbac patch' }),
  },
  {
    name: 'run simulation',
    allowed: ['admin', 'engineer', 'operator'],
    // Only the gate matters here — an empty canvas may make the solver return
    // 422, so allowed roles assert "not denied" rather than a specific status.
    exec: (token) => authed('post', `/api/v1/projects/${projectId}/flowsheets/${flowsheetId}/simulate`, token)
      .send({ mode: 'steady_state' }),
  },
  {
    name: 'list projects',
    allowed: ['admin', 'engineer', 'operator', 'viewer'],
    exec: (token) => authed('get', '/api/v1/projects', token),
  },
];

describe('RBAC role × endpoint matrix', () => {
  if (SKIP) {
    it.skip('No DB — skipping RBAC matrix tests', () => {});
  } else {
    beforeAll(setupOrg);

    for (const endpoint of MATRIX) {
      for (const role of ROLES) {
        const isAllowed = endpoint.allowed.includes(role);
        it(`${role} ${isAllowed ? 'CAN' : 'CANNOT'} ${endpoint.name}`, async () => {
          const res = await endpoint.exec(tokens[role], role, isAllowed);
          if (isAllowed) {
            expect(res.status).not.toBe(403);
            expect(res.status).not.toBe(401);
          } else {
            expect(res.status).toBe(403);
          }
        });
      }
    }

    // ── Admin route param validation ─────────────────────────────────────────
    it('rejects a non-UUID userId on admin member routes with 400 (not 500)', async () => {
      const res = await authed('patch', '/api/v1/admin/members/not-a-uuid', tokens.admin)
        .send({ role: 'viewer' });
      expect(res.status).toBe(400);
    });

    // ── Last-admin protection ────────────────────────────────────────────────
    describe('last-admin protection', () => {
      it('refuses a change that would leave the org with zero active admins', async () => {
        // Invite a second admin B, log them in, then deactivate B. B's JWT is
        // still valid, so without the guard B could now demote/delete A and
        // leave the org admin-less.
        const emailB = `rbac-admin2-${ts}@test.example`;
        const inv = await authed('post', '/api/v1/admin/members', tokens.admin).send({
          email: emailB, firstName: 'Second', lastName: 'Admin', role: 'admin', password: PASSWORD,
        });
        expect(inv.status).toBe(201);
        const tokenB = await login(emailB);

        // Find A's userId and deactivate B (A remains the only active admin)
        const members = await authed('get', '/api/v1/admin/members', tokens.admin);
        const userA = members.body.find((m) => m.email === emails.admin);
        const userB = members.body.find((m) => m.email === emailB);
        const deact = await authed('patch', `/api/v1/admin/members/${userB.id}`, tokens.admin)
          .send({ isActive: false });
        expect(deact.status).toBe(200);

        // B (stale but valid JWT) tries to demote A — must be refused
        const demote = await authed('patch', `/api/v1/admin/members/${userA.id}`, tokenB)
          .send({ role: 'engineer' });
        expect(demote.status).toBe(409);

        // ... and to delete A — must also be refused
        const del = await authed('delete', `/api/v1/admin/members/${userA.id}`, tokenB);
        expect(del.status).toBe(409);
      });
    });

    // ── Change password ──────────────────────────────────────────────────────
    describe('POST /api/v1/auth/change-password', () => {
      const NEW_PASSWORD = 'BrandNew456!';

      it('rejects a wrong current password', async () => {
        const res = await authed('post', '/api/v1/auth/change-password', tokens.viewer)
          .send({ currentPassword: 'Wrong123!', newPassword: NEW_PASSWORD });
        expect(res.status).toBe(401);
      });

      it('rejects a weak new password', async () => {
        const res = await authed('post', '/api/v1/auth/change-password', tokens.viewer)
          .send({ currentPassword: PASSWORD, newPassword: 'short' });
        expect(res.status).toBe(422);
      });

      it('requires authentication', async () => {
        const res = await request(app).post('/api/v1/auth/change-password')
          .send({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD });
        expect(res.status).toBe(401);
      });

      it('changes the password; old one stops working, new one logs in', async () => {
        const res = await authed('post', '/api/v1/auth/change-password', tokens.viewer)
          .send({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD });
        expect(res.status).toBe(200);

        const oldLogin = await request(app).post('/api/v1/auth/login')
          .send({ email: emails.viewer, password: PASSWORD, orgSlug: ORG_SLUG });
        expect(oldLogin.status).toBe(401);

        const newLogin = await request(app).post('/api/v1/auth/login')
          .send({ email: emails.viewer, password: NEW_PASSWORD, orgSlug: ORG_SLUG });
        expect(newLogin.status).toBe(200);
      });
    });
  }
});
