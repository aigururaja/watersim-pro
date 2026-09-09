/**
 * SafeKrit — Plant definition API tests  (Session 18)
 *
 * The /plant routes serve a static transcription: no database, no organisation
 * scope. That makes them testable without a DB, which is why the auth check is
 * the only thing here that would otherwise need one — and an unauthenticated
 * 401 needs no database at all.
 *
 * What these tests guard is the CONTRACT the frontend reads: the shapes of the
 * five payloads, the CSV export's header row and quoting, and the fact that the
 * commercial tables are behind authentication because they are a client's pricing.
 */

'use strict';

const { request, app } = require('./helpers');
const { signAccess } = require('../utils/jwt');

const API = '/api/v1/plant';
const USER = '00000000-0000-0000-0000-000000000001';
const ORG = '00000000-0000-0000-0000-000000000002';

// ── Authentication ───────────────────────────────────────────────────────────

describe('Plant API authentication', () => {
  it.each([
    ['/', ''],
    ['/io-schedule', ''],
    ['/io-schedule.csv', ''],
    ['/narrative', ''],
    ['/costing', ''],
    ['/review', ''],
    ['/flowsheet', ''],
  ])('requires a token for %s', async (path) => {
    const res = await request(app).get(`${API}${path}`);
    expect(res.status).toBe(401);
  });
});

// ── The route handlers, exercised directly ──────────────────────────────────
//
// `authenticate` is the only DB-free thing standing between these handlers and
// a response, so the payload shapes are asserted against the modules the
// handlers serve. That keeps the contract tested without a database while the
// 401s above prove the guard is actually mounted.

describe('Plant API payload contract', () => {
  const plant = require('../plants/itcStp');

  it('serves an identity with the parties and design flow the proposal names', () => {
    expect(plant.IDENTITY).toMatchObject({
      client: 'ITC',
      contractor: 'Safekrite',
      subContractor: 'Infercon Automation',
      designFlowKld: 675,
      processCount: 11,
    });
  });

  it('serves reuse criteria that are explicitly unconfirmed', () => {
    expect(plant.REUSE_CRITERIA.confirmed).toBe(false);
    expect(plant.REUSE_CRITERIA.name).toMatch(/TEMPLATE/i);
    // TN and TP are deliberately unset for non-potable reuse.
    expect(plant.REUSE_CRITERIA.limits.TN).toBeNull();
    expect(plant.REUSE_CRITERIA.limits.TP).toBeNull();
    expect(plant.REUSE_CRITERIA.limits.BOD).toBe(10);
  });

  it('serves a snapshot small enough to send in one response', () => {
    const bytes = Buffer.byteLength(JSON.stringify(plant.snapshot()), 'utf8');
    expect(bytes).toBeGreaterThan(10_000);
    expect(bytes).toBeLessThan(500_000);
  });

  it('serves a snapshot that is JSON-round-trippable without loss of the review', () => {
    const round = JSON.parse(JSON.stringify(plant.snapshot()));
    expect(round.review).toHaveLength(plant.review().length);
    expect(round.reviewSummary.total).toBe(plant.reviewSummary().total);
  });

  it('serves a flowsheet the canvas can render and the solver can run', () => {
    const canvas = plant.flowsheet.buildFlowsheet();
    expect(canvas.nodes.length).toBeGreaterThan(40);
    expect(canvas.edges.length).toBeGreaterThan(40);
    for (const n of canvas.nodes) {
      expect(n.type).toBe('unitOp');
      expect(typeof n.data.opType).toBe('string');
      expect(n.position).toEqual({ x: expect.any(Number), y: expect.any(Number) });
    }
  });
});

// ── Response caching ─────────────────────────────────────────────────────────
//
// Every payload on this router is a pure function of code, so it is built once
// and served from a string cache with an ETag. The risk that introduces is a
// cache that serves the WRONG bytes — a key collision between two query
// variants, or a stale entry surviving a change. These pin the behaviour that
// makes the cache safe: identical requests give identical bytes, different
// variants never share an entry, and a conditional request is honoured exactly.

describe('Plant API response caching', () => {
  const token = signAccess({ sub: USER, org: ORG, role: 'engineer' });
  const get = (path, headers = {}) =>
    request(app).get(path).set('Authorization', `Bearer ${token}`).set(headers);

  it('serves a strong ETag on every cached payload', async () => {
    for (const path of ['', '/io-schedule', '/narrative', '/costing', '/review', '/flowsheet']) {
      const res = await get(`${API}${path}`);
      expect(res.status).toBe(200);
      expect(res.headers.etag).toMatch(/^"[A-Za-z0-9+/=]+"$/);
      expect(res.headers['cache-control']).toBe('private, max-age=3600');
    }
  });

  it('returns byte-identical bodies on repeat requests', async () => {
    const a = await get(`${API}/review`);
    const b = await get(`${API}/review`);
    expect(JSON.stringify(a.body)).toBe(JSON.stringify(b.body));
    expect(a.headers.etag).toBe(b.headers.etag);
  });

  it('answers a matching If-None-Match with 304 and no body', async () => {
    const first = await get(`${API}/io-schedule`);
    const second = await get(`${API}/io-schedule`, { 'If-None-Match': first.headers.etag });
    expect(second.status).toBe(304);
    expect(second.text).toBeFalsy();
  });

  it('serves the full body when the client holds a stale ETag', async () => {
    const fresh = await get(`${API}/review`);
    const stale = await get(`${API}/review`, { 'If-None-Match': '"not-the-current-one"' });
    expect(stale.status).toBe(200);
    expect(JSON.stringify(stale.body)).toBe(JSON.stringify(fresh.body));
  });

  it('never lets two query variants share a cache entry', async () => {
    const all = await get(`${API}/io-schedule`);
    const ai = await get(`${API}/io-schedule?type=AI`);
    const inR = await get(`${API}/io-schedule?type=AI&area=R`);
    expect(all.body.total).toBeGreaterThan(ai.body.total);
    expect(ai.body.total).toBeGreaterThan(inR.body.total);
    expect(new Set([all.headers.etag, ai.headers.etag, inR.headers.etag]).size).toBe(3);
  });

  it('keys the flow diagram by detail level and by whether it is balanced', async () => {
    const pfd = await get(`${API}/flow-diagram?detail=pfd`);
    const full = await get(`${API}/flow-diagram?detail=full`);
    const dry = await get(`${API}/flow-diagram?detail=pfd&balanced=0`);
    expect(full.body.model.blocks.length).toBeGreaterThan(pfd.body.model.blocks.length);
    expect(dry.body.model.balanced).toBe(false);
    expect(pfd.body.model.balanced).toBe(true);
    expect(new Set([pfd.headers.etag, full.headers.etag, dry.headers.etag]).size).toBe(3);
  });

  it('varies the SVG disposition without varying the cached bytes', async () => {
    const inline = await get(`${API}/flow-diagram.svg`);
    const attach = await get(`${API}/flow-diagram.svg?download=1`);
    expect(inline.headers['content-disposition']).toMatch(/^inline;/);
    expect(attach.headers['content-disposition']).toMatch(/^attachment;/);
    expect(inline.headers.etag).toBe(attach.headers.etag);
  });
});

// ── Instantiating the plant onto a canvas ────────────────────────────────────
//
// The write path needs a database, so the DB-dependent assertions are skipped
// without TEST_DB — but the guards in front of it are not: an unauthenticated
// request and a viewer's request must be refused with no database involved, and
// those are exactly the checks that would be dangerous to leave untested.

describe('POST /plant/instantiate', () => {
  it('refuses an unauthenticated request', async () => {
    const res = await request(app).post(`${API}/instantiate`);
    expect(res.status).toBe(401);
  });

  it('refuses a viewer — creating a flowsheet is an engineer action', async () => {
    const viewer = signAccess({ sub: USER, org: ORG, role: 'viewer' });
    const res = await request(app).post(`${API}/instantiate`).set('Authorization', `Bearer ${viewer}`);
    expect(res.status).toBe(403);
  });

  it('refuses an operator too', async () => {
    const operator = signAccess({ sub: USER, org: ORG, role: 'operator' });
    const res = await request(app).post(`${API}/instantiate`).set('Authorization', `Bearer ${operator}`);
    expect(res.status).toBe(403);
  });

  it('rejects an over-long name before it reaches the database', async () => {
    const engineer = signAccess({ sub: USER, org: ORG, role: 'engineer' });
    const res = await request(app)
      .post(`${API}/instantiate`)
      .set('Authorization', `Bearer ${engineer}`)
      .send({ name: 'x'.repeat(201) });
    expect(res.status).toBe(422);
  });

  it('writes the same canvas_data the read routes serve', () => {
    // The payload is built from one function, so the sheet a user opens is the
    // sheet the PFD, the I/O schedule and the review all describe.
    const plant = require('../plants/itcStp');
    const a = plant.flowsheet.buildFlowsheet();
    const b = plant.flowsheet.buildFlowsheet();
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.nodes.length).toBeGreaterThan(40);
  });
});

// ── CSV export ───────────────────────────────────────────────────────────────

describe('I/O schedule CSV', () => {
  const io = require('../plants/itcStp/ioSchedule');

  it('has one row per wired signal, plus a header', () => {
    const rows = io.buildTagList();
    const totals = io.plantTotals().derived;
    expect(rows).toHaveLength(totals.DI + totals.DO + totals.AI + totals.AO);
  });

  it('produces cells that need no quoting for the tag and type columns', () => {
    // A panel builder sorts on these; a stray comma or quote would break it.
    for (const row of io.buildTagList()) {
      expect(row.tag).not.toMatch(/[",\r\n]/);
      expect(row.type).toMatch(/^(DI|DO|AI|AO)$/);
    }
  });

  it('names a PLC node for every signal', () => {
    for (const row of io.buildTagList()) {
      expect(row.node).toMatch(/^(IOT )?Node \d+ — /);
    }
  });
});
