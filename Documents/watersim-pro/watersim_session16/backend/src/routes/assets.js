/**
 * SafeKrit — Asset read API for the CMMS boundary (Phase 5)
 *
 * Mounted at: /api/v1/assets · versioned, keyset-paged, served to an API key
 * with the scope or to a logged-in admin.
 *
 *   GET /assets                      one row per equipment loop (the ISA tag IS the asset code)
 *   GET /assets/:tag                 the loop with its points and their live state
 *   GET /assets/:tag/history         the loop's analogue points over a window (bucketed)
 *   GET /assets/:tag/counters        run hours / starts / trips per day
 *   GET /assets/:tag/events          alarm events and maintenance tasks on the loop
 *
 * `:tag` is the loop tag (RFP-P-201) or a unit (RFP-P-201/1, URL-encoded).
 * Asset identity across the boundary: the loop tag is the CMMS's asset_code,
 * a unit is a sub-asset, and the SafeKrit ids ride in `watersim` for the
 * CMMS's custom_fields.
 */
'use strict';

const express = require('express');
const { param, query: qv, validationResult } = require('express-validator');
const { query, isSqlite } = require('../db/pool');
const { serviceOrUser } = require('../middleware/serviceAuth');
const { readHistory } = require('../historian/query');
const { readCounters } = require('../twin/counters');
const { processes } = require('../plants/itcStp');

const router = express.Router();
const API_VERSION = 'v1';
const orgId = (req) => req.user.org || req.user.organisationId;

function vErr(req, res) {
  const e = validationResult(req);
  if (!e.isEmpty()) { res.status(422).json({ error: 'Validation failed', details: e.array() }); return true; }
  return false;
}

const KIND_LABELS = { ...(processes.KIND_LABELS || {}) };
const label = (kind) => KIND_LABELS[kind]?.label || KIND_LABELS[kind] || kind;

/** "RFP-P-201/1" → { loopTag: 'RFP-P-201', unit: 1 }; "RFP-P-201" → unit null. */
function parseAssetTag(s) {
  const m = /^([A-Z]{1,6}-[A-Z]{1,4}-\d{3,4})(?:\/(\d{1,2}))?$/i.exec(String(s || '').trim().toUpperCase());
  return m ? { loopTag: m[1], unit: m[2] ? Number(m[2]) : null } : null;
}

const LOOP_SELECT = `
  SELECT t.loop_tag, t.area, t.code, MIN(t.kind) AS kind, MIN(t.name) AS name, MIN(t.plc_node) AS plc_node,
         MIN(t.flowsheet_id::text) AS flowsheet_id, MIN(t.node_id) AS node_id,
         COUNT(*)::int AS points, MAX(t.unit) AS units,
         COUNT(*) FILTER (WHERE t.signal_type = 'AI')::int AS analog,
         COUNT(b.id)::int AS bound,
         MAX(b.last_read_at) AS last_read_at,
         ${isSqlite ? 'json_group_array(DISTINCT t.id)' : 'ARRAY_AGG(DISTINCT t.id::text)'} AS tag_ids
    FROM tags t
    LEFT JOIN plc_bindings b ON b.tag_id = t.id AND b.enabled = TRUE`;

/** tag_ids is a text[] on Postgres and JSON text (json_group_array) on SQLite. */
function tagIdList(r) {
  if (Array.isArray(r.tag_ids)) return r.tag_ids;
  try { return JSON.parse(r.tag_ids || '[]'); } catch { return []; }
}

function fmtLoop(r) {
  return {
    assetCode: r.loop_tag, loopTag: r.loop_tag, area: r.area, functionLetters: r.code,
    kind: r.kind, kindLabel: label(r.kind), name: r.name, plcNode: r.plc_node,
    units: r.units ? Number(r.units) : 0,
    subAssets: r.units ? Array.from({ length: Number(r.units) }, (_, i) => `${r.loop_tag}/${i + 1}`) : [],
    points: r.points, analogPoints: r.analog, boundPoints: r.bound, lastReadAt: r.last_read_at,
    watersim: { flowsheetId: r.flowsheet_id, nodeId: r.node_id, tagIds: tagIdList(r) },
  };
}

// ── GET /assets ──────────────────────────────────────────────────────────────
router.get('/', serviceOrUser('assets:read', 'users.manage'), [
  qv('area').optional().isString().trim().isLength({ max: 8 }),
  qv('kind').optional().isString().trim().isLength({ max: 32 }),
  qv('cursor').optional().isString().trim().isLength({ max: 40 }),
  qv('limit').optional().isInt({ min: 1, max: 500 }).toInt(),
], async (req, res, next) => {
  if (vErr(req, res)) return;
  try {
    const params = [orgId(req)];
    const where = ['t.organisation_id = $1'];
    if (req.query.area) { params.push(req.query.area.toUpperCase()); where.push(`t.area = $${params.length}`); }
    if (req.query.kind) { params.push(req.query.kind); where.push(`t.kind = $${params.length}`); }
    const limit = req.query.limit || 100;
    let having = '';
    if (req.query.cursor) { params.push(req.query.cursor.toUpperCase()); having = ` HAVING t.loop_tag > $${params.length}`; }
    const { rows } = await query(`${LOOP_SELECT} WHERE ${where.join(' AND ')} GROUP BY t.loop_tag, t.area, t.code${having} ORDER BY t.loop_tag LIMIT ${limit + 1}`, params);
    const page = rows.slice(0, limit);
    res.json({ apiVersion: API_VERSION, assets: page.map(fmtLoop), nextCursor: rows.length > limit ? page[page.length - 1].loop_tag : null });
  } catch (err) { next(err); }
});

async function loadLoop(req, res) {
  const parsed = parseAssetTag(req.params.tag);
  if (!parsed) { res.status(422).json({ error: 'tag must be an ISA loop tag such as RFP-P-201 or a unit such as RFP-P-201/1' }); return null; }
  const { rows } = await query(`${LOOP_SELECT} WHERE t.organisation_id = $1 AND t.loop_tag = $2 GROUP BY t.loop_tag, t.area, t.code`, [orgId(req), parsed.loopTag]);
  if (!rows[0]) { res.status(404).json({ error: 'No such asset' }); return null; }
  return { parsed, loop: rows[0] };
}

// ── GET /assets/:tag ─────────────────────────────────────────────────────────
router.get('/:tag', serviceOrUser('assets:read', 'users.manage'), [param('tag').isString()], async (req, res, next) => {
  try {
    const found = await loadLoop(req, res); if (!found) return;
    const { parsed, loop } = found;
    const pts = await query(
      `SELECT t.id, t.tag, t.unit, t.fn, t.signal_type, t.signal, t.name, t.eng_unit, t.range_min, t.range_max, t.node_id, t.param_key,
              b.id AS binding_id, b.direction, b.quality, b.last_value, b.last_read_at
         FROM tags t LEFT JOIN plc_bindings b ON b.tag_id = t.id AND b.enabled = TRUE
        WHERE t.organisation_id = $1 AND t.loop_tag = $2 ${parsed.unit ? 'AND t.unit = $3' : ''}
        ORDER BY t.unit NULLS FIRST, t.fn`,
      parsed.unit ? [orgId(req), parsed.loopTag, parsed.unit] : [orgId(req), parsed.loopTag]
    );
    const counters = await readCounters(orgId(req), { loopTag: parsed.loopTag, days: 30 });
    res.json({
      apiVersion: API_VERSION,
      ...fmtLoop(loop),
      subAsset: parsed.unit ? `${parsed.loopTag}/${parsed.unit}` : null,
      points: pts.rows.map((p) => ({
        id: p.id, tag: p.tag, unit: p.unit, fn: p.fn, signalType: p.signal_type, signal: p.signal, name: p.name,
        engUnit: p.eng_unit, rangeMin: p.range_min, rangeMax: p.range_max, nodeId: p.node_id, paramKey: p.param_key,
        bound: !!p.binding_id, direction: p.direction, value: p.last_value == null ? null : Number(p.last_value), quality: p.quality, at: p.last_read_at,
      })),
      counters30d: counters.filter((c) => !parsed.unit || c.unit === parsed.unit).map((c) => ({ subAsset: c.key, runHours: c.runHours, starts: c.starts, trips: c.trips, running: c.running, lastTs: c.lastTs })),
    });
  } catch (err) { next(err); }
});

// ── GET /assets/:tag/history ─────────────────────────────────────────────────
router.get('/:tag/history', serviceOrUser('history:read', 'users.manage'), [
  qv('from').optional().isISO8601(), qv('to').optional().isISO8601(),
  qv('range').optional().matches(/^\d+(m|h|d)$/), qv('bucket').optional().isIn(['auto', 'raw', '1m', '5m', '15m', '1h', '6h', '1d']),
], async (req, res, next) => {
  if (vErr(req, res)) return;
  try {
    const found = await loadLoop(req, res); if (!found) return;
    const { parsed } = found;
    const to = req.query.to ? new Date(req.query.to) : new Date();
    let from;
    if (req.query.from) from = new Date(req.query.from);
    else { const m = String(req.query.range || '24h').match(/^(\d+)(m|h|d)$/); from = new Date(to.getTime() - Number(m[1]) * { m: 60_000, h: 3600_000, d: 86400_000 }[m[2]]); }
    if (!(from < to) || to - from > 400 * 86400_000) return res.status(422).json({ error: 'from must be before to, and the window at most 400 days' });
    const ids = await query(
      `SELECT id FROM tags WHERE organisation_id = $1 AND loop_tag = $2 ${parsed.unit ? 'AND unit = $3' : ''} AND signal_type = 'AI' ORDER BY tag LIMIT 12`,
      parsed.unit ? [orgId(req), parsed.loopTag, parsed.unit] : [orgId(req), parsed.loopTag]
    );
    const result = await readHistory({ orgId: orgId(req), tagIds: ids.rows.map((r) => r.id), from, to, bucket: req.query.bucket || 'auto' });
    res.json({ apiVersion: API_VERSION, assetCode: parsed.loopTag, ...result, from: from.toISOString(), to: to.toISOString() });
  } catch (err) { next(err); }
});

// ── GET /assets/:tag/counters ────────────────────────────────────────────────
router.get('/:tag/counters', serviceOrUser('counters:read', 'users.manage'), [qv('days').optional().isInt({ min: 1, max: 365 }).toInt()], async (req, res, next) => {
  if (vErr(req, res)) return;
  try {
    const found = await loadLoop(req, res); if (!found) return;
    const { parsed } = found;
    const drives = await readCounters(orgId(req), { loopTag: parsed.loopTag, days: req.query.days || 30 });
    res.json({ apiVersion: API_VERSION, assetCode: parsed.loopTag, days: req.query.days || 30, drives: drives.filter((d) => !parsed.unit || d.unit === parsed.unit) });
  } catch (err) { next(err); }
});

// ── GET /assets/:tag/events ──────────────────────────────────────────────────
router.get('/:tag/events', serviceOrUser('events:read', 'users.manage'), [
  qv('from').optional().isISO8601(), qv('to').optional().isISO8601(),
  qv('limit').optional().isInt({ min: 1, max: 500 }).toInt(), qv('cursor').optional().isISO8601(),
], async (req, res, next) => {
  if (vErr(req, res)) return;
  try {
    const found = await loadLoop(req, res); if (!found) return;
    const { parsed, loop } = found;
    const limit = req.query.limit || 100;
    const params = [orgId(req), loop.tag_ids, loop.node_id, req.query.from ? new Date(req.query.from) : new Date(0), req.query.to ? new Date(req.query.to) : new Date(), limit + 1];
    let cursor = '';
    if (req.query.cursor) { params.push(new Date(req.query.cursor)); cursor = ` AND e.triggered_at < $${params.length}`; }
    const ev = await query(
      `SELECT e.id, e.severity, e.state, e.message, e.value, e.triggered_at, e.cleared_at, e.acknowledged, e.source, r.name AS rule, r.kind, r.tag_id, r.node_id
         FROM alarm_events e JOIN alarm_rules r ON r.id = e.rule_id
        WHERE e.organisation_id = $1 AND (r.tag_id::text = ANY($2::text[]) OR ($3::text IS NOT NULL AND r.node_id = $3))
          AND e.triggered_at >= $4 AND e.triggered_at < $5${cursor}
        ORDER BY e.triggered_at DESC LIMIT $6`,
      params
    );
    const tasks = await query(
      `SELECT t.id, t.number, t.title, t.state, t.priority, t.severity, t.created_at, t.due_at, t.closed_at, t.external_system, t.external_ref, t.source_event_id
         FROM maintenance_tasks t
        WHERE t.organisation_id = $1 AND (t.tag_id::text = ANY($2::text[]) OR t.source_event_id IN (
              SELECT e.id FROM alarm_events e JOIN alarm_rules r ON r.id = e.rule_id WHERE r.tag_id::text = ANY($2::text[]) OR ($3::text IS NOT NULL AND r.node_id = $3)))
        ORDER BY t.created_at DESC LIMIT 100`,
      [orgId(req), loop.tag_ids, loop.node_id]
    );
    const page = ev.rows.slice(0, limit);
    res.json({
      apiVersion: API_VERSION, assetCode: parsed.loopTag,
      events: page.map((e) => ({ id: e.id, severity: e.severity, state: e.state, kind: e.kind, rule: e.rule, message: e.message, value: e.value, triggeredAt: e.triggered_at, clearedAt: e.cleared_at, acknowledged: e.acknowledged, source: e.source })),
      nextCursor: ev.rows.length > limit ? new Date(page[page.length - 1].triggered_at).toISOString() : null,
      tasks: tasks.rows.map((t) => ({ id: t.id, number: `WO-${String(t.number).padStart(5, '0')}`, title: t.title, state: t.state, priority: t.priority, severity: t.severity, createdAt: t.created_at, dueAt: t.due_at, closedAt: t.closed_at, externalSystem: t.external_system, externalRef: t.external_ref, sourceEventId: t.source_event_id })),
    });
  } catch (err) { next(err); }
});

module.exports = router;
module.exports.parseAssetTag = parseAssetTag;
