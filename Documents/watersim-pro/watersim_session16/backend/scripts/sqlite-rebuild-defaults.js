/**
 * One-off: move column DEFAULTs from SQLite's own clock to the driver's.
 *
 * Databases created before commit "monotonic NOW()" have
 *   DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 * on every timestamp column. That clock is separate from the NOW() the driver
 * registers (so a default could sit a fraction of a millisecond ahead of a
 * NOW() evaluated right after the insert) and it has millisecond resolution
 * (so rows written in one burst tie, and an ORDER BY on them falls back to a
 * random UUID tiebreak). Fresh databases now get DEFAULT (NOW()) from the
 * migrations; this script converts an existing file.
 *
 * SQLite cannot ALTER a default, so each affected table is rebuilt the
 * documented way: create the new table under a temporary name from the old
 * CREATE statement with the default replaced, copy every row, drop the old
 * table, rename, recreate its indexes; foreign keys are off for the duration
 * so dropping a table does not cascade into its children, and
 * foreign_key_check runs before the commit.
 *
 * Run with the service STOPPED (one writer), as the service user:
 *   sudo -u watersim -H watersim-node scripts/sqlite-rebuild-defaults.js
 * Locally (DATABASE_URL from backend/.env):
 *   node scripts/sqlite-rebuild-defaults.js
 * Safe to re-run: with nothing left to convert it exits without touching the file.
 */
'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const pool = require('../src/db/pool');

if (!pool.isSqlite) {
  console.error('DATABASE_URL is not a SQLite database — nothing to do.');
  process.exit(1);
}

const db  = pool.raw;
const OLD = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";

const tables = db
  .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND sql LIKE '%strftime(%' ORDER BY rowid")
  .all();

if (!tables.length) {
  console.log(`✅  ${pool.databasePath}: no strftime() defaults left — nothing to do.`);
  process.exit(0);
}

console.log(`▶  ${pool.databasePath}: rebuilding ${tables.length} table(s) with DEFAULT (NOW())`);

db.exec('PRAGMA foreign_keys = OFF');
db.exec('BEGIN IMMEDIATE');
try {
  for (const { name, sql } of tables) {
    if (!sql.includes(OLD)) throw new Error(`${name}: unexpected strftime default, refusing to guess`);
    const tmp = `${name}__new`;
    const createTmp = sql
      .replace(new RegExp(`^CREATE TABLE\\s+"?${name}"?\\s*\\(`), `CREATE TABLE "${tmp}" (`)
      .split(OLD).join('NOW()');
    if (!createTmp.startsWith(`CREATE TABLE "${tmp}"`)) throw new Error(`${name}: could not rewrite CREATE TABLE`);

    const indexes = db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL")
      .all(name);
    const before = db.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get().n;

    db.exec(createTmp);
    db.exec(`INSERT INTO "${tmp}" SELECT * FROM "${name}"`);
    db.exec(`DROP TABLE "${name}"`);
    db.exec(`ALTER TABLE "${tmp}" RENAME TO "${name}"`);
    for (const { sql: ix } of indexes) db.exec(ix);

    const after = db.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get().n;
    if (after !== before) throw new Error(`${name}: row count changed ${before} → ${after}`);
    console.log(`   ✓ ${name} (${after} rows, ${indexes.length} indexes)`);
  }

  const problems = db.prepare('PRAGMA foreign_key_check').all();
  if (problems.length) throw new Error(`foreign_key_check reported ${problems.length} problem row(s)`);

  const left = db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND sql LIKE '%strftime(%'").get().n;
  if (left) throw new Error(`${left} table(s) still carry a strftime default`);

  db.exec('COMMIT');
} catch (err) {
  db.exec('ROLLBACK');
  console.error(`❌  rolled back: ${err.message}`);
  process.exit(1);
}
db.exec('PRAGMA foreign_keys = ON');
console.log('✅  done — every timestamp default now uses NOW()');
