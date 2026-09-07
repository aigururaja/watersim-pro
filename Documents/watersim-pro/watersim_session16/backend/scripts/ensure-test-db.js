/**
 * Jest global setup: give the suite a database of its own and migrate it.
 *
 * The suite wants a separate database (`watersim_test`, or TEST_DATABASE_URL),
 * so a running app's poller, twin loop and jobs never collide with what the
 * tests assert on. It is created here if the role may CREATE DATABASE, and
 * migrated on every run. When the role may not create it, the dev database
 * is used with a loud warning: create the test database once as a superuser
 * (`CREATE DATABASE watersim_test OWNER watersim;`) and the warning goes away.
 *
 * The URL chosen here reaches every test file through TEST_DATABASE_URL.
 */
'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { spawnSync } = require('child_process');
const path = require('path');
const { Client } = require('pg');
const { testDbUrl, adminDbUrl } = require('./testDbUrl');

function migrate(url) {
  const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'src', 'db', 'migrate.js'), 'up'], {
    env: { ...process.env, DATABASE_URL: url, NODE_ENV: 'test' },
    encoding: 'utf8',
  });
  if (r.status !== 0) throw new Error(`migrations failed:\n${r.stdout}\n${r.stderr}`);
  if (/Running \d+ pending/.test(r.stdout)) process.stdout.write(`[test-db] ${r.stdout.trim().split('\n').pop()}\n`);
}

async function databaseExists(url) {
  const name = new URL(url).pathname.replace(/^\//, '');
  const admin = new Client({ connectionString: adminDbUrl(url) });
  await admin.connect();
  try {
    const { rows } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
    if (rows.length) return true;
    await admin.query(`CREATE DATABASE "${name.replace(/"/g, '""')}"`);
    process.stdout.write(`\n[test-db] created database ${name}\n`);
    return true;
  } finally {
    await admin.end();
  }
}

module.exports = async function ensureTestDb() {
  if (process.env.TEST_DATABASE_URL) { migrate(process.env.TEST_DATABASE_URL); return; }
  const devUrl = process.env.DATABASE_URL;
  const url = testDbUrl(devUrl);
  if (!devUrl || !url) return;

  try {
    await databaseExists(url);
    migrate(url);
    process.env.TEST_DATABASE_URL = url;
  } catch (err) {
    const name = new URL(url).pathname.replace(/^\//, '');
    process.stdout.write(
      `\n[test-db] WARNING: no separate test database (${err.message.split('\n')[0]}).\n`
      + `[test-db] Tests will run on the DEV database; a running app can collide with them.\n`
      + `[test-db] Fix once, as a Postgres superuser:  CREATE DATABASE ${name} OWNER ${new URL(devUrl).username || 'watersim'};\n`
    );
    process.env.TEST_DATABASE_URL = devUrl;
  }
};
