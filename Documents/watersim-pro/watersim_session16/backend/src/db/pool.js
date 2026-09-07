/**
 * WaterSim Pro — Database client selector
 *
 * Every module requires `./db/pool` and gets the same five things:
 * `query(text, params)`, `getClient()`, `withTransaction(fn)`,
 * `testConnection()` and `pool`. Which engine answers is decided once, here:
 *
 *   DB_CLIENT=sqlite | pg          explicit
 *   DATABASE_URL=sqlite:<path>     SQLite (the default when the URL is unset)
 *   DATABASE_URL=postgres://…      PostgreSQL
 *
 * The SQL in the application is written in the PostgreSQL dialect; the SQLite
 * driver (./sqlite.js) translates the handful of constructs that differ and
 * converts values on the way in and out so callers see the same shapes
 * (booleans, Date objects, parsed JSON). The few places where a query cannot
 * be expressed the same way on both engines branch on `isSqlite`.
 */
'use strict';

require('dotenv').config();

function chooseClient() {
  const explicit = (process.env.DB_CLIENT || '').trim().toLowerCase();
  if (explicit === 'pg' || explicit === 'postgres' || explicit === 'postgresql') return 'pg';
  if (explicit === 'sqlite' || explicit === 'sqlite3') return 'sqlite';
  const url = process.env.DATABASE_URL || '';
  if (!url || url.startsWith('sqlite:')) return 'sqlite';
  return 'pg';
}

const client = chooseClient();
const impl = client === 'pg' ? require('./pg') : require('./sqlite');

module.exports = {
  ...impl,
  client,
  isSqlite: client === 'sqlite',
  isPg: client === 'pg',
};
