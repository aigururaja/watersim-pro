/**
 * WaterSim Pro — Reliability & observability hardening tests (Session 16)
 *
 * Covers:
 *  - flowsheet PATCH optimistic concurrency (expectedVersion → 409 / 200)
 *  - permit template activation invariant (exactly one active per org)
 *  - flowsheet size bounds (201 nodes → 422 before running)
 *  - composite keyset cursor pagination (no drops / no dupes on tied completed_at)
 *  - /health/live liveness endpoint (no DB)
 *  - /metrics Prometheus exposition
 *  - simulate response carries quality.converged
 */

'use strict';

const { request, app, createTestUser, loginAs, makeProject, makeFlowsheet } = require('./helpers');
const { pool } = require('../db/pool');

// Minimal valid canvas for simulation
const LINEAR_CANVAS = {
  nodes: [
    { id: 'n_in',  type: 'unitOp', data: { opType: 'inlet',            params: {} } },
    { id: 'n_as',  type: 'unitOp', data: { opType: 'activated_sludge', params: {} } },
    { id: 'n_out', type: 'unitOp', data: { opType: 'outlet',           params: {} } },
  ],
  edges: [
    { id: 'e1', source: 'n_in', target: 'n_as',  data: { streamType: 'stream' } },
    { id: 'e2', source: 'n_as', target: 'n_out', data: { streamType: 'stream' } },
  ],
};

afterAll(async () => {
  await pool.end().catch(() => {});
});

// ── Liveness / metrics (no DB, no auth) ─────────────────────────────────────

describe('GET /health/live', () => {
  it('returns 200 without touching the database', async () => {
    const res = await request(app).get('/health/live');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('alive');
    expect(typeof res.body.uptime).toBe('number');
  });
});

describe('GET /metrics', () => {
  it('returns Prometheus text exposition', async () => {
    const res = await request(app).get('/metrics');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/plain/);
    expect(res.text).toContain('process_cpu_user_seconds_total');
    expect(res.text).toContain('http_request_duration_seconds');
    expect(res.text).toContain('simulation_duration_seconds');
  });
});

describe('Request id', () => {
  it('echoes inbound X-Request-Id and generates one otherwise', async () => {
    const res1 = await request(app).get('/health/live').set('X-Request-Id', 'test-req-123');
    expect(res1.headers['x-request-id']).toBe('test-req-123');
    const res2 = await request(app).get('/health/live');
    expect(res2.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });
});

// ── Flowsheet PATCH optimistic concurrency ──────────────────────────────────

describe('Flowsheet PATCH — optimistic concurrency', () => {
  let agent, projectId, flowsheetId, version;

  beforeAll(async () => {
    const user = await createTestUser('occ@test.example', 'OccPass123!', 'admin');
    agent = await loginAs(user);
    const project = await makeProject(agent, 'OCC Project');
    projectId = project.id;
    const fs = await makeFlowsheet(agent, projectId, 'OCC Flowsheet');
    flowsheetId = fs.id;
    version = fs.version; // 1 on create
  });

  const url = () => `/api/v1/projects/${projectId}/flowsheets/${flowsheetId}`;

  it('rejects a stale expectedVersion with 409 and the current version', async () => {
    const res = await agent.patch(url()).send({ name: 'Stale write', expectedVersion: version + 999 });
    expect(res.status).toBe(409);
    expect(res.body.currentVersion).toBe(version);
    expect(res.body.error).toMatch(/conflict/i);
  });

  it('accepts the right expectedVersion with 200', async () => {
    const res = await agent.patch(url()).send({ name: 'Fresh write', expectedVersion: version });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Fresh write');
  });

  it('bumps version on canvas save and then rejects the old version', async () => {
    const res = await agent.patch(url()).send({ canvasData: LINEAR_CANVAS, expectedVersion: version });
    expect(res.status).toBe(200);
    expect(res.body.version).toBe(version + 1);

    const stale = await agent.patch(url()).send({ canvasData: LINEAR_CANVAS, expectedVersion: version });
    expect(stale.status).toBe(409);
    expect(stale.body.currentVersion).toBe(version + 1);
  });

  it('still allows last-write-wins when expectedVersion is omitted', async () => {
    const res = await agent.patch(url()).send({ name: 'No version guard' });
    expect(res.status).toBe(200);
  });
});

// ── Permit template activation invariant ────────────────────────────────────

describe('Permit template activation — exactly one active per org', () => {
  let agent;

  beforeAll(async () => {
    const user = await createTestUser('permit@test.example', 'PermitPass1!', 'admin');
    agent = await loginAs(user);
  });

  const makeTemplate = async (name, isActive = false) => {
    const res = await agent.post('/api/v1/permit-templates').send({
      name, permit_limits: { BOD: 30, TSS: 30 }, is_active: isActive,
    });
    expect(res.status).toBe(201);
    return res.body;
  };

  const activeCount = async () => {
    const res = await agent.get('/api/v1/permit-templates');
    expect(res.status).toBe(200);
    return res.body.filter(t => t.is_active).length;
  };

  it('activation leaves exactly one active template', async () => {
    const a = await makeTemplate('Template A', true);
    const b = await makeTemplate('Template B');
    const c = await makeTemplate('Template C');

    expect(await activeCount()).toBe(1);

    const act = await agent.post(`/api/v1/permit-templates/${b.id}/activate`).send({});
    expect(act.status).toBe(200);
    expect(act.body.is_active).toBe(true);
    expect(await activeCount()).toBe(1);

    // Concurrent activations of two different templates: whatever wins,
    // the unique partial index guarantees at most one active row survives.
    const [r1, r2] = await Promise.all([
      agent.post(`/api/v1/permit-templates/${a.id}/activate`).send({}),
      agent.post(`/api/v1/permit-templates/${c.id}/activate`).send({}),
    ]);
    expect([200, 409]).toContain(r1.status);
    expect([200, 409]).toContain(r2.status);
    expect(await activeCount()).toBe(1);
  });
});

// ── Oversized flowsheet rejection ───────────────────────────────────────────

describe('Simulation input bounds', () => {
  let agent, projectId, flowsheetId;

  beforeAll(async () => {
    const user = await createTestUser('bounds@test.example', 'BoundsPass1!', 'admin');
    agent = await loginAs(user);
    const project = await makeProject(agent, 'Bounds Project');
    projectId = project.id;
    const fs = await makeFlowsheet(agent, projectId, 'Huge Flowsheet');
    flowsheetId = fs.id;

    // 201 nodes (> 200 limit)
    const bigCanvas = {
      nodes: Array.from({ length: 201 }, (_, i) => ({
        id: `n${i}`, type: 'unitOp', data: { opType: 'inlet', params: {} },
      })),
      edges: [],
    };
    const patch = await agent
      .patch(`/api/v1/projects/${projectId}/flowsheets/${flowsheetId}`)
      .send({ canvasData: bigCanvas });
    expect(patch.status).toBe(200);
  });

  it('rejects a 201-node flowsheet with 422 before running', async () => {
    const res = await agent
      .post(`/api/v1/projects/${projectId}/flowsheets/${flowsheetId}/simulate`)
      .send({ mode: 'steady_state' });
    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/too large/i);
  });
});

// ── Simulate response quality flags ─────────────────────────────────────────

describe('Simulate response carries quality flags', () => {
  let agent, projectId, flowsheetId;

  beforeAll(async () => {
    const user = await createTestUser('quality@test.example', 'QualityPass1!', 'admin');
    agent = await loginAs(user);
    const project = await makeProject(agent, 'Quality Project');
    projectId = project.id;
    const fs = await makeFlowsheet(agent, projectId, 'Quality Flowsheet');
    flowsheetId = fs.id;
    await agent
      .patch(`/api/v1/projects/${projectId}/flowsheets/${flowsheetId}`)
      .send({ canvasData: LINEAR_CANVAS });
  });

  it('POST /simulate returns top-level quality with converged flag', async () => {
    const res = await agent
      .post(`/api/v1/projects/${projectId}/flowsheets/${flowsheetId}/simulate`)
      .send({
        mode: 'steady_state',
        nodeParams: { n_in: { Q: 10000, BOD: 250, COD: 450, TSS: 200, TN: 45, NH4: 35, TP: 8 } },
      });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('completed');
    expect(res.body.quality).toBeDefined();
    expect(typeof res.body.quality.converged).toBe('boolean');
    expect(res.body.quality.converged).toBe(true);
    expect(res.body.quality.degraded).toBe(false);
    expect(res.body.quality.iterations).toBeGreaterThanOrEqual(1);

    // Flags are also persisted with the run's results
    const run = await agent
      .get(`/api/v1/projects/${projectId}/flowsheets/${flowsheetId}/simulate/${res.body.run_id}`);
    expect(run.status).toBe(200);
    expect(run.body.results.converged).toBe(true);
    expect(run.body.results.degraded).toBe(false);
  });
});

// ── Composite keyset cursor pagination ──────────────────────────────────────

describe('GET /api/v1/reports — composite cursor pagination', () => {
  let agent, flowsheetId, userId;
  const insertedIds = [];

  beforeAll(async () => {
    const user = await createTestUser('cursor@test.example', 'CursorPass1!', 'admin');
    agent = await loginAs(user);
    const project = await makeProject(agent, 'Cursor Project');
    const fs = await makeFlowsheet(agent, project.id, 'Cursor Flowsheet');
    flowsheetId = fs.id;

    const owner = await pool.query('SELECT created_by FROM flowsheets WHERE id = $1', [flowsheetId]);
    userId = owner.rows[0].created_by;

    // 5 runs tied on the SAME completed_at + 2 runs at distinct times = 7 rows.
    const tiedTs = new Date('2026-01-15T12:00:00.000Z').toISOString();
    for (let i = 0; i < 5; i++) {
      const r = await pool.query(
        `INSERT INTO simulation_runs
           (flowsheet_id, created_by, mode, status, config, results, started_at, completed_at)
         VALUES ($1, $2, 'steady_state', 'completed', '{}', '{"summary":{}}', $3, $3)
         RETURNING id`,
        [flowsheetId, userId, tiedTs]
      );
      insertedIds.push(r.rows[0].id);
    }
    for (const ts of ['2026-01-16T09:00:00.000Z', '2026-01-14T09:00:00.000Z']) {
      const r = await pool.query(
        `INSERT INTO simulation_runs
           (flowsheet_id, created_by, mode, status, config, results, started_at, completed_at)
         VALUES ($1, $2, 'steady_state', 'completed', '{}', '{"summary":{}}', $3, $3)
         RETURNING id`,
        [flowsheetId, userId, ts]
      );
      insertedIds.push(r.rows[0].id);
    }
  });

  it('pages through tied completed_at rows without drops or duplicates', async () => {
    const seen = [];
    let cursor = null;
    let pages = 0;

    do {
      const q = cursor ? `?limit=2&cursor=${encodeURIComponent(cursor)}` : '?limit=2';
      const res = await agent.get(`/api/v1/reports${q}`);
      expect(res.status).toBe(200);
      expect(res.body.total).toBe(insertedIds.length);
      for (const run of res.body.runs) seen.push(run.id);
      cursor = res.body.nextCursor;
      pages += 1;
      expect(pages).toBeLessThan(20); // safety against a cursor loop
    } while (cursor);

    // No duplicates
    expect(new Set(seen).size).toBe(seen.length);
    // No drops — every inserted run appears exactly once
    expect(seen.length).toBe(insertedIds.length);
    expect([...seen].sort()).toEqual([...insertedIds].sort());
  });

  it('rejects a garbage cursor with 422', async () => {
    const res = await agent.get('/api/v1/reports?cursor=zzz-not-a-cursor');
    expect(res.status).toBe(422);
  });

  it('still accepts a legacy plain-ISO cursor', async () => {
    const res = await agent.get(`/api/v1/reports?cursor=${encodeURIComponent('2026-01-15T00:00:00.000Z')}`);
    expect(res.status).toBe(200);
    // Only the run completed before that instant qualifies
    expect(res.body.runs.length).toBe(1);
  });
});
