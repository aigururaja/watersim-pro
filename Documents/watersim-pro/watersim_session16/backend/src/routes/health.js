const express = require('express');
const { testConnection } = require('../db');
const config = require('../config');

const router = express.Router();

/**
 * GET /api/health
 * Returns platform health and DB connectivity status.
 */
router.get('/', async (req, res) => {
  const start = Date.now();
  let dbStatus = 'ok';
  let dbInfo = null;

  try {
    dbInfo = await testConnection();
  } catch (err) {
    dbStatus = 'error';
  }

  const uptime = process.uptime();

  res.status(dbStatus === 'ok' ? 200 : 503).json({
    success: dbStatus === 'ok',
    status: dbStatus === 'ok' ? 'healthy' : 'degraded',
    timestamp: new Date().toISOString(),
    version: process.env.npm_package_version || '0.1.0',
    environment: config.env,
    uptime: Math.floor(uptime),
    responseTimeMs: Date.now() - start,
    services: {
      database: {
        status: dbStatus,
        ...(dbInfo && { server_time: dbInfo.now, database: dbInfo.db }),
      },
    },
  });
});

module.exports = router;
