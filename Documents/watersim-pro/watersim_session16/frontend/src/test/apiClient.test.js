/**
 * Tests for the unified axios client's 401 → refresh → retry interceptor.
 *
 * The module keeps state (the shared refreshPromise), so each test gets a
 * fresh import via vi.resetModules(). Network I/O is faked by swapping the
 * instance's adapter.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

async function freshApi() {
  vi.resetModules();
  const mod = await import('../services/api.js');
  return mod.default;
}

const authHeader = (config) =>
  typeof config.headers?.get === 'function'
    ? config.headers.get('Authorization')
    : config.headers?.Authorization;

/** Adapter that 401s data endpoints until the token is 'fresh'. */
function makeAdapter(counters, { refreshFails = false, refreshDelayMs = 10 } = {}) {
  return async (config) => {
    const ok = (data) => ({ data, status: 200, statusText: 'OK', headers: {}, config });
    const fail = (status, data) => {
      const error = new Error(`Request failed with status code ${status}`);
      error.config = config;
      error.response = { status, data, config };
      throw error;
    };

    if (String(config.url).includes('/auth/refresh')) {
      counters.refresh += 1;
      await new Promise(r => setTimeout(r, refreshDelayMs));
      if (refreshFails) fail(401, { error: 'Refresh token expired' });
      return ok({ data: { accessToken: 'fresh' } });
    }

    counters.data += 1;
    if (authHeader(config) === 'Bearer fresh') return ok({ ok: true, url: config.url });
    return fail(401, { error: 'Unauthorized' });
  };
}

beforeEach(() => {
  localStorage.clear();
});

describe('services/api 401 interceptor', () => {
  it('attaches the localStorage access token to requests', async () => {
    const api = await freshApi();
    localStorage.setItem('accessToken', 'fresh');
    const counters = { refresh: 0, data: 0 };
    api.defaults.adapter = makeAdapter(counters);

    const res = await api.get('/reports');
    expect(res.data.ok).toBe(true);
    expect(counters.refresh).toBe(0);
    expect(counters.data).toBe(1);
  });

  it('on 401: refreshes once, stores the new token, and replays the request', async () => {
    const api = await freshApi();
    localStorage.setItem('accessToken', 'expired');
    const counters = { refresh: 0, data: 0 };
    api.defaults.adapter = makeAdapter(counters);

    const res = await api.get('/reports');

    expect(res.data.ok).toBe(true);
    expect(counters.refresh).toBe(1);
    expect(counters.data).toBe(2); // original + one replay
    expect(localStorage.getItem('accessToken')).toBe('fresh');
  });

  it('concurrent 401s share a single refresh', async () => {
    const api = await freshApi();
    localStorage.setItem('accessToken', 'expired');
    const counters = { refresh: 0, data: 0 };
    api.defaults.adapter = makeAdapter(counters, { refreshDelayMs: 25 });

    const [a, b, c] = await Promise.all([
      api.get('/reports'),
      api.get('/projects'),
      api.get('/permit-templates'),
    ]);

    expect(a.data.ok).toBe(true);
    expect(b.data.ok).toBe(true);
    expect(c.data.ok).toBe(true);
    expect(counters.refresh).toBe(1);       // one shared refresh
    expect(counters.data).toBe(6);          // 3 originals + 3 replays
  });

  it('replays each request at most once (no infinite retry loop)', async () => {
    const api = await freshApi();
    localStorage.setItem('accessToken', 'expired');
    const counters = { refresh: 0, data: 0 };
    // Refresh "succeeds" but hands back a token the API still rejects
    api.defaults.adapter = async (config) => {
      if (String(config.url).includes('/auth/refresh')) {
        counters.refresh += 1;
        return { data: { data: { accessToken: 'still-bad' } }, status: 200, statusText: 'OK', headers: {}, config };
      }
      counters.data += 1;
      const error = new Error('Request failed with status code 401');
      error.config = config;
      error.response = { status: 401, data: { error: 'Unauthorized' }, config };
      throw error;
    };

    await expect(api.get('/reports')).rejects.toMatchObject({ response: { status: 401 } });
    expect(counters.refresh).toBe(1);
    expect(counters.data).toBe(2); // original + exactly one replay, then give up
  });

  it('does not attempt a refresh for unauthenticated requests', async () => {
    const api = await freshApi();
    // No token in localStorage → request carries no Authorization header
    const counters = { refresh: 0, data: 0 };
    api.defaults.adapter = makeAdapter(counters);

    await expect(api.get('/reports')).rejects.toMatchObject({ response: { status: 401 } });
    expect(counters.refresh).toBe(0);
    expect(counters.data).toBe(1);
  });
});
