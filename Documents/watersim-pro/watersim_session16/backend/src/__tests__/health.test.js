/**
 * Health endpoint — no DB required, always runs.
 */
const { request, app } = require('./helpers');

describe('GET /health', () => {
  it('returns status json', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBeGreaterThanOrEqual(200);
    expect(res.body).toHaveProperty('status');
  });
});

describe('404 handler', () => {
  it('returns 404 for unknown routes', async () => {
    const res = await request(app).get('/api/v1/nonexistent-route-xyz');
    expect(res.status).toBe(404);
    expect(res.body.error).toBeTruthy();
  });
});
