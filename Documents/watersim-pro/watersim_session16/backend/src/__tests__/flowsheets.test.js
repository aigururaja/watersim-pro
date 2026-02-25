/**
 * Flowsheets CRUD endpoint tests
 */
const { request, app, registerAndLogin } = require('./helpers');

const SKIP = process.env.CI !== 'true' && !process.env.DATABASE_URL && !process.env.TEST_DATABASE_URL;

describe('Flowsheets API', () => {
  if (SKIP) return it.skip('No DB — skipping flowsheet tests');

  let token;
  let projectId;

  beforeAll(async () => {
    ({ token } = await registerAndLogin({
      orgSlug: `fs-test-${Date.now()}`,
      email:   `fs-${Date.now()}@test.example`,
    }));

    // Create a project to hang flowsheets from
    const res = await request(app)
      .post('/api/v1/projects')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Flowsheet Test Project', projectType: 'wastewater' });
    projectId = res.body.id;
  });

  describe('GET /api/v1/projects/:projectId/flowsheets', () => {
    it('returns empty array for new project', async () => {
      const res = await request(app)
        .get(`/api/v1/projects/${projectId}/flowsheets`)
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });
  });

  describe('POST /api/v1/projects/:projectId/flowsheets', () => {
    it('creates a flowsheet', async () => {
      const res = await request(app)
        .post(`/api/v1/projects/${projectId}/flowsheets`)
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Train A', description: 'Primary treatment' });
      expect(res.status).toBe(201);
      expect(res.body.name).toBe('Train A');
      expect(res.body.version).toBe(1);
      expect(res.body.is_snapshot).toBe(false);
      expect(res.body.canvas_data).toBeDefined();
    });

    it('rejects missing name', async () => {
      const res = await request(app)
        .post(`/api/v1/projects/${projectId}/flowsheets`)
        .set('Authorization', `Bearer ${token}`)
        .send({ description: 'No name' });
      expect(res.status).toBe(422);
    });

    it('returns 404 for nonexistent project', async () => {
      const res = await request(app)
        .post('/api/v1/projects/00000000-0000-0000-0000-000000000000/flowsheets')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Ghost', projectType: 'wastewater' });
      expect(res.status).toBe(404);
    });
  });

  describe('GET /api/v1/projects/:projectId/flowsheets/:id', () => {
    let flowsheetId;
    beforeAll(async () => {
      const res = await request(app)
        .post(`/api/v1/projects/${projectId}/flowsheets`)
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Fetch Me' });
      flowsheetId = res.body.id;
    });

    it('returns flowsheet by id', async () => {
      const res = await request(app)
        .get(`/api/v1/projects/${projectId}/flowsheets/${flowsheetId}`)
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body.id).toBe(flowsheetId);
      expect(res.body.canvas_data).toBeDefined();
    });

    it('returns 404 for unknown id', async () => {
      const res = await request(app)
        .get(`/api/v1/projects/${projectId}/flowsheets/00000000-0000-0000-0000-000000000000`)
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(404);
    });
  });

  describe('PATCH /api/v1/projects/:projectId/flowsheets/:id', () => {
    let flowsheetId;
    beforeAll(async () => {
      const res = await request(app)
        .post(`/api/v1/projects/${projectId}/flowsheets`)
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Patch Me' });
      flowsheetId = res.body.id;
    });

    it('saves canvas data and bumps version', async () => {
      const canvasData = {
        nodes: [{ id: 'n1', type: 'unitOp', position: { x: 0, y: 0 }, data: { label: 'Pump' } }],
        edges: [],
        viewport: { x: 0, y: 0, zoom: 1 },
      };
      const res = await request(app)
        .patch(`/api/v1/projects/${projectId}/flowsheets/${flowsheetId}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ canvasData });
      expect(res.status).toBe(200);
      expect(res.body.version).toBe(2); // bumped from 1
      expect(res.body.canvas_data.nodes).toHaveLength(1);
    });

    it('renames flowsheet without bumping version', async () => {
      const before = await request(app)
        .get(`/api/v1/projects/${projectId}/flowsheets/${flowsheetId}`)
        .set('Authorization', `Bearer ${token}`);
      const vBefore = before.body.version;

      const res = await request(app)
        .patch(`/api/v1/projects/${projectId}/flowsheets/${flowsheetId}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Renamed Flowsheet' });
      expect(res.status).toBe(200);
      expect(res.body.name).toBe('Renamed Flowsheet');
      expect(res.body.version).toBe(vBefore); // no bump
    });
  });

  describe('POST /api/v1/projects/:projectId/flowsheets/:id/snapshot', () => {
    let flowsheetId;
    beforeAll(async () => {
      const res = await request(app)
        .post(`/api/v1/projects/${projectId}/flowsheets`)
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Snapshot Source' });
      flowsheetId = res.body.id;
    });

    it('creates a snapshot', async () => {
      const res = await request(app)
        .post(`/api/v1/projects/${projectId}/flowsheets/${flowsheetId}/snapshot`)
        .set('Authorization', `Bearer ${token}`)
        .send({ tag: 'v1.0' });
      expect(res.status).toBe(201);
      expect(res.body.is_snapshot).toBe(true);
      expect(res.body.snapshot_tag).toBe('v1.0');
    });

    it('rejects duplicate snapshot tag', async () => {
      const res = await request(app)
        .post(`/api/v1/projects/${projectId}/flowsheets/${flowsheetId}/snapshot`)
        .set('Authorization', `Bearer ${token}`)
        .send({ tag: 'v1.0' });
      expect(res.status).toBe(409);
    });
  });

  describe('DELETE /api/v1/projects/:projectId/flowsheets/:id', () => {
    it('deletes a flowsheet', async () => {
      const create = await request(app)
        .post(`/api/v1/projects/${projectId}/flowsheets`)
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Delete Me' });
      const id = create.body.id;

      const del = await request(app)
        .delete(`/api/v1/projects/${projectId}/flowsheets/${id}`)
        .set('Authorization', `Bearer ${token}`);
      expect(del.status).toBe(200);

      const get = await request(app)
        .get(`/api/v1/projects/${projectId}/flowsheets/${id}`)
        .set('Authorization', `Bearer ${token}`);
      expect(get.status).toBe(404);
    });
  });
});
