/**
 * WaterSim Pro — Request ID middleware
 *
 * Accepts an inbound X-Request-Id header (from a load balancer / upstream
 * service) or generates a UUID. The id is:
 *   - attached to `req.id` (used by morgan and the global error handler)
 *   - echoed back on the response as `X-Request-Id`
 * so every log line and error response can be correlated across services.
 */

'use strict';

const { randomUUID } = require('crypto');

// Only accept sane inbound ids — anything else gets replaced.
const VALID_ID = /^[A-Za-z0-9._-]{1,128}$/;

function requestId(req, res, next) {
  const inbound = req.headers['x-request-id'];
  req.id = (typeof inbound === 'string' && VALID_ID.test(inbound)) ? inbound : randomUUID();
  res.setHeader('X-Request-Id', req.id);
  next();
}

module.exports = { requestId };
