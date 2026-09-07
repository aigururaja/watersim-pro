/**
 * The database the test suite uses — never the one the running app uses.
 *
 * TEST_DATABASE_URL wins when set. Otherwise:
 *   SQLite    a `_test` sibling of the dev file (`data/watersim.db` →
 *             `data/watersim_test.db`); with no DATABASE_URL at all, the
 *             driver's default file gets the same treatment.
 *   Postgres  the dev URL's database name gets a `_test` suffix
 *             (`watersim_dev` → `watersim_test`).
 * Either way a developer with the app running can run the suite without its
 * poller, twin loop and jobs touching the rows the tests are asserting on.
 */
'use strict';

const path = require('path');

const isSqliteUrl = (url) => !url || String(url).startsWith('sqlite:');

/** Absolute file behind a sqlite: URL (the driver's own resolution rules). */
function sqliteFile(url) {
  if (!url) return path.resolve(__dirname, '..', 'data', 'watersim.db');
  let p = String(url).slice('sqlite:'.length);
  if (p.startsWith('//')) p = p.slice(2);
  if (!p || p === ':memory:') return ':memory:';
  return path.resolve(p);
}

function testDbUrl(devUrl = process.env.DATABASE_URL) {
  if (process.env.TEST_DATABASE_URL) return process.env.TEST_DATABASE_URL;
  if (isSqliteUrl(devUrl)) {
    const file = sqliteFile(devUrl);
    if (file === ':memory:') return 'sqlite::memory:';
    const ext  = path.extname(file) || '.db';
    const base = path.basename(file, ext).replace(/_dev$/, '');
    return `sqlite:${path.join(path.dirname(file), `${base}_test${ext}`)}`;
  }
  try {
    const u = new URL(devUrl);
    const name = u.pathname.replace(/^\//, '');
    if (!name) return null;
    u.pathname = `/${name.replace(/_dev$/, '')}_test`;
    return u.toString();
  } catch {
    return null;
  }
}

/** The maintenance database on the same Postgres server, for CREATE DATABASE. */
function adminDbUrl(url) {
  const u = new URL(url);
  u.pathname = '/postgres';
  return u.toString();
}

module.exports = { testDbUrl, adminDbUrl, isSqliteUrl, sqliteFile };
