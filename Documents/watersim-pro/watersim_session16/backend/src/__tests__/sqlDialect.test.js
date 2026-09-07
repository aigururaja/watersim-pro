/**
 * SQLite driver — PostgreSQL dialect translation.
 *
 * The application's SQL is written for PostgreSQL and the SQLite driver
 * translates it (see src/db/sqlite.js). Most dialect gaps announce themselves
 * as syntax errors, so a broken translation fails loudly. The dangerous ones
 * are the constructs SQLite *accepts* with different meaning — those return a
 * plausible wrong answer and no error at all. `CURRENT_DATE - 6` is the worst
 * of them: SQLite's CURRENT_DATE is the text '2026-09-07', so subtracting 6
 * coerces it to a number and yields 2020, and a rolling-window predicate like
 * `WHERE day >= CURRENT_DATE - 6` silently matches every row ever recorded.
 *
 * These tests run against an in-memory database and need no TEST_DB.
 */
'use strict';

process.env.DATABASE_URL = 'sqlite::memory:';
const { query, translateSql } = require('../db/sqlite');

const day = (offset) =>
  new Date(Date.now() - offset * 86400000).toISOString().slice(0, 10);

beforeAll(async () => {
  await query(`CREATE TABLE counters (day DATE, runs REAL)`);
  await query(`CREATE TABLE ev (id INTEGER PRIMARY KEY, severity TEXT, ts TIMESTAMPTZ)`);
  for (let d = 0; d < 12; d++) {
    await query(`INSERT INTO counters (day, runs) VALUES ($1, $2)`, [day(d), d]);
  }
  const now = new Date().toISOString();
  await query(
    `INSERT INTO ev (severity, ts) VALUES ('critical', $1), ('warning', $1), ('info', $1)`,
    [now]
  );
});

describe('date arithmetic', () => {
  it('bounds a CURRENT_DATE - N window to N+1 days, not the whole table', async () => {
    const { rows } = await query(
      `SELECT COUNT(*)::int AS n FROM counters WHERE day >= CURRENT_DATE - 6`
    );
    expect(rows[0].n).toBe(7);          // 12 rows exist; an untranslated window returns all 12
  });

  it('translates CURRENT_DATE - N to a real date, never to bare arithmetic', () => {
    const out = translateSql(`SELECT * FROM t WHERE day >= CURRENT_DATE - 6`);
    expect(out).toContain(`date('now','-6 days')`);
    expect(out).not.toMatch(/CURRENT_DATE\s*-\s*6/);
  });

  it('handles the INTERVAL spelling and forward offsets too', () => {
    expect(translateSql(`SELECT CURRENT_DATE - INTERVAL '30 days'`))
      .toContain(`date('now','-30 days')`);
    expect(translateSql(`SELECT CURRENT_DATE + 1`))
      .toContain(`date('now','+1 days')`);
  });

  it('keeps NOW() - INTERVAL windows bounded', async () => {
    const { rows } = await query(
      `SELECT COUNT(*)::int AS n FROM ev WHERE ts > NOW() - INTERVAL '24 hours'`
    );
    expect(rows[0].n).toBe(3);
  });
});

describe('constructs that run unchanged on both engines', () => {
  it('supports aggregate FILTER (WHERE …) natively', async () => {
    const { rows } = await query(
      `SELECT COUNT(*) FILTER (WHERE severity = 'critical')::int AS critical,
              COUNT(*) FILTER (WHERE severity = 'warning')::int  AS warning
         FROM ev`
    );
    expect(rows[0]).toEqual({ critical: 1, warning: 1 });
  });

  it('rewrites = ANY($n::text[]) into an IN over the bound array', async () => {
    const { rows } = await query(
      `SELECT COUNT(*)::int AS n FROM ev WHERE severity = ANY($1::text[])`,
      [['critical', 'info']]
    );
    expect(rows[0].n).toBe(2);
  });

  it('strips ::int / ::float casts without changing the value', async () => {
    const { rows } = await query(`SELECT COUNT(*)::int AS c, SUM(id)::float AS s FROM ev`);
    expect(rows[0].c).toBe(3);
    expect(rows[0].s).toBe(6);
  });
});
