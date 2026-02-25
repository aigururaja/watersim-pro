const { Pool } = require('pg');
const config = require('../config');
const logger = require('../utils/logger');

const pool = new Pool({
  connectionString: config.db.url,
  min: config.db.pool.min,
  max: config.db.pool.max,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on('error', (err) => {
  logger.error('Unexpected PostgreSQL pool error', { error: err.message });
});

/**
 * Execute a single query. Returns rows array.
 */
const query = async (text, params) => {
  const start = Date.now();
  try {
    const result = await pool.query(text, params);
    const duration = Date.now() - start;
    logger.debug('DB query', { duration, rows: result.rowCount });
    return result;
  } catch (err) {
    logger.error('DB query error', { error: err.message, query: text });
    throw err;
  }
};

/**
 * Get a client from the pool for transactions.
 * Always call client.release() in a finally block.
 */
const getClient = () => pool.connect();

/**
 * Run a function inside a transaction.
 * Automatically commits on success, rolls back on error.
 */
const withTransaction = async (fn) => {
  const client = await getClient();
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
};

/**
 * Test the database connection (used by health check).
 */
const testConnection = async () => {
  const result = await query('SELECT NOW() AS now, current_database() AS db');
  return result.rows[0];
};

module.exports = { query, getClient, withTransaction, testConnection, pool };
