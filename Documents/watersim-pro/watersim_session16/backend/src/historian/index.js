/**
 * WaterSim Pro — Historian
 *
 * Owns the sample tables created by migration 011. Three responsibilities:
 *
 *   recordSamples(samples)  — the poller's write path: one batched INSERT per
 *                             tick, via UNNEST, never one statement per sample.
 *                             A routing failure (no partition for the month)
 *                             creates the partitions and retries once.
 *   rollup()                — the periodic job: raw → 1-minute buckets, 1-minute
 *                             → 1-hour buckets, each from a watermark kept in
 *                             historian_jobs so a restart resumes, not restarts.
 *                             Once a day it also drops partitions past
 *                             retention and prunes the rollups.
 *   backfillBindingTags()   — links plc_bindings / alarm_rules to the registry
 *                             by (flowsheet, node, param) so a tag created
 *                             after its binding still gets a history.
 *
 * The job runs in-process on the pattern of the stale-run reaper: setInterval,
 * unref'd, guarded against overlap, no-op under NODE_ENV=test unless forced.
 *
 * Retention (days; env):
 *   HISTORIAN_RAW_RETENTION_DAYS   raw samples        default 30
 *   HISTORIAN_1M_RETENTION_DAYS    1-minute rollups   default 730  (2 years)
 *   HISTORIAN_1H_RETENTION_DAYS    1-hour rollups     default 3650 (10 years)
 *   HISTORIAN_ROLLUP_INTERVAL_MS   job cadence        default 60000
 */
'use strict';

const { query } = require('../db/pool');
const logger = require('../utils/logger');

const envInt = (name, dflt, min = 1) => {
  const n = parseInt(process.env[name] || '', 10);
  return Number.isFinite(n) && n >= min ? n : dflt;
};

const RAW_RETENTION_DAYS   = envInt('HISTORIAN_RAW_RETENTION_DAYS', 30);
const M1_RETENTION_DAYS    = envInt('HISTORIAN_1M_RETENTION_DAYS', 730);
const H1_RETENTION_DAYS    = envInt('HISTORIAN_1H_RETENTION_DAYS', 3650);
const ROLLUP_INTERVAL_MS   = envInt('HISTORIAN_ROLLUP_INTERVAL_MS', 60_000, 1000);
const RETENTION_EVERY_MS   = 24 * 3600 * 1000;
// The rollup window ends this far behind "now" so a tick that is still
// inserting cannot leave a half-filled bucket that the next pass never revisits.
const ROLLUP_LAG_MS        = 30_000;
// …and starts this far behind the watermark, so the bucket the watermark
// landed in is recomputed with any late sample.
const ROLLUP_OVERLAP_MS    = 2 * 60_000;
// The origin every bucket is aligned to (a whole minute, hour and day).
const ORIGIN = '2000-01-01T00:00:00Z';

let timer = null;
let running = false;
let lastRetentionAt = 0;

// ── Partitions ───────────────────────────────────────────────────────────────

async function ensurePartitions() {
  const { rows } = await query('SELECT ensure_tag_sample_partitions(1, 2) AS created');
  const created = rows[0]?.created ?? 0;
  if (created > 0) logger.info('Historian: partitions created', { created });
  await query(
    `UPDATE historian_jobs SET last_run_at = NOW(), rows_affected = rows_affected + $1, last_error = NULL
      WHERE name = 'partitions'`, [created]
  ).catch(() => {});
  return created;
}

// ── Write path ───────────────────────────────────────────────────────────────

/**
 * Append samples. `samples` is [{ tagId, ts (Date|ISO|ms), value|null, quality }].
 * Resolves with the number written; never throws (the poller must not stall).
 */
async function recordSamples(samples) {
  const rows = (samples || []).filter((s) => s && s.tagId);
  if (!rows.length) return 0;

  const tagIds = rows.map((s) => s.tagId);
  const tss = rows.map((s) => new Date(s.ts || Date.now()).toISOString());
  const values = rows.map((s) => (Number.isFinite(Number(s.value)) && s.value !== null ? Number(s.value) : null));
  const qualities = rows.map((s) => (['good', 'bad', 'stale'].includes(s.quality) ? s.quality : 'good'));

  const sql = `INSERT INTO tag_samples (tag_id, ts, value, quality)
               SELECT * FROM UNNEST($1::uuid[], $2::timestamptz[], $3::float8[], $4::text[])`;
  const params = [tagIds, tss, values, qualities];

  try {
    const r = await query(sql, params);
    return r.rowCount;
  } catch (err) {
    // 23514 is what Postgres raises when no partition accepts the row.
    if (err.code === '23514' && /partition/i.test(err.message)) {
      try {
        await ensurePartitions();
        const r = await query(sql, params);
        return r.rowCount;
      } catch (err2) {
        logger.warn('Historian: sample insert failed after creating partitions', { err: err2.message });
        return 0;
      }
    }
    logger.warn('Historian: sample insert failed', { err: err.message, n: rows.length });
    return 0;
  }
}

// ── Rollups ──────────────────────────────────────────────────────────────────

async function getWatermark(name) {
  const { rows } = await query('SELECT watermark FROM historian_jobs WHERE name = $1', [name]);
  return rows[0]?.watermark ? new Date(rows[0].watermark) : null;
}

async function setWatermark(name, watermark, affected, error = null) {
  await query(
    `INSERT INTO historian_jobs (name, watermark, last_run_at, rows_affected, last_error)
     VALUES ($1, $2, NOW(), $3, $4)
     ON CONFLICT (name) DO UPDATE SET
       watermark = COALESCE(EXCLUDED.watermark, historian_jobs.watermark),
       last_run_at = NOW(),
       rows_affected = historian_jobs.rows_affected + EXCLUDED.rows_affected,
       last_error = EXCLUDED.last_error`,
    [name, watermark, affected || 0, error]
  );
}

/**
 * Raw → 1-minute buckets for [from, to). Upserts, so the same window can be
 * recomputed. Returns rows written.
 */
async function rollup1m(from, to) {
  const r = await query(
    `INSERT INTO tag_samples_1m (tag_id, bucket, avg, min, max, last, count, good)
     SELECT tag_id,
            date_bin('1 minute', ts, $3::timestamptz)                         AS bucket,
            AVG(value)  FILTER (WHERE quality = 'good' AND value IS NOT NULL)  AS avg,
            MIN(value)  FILTER (WHERE quality = 'good' AND value IS NOT NULL)  AS min,
            MAX(value)  FILTER (WHERE quality = 'good' AND value IS NOT NULL)  AS max,
            (ARRAY_AGG(value ORDER BY ts DESC)
               FILTER (WHERE quality = 'good' AND value IS NOT NULL))[1]       AS last,
            COUNT(*)::int                                                       AS count,
            COUNT(*) FILTER (WHERE quality = 'good' AND value IS NOT NULL)::int AS good
       FROM tag_samples
      WHERE ts >= $1 AND ts < $2
      GROUP BY tag_id, 2
     ON CONFLICT (tag_id, bucket) DO UPDATE SET
       avg = EXCLUDED.avg, min = EXCLUDED.min, max = EXCLUDED.max, last = EXCLUDED.last,
       count = EXCLUDED.count, good = EXCLUDED.good`,
    [from, to, ORIGIN]
  );
  return r.rowCount;
}

/** 1-minute → 1-hour buckets for [from, to), weighted by good-sample count. */
async function rollup1h(from, to) {
  const r = await query(
    `INSERT INTO tag_samples_1h (tag_id, bucket, avg, min, max, last, count, good)
     SELECT tag_id,
            date_bin('1 hour', bucket, $3::timestamptz)                          AS bucket,
            CASE WHEN SUM(good) > 0 THEN SUM(avg * good) / SUM(good) END        AS avg,
            MIN(min)                                                             AS min,
            MAX(max)                                                             AS max,
            (ARRAY_AGG(last ORDER BY bucket DESC) FILTER (WHERE last IS NOT NULL))[1] AS last,
            SUM(count)::int                                                      AS count,
            SUM(good)::int                                                       AS good
       FROM tag_samples_1m
      WHERE bucket >= $1 AND bucket < $2
      GROUP BY tag_id, 2
     ON CONFLICT (tag_id, bucket) DO UPDATE SET
       avg = EXCLUDED.avg, min = EXCLUDED.min, max = EXCLUDED.max, last = EXCLUDED.last,
       count = EXCLUDED.count, good = EXCLUDED.good`,
    [from, to, ORIGIN]
  );
  return r.rowCount;
}

const floorTo = (ms, stepMs) => new Date(Math.floor(ms / stepMs) * stepMs);

/**
 * One rollup pass. `now` is injectable for tests. Returns what was written.
 */
async function rollup(now = Date.now()) {
  const out = { m1: 0, h1: 0 };
  const end = floorTo(now - ROLLUP_LAG_MS, 60_000); // whole minutes only

  // ── 1m ──
  try {
    let wm = await getWatermark('rollup_1m');
    if (!wm) {
      const { rows } = await query('SELECT MIN(ts) AS t FROM tag_samples');
      wm = rows[0]?.t ? floorTo(new Date(rows[0].t).getTime(), 60_000) : end;
    }
    const from = new Date(Math.max(0, wm.getTime() - ROLLUP_OVERLAP_MS));
    if (end > from) {
      out.m1 = await rollup1m(from, end);
      await setWatermark('rollup_1m', end, out.m1);
    }
  } catch (err) {
    logger.warn('Historian: 1m rollup failed', { err: err.message });
    await setWatermark('rollup_1m', null, 0, err.message).catch(() => {});
  }

  // ── 1h (from the 1m table; may lag the 1m watermark by up to an hour) ──
  try {
    let wm = await getWatermark('rollup_1h');
    if (!wm) {
      const { rows } = await query('SELECT MIN(bucket) AS t FROM tag_samples_1m');
      wm = rows[0]?.t ? floorTo(new Date(rows[0].t).getTime(), 3600_000) : end;
    }
    const from = floorTo(wm.getTime() - ROLLUP_OVERLAP_MS, 3600_000);
    if (end > from) {
      out.h1 = await rollup1h(from, end);
      await setWatermark('rollup_1h', end, out.h1);
    }
  } catch (err) {
    logger.warn('Historian: 1h rollup failed', { err: err.message });
    await setWatermark('rollup_1h', null, 0, err.message).catch(() => {});
  }

  return out;
}

// ── Retention ────────────────────────────────────────────────────────────────

/** Partitions whose whole range ended more than `days` ago. */
async function listExpiredPartitions(days, now = Date.now()) {
  const { rows } = await query(
    `SELECT c.relname AS name
       FROM pg_inherits i
       JOIN pg_class c ON c.oid = i.inhrelid
       JOIN pg_class p ON p.oid = i.inhparent
      WHERE p.relname = 'tag_samples' AND c.relname ~ '^tag_samples_y\\d{4}m\\d{2}$'`
  );
  const cutoff = now - days * 86400_000;
  return rows
    .map((r) => r.name)
    .filter((name) => {
      const m = name.match(/y(\d{4})m(\d{2})$/);
      if (!m) return false;
      const hi = Date.UTC(Number(m[1]), Number(m[2]), 1); // first instant of the NEXT month
      return hi < cutoff;
    });
}

async function applyRetention(now = Date.now()) {
  const out = { droppedPartitions: [], m1: 0, h1: 0 };
  try {
    for (const name of await listExpiredPartitions(RAW_RETENTION_DAYS, now)) {
      await query(`DROP TABLE IF EXISTS "${name}"`);
      out.droppedPartitions.push(name);
    }
    const m1 = await query(`DELETE FROM tag_samples_1m WHERE bucket < $1`, [new Date(now - M1_RETENTION_DAYS * 86400_000)]);
    const h1 = await query(`DELETE FROM tag_samples_1h WHERE bucket < $1`, [new Date(now - H1_RETENTION_DAYS * 86400_000)]);
    out.m1 = m1.rowCount; out.h1 = h1.rowCount;
    await setWatermark('retention', new Date(now), out.droppedPartitions.length + out.m1 + out.h1);
    if (out.droppedPartitions.length || out.m1 || out.h1) logger.info('Historian: retention applied', out);
  } catch (err) {
    logger.warn('Historian: retention failed', { err: err.message });
    await setWatermark('retention', null, 0, err.message).catch(() => {});
  }
  return out;
}

// ── Registry linkage ─────────────────────────────────────────────────────────

async function backfillBindingTags() {
  const b = await query(
    `UPDATE plc_bindings b SET tag_id = t.id FROM tags t
      WHERE b.tag_id IS NULL AND t.flowsheet_id = b.flowsheet_id
        AND t.node_id = b.node_id AND t.param_key = b.param_key`
  );
  const r = await query(
    `UPDATE alarm_rules r SET tag_id = t.id FROM tags t
      WHERE r.tag_id IS NULL AND r.node_id IS NOT NULL AND t.flowsheet_id = r.flowsheet_id
        AND t.node_id = r.node_id AND t.param_key = r.param_key`
  );
  if (b.rowCount || r.rowCount) logger.info('Historian: linked to registry', { bindings: b.rowCount, rules: r.rowCount });
  return { bindings: b.rowCount, rules: r.rowCount };
}

// ── Job loop ─────────────────────────────────────────────────────────────────

async function runOnce(now = Date.now()) {
  if (running) return null;
  running = true;
  try {
    const result = await rollup(now);
    if (now - lastRetentionAt > RETENTION_EVERY_MS) {
      lastRetentionAt = now;
      await ensurePartitions().catch((err) => logger.warn('Historian: partition check failed', { err: err.message }));
      result.retention = await applyRetention(now);
    }
    return result;
  } finally {
    running = false;
  }
}

function startHistorian({ force = false, intervalMs = ROLLUP_INTERVAL_MS } = {}) {
  if (timer) return;
  if (process.env.NODE_ENV === 'test' && !force) return;

  // First things first: partitions for this month, and bindings linked.
  ensurePartitions().catch((err) => logger.warn('Historian: partition check failed', { err: err.message }));
  backfillBindingTags().catch((err) => logger.warn('Historian: registry link failed', { err: err.message }));

  timer = setInterval(() => {
    runOnce().catch((err) => logger.error('Historian job failed', { error: err.message }));
  }, intervalMs);
  timer.unref();
  logger.info('Historian started', { intervalMs, rawRetentionDays: RAW_RETENTION_DAYS });
}

function stopHistorian() {
  if (timer) { clearInterval(timer); timer = null; }
}

module.exports = {
  recordSamples,
  rollup,
  applyRetention,
  ensurePartitions,
  backfillBindingTags,
  runOnce,
  startHistorian,
  stopHistorian,
  ORIGIN,
  RETENTION: { RAW_RETENTION_DAYS, M1_RETENTION_DAYS, H1_RETENTION_DAYS },
  _listExpiredPartitions: listExpiredPartitions,
};
