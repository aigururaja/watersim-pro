/**
 * SafeKrit — Equipment counters (Phase 4)
 *
 * Run hours, starts and trips per drive per day, derived from the historian:
 * every XS (run status) and XA (trip) sample since the last pass, walked in
 * time order per tag.
 *
 *   XS 0 → 1   a start;  while 1, the time to the next sample is run time
 *              (a gap longer than MAX_GAP_MS is not counted — the link was
 *              down, not the pump running unobserved)
 *   XA 0 → 1   a trip
 *
 * The last state and timestamp are carried on the most recent day row, so a
 * batch boundary never loses or double-counts a transition. The watermark is
 * historian_jobs 'counters'. This is the feed predictive maintenance needs.
 */
'use strict';

const { query } = require('../db/pool');
const logger = require('../utils/logger');

// The day whose totals were last announced per organisation (in-process).
const announced = new Map();

/**
 * Once a day per organisation, emit `equipment.counters.daily` with the
 * previous day's totals per drive — the feed predictive maintenance reads.
 */
async function announceDaily(now = Date.now()) {
  const yesterday = new Date(now - 86400_000).toISOString().slice(0, 10);
  const { rows: orgs } = await query(`SELECT DISTINCT t.organisation_id FROM equipment_counters c JOIN tags t ON t.id = c.tag_id WHERE c.day = $1`, [yesterday]);
  for (const { organisation_id: orgId } of orgs) {
    if (announced.get(orgId) === yesterday) continue;
    announced.set(orgId, yesterday);
    try {
      const drives = (await readCounters(orgId, { days: 2 })).map((d) => ({
        assetCode: d.key, loopTag: d.loopTag, unit: d.unit, name: d.name, area: d.area, kind: d.kind,
        day: yesterday,
        runHours: +(d.days.filter((x) => x.day === yesterday && x.fn === 'XS').reduce((a, x) => a + x.runHours, 0)).toFixed(3),
        starts: d.days.filter((x) => x.day === yesterday && x.fn === 'XS').reduce((a, x) => a + x.starts, 0),
        trips: d.days.filter((x) => x.day === yesterday && x.fn === 'XA').reduce((a, x) => a + x.trips, 0),
      }));
      const { emit } = require('../notifications');
      await emit('equipment.counters.daily', { orgId, severity: 'info', payload: { day: yesterday, drives }, dedupeKey: `counters|${orgId}|${yesterday}` });
    } catch (err) {
      logger.warn('Daily counters announcement failed', { orgId, err: err.message });
    }
  }
}

const MAX_GAP_MS = 15 * 60_000;
const LAG_MS = 30_000;
const BATCH = 50_000;

const dayOf = (ts) => new Date(ts).toISOString().slice(0, 10);

async function runCounters(now = Date.now()) {
  const wm = await query(`SELECT watermark FROM historian_jobs WHERE name = 'counters'`);
  const from = wm.rows[0]?.watermark ? new Date(wm.rows[0].watermark) : new Date(0);
  const to = new Date(now - LAG_MS);
  if (to <= from) return { tags: 0, samples: 0 };

  const { rows } = await query(
    `SELECT s.tag_id, s.ts, s.value, t.fn
       FROM tag_samples s JOIN tags t ON t.id = s.tag_id
      WHERE s.ts > $1 AND s.ts <= $2 AND s.quality = 'good' AND s.value IS NOT NULL
        AND t.signal_type = 'DI' AND t.fn IN ('XS', 'XA')
      ORDER BY s.tag_id, s.ts
      LIMIT ${BATCH}`,
    [from, to]
  );
  if (!rows.length) {
    await query(`UPDATE historian_jobs SET watermark = $1, last_run_at = NOW() WHERE name = 'counters'`, [to]);
    return { tags: 0, samples: 0 };
  }

  // Group per tag.
  const byTag = new Map();
  for (const r of rows) { if (!byTag.has(r.tag_id)) byTag.set(r.tag_id, { fn: r.fn, samples: [] }); byTag.get(r.tag_id).samples.push(r); }

  let maxTs = from;
  for (const [tagId, { fn, samples }] of byTag) {
    // Carry-over from the latest day row.
    const last = await query(`SELECT day, last_state, last_ts FROM equipment_counters WHERE tag_id = $1 ORDER BY day DESC LIMIT 1`, [tagId]);
    let state = last.rows[0]?.last_state ?? null;
    let lastTs = last.rows[0]?.last_ts ? new Date(last.rows[0].last_ts).getTime() : null;

    const perDay = new Map(); // day → { run_ms, starts, trips }
    const bump = (day) => { if (!perDay.has(day)) perDay.set(day, { run_ms: 0, starts: 0, trips: 0 }); return perDay.get(day); };

    for (const s of samples) {
      const ts = new Date(s.ts).getTime();
      const bit = Number(s.value) >= 0.5 ? 1 : 0;
      const day = dayOf(ts);
      if (fn === 'XS') {
        if (state === 1 && lastTs != null) {
          const gap = ts - lastTs;
          if (gap > 0 && gap <= MAX_GAP_MS) bump(day).run_ms += gap;
        }
        if (bit === 1 && state === 0) bump(day).starts += 1;
      } else if (fn === 'XA') {
        if (bit === 1 && state === 0) bump(day).trips += 1;
      }
      state = bit;
      lastTs = ts;
      if (ts > maxTs.getTime()) maxTs = new Date(ts);
    }

    for (const [day, c] of perDay) {
      await query(
        `INSERT INTO equipment_counters (tag_id, day, run_hours, starts, trips, last_state, last_ts)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (tag_id, day) DO UPDATE SET
           run_hours = equipment_counters.run_hours + EXCLUDED.run_hours,
           starts = equipment_counters.starts + EXCLUDED.starts,
           trips = equipment_counters.trips + EXCLUDED.trips,
           last_state = EXCLUDED.last_state, last_ts = EXCLUDED.last_ts`,
        [tagId, day, c.run_ms / 3600_000, c.starts, c.trips, state, new Date(lastTs)]
      );
    }
    // Even a day with no transitions must carry the state forward.
    if (!perDay.size && lastTs != null) {
      await query(
        `INSERT INTO equipment_counters (tag_id, day, last_state, last_ts) VALUES ($1, $2, $3, $4)
         ON CONFLICT (tag_id, day) DO UPDATE SET last_state = EXCLUDED.last_state, last_ts = EXCLUDED.last_ts`,
        [tagId, dayOf(lastTs), state, new Date(lastTs)]
      );
    }
  }

  // If the batch was full, only advance to the last sample seen so the rest is picked up next pass.
  const newWm = rows.length >= BATCH ? maxTs : to;
  await query(`UPDATE historian_jobs SET watermark = $1, last_run_at = NOW(), rows_affected = rows_affected + $2 WHERE name = 'counters'`, [newWm, rows.length]);
  logger.debug('Equipment counters updated', { tags: byTag.size, samples: rows.length });
  announceDaily(now).catch((err) => logger.debug('Daily counters skipped', { err: err.message }));
  return { tags: byTag.size, samples: rows.length };
}

/** Counters for the drives of an organisation (optionally one loop), by day and in total. */
async function readCounters(orgId, { loopTag = null, tagIds = null, days = 30 } = {}) {
  const params = [orgId, new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10)];
  let extra = '';
  if (loopTag) { params.push(loopTag); extra += ` AND t.loop_tag = $${params.length}`; }
  if (tagIds?.length) { params.push(tagIds); extra += ` AND t.id = ANY($${params.length}::uuid[])`; }
  const { rows } = await query(
    `SELECT t.id AS tag_id, t.tag, t.loop_tag, t.unit, t.fn, t.name, t.area, t.kind,
            c.day, c.run_hours, c.starts, c.trips, c.last_state, c.last_ts
       FROM equipment_counters c JOIN tags t ON t.id = c.tag_id
      WHERE t.organisation_id = $1 AND c.day >= $2${extra}
      ORDER BY t.loop_tag, t.unit, t.fn, c.day`,
    params
  );
  const byDrive = new Map();
  for (const r of rows) {
    const key = `${r.loop_tag}${r.unit ? `/${r.unit}` : ''}`;
    if (!byDrive.has(key)) byDrive.set(key, { key, loopTag: r.loop_tag, unit: r.unit, name: r.name, area: r.area, kind: r.kind, runHours: 0, starts: 0, trips: 0, running: null, lastTs: null, days: [] });
    const d = byDrive.get(key);
    d.runHours += Number(r.run_hours);
    d.starts += r.starts;
    d.trips += r.trips;
    if (r.fn === 'XS') { d.running = r.last_state == null ? null : r.last_state === 1; if (!d.lastTs || new Date(r.last_ts) > new Date(d.lastTs)) d.lastTs = r.last_ts; }
    d.days.push({ day: r.day, fn: r.fn, runHours: Number(r.run_hours), starts: r.starts, trips: r.trips });
  }
  return [...byDrive.values()].map((d) => ({ ...d, runHours: +d.runHours.toFixed(3) }));
}

module.exports = { runCounters, readCounters, announceDaily, MAX_GAP_MS };
