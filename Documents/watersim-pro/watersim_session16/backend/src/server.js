require('dotenv').config();
const express     = require('express');
const helmet      = require('helmet');
const cors        = require('cors');
const morgan      = require('morgan');
const compression = require('compression');
const rateLimit   = require('express-rate-limit');

const logger             = require('./utils/logger');
const { testConnection } = require('./db/pool');
const authRoutes         = require('./routes/auth');
const projectRoutes      = require('./routes/projects');
const flowsheetRoutes    = require('./routes/flowsheets');
const simulateRoutes     = require('./routes/simulate');
const reportRoutes       = require('./routes/reports');
const permitRoutes       = require('./routes/permitTemplates');
const adminRoutes        = require('./routes/admin');
const reportsOrgRoutes   = require('./routes/reports_org');
const { attachWsServer } = require('./collab/wsServer');

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
const PORT = parseInt(process.env.PORT || '4000', 10);
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
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

// ── General middleware ────────────────────────────────────────────────────────
app.use(compression());
app.use(express.json({ limit: '5mb' }));
app.use(morgan(IS_PROD ? 'combined' : 'dev', {
  stream: { write: (msg) => logger.http(msg.trim()) },
  // Skip health check logs to avoid noise
  skip: (req) => req.path === '/health',
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
app.use(`${API}/auth`,                                           authRoutes);
app.use(`${API}/projects`,                                       projectRoutes);
app.use(`${API}/projects/:projectId/flowsheets`,                 flowsheetRoutes);
app.use(`${API}/projects/:projectId/flowsheets/:flowsheetId/simulate`, simulateRoutes);
app.use(`${API}/projects/:projectId/flowsheets/:flowsheetId/simulate`, reportRoutes);
app.use(`${API}/permit-templates`,                               permitRoutes);
app.use(`${API}/admin`,                                          adminRoutes);
app.use(`${API}/reports`,                                        reportsOrgRoutes);

// ── Health check (unauthenticated — used by load balancers + k8s probes) ─────
app.get('/health', async (_req, res) => {
  const start = Date.now();
  try {
    const dbInfo = await testConnection();
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
  } catch {
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
app.use((err, _req, res, _next) => {
  const status  = err.statusCode || err.status || 500;
  const message = err.isOperational ? err.message : 'Internal server error';
  if (status >= 500) logger.error('Unhandled error', { error: err.message, stack: err.stack });
  res.status(status).json({ error: message });
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

  attachWsServer(server);

  // Graceful shutdown — drains in-flight requests before exiting
  const shutdown = (signal) => {
    logger.info(`${signal} received — shutting down gracefully`);
    server.close(() => {
      logger.info('HTTP server closed');
      process.exit(0);
    });
    // Force exit if graceful shutdown takes too long
    setTimeout(() => {
      logger.error('Forced shutdown after 10s timeout');
      process.exit(1);
    }, 10_000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));

  // Log uncaught errors instead of crashing silently
  process.on('uncaughtException',  (err) => logger.error('Uncaught exception',  { error: err.message, stack: err.stack }));
  process.on('unhandledRejection', (reason) => logger.error('Unhandled rejection', { reason: String(reason) }));
}

if (require.main === module) start();

module.exports = app;
