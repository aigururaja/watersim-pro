/**
 * WaterSim Pro — Database Connection Pool
 *
 * Supports both DATABASE_URL (production/Docker) and individual
 * DB_HOST/DB_PORT/DB_NAME/DB_USER/DB_PASSWORD env vars (local dev).
 *
 * SSL: enabled when DATABASE_URL contains ?sslmode=require, or when
 * DB_SSL=true env var is set. Uses NODE_EXTRA_CA_CERTS for custom CAs.
 */
const { Pool } = require('pg');
const logger   = require('../utils/logger');

require('dotenv').config();

function buildPoolConfig() {
  const isProduction = process.env.NODE_ENV === 'production';

  // SSL config: always enabled in prod if DATABASE_URL has sslmode, or DB_SSL=true
  let ssl = false;
  if (process.env.DB_SSL === 'true' || isProduction) {
    ssl = { rejectUnauthorized: true };
    // Allow self-signed in dev/staging with DB_SSL_REJECT_UNAUTHORIZED=false
    if (process.env.DB_SSL_REJECT_UNAUTHORIZED === 'false') {
      ssl.rejectUnauthorized = false;
    }
  }

  if (process.env.DATABASE_URL) {
    return {
      connectionString: process.env.DATABASE_URL,
      min:  parseInt(process.env.DB_POOL_MIN  || '2',  10),
      max:  parseInt(process.env.DB_POOL_MAX  || '10', 10),
      idleTimeoutMillis:    parseInt(process.env.DB_IDLE_TIMEOUT_MS    || '30000', 10),
      connectionTimeoutMillis: parseInt(process.env.DB_CONNECTION_TIMEOUT_MS || '5000', 10),
      ssl,
    };
  }

  return {
    host:     process.env.DB_HOST     || 'localhost',
    port:     parseInt(process.env.DB_PORT || '5432', 10),
    database: process.env.DB_NAME     || 'watersim_dev',
    user:     process.env.DB_USER     || 'watersim',
    password: process.env.DB_PASSWORD || 'watersim_dev_pw',
    min:  parseInt(process.env.DB_POOL_MIN || '2',  10),
    max:  parseInt(process.env.DB_POOL_MAX || '10', 10),
    idleTimeoutMillis:    parseInt(process.env.DB_IDLE_TIMEOUT_MS    || '30000', 10),
    connectionTimeoutMillis: parseInt(process.env.DB_CONNECTION_TIMEOUT_MS || '5000', 10),
    ssl,
  };
}

const pool = new Pool(buildPoolConfig());

pool.on('error', (err) => {
  logger.error('Unexpected PostgreSQL pool error', { error: err.message });
});

pool.on('connect', () => {
  if (process.env.LOG_LEVEL === 'debug') {
    logger.debug('New DB client connected to pool');
  }
});

/**
 * Execute a single query. Returns pg QueryResult.
 */
async function query(text, params) {
  const start  = Date.now();
  const result = await pool.query(text, params);
  const ms     = Date.now() - start;
  if (process.env.LOG_LEVEL === 'debug') {
    logger.debug('DB query', { text: text.slice(0, 80), ms, rows: result.rowCount });
  }
  if (ms > 3000) {
    logger.warn('Slow DB query detected', { text: text.slice(0, 80), ms });
  }
  return result;
}

/**
 * Acquire a dedicated client for transactions.
 * ALWAYS call client.release() in a finally block.
 */
async function getClient() {
  return pool.connect();
}

/**
 * Run a function inside a transaction.
 * Automatically commits on success, rolls back on error.
 * The callback receives a dedicated client: `withTransaction(async (client) => { ... })`.
 */
async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Test connectivity — used by /health endpoint.
 * Returns { now, db } from the server.
 */
async function testConnection() {
  const client = await pool.connect();
  try {
    const res = await client.query('SELECT NOW() AS now, current_database() AS db');
    return res.rows[0];
  } finally {
    client.release();
  }
}

module.exports = { query, getClient, withTransaction, testConnection, pool };
