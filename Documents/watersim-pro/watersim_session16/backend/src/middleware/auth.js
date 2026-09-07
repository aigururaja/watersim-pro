
const jwtUtils = require('../utils/jwt');
const { ROLES, CAPABILITIES, can, rank } = require('../auth/roles');
const logger = require('../utils/logger');

/**
 * Operational error carrying an HTTP status.
 * (Lives here since middleware/errorHandler.js was removed — server.js has its
 * own inline error handler that reads .status/.isOperational.)
 */
class AppError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
    this.isOperational = true;
    Error.captureStackTrace(this, this.constructor);
  }
}

// ── Per-request role freshening ──────────────────────────────────────────────
//
// A JWT carries the role the user held when it was minted, and the access token
// lives 15 minutes. Until now that was the only check: a user demoted or
// deactivated by an admin kept operator/engineer rights until their next
// refresh. For a platform that is about to let operators start pumps and
// managers approve work, fifteen minutes of stale authority is too long.
//
// So on every authenticated request the user's CURRENT role and active flag
// are read back from the database, cached per user for a short window, and the
// token's role is replaced with the live one. The cache keeps the cost to one
// query per user per window rather than per request.
//
// FAIL-OPEN, DELIBERATELY. If the lookup errors (database down, connection pool
// exhausted) or finds no row, the request proceeds on the token's role. The
// token is still a signed, unexpired credential the server issued; refusing
// every request because the role cache cannot be refreshed would turn a
// database hiccup into a total outage of an operations console. Deactivation is
// the one thing that is NOT fail-open: a row that exists and says inactive is
// refused. The window is short enough that the worst case — a demotion taking
// up to ROLE_CACHE_TTL_MS to bite — is a rounding error against the old 15 min.
const ROLE_CACHE_TTL_MS = Math.max(1000, parseInt(process.env.ROLE_CACHE_TTL_MS || '30000', 10) || 30000);
// How long a request will wait for the role lookup before proceeding on the
// token. A database that answers slowly must not turn into slow requests: past
// this the lookup is abandoned (fail-open) and the miss is cached for the TTL,
// so a down database costs one short wait per user per window, not per request.
const ROLE_LOOKUP_TIMEOUT_MS = Math.max(50, parseInt(process.env.ROLE_LOOKUP_TIMEOUT_MS || '500', 10) || 500);
const roleCache = new Map(); // userId → { role, isActive, expiresAt } | { miss: true, expiresAt }

let dbQuery = null;
function getQuery() {
  // Lazily required so unit tests that stub the pool, and environments with no
  // database at all, can still load this module.
  if (dbQuery === null) {
    try { dbQuery = require('../db/pool').query; } catch { dbQuery = false; }
  }
  return dbQuery || null;
}

const withTimeout = (promise, ms) => new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error(`role lookup exceeded ${ms} ms`)), ms);
  promise.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
});

async function freshRole(userId) {
  const now = Date.now();
  const hit = roleCache.get(userId);
  if (hit && hit.expiresAt > now) return hit.miss ? null : hit;

  const query = getQuery();
  if (!query) return null;
  try {
    const { rows } = await withTimeout(
      query('SELECT role, is_active FROM users WHERE id = $1', [userId]),
      ROLE_LOOKUP_TIMEOUT_MS
    );
    if (!rows.length) {
      roleCache.set(userId, { miss: true, expiresAt: now + ROLE_CACHE_TTL_MS });
      return null;
    }
    const entry = { role: rows[0].role, isActive: rows[0].is_active !== false, expiresAt: now + ROLE_CACHE_TTL_MS };
    roleCache.set(userId, entry);
    return entry;
  } catch (err) {
    roleCache.set(userId, { miss: true, expiresAt: now + ROLE_CACHE_TTL_MS });
    logger.debug('Role refresh skipped — using token role', { userId, err: err.message });
    return null;
  }
}

/** Drop a user's cached role — call after an admin changes it, so it bites now. */
function invalidateRoleCache(userId) {
  if (userId) roleCache.delete(userId); else roleCache.clear();
}

const authenticate = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer '))
    return next(new AppError('No authentication token provided', 401));
  const token = authHeader.slice(7);
  let claims;
  try {
    claims = jwtUtils.verifyAccess(token);
  } catch (err) {
    return next(new AppError(err.name === 'TokenExpiredError' ? 'Access token expired' : 'Invalid token', 401));
  }
  req.user = claims;

  const userId = claims.sub || claims.id;
  if (!userId) return next();

  freshRole(userId)
    .then((live) => {
      if (live) {
        if (!live.isActive) return next(new AppError('Account is deactivated', 401));
        req.user.role = live.role;
      }
      next();
    })
    .catch(() => next());
};

/**
 * The role hierarchy, lowest to highest. Re-exported from auth/roles.js so the
 * name every existing consumer imports keeps working.
 */
const ROLE_HIERARCHY = ROLES;

/**
 * Require the user to hold at least the minimum of the given roles.
 * Fails CLOSED:
 *  - unknown role names in the route definition throw at module load
 *    (previously indexOf() returned -1 and the check passed for everyone);
 *  - a user token with an unrecognisable role is denied.
 */
const requireRole = (...requiredRoles) => {
  for (const r of requiredRoles) {
    if (!ROLE_HIERARCHY.includes(r)) {
      throw new Error(`requireRole: unknown role "${r}" — valid roles: ${ROLE_HIERARCHY.join(', ')}`);
    }
  }
  const minIdx = Math.min(...requiredRoles.map((r) => rank(r)));

  return (req, res, next) => {
    if (!req.user) return next(new AppError('Not authenticated', 401));
    const userIdx = rank(req.user.role);
    if (userIdx === -1) return next(new AppError('Access denied: unrecognised role', 403));
    if (userIdx >= minIdx) return next();
    return next(new AppError(`Access denied. Required role: ${requiredRoles.join(' or ')}`, 403));
  };
};

/**
 * Require a named capability (auth/roles.js CAPABILITIES). Same fail-closed
 * contract as requireRole: an unknown verb throws at definition time, so a
 * typo in a route file is a boot failure rather than an open door.
 */
const requireCapability = (capability) => {
  if (!CAPABILITIES[capability]) {
    throw new Error(`requireCapability: unknown capability "${capability}" — see auth/roles.js`);
  }
  return (req, res, next) => {
    if (!req.user) return next(new AppError('Not authenticated', 401));
    if (rank(req.user.role) === -1) return next(new AppError('Access denied: unrecognised role', 403));
    if (can(req.user.role, capability)) return next();
    return next(new AppError(`Access denied. Requires: ${capability} (${CAPABILITIES[capability]} or above)`, 403));
  };
};

const requireAdmin = requireRole('admin');

module.exports = {
  authenticate,
  requireRole,
  requireCapability,
  requireAdmin,
  invalidateRoleCache,
  ROLE_HIERARCHY,
  ROLE_CACHE_TTL_MS,
  AppError,
};
