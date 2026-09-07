/**
 * WaterSim Pro — Tag registry API
 *
 * Mounted at: /api/v1/tags
 *
 *   GET    /tags                  — list, filterable (area, kind, signalType, loopTag, flowsheetId, q)
 *   GET    /tags/loops            — the registry grouped by loop / equipment tag
 *   GET    /tags/:id              — one point by id
 *   GET    /tags/by-tag/:tag      — one point by its ISA signal tag
 *   POST   /tags                  — create one point           (engineer+, ISA-validated)
 *   PATCH  /tags/:id              — edit name / node / range   (engineer+; the tag itself is immutable)
 *   DELETE /tags/:id              — remove a point             (engineer+; bindings/rules keep working, unlinked)
 *   POST   /tags/seed/itc-stp     — populate from the ITC schedule for a flowsheet (engineer+, idempotent)
 *
 * Every tag written through here is validated against ISA-5.1 by `tags/isa.js`
 * — the same validator `isaTags.test.js` holds the seeded schedule to. A tag
 * that would mislead an ISA reader (AV, BV, XC, XR, DEC) is refused with the
 * reason, not silently stored.
 *
 * The tag string is immutable once created. Bindings, alarm rules, events and
 * — from Phase 1 — historian samples all hang off `tags.id`, and a renamed tag
 * would orphan every reference in every downstream system, including the CMMS.
 * Renaming is delete-and-recreate, on purpose.
 */
'use strict';

const express = require('express');
const { body, param, query: qv, validationResult } = require('express-validator');
const { query } = require('../db/pool');
const { authenticate, requireRole } = require('../middleware/auth');
const { auditLog } = require('../utils/audit');
const logger = require('../utils/logger');
const isa = require('../tags/isa');
const { readHistory, historyToCsv, BUCKETS, AGGS, MAX_TAGS } = require('../historian/query');

const router = express.Router();
router.use(authenticate);

const userId = (req) => req.user.sub || req.user.id;
const orgId = (req) => req.user.org || req.user.organisationId;

function vErr(req, res) {
  const e = validationResult(req);
  if (!e.isEmpty()) {
    res.status(422).json({ error: 'Validation failed', details: e.array() });
    return true;
  }
  return false;
}

const SIGNAL_TYPES = ['DI', 'DO', 'AI', 'AO'];

/** snake_case row → the camelCase shape the client reads. */
function formatTag(r, binding) {
  return {
    ...(binding !== undefined ? { binding } : {}),
    id: r.id,
    tag: r.tag,
    loopTag: r.loop_tag,
    area: r.area,
    code: r.code,
    loopNo: r.loop_no,
    unit: r.unit,
    fn: r.fn,
    fnSuffix: r.fn_suffix,
    signalType: r.signal_type,
    kind: r.kind,
    name: r.name,
    signal: r.signal,
    description: r.description,
    flowsheetId: r.flowsheet_id,
    nodeId: r.node_id,
    paramKey: r.param_key,
    plcNode: r.plc_node,
    engUnit: r.eng_unit,
    rangeMin: r.range_min,
    rangeMax: r.range_max,
    enabled: r.enabled,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

const SELECT = 'SELECT * FROM tags';

// ── GET /tags ────────────────────────────────────────────────────────────────
router.get(
  '/',
  [
    qv('area').optional().isString().trim().isLength({ max: 8 }),
    qv('kind').optional().isString().trim().isLength({ max: 32 }),
    qv('signalType').optional().isIn(SIGNAL_TYPES),
    qv('loopTag').optional().isString().trim().isLength({ max: 24 }),
    qv('flowsheetId').optional().isUUID(),
    qv('q').optional().isString().trim().isLength({ max: 60 }),
    qv('limit').optional().isInt({ min: 1, max: 1000 }).toInt(),
    qv('offset').optional().isInt({ min: 0 }).toInt(),
  ],
  async (req, res, next) => {
    if (vErr(req, res)) return;
    try {
      const where = ['organisation_id = $1'];
      const params = [orgId(req)];
      const add = (sql, v) => { params.push(v); where.push(sql.replace('?', `$${params.length}`)); };
      if (req.query.area) add('area = ?', req.query.area.toUpperCase());
      if (req.query.kind) add('kind = ?', req.query.kind);
      if (req.query.signalType) add('signal_type = ?', req.query.signalType);
      if (req.query.loopTag) add('loop_tag = ?', req.query.loopTag.toUpperCase());
      if (req.query.flowsheetId) add('flowsheet_id = ?', req.query.flowsheetId);
      if (req.query.q) add('(tag ILIKE ? OR name ILIKE $' + (params.length + 1) + ')', `%${req.query.q}%`);
      if (req.query.q) params.push(`%${req.query.q}%`);

      const limit = req.query.limit ?? 500;
      const offset = req.query.offset ?? 0;
      const sql = `${SELECT} WHERE ${where.join(' AND ')} ORDER BY area, loop_tag, unit NULLS FIRST, fn`;
      const [{ rows }, { rows: [{ count }] }] = await Promise.all([
        query(`${sql} LIMIT ${limit} OFFSET ${offset}`, params),
        query(`SELECT COUNT(*)::int AS count FROM tags WHERE ${where.join(' AND ')}`, params),
      ]);
      // The live state of each tag's PLC binding, so a picker can show which
      // points are actually being read (and their last value) without a
      // request per tag.
      const bindings = await bindingStates(rows.map((r) => r.id));
      res.json({ total: count, tags: rows.map((r) => formatTag(r, bindings.get(r.id) || null)) });
    } catch (err) { next(err); }
  }
);

/** tagId → { id, quality, value, at } for the newest binding of each tag. */
async function bindingStates(tagIds) {
  if (!tagIds.length) return new Map();
  const { rows } = await query(
    `SELECT DISTINCT ON (tag_id) tag_id, id, quality, last_value, last_read_at
       FROM plc_bindings WHERE tag_id = ANY($1::uuid[])
      ORDER BY tag_id, updated_at DESC`,
    [tagIds]
  );
  return new Map(rows.map((b) => [b.tag_id, { id: b.id, quality: b.quality, value: b.last_value, at: b.last_read_at }]));
}

// ── History (the Phase 1 historian) ──────────────────────────────────────────
//
//   GET /tags/history?ids=a,b&range=24h            multi-tag series
//   GET /tags/history.csv?ids=a,b&from=&to=        the same, wide CSV
//   GET /tags/:id/history · /tags/:id/history.csv  one tag
//   GET /tags/:id/latest                           binding state + last sample + last minute
//
// Window: explicit from/to (ISO), or `range` back from now (e.g. 6h, 7d);
// resolution: bucket=auto|raw|1m|5m|15m|1h|6h|1d (auto picks from the span).

const HISTORY_QUERY = [
  qv('from').optional().isISO8601(),
  qv('to').optional().isISO8601(),
  qv('range').optional().matches(/^\d+(m|h|d)$/).withMessage('range looks like 30m, 6h or 7d'),
  qv('bucket').optional().isIn(['auto', ...BUCKETS]),
  qv('agg').optional().isIn(AGGS),
  qv('maxPoints').optional().isInt({ min: 10, max: 5000 }).toInt(),
];

const MAX_WINDOW_MS = 400 * 86400_000;

/** from/to from the query: explicit ISO, or `range` back from now (default 6h). */
function windowOf(q) {
  const to = q.to ? new Date(q.to) : new Date();
  let from;
  if (q.from) from = new Date(q.from);
  else {
    const m = String(q.range || '6h').match(/^(\d+)(m|h|d)$/);
    const unit = { m: 60_000, h: 3600_000, d: 86400_000 }[m[2]];
    from = new Date(to.getTime() - Number(m[1]) * unit);
  }
  if (!(from < to) || to - from > MAX_WINDOW_MS) return null;
  return { from, to };
}

async function historyHandler(req, res, next, ids) {
  if (vErr(req, res)) return;
  const win = windowOf(req.query);
  if (!win) {
    return res.status(422).json({ error: 'Validation failed', details: [{ msg: 'from must be before to, and the window at most 400 days', path: 'from' }] });
  }
  try {
    const result = await readHistory({
      orgId: orgId(req), tagIds: ids, from: win.from, to: win.to,
      bucket: req.query.bucket || 'auto', maxPoints: req.query.maxPoints,
    });
    if (req.path.endsWith('.csv')) {
      res
        .set('Content-Type', 'text/csv; charset=utf-8')
        .set('Content-Disposition', `attachment; filename="watersim_trend_${win.to.toISOString().slice(0, 10)}.csv"`)
        .send(historyToCsv(result, req.query.agg || 'avg'));
      return;
    }
    res.json({ ...result, from: win.from.toISOString(), to: win.to.toISOString() });
  } catch (err) { next(err); }
}

const idsOf = (req) => String(req.query.ids || '').split(',').map((s) => s.trim()).filter(Boolean);
const IDS = qv('ids').isString().custom((v) => {
  const ids = String(v).split(',').map((s) => s.trim()).filter(Boolean);
  if (!ids.length || ids.length > MAX_TAGS) throw new Error(`ids must list 1–${MAX_TAGS} tag ids`);
  if (ids.some((id) => !/^[0-9a-f-]{36}$/i.test(id))) throw new Error('ids must be UUIDs');
  return true;
});

router.get('/history',     [IDS, ...HISTORY_QUERY], (req, res, next) => historyHandler(req, res, next, idsOf(req)));
router.get('/history.csv', [IDS, ...HISTORY_QUERY], (req, res, next) => historyHandler(req, res, next, idsOf(req)));
router.get('/:id/history',     [param('id').isUUID(), ...HISTORY_QUERY], (req, res, next) => historyHandler(req, res, next, [req.params.id]));
router.get('/:id/history.csv', [param('id').isUUID(), ...HISTORY_QUERY], (req, res, next) => historyHandler(req, res, next, [req.params.id]));

router.get('/:id/latest', [param('id').isUUID()], async (req, res, next) => {
  if (vErr(req, res)) return;
  try {
    const t = await query(`${SELECT} WHERE id = $1 AND organisation_id = $2`, [req.params.id, orgId(req)]);
    if (!t.rows[0]) return res.status(404).json({ error: 'Tag not found' });
    const [b, s, m] = await Promise.all([
      query(`SELECT id, quality, last_value, last_read_at FROM plc_bindings WHERE tag_id = $1 ORDER BY updated_at DESC LIMIT 1`, [req.params.id]),
      query(`SELECT ts, value, quality FROM tag_samples WHERE tag_id = $1 ORDER BY ts DESC LIMIT 1`, [req.params.id]),
      query(`SELECT bucket, avg, min, max, last, count, good FROM tag_samples_1m WHERE tag_id = $1 ORDER BY bucket DESC LIMIT 1`, [req.params.id]),
    ]);
    res.json({
      tag: formatTag(t.rows[0]),
      binding: b.rows[0] ? { id: b.rows[0].id, quality: b.rows[0].quality, value: b.rows[0].last_value, at: b.rows[0].last_read_at } : null,
      lastSample: s.rows[0] || null,
      lastMinute: m.rows[0] || null,
    });
  } catch (err) { next(err); }
});

// ── GET /tags/loops ──────────────────────────────────────────────────────────
router.get('/loops', [qv('flowsheetId').optional().isUUID()], async (req, res, next) => {
  if (vErr(req, res)) return;
  try {
    const params = [orgId(req)];
    let extra = '';
    if (req.query.flowsheetId) { params.push(req.query.flowsheetId); extra = ' AND flowsheet_id = $2'; }
    const { rows } = await query(
      `SELECT loop_tag, area, code, MIN(kind) AS kind, MIN(name) AS name, MIN(plc_node) AS plc_node,
              COUNT(*)::int AS points,
              COUNT(*) FILTER (WHERE signal_type = 'DI')::int AS di,
              COUNT(*) FILTER (WHERE signal_type = 'DO')::int AS "do",
              COUNT(*) FILTER (WHERE signal_type = 'AI')::int AS ai,
              MAX(unit) AS units
         FROM tags
        WHERE organisation_id = $1${extra}
        GROUP BY loop_tag, area, code
        ORDER BY area, loop_tag`,
      params
    );
    res.json({
      total: rows.length,
      loops: rows.map((r) => ({
        loopTag: r.loop_tag, area: r.area, code: r.code, kind: r.kind, name: r.name,
        plcNode: r.plc_node, points: r.points, di: r.di, do: r.do, ai: r.ai, units: r.units,
      })),
    });
  } catch (err) { next(err); }
});

// ── GET /tags/by-tag/:tag ────────────────────────────────────────────────────
router.get('/by-tag/:tag', [param('tag').isString().trim().isLength({ min: 3, max: 48 })], async (req, res, next) => {
  if (vErr(req, res)) return;
  try {
    const { rows } = await query(`${SELECT} WHERE organisation_id = $1 AND tag = $2`, [orgId(req), req.params.tag.toUpperCase()]);
    if (!rows.length) return res.status(404).json({ error: 'Tag not found' });
    res.json(formatTag(rows[0]));
  } catch (err) { next(err); }
});

// ── GET /tags/:id ────────────────────────────────────────────────────────────
router.get('/:id', [param('id').isUUID()], async (req, res, next) => {
  if (vErr(req, res)) return;
  try {
    const { rows } = await query(`${SELECT} WHERE organisation_id = $1 AND id = $2`, [orgId(req), req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Tag not found' });
    res.json(formatTag(rows[0]));
  } catch (err) { next(err); }
});

// ── POST /tags ───────────────────────────────────────────────────────────────
const tagBody = [
  body('tag').isString().trim().isLength({ min: 3, max: 48 }).customSanitizer((v) => v.toUpperCase()),
  body('signalType').isIn(SIGNAL_TYPES),
  body('kind').isString().trim().isLength({ min: 1, max: 32 }),
  body('name').isString().trim().isLength({ min: 1, max: 200 }),
  body('signal').isString().trim().isLength({ min: 1, max: 80 }),
  body('description').optional({ nullable: true }).isString().trim().isLength({ max: 2000 }),
  body('flowsheetId').optional({ nullable: true }).isUUID(),
  body('nodeId').optional({ nullable: true }).isString().trim().isLength({ max: 80 }),
  body('paramKey').optional({ nullable: true }).isString().trim().isLength({ max: 80 }),
  body('plcNode').optional({ nullable: true }).isString().trim().isLength({ max: 80 }),
  body('engUnit').optional({ nullable: true }).isString().trim().isLength({ max: 24 }),
  body('rangeMin').optional({ nullable: true }).isFloat().toFloat(),
  body('rangeMax').optional({ nullable: true }).isFloat().toFloat(),
];

/** Insert one validated point. Returns the row, or null on a duplicate. */
async function insertTag(client, org, by, t) {
  const v = isa.validateSignalTag(t.tag);
  if (!v.ok) {
    const err = new Error(`Not an ISA-5.1 tag — ${v.reason}`);
    err.status = 422; err.isOperational = true;
    throw err;
  }
  const p = v.parsed;
  const { rows } = await client(
    `INSERT INTO tags
       (organisation_id, flowsheet_id, tag, loop_tag, area, code, loop_no, unit, fn, fn_suffix,
        signal_type, kind, name, signal, description, node_id, param_key, plc_node,
        eng_unit, range_min, range_max, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
     ON CONFLICT (organisation_id, tag) DO NOTHING
     RETURNING *`,
    [
      org, t.flowsheetId || null, t.tag, p.loopTag, p.device.area, p.device.code, p.device.loop,
      p.unit, p.fn, p.suffix, t.signalType, t.kind, t.name, t.signal, t.description || null,
      t.nodeId || null, t.paramKey || null, t.plcNode || null,
      t.engUnit || null, t.rangeMin ?? null, t.rangeMax ?? null, by,
    ]
  );
  return rows[0] || null;
}

router.post('/', requireRole('engineer'), tagBody, async (req, res, next) => {
  if (vErr(req, res)) return;
  try {
    const row = await insertTag(query, orgId(req), userId(req), req.body);
    if (!row) return res.status(409).json({ error: `Tag ${req.body.tag} already exists in this organisation` });
    auditLog(req, 'tag.create', 'tag', row.id, { tag: row.tag });
    res.status(201).json(formatTag(row));
  } catch (err) { next(err); }
});

// ── PATCH /tags/:id ──────────────────────────────────────────────────────────
router.patch(
  '/:id',
  requireRole('engineer'),
  [
    param('id').isUUID(),
    body('tag').not().exists().withMessage('the tag string is immutable — delete and recreate to rename'),
    body('name').optional().isString().trim().isLength({ min: 1, max: 200 }),
    body('signal').optional().isString().trim().isLength({ min: 1, max: 80 }),
    body('description').optional({ nullable: true }).isString().trim().isLength({ max: 2000 }),
    body('flowsheetId').optional({ nullable: true }).isUUID(),
    body('nodeId').optional({ nullable: true }).isString().trim().isLength({ max: 80 }),
    body('paramKey').optional({ nullable: true }).isString().trim().isLength({ max: 80 }),
    body('plcNode').optional({ nullable: true }).isString().trim().isLength({ max: 80 }),
    body('engUnit').optional({ nullable: true }).isString().trim().isLength({ max: 24 }),
    body('rangeMin').optional({ nullable: true }).isFloat().toFloat(),
    body('rangeMax').optional({ nullable: true }).isFloat().toFloat(),
    body('enabled').optional().isBoolean().toBoolean(),
  ],
  async (req, res, next) => {
    if (vErr(req, res)) return;
    const COLS = {
      name: 'name', signal: 'signal', description: 'description', flowsheetId: 'flowsheet_id',
      nodeId: 'node_id', paramKey: 'param_key', plcNode: 'plc_node', engUnit: 'eng_unit',
      rangeMin: 'range_min', rangeMax: 'range_max', enabled: 'enabled',
    };
    const sets = []; const params = [orgId(req), req.params.id];
    for (const [k, col] of Object.entries(COLS)) {
      if (req.body[k] !== undefined) { params.push(req.body[k]); sets.push(`${col} = $${params.length}`); }
    }
    if (!sets.length) return res.status(422).json({ error: 'Nothing to update' });
    try {
      const { rows } = await query(
        `UPDATE tags SET ${sets.join(', ')} WHERE organisation_id = $1 AND id = $2 RETURNING *`, params
      );
      if (!rows.length) return res.status(404).json({ error: 'Tag not found' });
      auditLog(req, 'tag.update', 'tag', rows[0].id, { tag: rows[0].tag, fields: Object.keys(req.body) });
      res.json(formatTag(rows[0]));
    } catch (err) { next(err); }
  }
);

// ── DELETE /tags/:id ─────────────────────────────────────────────────────────
router.delete('/:id', requireRole('engineer'), [param('id').isUUID()], async (req, res, next) => {
  if (vErr(req, res)) return;
  try {
    const { rows } = await query(
      'DELETE FROM tags WHERE organisation_id = $1 AND id = $2 RETURNING id, tag', [orgId(req), req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Tag not found' });
    auditLog(req, 'tag.delete', 'tag', rows[0].id, { tag: rows[0].tag });
    res.json({ deleted: rows[0].id, tag: rows[0].tag });
  } catch (err) { next(err); }
});

// ── POST /tags/seed/itc-stp ──────────────────────────────────────────────────
//
// Populate the registry from the ITC I/O schedule — the 339 signal tags the
// plant definition derives — linked to a flowsheet in the caller's organisation
// and to the canvas nodes that carry each device tag. Idempotent: a tag already
// present is left alone, so running it twice adds nothing and changes nothing.
router.post(
  '/seed/itc-stp',
  requireRole('engineer'),
  [body('flowsheetId').optional({ nullable: true }).isUUID()],
  async (req, res, next) => {
    if (vErr(req, res)) return;
    try {
      const plant = require('../plants/itcStp');
      const rows = plant.ioSchedule.buildTagList();
      const nodeOfDevice = new Map();
      for (const n of plant.flowsheet.NODES) {
        for (const t of n.data.tags || []) if (!nodeOfDevice.has(t)) nodeOfDevice.set(t, n.id);
      }
      let created = 0; let skipped = 0;
      for (const r of rows) {
        const inserted = await insertTag(query, orgId(req), userId(req), {
          tag: r.tag, signalType: r.type, kind: r.kind, name: r.device, signal: r.signal,
          description: r.description, flowsheetId: req.body.flowsheetId || null,
          nodeId: nodeOfDevice.get(r.deviceTag) || null, plcNode: r.node,
        });
        if (inserted) created += 1; else skipped += 1;
      }
      auditLog(req, 'tag.seed', 'flowsheet', req.body.flowsheetId || null, { plant: plant.PLANT_ID, created, skipped });
      logger.info('Tag registry seeded from ITC schedule', { org: orgId(req), created, skipped });
      res.status(created ? 201 : 200).json({ plant: plant.PLANT_ID, created, skipped, total: rows.length });
    } catch (err) { next(err); }
  }
);

module.exports = router;
module.exports.formatTag = formatTag;
