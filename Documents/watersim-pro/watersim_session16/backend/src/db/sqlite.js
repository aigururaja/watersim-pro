/**
 * SafeKrit — SQLite driver (node:sqlite), behind the same API as pg.js
 *
 * The application's SQL is written for PostgreSQL. This module runs it on
 * SQLite by:
 *
 *   1. Translating the dialect differences that are mechanical —
 *        $1 … $n              → ?1 … ?n
 *        x = ANY($1::uuid[])  → x IN (SELECT value FROM json_each(?1))
 *        expr::type           → expr                    (SQLite is dynamically typed)
 *        NOW() ± INTERVAL 'x' → strftime(…, 'now', '±x')
 *        CURRENT_DATE ± n     → date('now', '±n days')
 *        ILIKE                → LIKE                    (case-insensitive for ASCII)
 *        FOR UPDATE [SKIP LOCKED] → (removed; one process, one writer)
 *        ARRAY[a, b]          → json_array(a, b)
 *        DEFAULT NOW()        → DEFAULT (NOW())        (the registered function)
 *        UPDATE t SET …       → UPDATE t SET updated_at = now, … when t has an
 *                               updated_at column and the statement does not
 *                               set it (what the Postgres trigger did).
 *   2. Registering the Postgres functions the SQL calls — NOW(),
 *      gen_random_uuid(), uuid_generate_v4() — and REGEXP for CHECK constraints.
 *   3. Converting values at the boundary. Parameters: booleans → 0/1, Dates →
 *      ISO-8601 UTC text, arrays and objects → JSON text. Results: columns
 *      declared BOOLEAN, JSONB or TIMESTAMPTZ come back as booleans, parsed
 *      JSON and Date objects, exactly as node-postgres returned them. The
 *      declared types are read from the schema once and refreshed after DDL.
 *   4. Mapping constraint failures to the Postgres SQLSTATE codes the routes
 *      test for (23505 unique, 23503 foreign key, 23514 check, 23502 not null).
 *
 * Timestamps are stored as ISO-8601 UTC text. A bound Date is written with
 * millisecond precision ("2026-09-07T10:00:00.000Z"); NOW() and the column
 * DEFAULTs write the same millisecond plus a three-digit sequence
 * ("2026-09-07T10:00:00.000017Z"), strictly monotonic within the process and
 * never ahead of wall time (see nowIso), so string comparison orders every
 * mix of the two correctly and rows written in one burst never tie. A
 * database created before DEFAULT (NOW()) is brought in line by
 * scripts/sqlite-rebuild-defaults.js.
 *
 * Concurrency: node:sqlite is synchronous on one connection. A transaction
 * holds an async mutex for its whole duration and runs its callback inside an
 * AsyncLocalStorage context, so queries issued from within the callback (via
 * the client or the module-level query()) join the transaction, while queries
 * from any other request wait until it commits. Nested withTransaction() calls
 * join the outer transaction.
 *
 * Location: DATABASE_URL=sqlite:<path> (also sqlite:///abs/path and
 * sqlite::memory:), else SQLITE_PATH, else backend/data/watersim.db.
 */
'use strict';

require('dotenv').config();

const path   = require('node:path');
const fs     = require('node:fs');
const crypto = require('node:crypto');
const { AsyncLocalStorage } = require('node:async_hooks');
// process.getBuiltinModule bypasses module resolvers (Jest) that predate node:sqlite.
const { DatabaseSync } = process.getBuiltinModule
  ? process.getBuiltinModule('node:sqlite')
  : require('node:sqlite');
const logger = require('../utils/logger');

// One clock for every timestamp the database generates — NOW() in queries,
// column DEFAULTs, the updated_at the driver adds — and a strictly monotonic
// one. Date.now() has millisecond resolution, so a burst of inserts would
// otherwise share a value and an ORDER BY on it would fall back to a random
// UUID tiebreak (a coin flip in tests, a wrong "latest" in the app). Every
// value is 27 characters, "2026-09-07T10:00:00.123000Z": the real millisecond
// followed by a per-millisecond sequence in the microsecond digits. So the
// clock never runs ahead of wall time — a JS Date bound as a parameter for
// the same millisecond ("…123Z") still compares as later, because "0" sorts
// before "Z" — and a thousand values per millisecond stay strictly ordered.
// Both JS Date parsing and SQLite's date functions accept the extra digits.
let lastMs = 0;
let seq = 0;
const nowIso = () => {
  const t = Date.now();
  if (t > lastMs) { lastMs = t; seq = 0; }
  else if (seq < 999) { seq += 1; }
  else { lastMs += 1; seq = 0; }            // >1000 in one ms: concede one ms of drift
  const base = new Date(lastMs).toISOString();   // "…sss" + "Z"
  return `${base.slice(0, -1)}${String(seq).padStart(3, '0')}Z`;
};
const NOW_EXPR = 'NOW()';

// ── Location ─────────────────────────────────────────────────────────────────

function databasePath() {
  const url = process.env.DATABASE_URL || '';
  if (url.startsWith('sqlite:')) {
    let p = url.slice('sqlite:'.length);
    if (p.startsWith('//')) p = p.slice(2);            // sqlite:///abs/path → /abs/path
    if (!p || p === ':memory:') return ':memory:';
    return path.resolve(p);
  }
  if (process.env.SQLITE_PATH) return path.resolve(process.env.SQLITE_PATH);
  return path.resolve(__dirname, '..', '..', 'data', 'watersim.db');
}

// ── Connection ───────────────────────────────────────────────────────────────

const file = databasePath();
if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });

const db = new DatabaseSync(file);
db.exec('PRAGMA foreign_keys = ON');
db.exec('PRAGMA busy_timeout = 5000');
if (file !== ':memory:') {
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
}
db.function('NOW', nowIso);
db.function('gen_random_uuid', () => crypto.randomUUID());
db.function('uuid_generate_v4', () => crypto.randomUUID());
db.function('regexp', { deterministic: true }, (re, s) =>
  (re == null || s == null ? null : (new RegExp(String(re)).test(String(s)) ? 1 : 0)));

let closed = false;

// ── Schema knowledge (declared column types, tables with updated_at) ─────────

let schema = null;

function loadSchema() {
  if (schema) return schema;
  const types = new Map();       // column name → 'bool' | 'json' | 'ts'
  const touch = new Set();       // tables with an updated_at column
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all();
  for (const { name } of tables) {
    for (const col of db.prepare(`PRAGMA table_info("${String(name).replace(/"/g, '""')}")`).all()) {
      const t = String(col.type || '').toUpperCase();
      const kind = t.includes('BOOL') ? 'bool' : t.includes('JSON') ? 'json' : t.includes('TIMESTAMP') ? 'ts' : null;
      if (kind && !types.has(col.name)) types.set(col.name, kind);
      if (col.name === 'updated_at') touch.add(String(name).toLowerCase());
    }
  }
  schema = { types, touch };
  return schema;
}

function invalidateSchema() {
  schema = null;
  translated.clear();
  statements.clear();
}

// ── SQL translation ──────────────────────────────────────────────────────────

const CAST_RE = /::(?:int|integer|bigint|smallint|text|varchar|uuid|jsonb|json|boolean|bool|float8|float4|float|numeric|real|double precision|timestamptz|timestamp|date|interval|regclass)(?:\[\])?/gi;
const UPDATE_RE = /^(\s*UPDATE\s+"?([A-Za-z_][A-Za-z0-9_]*)"?(?:\s+(?:AS\s+)?[A-Za-z_][A-Za-z0-9_]*)?\s+SET\s+)/i;

const translated = new Map();

function translate(sql) {
  const hit = translated.get(sql);
  if (hit) return hit;
  let s = sql;
  s = s.replace(/\$(\d+)/g, '?$1');
  s = s.replace(/=\s*ANY\s*\(\s*\?(\d+)(?:::[A-Za-z_]+(?:\[\])?)?\s*\)/gi, 'IN (SELECT value FROM json_each(?$1))');
  s = s.replace(CAST_RE, '');
  s = s.replace(/NOW\(\)\s*([-+])\s*INTERVAL\s*'([^']+)'/gi,
    (_m, op, iv) => `strftime('%Y-%m-%dT%H:%M:%fZ','now','${op}${iv.trim()}')`);
  // Date arithmetic on CURRENT_DATE. This one is a silent trap rather than a
  // syntax error: SQLite's CURRENT_DATE is the text '2026-09-07', so
  // `CURRENT_DATE - 6` coerces it to a number (2026) and yields 2020, and a
  // `day >= CURRENT_DATE - 6` window quietly matches every row ever recorded.
  // Both the integer-days and INTERVAL spellings become a real date().
  s = s.replace(/\bCURRENT_DATE\s*([-+])\s*INTERVAL\s*'([^']+)'/gi,
    (_m, op, iv) => `date('now','${op}${iv.trim()}')`);
  s = s.replace(/\bCURRENT_DATE\s*([-+])\s*(\d+)(?!\s*\d)\b/gi,
    (_m, op, n) => `date('now','${op}${n} days')`);
  s = s.replace(/\bCURRENT_DATE\b/gi, "date('now')");   // same value, said explicitly
  s = s.replace(/\bILIKE\b/gi, 'LIKE');
  s = s.replace(/\s+FOR\s+UPDATE(?:\s+SKIP\s+LOCKED|\s+NOWAIT)?/gi, '');
  s = s.replace(/\bARRAY\s*\[([^\]]*)\]/gi, 'json_array($1)');
  s = s.replace(/DEFAULT\s+NOW\(\)/gi, `DEFAULT (${NOW_EXPR})`);
  // `UPDATE t alias SET …` (and `UPDATE t alias SET … FROM …`): SQLite takes a
  // target alias only as `AS alias`.
  s = s.replace(/^(\s*UPDATE\s+"?[A-Za-z_][A-Za-z0-9_]*"?)\s+([A-Za-z_][A-Za-z0-9_]*)\s+SET\b/i, '$1 AS $2 SET');
  s = s.replace(/^(\s*DELETE\s+FROM\s+"?[A-Za-z_][A-Za-z0-9_]*"?)\s+([A-Za-z_][A-Za-z0-9_]*)\s+(WHERE|USING|RETURNING)\b/i, '$1 AS $2 $3');
  // `RETURNING t.*` — SQLite allows no table qualifier there; a bare `*` is the
  // modified table's columns, which is what `t.*` meant.
  s = s.replace(/\bRETURNING\s+"?[A-Za-z_][A-Za-z0-9_]*"?\.\*/gi, 'RETURNING *');
  // What Postgres' set_updated_at() BEFORE UPDATE trigger did.
  const m = UPDATE_RE.exec(s);
  if (m && loadSchema().touch.has(m[2].toLowerCase()) && !/\bupdated_at\s*=/i.test(s)) {
    s = `${m[1]}updated_at = ${NOW_EXPR}, ${s.slice(m[1].length)}`;
  }
  if (translated.size > 1000) translated.clear();
  translated.set(sql, s);
  return s;
}

// ── Values at the boundary ───────────────────────────────────────────────────

function bind(v) {
  if (v === undefined || v === null) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' || typeof v === 'bigint') return v;
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) return v;
  if (Array.isArray(v) || typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function convertRow(row, types) {
  const out = {};
  for (const k in row) {
    const v = row[k];
    const kind = v === null || v === undefined ? null : types.get(k);
    if (!kind) { out[k] = v; continue; }
    if (kind === 'bool') {
      out[k] = typeof v === 'number' ? v !== 0 : (v === true || v === 'true' || v === 't' || v === '1');
    } else if (kind === 'json') {
      if (typeof v === 'string') { try { out[k] = JSON.parse(v); } catch { out[k] = v; } } else out[k] = v;
    } else if (kind === 'ts') {
      if (typeof v === 'string') { const d = new Date(v); out[k] = Number.isNaN(d.getTime()) ? v : d; } else out[k] = v;
    } else {
      out[k] = v;
    }
  }
  return out;
}

// ── Errors ───────────────────────────────────────────────────────────────────

// SQLite extended result codes → PostgreSQL SQLSTATE the routes test for.
const PG_CODES = {
  2067: '23505', // SQLITE_CONSTRAINT_UNIQUE
  1555: '23505', // SQLITE_CONSTRAINT_PRIMARYKEY
  787:  '23503', // SQLITE_CONSTRAINT_FOREIGNKEY
  275:  '23514', // SQLITE_CONSTRAINT_CHECK
  1299: '23502', // SQLITE_CONSTRAINT_NOTNULL
};

function mapError(err, sql) {
  if (err && typeof err === 'object') {
    const code = PG_CODES[err.errcode];
    if (code) err.code = code;
    if (!err.sql) err.sql = String(sql).slice(0, 300);
  }
  return err;
}

// ── Execution (synchronous) ──────────────────────────────────────────────────

const statements = new Map();

function prepared(sql) {
  let stmt = statements.get(sql);
  if (!stmt) {
    stmt = db.prepare(sql);
    if (statements.size > 500) statements.clear();
    statements.set(sql, stmt);
  }
  return stmt;
}

const stripComments = (s) => s.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
const isMulti  = (s) => /;\s*\S/.test(stripComments(s));
const isDdl    = (s) => /(^|;)\s*(CREATE|ALTER|DROP)\b/i.test(stripComments(s));
const wantRows = (s) => /^\s*(WITH|SELECT|PRAGMA|EXPLAIN)\b/i.test(s) || /\bRETURNING\b/i.test(s);

function exec(text, params = []) {
  if (closed) throw new Error('SQLite connection is closed');
  const sql = translate(text);
  try {
    if (!stripComments(sql).trim()) return { rows: [], rowCount: 0 };
    if (!params.length && isMulti(sql)) {
      db.exec(sql);
      if (isDdl(sql)) invalidateSchema();
      return { rows: [], rowCount: 0 };
    }
    const ddl = isDdl(sql);
    const stmt = prepared(sql);
    const bound = params.map(bind);
    let result;
    if (wantRows(sql)) {
      const types = loadSchema().types;
      const rows = stmt.all(...bound).map((r) => convertRow(r, types));
      result = { rows, rowCount: rows.length };
    } else {
      const r = stmt.run(...bound);
      result = { rows: [], rowCount: Number(r.changes) };
    }
    if (ddl) invalidateSchema();
    return result;
  } catch (err) {
    throw mapError(err, sql);
  }
}

// ── Async API: mutex + transaction context ──────────────────────────────────

const txContext = new AsyncLocalStorage();
let tail = Promise.resolve();

function acquire() {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const ticket = tail.then(() => release);
  tail = tail.then(() => gate);
  return ticket;
}

const inTransaction = () => Boolean(txContext.getStore());

async function query(text, params) {
  if (inTransaction()) return exec(text, params);
  const release = await acquire();
  try {
    return exec(text, params);
  } finally {
    release();
  }
}

const txClient = {
  query: async (text, params) => exec(text, params),
  release() {},
};

async function withTransaction(fn) {
  if (inTransaction()) return fn(txClient);            // join the outer transaction
  const release = await acquire();
  try {
    return await txContext.run({ tx: true }, async () => {
      exec('BEGIN IMMEDIATE');
      try {
        const out = await fn(txClient);
        exec('COMMIT');
        return out;
      } catch (err) {
        try { exec('ROLLBACK'); } catch { /* already rolled back */ }
        throw err;
      }
    });
  } finally {
    release();
  }
}

/**
 * A dedicated client (migrate.js issues BEGIN/COMMIT on it by hand). Holds the
 * mutex until release(); its queries run in the transaction context so that
 * anything it calls joins in rather than waiting.
 */
async function getClient() {
  const release = await acquire();
  let released = false;
  const client = {
    query: async (text, params) => txContext.run({ tx: true }, () => exec(text, params)),
    release() {
      if (released) return;
      released = true;
      release();
    },
  };
  return client;
}

async function testConnection() {
  const { rows } = await query("SELECT NOW() AS now, 'sqlite' AS db");
  return rows[0];
}

const pool = {
  query,
  connect: getClient,
  on() {},
  async end() {
    if (closed) return;
    closed = true;
    try { db.close(); } catch (err) { logger.warn('SQLite close failed', { error: err.message }); }
  },
};

module.exports = {
  query,
  getClient,
  withTransaction,
  testConnection,
  pool,
  // SQLite-specific extras
  translateSql: translate,
  databasePath: file,
  NOW_EXPR,
  raw: db,
};
