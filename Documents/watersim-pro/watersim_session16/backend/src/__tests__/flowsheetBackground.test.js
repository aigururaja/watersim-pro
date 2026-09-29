/**
 * P&ID picture endpoints — GET / PUT / DELETE
 * /api/v1/projects/:projectId/flowsheets/:id/background
 * (the AI read endpoint is covered in pidReader.test.js)
 */
const { request, app, registerAndLogin } = require('./helpers');

const SKIP = process.env.CI !== 'true' && !process.env.DATABASE_URL && !process.env.TEST_DATABASE_URL;

// A 1x1 transparent PNG.
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

describe('Flowsheet P&ID picture API', () => {
  if (SKIP) return it.skip('No DB — skipping P&ID picture tests');

  let token, url, otherToken;

  beforeAll(async () => {
    ({ token } = await registerAndLogin({
      orgSlug: `bg-test-${Date.now()}`,
      email:   `bg-${Date.now()}@test.example`,
    }));
    const project = await request(app).post('/api/v1/projects')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'P&ID Picture Test', projectType: 'combined' });
    const fs = await request(app).post(`/api/v1/projects/${project.body.id}/flowsheets`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'P&ID import' });
    url = `/api/v1/projects/${project.body.id}/flowsheets/${fs.body.id}/background`;

    ({ token: otherToken } = await registerAndLogin({
      orgSlug: `bg-other-${Date.now()}`,
      email:   `bg-other-${Date.now()}@test.example`,
    }));
  });

  it('returns 204 before anything is uploaded', async () => {
    const res = await request(app).get(url).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(204);
  });

  it('stores an uploaded picture and returns its metadata, not the image', async () => {
    const res = await request(app).put(url).set('Authorization', `Bearer ${token}`)
      .send({ imageData: PNG, width: 1, height: 1, fileName: 'pid.png',
              placement: { x: 10, y: 20, scale: 99, junk: 'x' } });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ fileName: 'pid.png', width: 1, height: 1 });
    expect(res.body.placement).toEqual({ x: 10, y: 20, scale: 20 });
    expect(res.body.imageData).toBeUndefined();

    const got = await request(app).get(url).set('Authorization', `Bearer ${token}`);
    expect(got.status).toBe(200);
    expect(got.body.fileName).toBe('pid.png');
    expect(got.body.imageData).toBeUndefined();
  });

  it('requires the image and its size on every upload', async () => {
    const res = await request(app).put(url).set('Authorization', `Bearer ${token}`)
      .send({ placement: { x: 0, y: 0, scale: 1 } });
    expect(res.status).toBe(422);
  });

  it('rejects anything that is not a PNG, JPEG or WebP data URL', async () => {
    const res = await request(app).put(url).set('Authorization', `Bearer ${token}`)
      .send({ imageData: 'data:text/html;base64,PGgxPmhpPC9oMT4=', width: 1, height: 1 });
    expect(res.status).toBe(422);
  });

  it('hides the picture from another organisation', async () => {
    const res = await request(app).get(url).set('Authorization', `Bearer ${otherToken}`);
    expect(res.status).toBe(404);
  });

  it('removes the picture', async () => {
    const del = await request(app).delete(url).set('Authorization', `Bearer ${token}`);
    expect(del.status).toBe(204);
    const got = await request(app).get(url).set('Authorization', `Bearer ${token}`);
    expect(got.status).toBe(204);
  });
});
