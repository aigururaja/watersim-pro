/**
 * SafeKrit — Audit read API
 *
 * Mounted at: /api/v1/audit   (admin only — capability `audit.read`)
 *
 *   GET /audit          — the organisation's audit trail, filtered and paged
 *   GET /audit.csv      — the same query as CSV
 *   GET /audit/actions  — the distinct action names seen, for a filter picker
 *
 * The audit_logs table has been written to from 37 call sites since migration
 * 001 and could not be read by anyone: no API, no page, no export. For the
 * maintenance workflow in Phase 2 — where a manager's approval has to be shown
 * to have happened — the trail has to be readable, and it has to be exportable
 * to hand to an auditor who is not a user of the system.
 *
 * Paging is keyset on (created_at, id), the same shape reports_org.js uses, so
 * a long trail pages in constant time. Rows are joined to users for a display
 * name; a system-originated row (user_id NULL) shows `details.source` instead.
 */
'use strict';

const express = require('express');
const { query: qv, validationResult } = require('express-validator');
const { query } = require('../db/pool');
const { authenticate, requireCapability } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate);
router.use(requireCapability('audit.read'));

const orgId = (req) => req.user.org || req.user.organisationId;

function vErr(req, res) {
  const e = validationResult(req);
  if (!e.isEmpty()) {
    res.status(422).json({ error: 'Validation failed', details: e.array() });
    return true;
  }
  return false;
}

const FILTERS = [
  qv('action').optional().isString().trim().isLength({ max: 100 }),
  qv('resourceType').optional().isString().trim().isLength({ max: 100 }),
  qv('resourceId').optional().isUUID(),
  qv('userId').optional().isUUID(),
  qv('source').optional().isString().trim().isLength({ max: 40 }),
  qv('from').optional().isISO8601(),
  qv('to').optional().isISO8601(),
  qv('q').optional().isString().trim().isLength({ max: 80 }),
  qv('limit').optional().isInt({ min: 1, max: 500 }).toInt(),
  qv('cursor').optional().isString().trim().isLength({ max: 120 }),
];

/** Build WHERE + params from the validated query. */
function buildWhere(req) {
  const where = ['a.organisation_id = $1'];
  const params = [orgId(req)];
  const add = (sql, v) => { params.push(v); where.push(sql.replace('?', `$${params.length}`)); };
  const q = req.query;
  if (q.action) add(q.action.endsWith('.') ? 'a.action LIKE ?' : 'a.action = ?', q.action.endsWith('.') ? `${q.action}%` : q.action);
  if (q.resourceType) add('a.resource_type = ?', q.resourceType);
  if (q.resourceId) add('a.resource_id = ?', q.resourceId);
  if (q.userId) add('a.user_id = ?', q.userId);
  if (q.source) add("a.details->>'source' = ?", q.source);
  if (q.from) add('a.created_at >= ?', q.from);
  if (q.to) add('a.created_at <= ?', q.to);
  if (q.q) {
    params.push(`%${q.q}%`);
    const n = params.length;
    where.push(`(a.action ILIKE $${n} OR a.resource_type ILIKE $${n} OR u.email ILIKE $${n} OR a.details::text ILIKE $${n})`);
  }
  return { where, params };
}

const FROM = `FROM audit_logs a LEFT JOIN users u ON u.id = a.user_id`;

function formatRow(r) {
  const details = r.details || {};
  return {
    id: r.id,
    createdAt: r.created_at,
    action: r.action,
    resourceType: r.resource_type,
    resourceId: r.resource_id,
    userId: r.user_id,
    actor: r.user_id
      ? { id: r.user_id, email: r.email, name: [r.first_name, r.last_name].filter(Boolean).join(' ') || r.email, role: r.role }
      : { id: null, email: null, name: `system · ${details.source || 'unknown'}`, role: 'system' },
    source: r.user_id ? 'user' : (details.source || 'system'),
    ip: r.ip_address,
    details,
  };
}

/** Encode / decode the keyset cursor: "<iso created_at>|<id>". */
const encodeCursor = (r) => Buffer.from(`${new Date(r.created_at).toISOString()}|${r.id}`).toString('base64url');
function decodeCursor(c) {
  try {
    const [ts, id] = Buffer.from(c, 'base64url').toString('utf8').split('|');
    if (!ts || !id || Number.isNaN(Date.parse(ts))) return null;
    return { ts, id };
  } catch { return null; }
}

// ── GET /audit ───────────────────────────────────────────────────────────────
router.get('/', FILTERS, async (req, res, next) => {
  if (vErr(req, res)) return;
  try {
    const { where, params } = buildWhere(req);
    const limit = req.query.limit ?? 50;

    if (req.query.cursor) {
      const c = decodeCursor(req.query.cursor);
      if (!c) return res.status(422).json({ error: 'Invalid cursor' });
      params.push(c.ts, c.id);
      where.push(`(a.created_at, a.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
    }

    const sql = `SELECT a.*, u.email, u.first_name, u.last_name, u.role ${FROM}
                  WHERE ${where.join(' AND ')}
                  ORDER BY a.created_at DESC, a.id DESC
                  LIMIT ${limit + 1}`;
    const countSql = `SELECT COUNT(*)::int AS count ${FROM} WHERE ${buildWhere(req).where.join(' AND ')}`;

    const [{ rows }, { rows: [{ count }] }] = await Promise.all([
      query(sql, params),
      query(countSql, buildWhere(req).params),
    ]);
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    res.json({
      total: count,
      entries: page.map(formatRow),
      nextCursor: hasMore ? encodeCursor(page[page.length - 1]) : null,
    });
  } catch (err) { next(err); }
});

// ── GET /audit.csv ───────────────────────────────────────────────────────────
const csvCell = (v) => {
  const s = v == null ? '' : (typeof v === 'object' ? JSON.stringify(v) : String(v));
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

router.get('/export.csv', FILTERS, async (req, res, next) => {
  if (vErr(req, res)) return;
  try {
    const { where, params } = buildWhere(req);
    const { rows } = await query(
      `SELECT a.*, u.email, u.first_name, u.last_name, u.role ${FROM}
        WHERE ${where.join(' AND ')} ORDER BY a.created_at DESC, a.id DESC LIMIT 20000`, params
    );
    const header = 'created_at,action,resource_type,resource_id,actor,actor_role,source,ip,details';
    const lines = rows.map(formatRow).map((r) => [
      r.createdAt instanceof Date ? r.createdAt.toISOString() : r.createdAt,
      r.action, r.resourceType, r.resourceId, r.actor.name, r.actor.role, r.source, r.ip, r.details,
    ].map(csvCell).join(','));
    // UTF-8 BOM so Excel reads the non-ASCII in details. Built at runtime rather
    // than written as a literal or an escape: editors normalise one into the
    // other, and the literal form trips eslint's no-irregular-whitespace.
    const BOM = String.fromCharCode(0xfeff);
    res
      .set('Content-Type', 'text/csv; charset=utf-8')
      .set('Content-Disposition', 'attachment; filename="audit-trail.csv"')
      .send(`${BOM}${[header, ...lines].join('\r\n')}\r\n`);
  } catch (err) { next(err); }
});

// ── GET /audit/actions ───────────────────────────────────────────────────────
router.get('/actions', async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT action, COUNT(*)::int AS count FROM audit_logs WHERE organisation_id = $1
        GROUP BY action ORDER BY action`, [orgId(req)]
    );
    res.json({ actions: rows });
  } catch (err) { next(err); }
});

module.exports = router;
