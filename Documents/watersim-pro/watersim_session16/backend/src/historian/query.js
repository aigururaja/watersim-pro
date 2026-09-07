/**
 * WaterSim Pro — Historian read path
 *
 * readHistory() answers "these tags over this window at this resolution" with
 * a compact series per tag. The resolution is chosen so a browser never gets
 * raw rows for a 30-day window:
 *
 *   bucket   source                          picked automatically for spans up to
 *   raw      tag_samples                     3 hours   (or when raw is asked and fits)
 *   1m       tag_samples_1m (+ raw tail)     3 days
 *   15m      1m re-binned                    14 days
 *   1h       tag_samples_1h                  90 days
 *   1d       1h re-binned                    anything longer
 *
 * The 1-minute table lags "now" by up to the rollup cadence, so a 1m query is
 * completed from raw samples newer than the rollup watermark, binned on the
 * fly. A trend is therefore live to the last poll, not to the last job run.
 *
 * Points are arrays, not objects — [tsMs, avg, min, max, last, count] — a
 * 6-tag, 1500-point response is ~150 KB instead of ~400 KB.
 */
'use strict';

const { query } = require('../db/pool');
const { ORIGIN } = require('./index');

const BUCKET_S = { raw: 0, '1m': 60, '5m': 300, '15m': 900, '1h': 3600, '6h': 21600, '1d': 86400 };
const BUCKETS = Object.keys(BUCKET_S);
const AGGS = ['avg', 'min', 'max', 'last'];
const MAX_TAGS = 12;
const DEFAULT_MAX_POINTS = 1500;
const HARD_RAW_CAP = 20_000; // per query, across tags

function chooseBucket(spanMs) {
  const h = spanMs / 3600_000;
  if (h <= 3) return 'raw';
  if (h <= 72) return '1m';
  if (h <= 24 * 14) return '15m';
  if (h <= 24 * 90) return '1h';
  return '1d';
}

/** Which stored table a bucket is served from, and the interval it is re-binned to. */
function sourceFor(bucket) {
  switch (bucket) {
    case 'raw': return { table: 'tag_samples', rebin: null };
    case '1m':  return { table: 'tag_samples_1m', rebin: null };
    case '5m':  return { table: 'tag_samples_1m', rebin: '5 minutes' };
    case '15m': return { table: 'tag_samples_1m', rebin: '15 minutes' };
    case '1h':  return { table: 'tag_samples_1h', rebin: null };
    case '6h':  return { table: 'tag_samples_1h', rebin: '6 hours' };
    case '1d':  return { table: 'tag_samples_1h', rebin: '1 day' };
    default:    return { table: 'tag_samples_1m', rebin: null };
  }
}

const toPoint = (r) => [
  new Date(r.bucket).getTime(),
  r.avg == null ? null : Number(r.avg),
  r.min == null ? null : Number(r.min),
  r.max == null ? null : Number(r.max),
  r.last == null ? null : Number(r.last),
  Number(r.count) || 0,
];

/** Raw samples binned on the fly to `interval` (SQL interval literal). */
async function binRaw(tagIds, from, to, interval) {
  const { rows } = await query(
    `SELECT tag_id,
            date_bin($4::interval, ts, $5::timestamptz) AS bucket,
            AVG(value) FILTER (WHERE quality = 'good' AND value IS NOT NULL) AS avg,
            MIN(value) FILTER (WHERE quality = 'good' AND value IS NOT NULL) AS min,
            MAX(value) FILTER (WHERE quality = 'good' AND value IS NOT NULL) AS max,
            (ARRAY_AGG(value ORDER BY ts DESC) FILTER (WHERE quality = 'good' AND value IS NOT NULL))[1] AS last,
            COUNT(*)::int AS count
       FROM tag_samples
      WHERE tag_id = ANY($1::uuid[]) AND ts >= $2 AND ts < $3
      GROUP BY tag_id, 2
      ORDER BY 2`,
    [tagIds, from, to, interval, ORIGIN]
  );
  return rows;
}

/** A rollup table, optionally re-binned to a coarser interval. */
async function readRollup(table, tagIds, from, to, rebin) {
  if (!rebin) {
    const { rows } = await query(
      `SELECT tag_id, bucket, avg, min, max, last, count
         FROM ${table}
        WHERE tag_id = ANY($1::uuid[]) AND bucket >= $2 AND bucket < $3
        ORDER BY bucket`,
      [tagIds, from, to]
    );
    return rows;
  }
  const { rows } = await query(
    `SELECT tag_id,
            date_bin($4::interval, bucket, $5::timestamptz) AS bucket,
            CASE WHEN SUM(good) > 0 THEN SUM(avg * good) / SUM(good) END AS avg,
            MIN(min) AS min, MAX(max) AS max,
            (ARRAY_AGG(last ORDER BY bucket DESC) FILTER (WHERE last IS NOT NULL))[1] AS last,
            SUM(count)::int AS count
       FROM ${table}
      WHERE tag_id = ANY($1::uuid[]) AND bucket >= $2 AND bucket < $3
      GROUP BY tag_id, 2
      ORDER BY 2`,
    [tagIds, from, to, rebin, ORIGIN]
  );
  return rows;
}

/**
 * @param {object} o
 * @param {string}   o.orgId
 * @param {string[]} o.tagIds
 * @param {Date}     o.from
 * @param {Date}     o.to
 * @param {string}   [o.bucket='auto']
 * @param {number}   [o.maxPoints=1500]  per tag, for the automatic choice and the raw cap
 */
async function readHistory({ orgId, tagIds, from, to, bucket = 'auto', maxPoints = DEFAULT_MAX_POINTS }) {
  const ids = [...new Set((tagIds || []).filter(Boolean))].slice(0, MAX_TAGS);
  if (!ids.length) return { bucket: 'raw', from, to, series: [] };

  // Only the organisation's own tags, in the order asked.
  const { rows: tags } = await query(
    `SELECT id, tag, name, eng_unit, signal, signal_type, kind, area, range_min, range_max
       FROM tags WHERE organisation_id = $1 AND id = ANY($2::uuid[])`,
    [orgId, ids]
  );
  const byId = new Map(tags.map((t) => [t.id, t]));
  const okIds = ids.filter((id) => byId.has(id));
  if (!okIds.length) return { bucket: 'raw', from, to, series: [] };

  const spanMs = to.getTime() - from.getTime();
  let chosen = bucket === 'auto' || !BUCKETS.includes(bucket) ? chooseBucket(spanMs) : bucket;

  let rows = [];
  let raw = false;
  if (chosen === 'raw') {
    const cap = Math.min(HARD_RAW_CAP, maxPoints * okIds.length);
    const r = await query(
      `SELECT tag_id, ts AS bucket, value, quality
         FROM tag_samples
        WHERE tag_id = ANY($1::uuid[]) AND ts >= $2 AND ts < $3
        ORDER BY ts
        LIMIT ${cap + 1}`,
      [okIds, from, to]
    );
    if (r.rows.length > cap) {
      // Too dense for raw at this span — bin it to whatever gives ~maxPoints.
      const secs = Math.max(1, Math.ceil(spanMs / 1000 / maxPoints));
      chosen = secs <= 60 ? '1m' : secs <= 900 ? '15m' : '1h';
      rows = await binRaw(okIds, from, to, `${secs} seconds`);
      raw = false;
    } else {
      rows = r.rows.map((x) => ({
        tag_id: x.tag_id, bucket: x.bucket,
        avg: x.quality === 'good' ? x.value : null, min: null, max: null,
        last: x.quality === 'good' ? x.value : null, count: 1, quality: x.quality,
      }));
      raw = true;
    }
  } else {
    const { table, rebin } = sourceFor(chosen);
    rows = await readRollup(table, okIds, from, to, rebin);

    // Complete the window from raw samples the rollup job has not reached yet.
    const wmName = table === 'tag_samples_1h' ? 'rollup_1h' : 'rollup_1m';
    const { rows: wmRows } = await query('SELECT watermark FROM historian_jobs WHERE name = $1', [wmName]);
    const wm = wmRows[0]?.watermark ? new Date(wmRows[0].watermark) : from;
    const tailFrom = wm > from ? wm : from;
    if (to > tailFrom) {
      const interval = rebin || (table === 'tag_samples_1h' ? '1 hour' : '1 minute');
      const tail = await binRaw(okIds, tailFrom, to, interval);
      const seen = new Set(rows.map((r) => `${r.tag_id}|${new Date(r.bucket).getTime()}`));
      for (const t of tail) {
        const k = `${t.tag_id}|${new Date(t.bucket).getTime()}`;
        if (!seen.has(k)) rows.push(t);
      }
    }
  }

  const grouped = new Map(okIds.map((id) => [id, []]));
  for (const r of rows) grouped.get(r.tag_id)?.push(r);

  const series = okIds.map((id) => {
    const t = byId.get(id);
    const pts = grouped.get(id).sort((a, b) => new Date(a.bucket) - new Date(b.bucket)).map(toPoint);
    const goodVals = pts.map((p) => p[1]).filter((v) => v != null);
    const stats = goodVals.length ? {
      min: Math.min(...pts.map((p) => p[2] ?? p[1]).filter((v) => v != null)),
      max: Math.max(...pts.map((p) => p[3] ?? p[1]).filter((v) => v != null)),
      avg: goodVals.reduce((a, b) => a + b, 0) / goodVals.length,
      last: [...pts].reverse().find((p) => p[4] != null || p[1] != null),
      samples: pts.reduce((a, p) => a + (p[5] || 0), 0),
    } : { min: null, max: null, avg: null, last: null, samples: 0 };
    if (stats.last) stats.last = stats.last[4] ?? stats.last[1];
    return {
      tagId: id, tag: t.tag, name: t.name, unit: t.eng_unit || null, signal: t.signal,
      signalType: t.signal_type, kind: t.kind, area: t.area,
      rangeMin: t.range_min, rangeMax: t.range_max,
      points: pts, stats,
    };
  });

  return { bucket: chosen, raw, from, to, series, columns: ['ts', 'avg', 'min', 'max', 'last', 'count'] };
}

/** Wide CSV: one row per bucket, one column per tag (the chosen aggregate). */
function historyToCsv(result, agg = 'avg') {
  const col = { avg: 1, min: 2, max: 3, last: 4 }[AGGS.includes(agg) ? agg : 'avg'];
  const cell = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const times = new Set();
  const lookup = result.series.map((s) => {
    const m = new Map();
    for (const p of s.points) { times.add(p[0]); m.set(p[0], p[col]); }
    return m;
  });
  const header = ['timestamp', ...result.series.map((s) => `${s.tag}${s.unit ? ` (${s.unit})` : ''}`)].map(cell).join(',');
  const lines = [...times].sort((a, b) => a - b).map((t) =>
    [new Date(t).toISOString(), ...lookup.map((m) => (m.get(t) == null ? '' : Number(m.get(t)).toPrecision(8).replace(/\.?0+$/, '')))]
      .map(cell).join(',')
  );
  const BOM = String.fromCharCode(0xfeff);
  return `${BOM}${[header, ...lines].join('\r\n')}\r\n`;
}

module.exports = { readHistory, historyToCsv, chooseBucket, BUCKETS, AGGS, MAX_TAGS };
