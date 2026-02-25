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
