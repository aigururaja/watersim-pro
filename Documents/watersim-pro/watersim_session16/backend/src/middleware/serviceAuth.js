/**
 * WaterSim Pro — Service authentication (Phase 5)
 *
 * Machine callers (the CMMS, an analytics job) present an API key instead of
 * a person's JWT:
 *
 *   Authorization: Bearer wsk_<prefix>_<secret>      or      X-API-Key: wsk_…
 *
 * The key is looked up by its prefix and its SHA-256 compared in constant
 * time; the row's scopes decide what it may do. A matching key populates
 * `req.service` and a synthetic `req.user` ({ org, role: 'service' }) so the
 * organisation-scoped helpers every route uses keep working. Keys never
 * escalate to a person's capabilities: `requireScope()` is the only gate that
 * admits them.
 *
 * `serviceOrUser(scope, capability)` lets one route serve both a key with the
 * scope and a logged-in person with the capability — the read API is useful
 * to an admin checking what the CMMS will see.
 */
'use strict';

const crypto = require('crypto');
const { query } = require('../db/pool');
const { authenticate, requireCapability, AppError } = require('./auth');
const logger = require('../utils/logger');

const SCOPES = Object.freeze(['assets:read', 'history:read', 'counters:read', 'events:read', 'workorders:write']);
const KEY_RE = /^wsk_([A-Za-z0-9]{8})_([A-Za-z0-9]{32,64})$/;

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

/** Mint a key. Returns { key, prefix, hash } — the key is shown to the caller once. */
function generateKey() {
  const prefix = crypto.randomBytes(6).toString('base64url').replace(/[^A-Za-z0-9]/g, 'x').slice(0, 8).padEnd(8, 'x');
  const secret = crypto.randomBytes(24).toString('hex'); // 48 hex chars
  const key = `wsk_${prefix}_${secret}`;
  return { key, prefix, hash: sha256(key) };
}

function extractKey(req) {
  const h = req.headers.authorization;
  if (h && /^Bearer\s+wsk_/i.test(h)) return h.slice(7).trim();
  if (req.headers['x-api-key']) return String(req.headers['x-api-key']).trim();
  return null;
}

/** Resolve a presented key to its row, or null. Never throws. */
async function resolveKey(presented) {
  const m = KEY_RE.exec(presented || '');
  if (!m) return null;
  try {
    const { rows } = await query(
      `SELECT id, organisation_id, name, key_hash, scopes, expires_at, revoked_at FROM api_keys WHERE key_prefix = $1 AND revoked_at IS NULL`,
      [m[1]]
    );
    const hash = sha256(presented);
    for (const row of rows) {
      const a = Buffer.from(row.key_hash, 'hex');
      const b = Buffer.from(hash, 'hex');
      if (a.length === b.length && crypto.timingSafeEqual(a, b)) {
        if (row.expires_at && new Date(row.expires_at) < new Date()) return { expired: true, row };
        query('UPDATE api_keys SET last_used_at = NOW() WHERE id = $1', [row.id]).catch(() => {});
        return { row };
      }
    }
    return null;
  } catch (err) {
    logger.warn('API key lookup failed', { err: err.message });
    return null;
  }
}

/** Authenticate with an API key only. */
const authenticateService = async (req, res, next) => {
  const presented = extractKey(req);
  if (!presented) return next(new AppError('An API key is required (Authorization: Bearer wsk_… or X-API-Key)', 401));
  const found = await resolveKey(presented);
  if (!found) return next(new AppError('Invalid API key', 401));
  if (found.expired) return next(new AppError('API key has expired', 401));
  req.service = { id: found.row.id, orgId: found.row.organisation_id, name: found.row.name, scopes: found.row.scopes || [] };
  req.user = { sub: null, org: found.row.organisation_id, role: 'service', service: true, apiKeyId: found.row.id };
  next();
};

const requireScope = (scope) => (req, res, next) => {
  if (!req.service) return next(new AppError('Not authenticated as a service', 401));
  if (!req.service.scopes.includes(scope)) return next(new AppError(`API key lacks the ${scope} scope`, 403));
  next();
};

/**
 * A key with `scope`, or a person with `capability`. The presence of a
 * `wsk_` credential decides which path is taken; a person's JWT is never
 * mistaken for a key and vice versa.
 */
const serviceOrUser = (scope, capability) => (req, res, next) => {
  if (extractKey(req)) {
    return authenticateService(req, res, (err) => (err ? next(err) : requireScope(scope)(req, res, next)));
  }
  return authenticate(req, res, (err) => (err ? next(err) : requireCapability(capability)(req, res, next)));
};

module.exports = { SCOPES, generateKey, sha256, resolveKey, authenticateService, requireScope, serviceOrUser };
