/**
 * The database the test suite uses — never the one the running app uses.
 *
 * TEST_DATABASE_URL wins when set. Otherwise the dev URL's database name gets
 * a `_test` suffix (`watersim_dev` → `watersim_test`), so a developer with
 * the app running on `watersim_dev` can run the suite without its poller,
 * twin loop and jobs touching the rows the tests are asserting on.
 */
'use strict';

function testDbUrl(devUrl = process.env.DATABASE_URL) {
  if (process.env.TEST_DATABASE_URL) return process.env.TEST_DATABASE_URL;
  if (!devUrl) return null;
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

/** The maintenance database on the same server, for CREATE DATABASE. */
function adminDbUrl(url) {
  const u = new URL(url);
  u.pathname = '/postgres';
  return u.toString();
}

module.exports = { testDbUrl, adminDbUrl };
