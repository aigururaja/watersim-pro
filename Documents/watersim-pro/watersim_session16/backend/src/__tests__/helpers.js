/**
 * Test helpers — shared across all test files.
 * Uses supertest against the Express app (no real DB needed for unit tests).
 * Integration tests that need a DB are skipped when TEST_DB is not set.
 */
const request = require('supertest');
const app = require('../server');

const TEST_ADMIN = {
  orgName:   'Test Org',
  orgSlug:   `test-org-${Date.now()}`,
  email:     `admin-${Date.now()}@test.example`,
  password:  'TestPass123!',
  firstName: 'Test',
  lastName:  'Admin',
};

const TEST_ENGINEER = {
  email:     `eng-${Date.now()}@test.example`,
  password:  'EngPass123!',
  firstName: 'Test',
  lastName:  'Engineer',
};

/**
 * Register a fresh org + admin user, return { token, orgSlug }.
 */
async function registerAndLogin(overrides = {}) {
  const payload = { ...TEST_ADMIN, ...overrides };
  const regRes = await request(app)
    .post('/api/v1/auth/register')
    .send(payload);
  if (regRes.status !== 201) throw new Error(`Register failed: ${JSON.stringify(regRes.body)}`);

  const loginRes = await request(app)
    .post('/api/v1/auth/login')
    .send({ email: payload.email, password: payload.password, orgSlug: payload.orgSlug });
  if (loginRes.status !== 200) throw new Error(`Login failed: ${JSON.stringify(loginRes.body)}`);

  return {
    token:   loginRes.body.data.accessToken,
    orgSlug: payload.orgSlug,
    userId:  loginRes.body.data.user.id,
  };
}

module.exports._placeholder_remove = true; // replaced below

// ── Per-user isolated helpers (used by simulation tests) ─────────────────────

let _uid = 0;
const uniqueEmail = (base) => {
  _uid++;
  return base.replace('@', `+${Date.now()}${_uid}@`);
};

/**
 * Register a new isolated org and return a user of the requested role.
 * 'admin' is the org creator (via /register). Any other role is invited into
 * the fresh org through the admin members API, so the returned user really
 * holds that role (previously the role parameter was silently ignored and
 * every "engineer"/"operator" test user was actually an admin).
 */
async function createTestUser(email, password, role = 'admin') {
  const ue = uniqueEmail(email);
  const slug = `org-${Date.now()}-${_uid}`;
  const adminEmail = role === 'admin' ? ue : uniqueEmail(`owner.${email}`);

  const regRes = await request(app).post('/api/v1/auth/register').send({
    orgName: `TestOrg ${slug}`,
    orgSlug: slug,
    email: adminEmail,
    password,
    firstName: 'Test',
    lastName: 'User',
  });
  if (![200, 201].includes(regRes.status))
    throw new Error(`createTestUser failed (${regRes.status}): ${JSON.stringify(regRes.body)}`);
  if (role === 'admin') return { email: ue, password, orgSlug: slug };

  // Invite the non-admin role into the new org
  const loginRes = await request(app).post('/api/v1/auth/login')
    .send({ email: adminEmail, password, orgSlug: slug });
  if (loginRes.status !== 200)
    throw new Error(`createTestUser admin login failed: ${JSON.stringify(loginRes.body)}`);
  const adminToken = loginRes.body.data.accessToken;

  const invRes = await request(app).post('/api/v1/admin/members')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ email: ue, firstName: 'Test', lastName: role, role, password });
  if (invRes.status !== 201)
    throw new Error(`createTestUser invite (${role}) failed (${invRes.status}): ${JSON.stringify(invRes.body)}`);

  return { email: ue, password, orgSlug: slug };
}

/**
 * Login and return an authed supertest agent.
 */
async function loginAs({ email, password, orgSlug }) {
  const agent = request.agent(app);
  const loginRes = await agent.post('/api/v1/auth/login').send({ email, password, orgSlug });
  if (loginRes.status !== 200)
    throw new Error(`loginAs failed (${loginRes.status}): ${JSON.stringify(loginRes.body)}`);
  const token = loginRes.body.data?.accessToken || loginRes.body.accessToken;
  // Attach Authorization header to every subsequent request
  const _orig = agent.get.bind(agent);
  const methods = ['get', 'post', 'patch', 'put', 'delete'];
  for (const m of methods) {
    const orig = agent[m].bind(agent);
    agent[m] = (...args) => orig(...args).set('Authorization', `Bearer ${token}`);
  }
  return agent;
}

async function makeProject(agent, name, projectType = 'wastewater') {
  const res = await agent.post('/api/v1/projects').send({ name, projectType });
  if (![200, 201].includes(res.status))
    throw new Error(`makeProject failed (${res.status}): ${JSON.stringify(res.body)}`);
  return res.body.data || res.body;
}

async function makeFlowsheet(agent, projectId, name, canvasData = {}) {
  const res = await agent
    .post(`/api/v1/projects/${projectId}/flowsheets`)
    .send({ name, canvas_data: canvasData });
  if (![200, 201].includes(res.status))
    throw new Error(`makeFlowsheet failed (${res.status}): ${JSON.stringify(res.body)}`);
  return res.body.data || res.body;
}

module.exports = {
  request, app, TEST_ADMIN, registerAndLogin,
  createTestUser, loginAs, makeProject, makeFlowsheet,
};
