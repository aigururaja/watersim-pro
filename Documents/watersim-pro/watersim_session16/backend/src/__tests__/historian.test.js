/**
 * Historian — samples in, buckets out.
 *
 * Real database. What is pinned: a batch of samples lands in the partitioned
 * table; the rollup turns them into 1-minute and 1-hour buckets with the
 * right averages; the history API serves raw, bucketed and automatically
 * chosen resolutions, completes a 1m window from raw past the watermark, and
 * refuses another organisation's tags; the CSV is wide; expired partitions are
 * the only ones retention names; and the period report builds a payload
 * without Python.
 */
'use strict';

const { createTestUser, loginAs, makeProject, makeFlowsheet } = require('./helpers');
const { query, isSqlite } = require('../db/pool');
const historian = require('../historian');
const { readHistory, historyToCsv, chooseBucket } = require('../historian/query');
const { buildPeriodPayload } = require('../reports/periodReport');

const PW = 'Historian123!';
let agent, otherAgent, orgId, otherOrgId, flowsheetId;
let tagA, tagB;

// A fixed window in the recent past so partitions exist and "now" never moves
// the buckets: 10:00–10:05 UTC, three days ago, aligned to whole hours.
const DAY = 86400_000;
const T0 = (() => { const d = new Date(Date.now() - 3 * DAY); d.setUTCHours(10, 0, 0, 0); return d.getTime(); })();

async function createTag(ag, tag, name, extra = {}) {
  const r = await ag.post('/api/v1/tags').send({ tag, name, signalType: 'AI', kind: 'flow_meter', signal: 'Flow', flowsheetId, engUnit: 'm3/d', ...extra });
  if (r.status !== 201) throw new Error(`tag create ${r.status}: ${JSON.stringify(r.body)}`);
  // POST /tags answers with the formatted tag itself (its `tag` field is the ISA string).
  return r.body.id ? r.body : r.body.tag;
}

beforeAll(async () => {
  const admin = await createTestUser('hist.admin@test.example', PW, 'admin');
  agent = await loginAs(admin);
  const project = await makeProject(agent, 'Historian Project');
  const fs = await makeFlowsheet(agent, project.id, 'Historian FS');
  flowsheetId = fs.id;
  orgId = (await query('SELECT organisation_id FROM projects WHERE id = $1', [project.id])).rows[0].organisation_id;

  tagA = await createTag(agent, 'HST-FT-101.FT', 'Historian flow A');
  tagB = await createTag(agent, 'HST-LT-102.LT', 'Historian level B', { kind: 'level_tx', signal: 'Level', engUnit: '%' });

  const other = await createTestUser('hist.other@test.example', PW, 'admin');
  otherAgent = await loginAs(other);
  otherOrgId = (await query('SELECT organisation_id FROM users WHERE email = $1', [other.email])).rows[0].organisation_id;

  // 5 minutes of 10 s samples on A (values 1..30) and a flat 50 on B, with
  // one bad sample on A that must not pollute the average.
  const samples = [];
  for (let i = 0; i < 30; i++) {
    samples.push({ tagId: tagA.id, ts: new Date(T0 + i * 10_000), value: i + 1, quality: 'good' });
    samples.push({ tagId: tagB.id, ts: new Date(T0 + i * 10_000), value: 50, quality: 'good' });
  }
  samples.push({ tagId: tagA.id, ts: new Date(T0 + 5_000), value: 9999, quality: 'bad' });
  const n = await historian.recordSamples(samples);
  expect(n).toBe(61);
});

afterAll(async () => {
  await query('DELETE FROM historian_jobs WHERE name LIKE $1', ['rollup_%']).catch(() => {});
});

describe('write path', () => {
  test('samples land in the month partition for their timestamp', async () => {
    if (isSqlite) {
      // One plain table on SQLite — what matters is that every sample landed.
      const { rows } = await query(`SELECT COUNT(*)::int AS n FROM tag_samples WHERE tag_id = $1`, [tagA.id]);
      expect(rows[0].n).toBe(31);
      return;
    }
    const { rows } = await query(
      `SELECT tableoid::regclass AS part, COUNT(*)::int AS n FROM tag_samples WHERE tag_id = $1 GROUP BY 1`, [tagA.id]
    );
    expect(rows).toHaveLength(1);
    expect(String(rows[0].part)).toMatch(/^tag_samples_y\d{4}m\d{2}$/);
    expect(rows[0].n).toBe(31);
  });

  test('ensurePartitions is idempotent and covers next month', async () => {
    expect(await historian.ensurePartitions()).toBe(0);
    if (isSqlite) return; // nothing to create: no partitions
    const next = new Date(); next.setUTCMonth(next.getUTCMonth() + 1);
    const name = `tag_samples_y${next.getUTCFullYear()}m${String(next.getUTCMonth() + 1).padStart(2, '0')}`;
    const { rows } = await query('SELECT to_regclass($1) AS r', [name]);
    expect(rows[0].r).toBe(name);
  });

  test('recordSamples never throws on garbage and returns 0', async () => {
    expect(await historian.recordSamples([{ tagId: null }, null])).toBe(0);
    expect(await historian.recordSamples([{ tagId: '00000000-0000-0000-0000-000000000000', ts: new Date(), value: 1 }])).toBe(0);
  });
});

describe('rollup', () => {
  test('raw → 1m → 1h with good-only averages and a resumable watermark', async () => {
    // Reset the watermarks so this run starts from the oldest sample.
    await query(`UPDATE historian_jobs SET watermark = NULL WHERE name IN ('rollup_1m', 'rollup_1h')`);
    const out = await historian.rollup(T0 + 10 * 60_000);
    expect(out.m1).toBeGreaterThanOrEqual(10); // 5 minutes × 2 tags
    expect(out.h1).toBeGreaterThanOrEqual(2);

    const { rows } = await query(
      `SELECT bucket, avg, min, max, last, count, good FROM tag_samples_1m WHERE tag_id = $1 ORDER BY bucket`, [tagA.id]
    );
    expect(rows).toHaveLength(5);
    // Minute 0 holds values 1..6 (six samples at 0,10,…,50 s) plus one bad 9999 → avg 3.5, count 7, good 6.
    expect(rows[0].count).toBe(7);
    expect(rows[0].good).toBe(6);
    expect(rows[0].avg).toBeCloseTo(3.5, 6);
    expect(rows[0].min).toBe(1);
    expect(rows[0].max).toBe(6);
    expect(rows[0].last).toBe(6);
    // Minute 4 holds 25..30.
    expect(rows[4].avg).toBeCloseTo(27.5, 6);

    const h = await query(`SELECT avg, count, good FROM tag_samples_1h WHERE tag_id = $1`, [tagA.id]);
    expect(h.rows).toHaveLength(1);
    expect(h.rows[0].count).toBe(31);
    expect(h.rows[0].good).toBe(30);
    expect(h.rows[0].avg).toBeCloseTo(15.5, 6); // mean of 1..30

    const wm = await query(`SELECT watermark FROM historian_jobs WHERE name = 'rollup_1m'`);
    expect(new Date(wm.rows[0].watermark).getTime()).toBeGreaterThan(T0);

    // A second pass over the same window is idempotent.
    const again = await historian.rollup(T0 + 10 * 60_000);
    expect(again.m1).toBeGreaterThanOrEqual(0);
    const same = await query(`SELECT COUNT(*)::int AS n FROM tag_samples_1m WHERE tag_id = $1`, [tagA.id]);
    expect(same.rows[0].n).toBe(5);
  });
});

describe('read path', () => {
  const from = new Date(T0);
  const to = new Date(T0 + 5 * 60_000);

  test('chooseBucket scales with the span', () => {
    expect(chooseBucket(60 * 60_000)).toBe('raw');
    expect(chooseBucket(24 * 3600_000)).toBe('1m');
    expect(chooseBucket(7 * DAY)).toBe('15m');
    expect(chooseBucket(60 * DAY)).toBe('1h');
    expect(chooseBucket(365 * DAY)).toBe('1d');
  });

  test('raw series carry every sample; bad samples have no value', async () => {
    const r = await readHistory({ orgId, tagIds: [tagA.id], from, to, bucket: 'raw' });
    expect(r.bucket).toBe('raw');
    expect(r.raw).toBe(true);
    expect(r.series[0].points).toHaveLength(31);
    const bad = r.series[0].points.find((p) => p[1] == null);
    expect(bad).toBeTruthy();
    expect(r.series[0].stats.max).toBe(30);
  });

  test('1m series come from the rollup, in the order the ids were given', async () => {
    const r = await readHistory({ orgId, tagIds: [tagB.id, tagA.id], from, to, bucket: '1m' });
    expect(r.series.map((s) => s.tag)).toEqual(['HST-LT-102.LT', 'HST-FT-101.FT']);
    expect(r.series[1].points).toHaveLength(5);
    expect(r.series[1].points[0][1]).toBeCloseTo(3.5, 6);
    expect(r.series[0].points.every((p) => p[1] === 50)).toBe(true);
    expect(r.series[0].unit).toBe('%');
  });

  test('a 1m window past the rollup watermark is completed from raw', async () => {
    // The rollup above ran with "now" = T0 + 10 min, so its watermark sits at
    // T0 + 9 min. Samples after it are not rolled up yet — the read path bins
    // them from raw on the fly.
    const late = T0 + 10 * 60_000;
    await historian.recordSamples([
      { tagId: tagA.id, ts: new Date(late), value: 100 }, { tagId: tagA.id, ts: new Date(late + 30_000), value: 200 },
    ]);
    const r = await readHistory({ orgId, tagIds: [tagA.id], from, to: new Date(T0 + 12 * 60_000), bucket: '1m' });
    const tail = r.series[0].points.find((p) => p[0] === late);
    expect(tail).toBeTruthy();
    expect(tail[1]).toBe(150);
  });

  test('another organisation sees nothing', async () => {
    const r = await readHistory({ orgId: otherOrgId, tagIds: [tagA.id], from, to });
    expect(r.series).toEqual([]);
  });

  test('the CSV is wide: one column per tag, one row per bucket', async () => {
    const r = await readHistory({ orgId, tagIds: [tagA.id, tagB.id], from, to, bucket: '1m' });
    const csv = historyToCsv(r, 'avg');
    const BOM = String.fromCharCode(0xfeff);
    expect(csv.startsWith(BOM)).toBe(true);
    const lines = csv.slice(1).trim().split('\r\n');
    expect(lines[0]).toBe('timestamp,HST-FT-101.FT (m3/d),HST-LT-102.LT (%)');
    expect(lines).toHaveLength(6);
    expect(lines[1].split(',')[1]).toBe('3.5');
    expect(lines[1].split(',')[2]).toBe('50');
  });
});

describe('HTTP', () => {
  test('GET /tags/history serves a multi-tag window and picks the bucket', async () => {
    const r = await agent.get(`/api/v1/tags/history?ids=${tagA.id},${tagB.id}&from=${new Date(T0).toISOString()}&to=${new Date(T0 + 5 * 60_000).toISOString()}`);
    expect(r.status).toBe(200);
    expect(r.body.bucket).toBe('raw');
    expect(r.body.series).toHaveLength(2);
    expect(r.body.columns).toEqual(['ts', 'avg', 'min', 'max', 'last', 'count']);
  });

  test('GET /tags/:id/history honours range= and bucket=', async () => {
    const r = await agent.get(`/api/v1/tags/${tagA.id}/history?range=30d&bucket=1h`);
    expect(r.status).toBe(200);
    expect(r.body.bucket).toBe('1h');
    expect(r.body.series[0].points.length).toBeGreaterThanOrEqual(1);
  });

  test('GET /tags/history.csv downloads; bad windows and ids are 422', async () => {
    const csv = await agent.get(`/api/v1/tags/history.csv?ids=${tagA.id}&range=7d&bucket=1m`);
    expect(csv.status).toBe(200);
    expect(csv.headers['content-type']).toMatch(/text\/csv/);
    expect(csv.headers['content-disposition']).toMatch(/watersim_trend_/);

    expect((await agent.get(`/api/v1/tags/history?ids=not-a-uuid`)).status).toBe(422);
    expect((await agent.get(`/api/v1/tags/history?ids=${tagA.id}&from=2030-01-01T00:00:00Z&to=2020-01-01T00:00:00Z`)).status).toBe(422);
    expect((await agent.get(`/api/v1/tags/history?ids=${tagA.id}&range=3y`)).status).toBe(422);
  });

  test('GET /tags/:id/latest reports the last sample and minute', async () => {
    const r = await agent.get(`/api/v1/tags/${tagA.id}/latest`);
    expect(r.status).toBe(200);
    expect(r.body.tag.tag).toBe('HST-FT-101.FT');
    expect(r.body.lastSample.value).toBe(200);
    expect(r.body.lastMinute).toBeTruthy();
    expect(r.body.binding).toBeNull();
  });

  test('the tag list carries binding state (null when unbound)', async () => {
    const r = await agent.get(`/api/v1/tags?flowsheetId=${flowsheetId}`);
    expect(r.status).toBe(200);
    expect(r.body.tags.find((t) => t.id === tagA.id).binding).toBeNull();
  });

  test('the other organisation gets an empty series, never ours', async () => {
    const r = await otherAgent.get(`/api/v1/tags/history?ids=${tagA.id}&range=1d`);
    expect(r.status).toBe(200);
    expect(r.body.series).toEqual([]);
  });

  test('POST /reports/period as CSV, and its payload for the PDF/Excel scripts', async () => {
    const r = await agent.post('/api/v1/reports/period')
      .send({ tagIds: [tagA.id, tagB.id], from: new Date(T0).toISOString(), to: new Date(T0 + 5 * 60_000).toISOString(), format: 'csv', bucket: '1m' })
      .buffer(true).parse((res, cb) => { let d = ''; res.on('data', (c) => d += c); res.on('end', () => cb(null, d)); });
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toMatch(/text\/csv/);
    expect(r.headers['content-disposition']).toMatch(/watersim_history_/);
    expect(String(r.body)).toContain('HST-FT-101.FT');

    const payload = await buildPeriodPayload({ orgId, userId: null, tagIds: [tagA.id], from: new Date(T0), to: new Date(T0 + 5 * 60_000), bucket: '1m', title: 'Test' });
    expect(payload.series[0].stats.availabilityPct).toBe(100);
    expect(payload.series[0].points[0]).toHaveLength(4);
    expect(payload.counts).toEqual({ critical: 0, warning: 0, info: 0 });

    expect((await agent.post('/api/v1/reports/period').send({ tagIds: [], from: 'x', to: 'y' })).status).toBe(422);
    expect((await otherAgent.post('/api/v1/reports/period').send({ tagIds: [tagA.id], from: new Date(T0).toISOString(), to: new Date(T0 + 60_000).toISOString(), format: 'csv' })).status).toBe(404);
  });
});

describe('retention', () => {
  test('names only partitions whose month ended before the cutoff', async () => {
    const now = Date.UTC(2030, 5, 15); // June 2030
    const all = await historian._listExpiredPartitions(0, now);
    if (isSqlite) {
      expect(all).toEqual([]); // one plain table; SQLite retention deletes rows by ts instead
    } else {
      // Every existing partition is before 2030 → all named; none named with a huge retention.
      expect(all.length).toBeGreaterThanOrEqual(1);
    }
    expect(await historian._listExpiredPartitions(100_000, now)).toEqual([]);
    // Retention on the real clock with the configured days drops nothing from this test's data.
    const out = await historian.applyRetention();
    expect(out.droppedPartitions).toEqual([]);
  });
});
