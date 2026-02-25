/**
 * Auth endpoint tests
 * These tests use supertest against the Express app.
 * They require a running PostgreSQL database (TEST_DATABASE_URL or DATABASE_URL).
 * If no DB is available, the suite is skipped gracefully.
 */
const { request, app, registerAndLogin } = require('./helpers');

const SKIP = process.env.CI !== 'true' && !process.env.DATABASE_URL && !process.env.TEST_DATABASE_URL;

// Unique slugs to avoid collisions when tests are re-run
const slug = `auth-test-${Date.now()}`;
const email = `user-${Date.now()}@auth.test`;

const VALID_REGISTER = {
  orgName:   'Auth Test Org',
  orgSlug:   slug,
  email,
  password:  'SecurePass1!',
  firstName: 'Jane',
  lastName:  'Doe',
};

describe('POST /api/v1/auth/register', () => {
  if (SKIP) return it.skip('No DB — skipping auth tests');

  it('creates a new organisation and admin user', async () => {
    const res = await request(app).post('/api/v1/auth/register').send(VALID_REGISTER);
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.organisation.slug).toBe(slug);
    expect(res.body.data.user.role).toBe('admin');
  });

  it('rejects duplicate org slug', async () => {
    const res = await request(app).post('/api/v1/auth/register').send(VALID_REGISTER);
    expect(res.status).toBe(409);
  });

  it('returns 422 for missing required fields', async () => {
    const res = await request(app).post('/api/v1/auth/register').send({ email });
    expect(res.status).toBe(422);
  });

  it('rejects a weak password', async () => {
    const res = await request(app).post('/api/v1/auth/register')
      .send({ ...VALID_REGISTER, orgSlug: `weak-${Date.now()}`, email: `weak-${Date.now()}@x.test`, password: '123' });
    expect(res.status).toBe(422);
  });
});

describe('POST /api/v1/auth/login', () => {
  if (SKIP) return it.skip('No DB — skipping auth tests');

  it('returns access token on valid credentials', async () => {
    const res = await request(app).post('/api/v1/auth/login').send({
      email:    VALID_REGISTER.email,
      password: VALID_REGISTER.password,
      orgSlug:  VALID_REGISTER.orgSlug,
    });
    expect(res.status).toBe(200);
    expect(res.body.data.accessToken).toBeTruthy();
    expect(res.body.data.user.email).toBe(email);
  });

  it('rejects wrong password', async () => {
    const res = await request(app).post('/api/v1/auth/login').send({
      email:    VALID_REGISTER.email,
      password: 'WrongPassword99!',
      orgSlug:  VALID_REGISTER.orgSlug,
    });
    expect(res.status).toBe(401);
  });

  it('rejects wrong org slug', async () => {
    const res = await request(app).post('/api/v1/auth/login').send({
      email:    VALID_REGISTER.email,
      password: VALID_REGISTER.password,
      orgSlug:  'nonexistent-org',
    });
    expect(res.status).toBe(401);
  });

  it('rejects missing fields', async () => {
    const res = await request(app).post('/api/v1/auth/login').send({ email });
    expect(res.status).toBe(422);
  });
});

describe('GET /api/v1/auth/me', () => {
  if (SKIP) return it.skip('No DB — skipping auth tests');

  let token;
  beforeAll(async () => {
    ({ token } = await registerAndLogin({
      orgSlug: `me-test-${Date.now()}`,
      email:   `me-${Date.now()}@auth.test`,
    }));
  });

  it('returns current user when authenticated', async () => {
    const res = await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.user.role).toBe('admin');
  });

  it('returns 401 without token', async () => {
    const res = await request(app).get('/api/v1/auth/me');
    expect(res.status).toBe(401);
  });

  it('returns 401 with invalid token', async () => {
    const res = await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', 'Bearer this.is.invalid');
    expect(res.status).toBe(401);
  });
});

describe('POST /api/v1/auth/logout', () => {
  if (SKIP) return it.skip('No DB — skipping auth tests');

  it('returns 200 on logout', async () => {
    const { token } = await registerAndLogin({
      orgSlug: `logout-${Date.now()}`,
      email:   `logout-${Date.now()}@auth.test`,
    });
    const res = await request(app)
      .post('/api/v1/auth/logout')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
  });
});
