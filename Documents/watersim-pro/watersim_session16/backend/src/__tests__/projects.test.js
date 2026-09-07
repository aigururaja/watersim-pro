/**
 * Projects CRUD endpoint tests
 */
const { request, app, registerAndLogin } = require('./helpers');

const SKIP = process.env.CI !== 'true' && !process.env.DATABASE_URL && !process.env.TEST_DATABASE_URL;

describe('Projects API', () => {
  if (SKIP) return it.skip('No DB — skipping project tests');

  let token;

  beforeAll(async () => {
    ({ token } = await registerAndLogin({
      orgSlug: `proj-test-${Date.now()}`,
      email:   `proj-${Date.now()}@test.example`,
    }));
  });

  describe('GET /api/v1/projects', () => {
    it('returns empty array for new org', async () => {
      const res = await request(app)
        .get('/api/v1/projects')
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });

    it('returns 401 without auth', async () => {
      const res = await request(app).get('/api/v1/projects');
      expect(res.status).toBe(401);
    });
  });

  describe('POST /api/v1/projects', () => {
    it('creates a project', async () => {
      const res = await request(app)
        .post('/api/v1/projects')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'WWTP Alpha', projectType: 'wastewater', description: 'Test plant' });
      expect(res.status).toBe(201);
      expect(res.body.name).toBe('WWTP Alpha');
      expect(res.body.project_type).toBe('wastewater');
      expect(res.body.status).toBe('active');
    });

    it('rejects missing name', async () => {
      const res = await request(app)
        .post('/api/v1/projects')
        .set('Authorization', `Bearer ${token}`)
        .send({ projectType: 'wastewater' });
      expect(res.status).toBe(422);
    });

    it('rejects invalid projectType', async () => {
      const res = await request(app)
        .post('/api/v1/projects')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Bad Type', projectType: 'nuclear_plant' });
      expect(res.status).toBe(422);
    });
  });

  describe('GET /api/v1/projects/:id', () => {
    let projectId;
    beforeAll(async () => {
      const res = await request(app)
        .post('/api/v1/projects')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Get Test Project', projectType: 'combined' });
      projectId = res.body.id;
    });

    it('returns project by id', async () => {
      const res = await request(app)
        .get(`/api/v1/projects/${projectId}`)
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body.id).toBe(projectId);
    });

    it('returns 404 for unknown id', async () => {
      const res = await request(app)
        .get('/api/v1/projects/00000000-0000-0000-0000-000000000000')
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(404);
    });
  });

  describe('PATCH /api/v1/projects/:id', () => {
    let projectId;
    beforeAll(async () => {
      const res = await request(app)
        .post('/api/v1/projects')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Patch Me', projectType: 'wastewater' });
      projectId = res.body.id;
    });

    it('updates project name', async () => {
      const res = await request(app)
        .patch(`/api/v1/projects/${projectId}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Updated Name' });
      expect(res.status).toBe(200);
      expect(res.body.name).toBe('Updated Name');
    });

    it('archives a project', async () => {
      const res = await request(app)
        .patch(`/api/v1/projects/${projectId}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ status: 'archived' });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('archived');
    });

    it('returns 422 when no fields provided', async () => {
      const res = await request(app)
        .patch(`/api/v1/projects/${projectId}`)
        .set('Authorization', `Bearer ${token}`)
        .send({});
      expect(res.status).toBe(422);
    });
  });

  describe('DELETE /api/v1/projects/:id', () => {
    it('soft-deletes a project', async () => {
      const create = await request(app)
        .post('/api/v1/projects')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Delete Me', projectType: 'wastewater' });
      const id = create.body.id;

      const del = await request(app)
        .delete(`/api/v1/projects/${id}`)
        .set('Authorization', `Bearer ${token}`);
      expect(del.status).toBe(200);

      // Should now return 404
      const get = await request(app)
        .get(`/api/v1/projects/${id}`)
        .set('Authorization', `Bearer ${token}`);
      expect(get.status).toBe(404);
    });
  });
});

/**
 * Monitoring projects and twin projects are different things: the plant as
 * wired lives in Operations, the model beside it in the Digital Twin, and a
 * twin can be IMPORTED from a monitoring project — the flowsheets copied and
 * each linked to the live one it came from, so the twin reads the plant's
 * measurements through the link.
 */
describe('Monitoring and twin projects', () => {
  if (SKIP) return it.skip('No DB — skipping project kind tests');

  let token;
  const auth = (r) => r.set('Authorization', `Bearer ${token}`);

  beforeAll(async () => {
    ({ token } = await registerAndLogin({
      orgSlug: `kind-test-${Date.now()}`,
      email:   `kind-${Date.now()}@test.example`,
    }));
  });

  it('a project is a twin unless created as monitoring, and the list filters by kind', async () => {
    const plant = await auth(request(app).post('/api/v1/projects')).send({ name: 'Plant', projectType: 'wastewater', kind: 'monitoring' });
    expect(plant.status).toBe(201);
    expect(plant.body.kind).toBe('monitoring');
    const study = await auth(request(app).post('/api/v1/projects')).send({ name: 'Study', projectType: 'wastewater' });
    expect(study.body.kind).toBe('twin');
    expect((await auth(request(app).post('/api/v1/projects')).send({ name: 'Bad', projectType: 'wastewater', kind: 'nonsense' })).status).toBe(422);

    const mon = await auth(request(app).get('/api/v1/projects?kind=monitoring'));
    expect(mon.body.map((p) => p.name)).toEqual(['Plant']);
    const tw = await auth(request(app).get('/api/v1/projects?kind=twin'));
    expect(tw.body.map((p) => p.name)).toEqual(['Study']);
    expect((await auth(request(app).get('/api/v1/projects'))).body).toHaveLength(2);
    expect((await auth(request(app).get('/api/v1/projects?kind=other'))).status).toBe(422);
  });

  it('imports a monitoring project into the twin: flowsheets copied, linked to their live source, listed under Twin', async () => {
    const plant = (await auth(request(app).post('/api/v1/projects')).send({ name: 'ITC plant', projectType: 'wastewater', kind: 'monitoring', description: 'as built' })).body;
    const fs = (await auth(request(app).post(`/api/v1/projects/${plant.id}/flowsheets`)).send({ name: 'Full plant' })).body;
    const canvas = { nodes: [{ id: 'p1', type: 'unitOp', position: { x: 0, y: 0 }, data: { opType: 'pump', label: 'Pump', params: { running: 1 } } }], edges: [], viewport: {} };
    expect((await auth(request(app).patch(`/api/v1/projects/${plant.id}/flowsheets/${fs.id}`)).send({ canvasData: canvas })).status).toBe(200);

    const imp = await auth(request(app).post(`/api/v1/projects/${plant.id}/import-to-twin`)).send({});
    expect(imp.status).toBe(201);
    expect(imp.body.kind).toBe('twin');
    expect(imp.body.source_project_id).toBe(plant.id);
    expect(imp.body.name).toBe('ITC plant — twin');
    expect(imp.body.flowsheets).toHaveLength(1);
    expect(imp.body.flowsheets[0].source_flowsheet_id).toBe(fs.id);
    const copy = (await auth(request(app).get(`/api/v1/projects/${imp.body.id}/flowsheets/${imp.body.flowsheets[0].id}`))).body;
    expect(copy.canvas_data.nodes).toHaveLength(1);
    expect(copy.canvas_data.nodes[0].data.params.running).toBe(1);

    // A twin cannot be imported again; only a monitoring project can.
    expect((await auth(request(app).post(`/api/v1/projects/${imp.body.id}/import-to-twin`)).send({})).status).toBe(422);

    // The Digital Twin lists the imported flowsheet, never the plant's own.
    const twins = (await auth(request(app).get('/api/v1/twin'))).body.twins;
    const ids = twins.map((t) => t.flowsheetId);
    expect(ids).toContain(imp.body.flowsheets[0].id);
    expect(ids).not.toContain(fs.id);
    expect(twins.find((t) => t.flowsheetId === imp.body.flowsheets[0].id).sourceFlowsheetId).toBe(fs.id);

    // The list says where a twin came from, and the twin loop reads
    // measurements through the source flowsheet.
    const tw = (await auth(request(app).get('/api/v1/projects?kind=twin'))).body;
    expect(tw.find((p) => p.id === imp.body.id).source_project_name).toBe('ITC plant');
    const twin = require('../twin');
    expect(await twin.liveFlowsheetId(imp.body.flowsheets[0].id)).toBe(fs.id);
    expect(await twin.liveFlowsheetId(fs.id)).toBe(fs.id);
  });
});
