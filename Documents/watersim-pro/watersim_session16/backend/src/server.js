require('dotenv').config();
const express     = require('express');
const helmet      = require('helmet');
const cors        = require('cors');
const morgan      = require('morgan');
const compression = require('compression');
const rateLimit   = require('express-rate-limit');

const config             = require('./config');
const logger             = require('./utils/logger');
const { testConnection, query, pool } = require('./db/pool');
const { requestId }      = require('./middleware/requestId');
const { metricsMiddleware, metricsHandler } = require('./metrics');
const authRoutes         = require('./routes/auth');
const projectRoutes      = require('./routes/projects');
const flowsheetRoutes    = require('./routes/flowsheets');
const simulateRoutes     = require('./routes/simulate');
const reportRoutes       = require('./routes/reports');
const permitRoutes       = require('./routes/permitTemplates');
const adminRoutes        = require('./routes/admin');
const reportsOrgRoutes   = require('./routes/reports_org');
const plcRoutes          = require('./routes/plc');
const plcBindingRoutes   = require('./routes/plcBindings');
const { attachWsServer } = require('./collab/wsServer');
const { startPoller, stopPoller } = require('./plc/poller');

// ── Startup env validation ───────────────────────────────────────────────────
if (process.env.NODE_ENV === 'production') {
  const required = ['JWT_SECRET', 'DATABASE_URL', 'CORS_ORIGIN'];
  for (const key of required) {
    if (!process.env[key]) {
      throw new Error(`Missing required env var in production: ${key}`);
    }
  }
  if ((process.env.JWT_SECRET || '').length < 32) {
    throw new Error('JWT_SECRET must be at least 32 characters in production');
  }
}

const app  = express();
// Port comes from config only (single source of truth; default 4000, local dev
// overrides via backend/.env PORT=3001).
const PORT = config.port;
const API  = `/api/${process.env.API_VERSION || 'v1'}`;
const IS_PROD = process.env.NODE_ENV === 'production';

// ── Trust proxy (required when behind Nginx / load balancer) ────────────────
app.set('trust proxy', 1);

// ── Helmet — security headers ────────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc:     ["'self'"],
      scriptSrc:      ["'self'"],
      styleSrc:       ["'self'", "'unsafe-inline'"],  // Tailwind inline styles
      imgSrc:         ["'self'", 'data:', 'blob:'],
      connectSrc:     ["'self'", 'wss:', 'ws:'],      // WebSocket allowed
      fontSrc:        ["'self'"],
      objectSrc:      ["'none'"],
      frameSrc:       ["'none'"],
      baseUri:        ["'self'"],
      formAction:     ["'self'"],
      upgradeInsecureRequests: IS_PROD ? [] : null,
    },
  },
  // HSTS — only in production
  hsts: IS_PROD
    ? { maxAge: 31536000, includeSubDomains: true, preload: true }
    : false,
  // Prevent IE from MIME-sniffing
  noSniff: true,
  // Hide X-Powered-By
  hidePoweredBy: true,
  // XSS filter (legacy browsers)
  xssFilter: true,
}));

// ── CORS ─────────────────────────────────────────────────────────────────────
app.use(cors({
  origin:         process.env.CORS_ORIGIN || 'http://localhost:3000',
  credentials:    true,
  methods:        ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-Id'],
}));

// ── General middleware ────────────────────────────────────────────────────────
app.use(requestId);          // correlation id — before logging so morgan sees it
app.use(compression());
app.use(express.json({ limit: '5mb' }));
app.use(metricsMiddleware);  // http_request_duration histogram

// Access logs carry the request id; written at 'info' so they survive the
// production log level (logger.http was silently discarded when level=info).
morgan.token('id', (req) => req.id);
const MORGAN_PROD = ':remote-addr - :remote-user [:date[clf]] ":method :url HTTP/:http-version" :status :res[content-length] ":referrer" ":user-agent" reqId=:id';
const MORGAN_DEV  = ':method :url :status :response-time ms - :res[content-length] reqId=:id';
app.use(morgan(IS_PROD ? MORGAN_PROD : MORGAN_DEV, {
  stream: { write: (msg) => logger.info(msg.trim()) },
  // Skip health/metrics probe logs to avoid noise
  skip: (req) => req.path === '/health' || req.path === '/health/live' || req.path === '/metrics',
}));

// ── Rate limiters ─────────────────────────────────────────────────────────────
const globalLimiter = rateLimit({
  windowMs:        parseInt(process.env.RATE_LIMIT_WINDOW_MS || '900000', 10),
  max:             parseInt(process.env.RATE_LIMIT_MAX || '500', 10),
  standardHeaders: true,
  legacyHeaders:   false,
  message:         { error: 'Too many requests, please try again later' },
  skip:            () => process.env.NODE_ENV === 'test',
  // Key by real IP (trust proxy = 1 above)
  keyGenerator:    (req) => req.ip,
});

const authLimiter = rateLimit({
  windowMs:        15 * 60 * 1000,
  max:             parseInt(process.env.AUTH_RATE_LIMIT_MAX || '20', 10),
  message:         { error: 'Too many auth attempts, please try again later' },
  skip:            () => process.env.NODE_ENV === 'test',
  keyGenerator:    (req) => req.ip,
});

app.use(API, globalLimiter);

// ── Routes ────────────────────────────────────────────────────────────────────
app.use(`${API}/auth`,                                           authLimiter, authRoutes);
app.use(`${API}/projects`,                                       projectRoutes);
app.use(`${API}/projects/:projectId/flowsheets`,                 flowsheetRoutes);
app.use(`${API}/projects/:projectId/flowsheets/:flowsheetId/simulate`, simulateRoutes);
app.use(`${API}/projects/:projectId/flowsheets/:flowsheetId/simulate`, reportRoutes);
// PLC bindings live under the same base as simulate (plc-bindings, plc-values)
app.use(`${API}/projects/:projectId/flowsheets/:flowsheetId`,    plcBindingRoutes);
app.use(`${API}/permit-templates`,                               permitRoutes);
app.use(`${API}/admin`,                                          adminRoutes);
app.use(`${API}/reports`,                                        reportsOrgRoutes);
app.use(`${API}/plc`,                                            plcRoutes);

// ── Metrics (unauthenticated, outside the /api rate limiter) ─────────────────
// NOTE: /metrics must be network-restricted in production (cluster-internal
// scraper only) — it exposes operational detail and is deliberately exempt
// from auth and rate limiting so Prometheus can never be locked out.
app.get('/metrics', metricsHandler);

// ── Liveness probe — /health/live (no DB, no I/O) ────────────────────────────
// Used by orchestrators to answer "is the process alive?" — it must never
// touch the database, so a DB outage can't get healthy pods restarted.
app.get('/health/live', (_req, res) => {
  res.json({
    status: 'alive',
    uptime: Math.floor(process.uptime()),
    ts:     new Date().toISOString(),
  });
});

// ── Readiness — /health (k8s/backend.yaml + docker-compose probe this) ───────
// The DB check result is cached for ~5s so unauthenticated probe traffic can't
// open a DB connection per hit.
const HEALTH_CACHE_TTL_MS = 5000;
let healthCache = { at: 0, ok: false, dbInfo: null, promise: null };

async function checkDbCached() {
  const now = Date.now();
  if (now - healthCache.at < HEALTH_CACHE_TTL_MS && healthCache.promise === null) {
    return healthCache;
  }
  if (!healthCache.promise) {
    healthCache.promise = testConnection()
      .then((dbInfo) => { healthCache = { at: Date.now(), ok: true,  dbInfo, promise: null }; })
      .catch(()       => { healthCache = { at: Date.now(), ok: false, dbInfo: null, promise: null }; });
  }
  await healthCache.promise;
  return healthCache;
}

app.get('/health', async (_req, res) => {
  const start = Date.now();
  const { ok, dbInfo } = await checkDbCached();
  if (ok) {
    res.json({
      status:         'healthy',
      db:             'connected',
      version:        process.env.npm_package_version || '0.2.0',
      apiVersion:     process.env.API_VERSION || 'v1',
      environment:    process.env.NODE_ENV,
      uptime:         Math.floor(process.uptime()),
      responseTimeMs: Date.now() - start,
      ts:             new Date().toISOString(),
      dbServerTime:   dbInfo?.now,
    });
  } else {
    res.status(503).json({
      status:         'degraded',
      db:             'disconnected',
      uptime:         Math.floor(process.uptime()),
      responseTimeMs: Date.now() - start,
      ts:             new Date().toISOString(),
    });
  }
});

// ── 404 handler ───────────────────────────────────────────────────────────────
app.use((_req, res) => res.status(404).json({ error: 'Route not found' }));

// ── Global error handler ──────────────────────────────────────────────────────
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  const status  = err.statusCode || err.status || 500;
  const message = err.isOperational ? err.message : 'Internal server error';
  if (status >= 500) {
    logger.error('Unhandled error', { requestId: req.id, error: err.message, stack: err.stack });
  }
  res.status(status).json({ error: message, requestId: req.id });
});

// ── Startup ───────────────────────────────────────────────────────────────────
async function start() {
  try {
    await testConnection();
    logger.info('Database connected');
  } catch (err) {
    logger.warn('Database not available — server starting anyway', { error: err.message });
  }

  const server = app.listen(PORT, '0.0.0.0', () =>
    logger.info('WaterSim API running', { port: PORT, env: process.env.NODE_ENV, api: API })
  );

  const wss = attachWsServer(server);

  // ── PLC poller ─────────────────────────────────────────────────────────────
  // Reads bound PLC tags and pushes live values into flowsheet WS rooms.
  // No-op under NODE_ENV=test (poller guards this itself).
  startPoller();

  // ── Stale-run reaper ───────────────────────────────────────────────────────
  // Runs inserted as 'running' orphan forever if the process dies mid-run.
  // Every 5 minutes, mark anything stuck in 'running' for >15 min as failed.
  const REAPER_INTERVAL_MS = 5 * 60 * 1000;
  const reaper = setInterval(async () => {
    try {
      const r = await query(
        `UPDATE simulation_runs
         SET status = 'failed', error_message = 'timed out / orphaned', completed_at = NOW()
         WHERE status = 'running' AND started_at < NOW() - INTERVAL '15 minutes'`
      );
      if (r.rowCount > 0) logger.warn('Stale-run reaper marked orphaned runs failed', { count: r.rowCount });
    } catch (err) {
      logger.error('Stale-run reaper failed', { error: err.message });
    }
  }, REAPER_INTERVAL_MS);
  reaper.unref();

  // ── Graceful shutdown ──────────────────────────────────────────────────────
  // Order: stop the reaper → close WS connections (proper close frame) →
  // drain HTTP → close the pg pool → exit.
  let shuttingDown = false;
  const shutdown = (signal, exitCode = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`${signal} received — shutting down gracefully`);

    clearInterval(reaper);

    // Stop the PLC poller (clears its interval, disconnects cached clients).
    stopPoller().catch((err) => logger.warn('Error stopping PLC poller', { error: err.message }));

    // Close WebSocket clients with a going-away close frame, then the wss.
    try {
      for (const ws of wss.clients) {
        try { ws.close(1001, 'Server shutting down'); } catch { /* already gone */ }
      }
      wss.close(() => logger.info('WebSocket server closed'));
    } catch (err) {
      logger.warn('Error closing WebSocket server', { error: err.message });
    }

    server.close(async () => {
      logger.info('HTTP server closed');
      try {
        await pool.end();
        logger.info('Database pool closed');
      } catch (err) {
        logger.warn('Error closing database pool', { error: err.message });
      }
      process.exit(exitCode);
    });

    // Force exit if graceful shutdown takes too long
    setTimeout(() => {
      logger.error('Forced shutdown after 10s timeout');
      process.exit(exitCode || 1);
    }, 10_000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));

  // A poisoned process must leave the rotation: log, stop accepting
  // connections, drain in-flight work, exit(1) (with the 10s force-exit timer).
  process.on('uncaughtException', (err) => {
    logger.error('Uncaught exception — draining and exiting', { error: err.message, stack: err.stack });
    shutdown('uncaughtException', 1);
  });

  // Unhandled rejections are logged loudly but do NOT kill the process —
  // they are usually recoverable (a forgotten .catch on a background task).
  process.on('unhandledRejection', (reason) => {
    logger.error('UNHANDLED PROMISE REJECTION — this is a bug; add a .catch()', {
      reason: reason instanceof Error ? reason.stack : String(reason),
    });
  });
}

if (require.main === module) start();

module.exports = app;
