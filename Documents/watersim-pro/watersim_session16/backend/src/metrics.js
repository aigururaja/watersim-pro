/**
 * WaterSim Pro — Prometheus metrics
 *
 * Exposes:
 *   - default Node.js process metrics (CPU, memory, event-loop lag, GC, ...)
 *   - http_request_duration_seconds{route,method,status} histogram
 *   - simulation_duration_seconds{mode,status} histogram (recorded around
 *     solver execution by routes/simulate.js)
 *
 * GET /metrics is wired up in server.js. It is unauthenticated and exempt
 * from the /api rate limiter so scrapers can't be locked out — in production
 * it MUST be network-restricted (e.g. only reachable from the cluster-internal
 * Prometheus scraper, never exposed through the public ingress).
 */

'use strict';

const client = require('prom-client');

const register = new client.Registry();

client.collectDefaultMetrics({ register });

const httpRequestDuration = new client.Histogram({
  name:       'http_request_duration_seconds',
  help:       'HTTP request duration in seconds',
  labelNames: ['route', 'method', 'status'],
  buckets:    [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
  registers:  [register],
});

const simulationDuration = new client.Histogram({
  name:       'simulation_duration_seconds',
  help:       'Simulation solver execution duration in seconds',
  labelNames: ['mode', 'status'],
  buckets:    [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120],
  registers:  [register],
});

/**
 * Express middleware — observes every request's duration.
 * Uses the matched Express route pattern (not the raw URL) to keep label
 * cardinality bounded; unmatched requests are bucketed as "unmatched".
 */
function metricsMiddleware(req, res, next) {
  const end = httpRequestDuration.startTimer();
  res.on('finish', () => {
    const route = req.route
      ? (req.baseUrl || '') + req.route.path
      : (res.statusCode === 404 ? 'unmatched' : req.baseUrl || req.path || 'unknown');
    end({ route, method: req.method, status: String(res.statusCode) });
  });
  next();
}

/** GET /metrics handler — Prometheus text exposition format. */
async function metricsHandler(_req, res, next) {
  try {
    res.set('Content-Type', register.contentType);
    res.end(await register.metrics());
  } catch (err) {
    next(err);
  }
}

module.exports = { register, httpRequestDuration, simulationDuration, metricsMiddleware, metricsHandler };
