/**
 * Role dashboards: one endpoint, a different home screen per login.
 *
 * Real database. What is pinned: every role gets exactly its own sections, in
 * order; a task assigned to a role lands on that role's desk and nobody
 * else's; a manager sees approvals and the team, an admin the audit trail and
 * system health; a viewer gets the plant and nothing to act on; nothing
 * leaks across organisations.
 */
'use strict';

const { createTestUser, loginAs } = require('./helpers');
const { SECTIONS } = require('../routes/dashboard');

const PW = 'Dashboard123!';
const agents = {};
let orgSlug;

async function invite(admin, role) {
  const email = `dash.${role}.${Date.now()}@test.example`;
  const r = await admin.post('/api/v1/admin/members').send({ email, firstName: 'Dash', lastName: role, role, password: PW });
  if (r.status !== 201) throw new Error(`invite ${role}: ${r.status} ${JSON.stringify(r.body)}`);
  return loginAs({ email, password: PW, orgSlug });
}

beforeAll(async () => {
  const a = await createTestUser('dash.admin@test.example', PW, 'admin');
  orgSlug = a.orgSlug;
  agents.admin = await loginAs(a);
  for (const role of ['viewer', 'operator', 'engineer', 'manager']) agents[role] = await invite(agents.admin, role);

  const t1 = await agents.admin.post('/api/v1/tasks').send({ title: 'Grease the reactor feed pump', assignedRole: 'engineer', priority: 'high' });
  expect(t1.status).toBe(201);
  const t2 = await agents.admin.post('/api/v1/tasks').send({ title: 'Hose down the fine screen', assignedRole: 'operator', priority: 'medium' });
  expect(t2.status).toBe(201);
});

describe('GET /api/v1/dashboard', () => {
  test('every role gets its own sections, in order, with the plant summary', async () => {
    for (const role of Object.keys(SECTIONS)) {
      const r = await agents[role].get('/api/v1/dashboard');
      expect(r.status).toBe(200);
      expect(r.body.role).toBe(role);
      expect(r.body.sections).toEqual(SECTIONS[role]);
      expect(r.body.plant).toMatchObject({ bindings: expect.any(Object), drives: expect.any(Object), alarms: expect.any(Object) });
      for (const s of SECTIONS[role]) expect(r.body[s]).toBeDefined();
      const foreign = Object.values(SECTIONS).flat().filter((s) => !SECTIONS[role].includes(s));
      for (const s of foreign) expect(r.body[s]).toBeUndefined();
    }
  });

  test('a task assigned to a role lands on that role\'s desk and nobody else\'s', async () => {
    const eng = (await agents.engineer.get('/api/v1/dashboard')).body;
    expect(eng.myTasks.items.map((t) => t.title)).toContain('Grease the reactor feed pump');
    expect(eng.myTasks.items.map((t) => t.title)).not.toContain('Hose down the fine screen');
    expect(eng.myTasks.total).toBe(1); // auto-assigned to the only engineer, so it is theirs outright
    const op = (await agents.operator.get('/api/v1/dashboard')).body;
    expect(op.myTasks.items.map((t) => t.title)).toEqual(['Hose down the fine screen']);
    expect(op.equipment).toMatchObject({ tripped: [], total: 0 });
    const viewer = (await agents.viewer.get('/api/v1/dashboard')).body;
    expect(viewer.myTasks).toBeUndefined();
    expect(viewer.readings.items).toEqual([]);
  });

  test('a manager sees approvals, alarm load and the team; an admin the audit trail and system health', async () => {
    const m = (await agents.manager.get('/api/v1/dashboard')).body;
    expect(m.approvals.counts).toMatchObject({ awaiting: 0, open: 2 });
    expect(m.alarms.last24h).toMatchObject({ critical: 0, warning: 0 });
    expect(m.team.byRole).toMatchObject({ engineer: { total: 1, active: 1 }, operator: { total: 1, active: 1 } });
    expect(m.team.total).toBe(5);
    const a = (await agents.admin.get('/api/v1/dashboard')).body;
    expect(Array.isArray(a.audit.items)).toBe(true);
    expect(a.audit.items.length).toBeGreaterThan(0);
    expect(a.audit.items[0]).toMatchObject({ action: expect.any(String), at: expect.any(String) });
    expect(a.system.uptimeS).toBeGreaterThanOrEqual(0);
    expect(a.integrations.apiKeys).toMatchObject({ active: 0, total: 0 });
    expect(a.notifications.last24h).toMatchObject({ dead: 0 });
    expect(a.twin.items).toEqual([]);
  });

  test('nothing leaks across organisations, and an anonymous call is refused', async () => {
    const other = await loginAs(await createTestUser('dash.other@test.example', PW, 'admin'));
    const o = (await other.get('/api/v1/dashboard')).body;
    expect(o.team.total).toBe(1);
    expect(o.approvals.counts.open).toBe(0);
    const { request, app } = require('./helpers');
    expect((await request(app).get('/api/v1/dashboard')).status).toBe(401);
  });
});
