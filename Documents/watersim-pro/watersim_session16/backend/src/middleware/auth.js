
const jwtUtils = require('../utils/jwt');

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

const authenticate = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer '))
    return next(new AppError('No authentication token provided', 401));
  const token = authHeader.slice(7);
  try {
    req.user = jwtUtils.verifyAccess(token);
    next();
  } catch (err) {
    return next(new AppError(err.name === 'TokenExpiredError' ? 'Access token expired' : 'Invalid token', 401));
  }
};

const ROLE_HIERARCHY = ['viewer', 'operator', 'engineer', 'admin'];

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
  const minIdx = Math.min(...requiredRoles.map((r) => ROLE_HIERARCHY.indexOf(r)));

  return (req, res, next) => {
    if (!req.user) return next(new AppError('Not authenticated', 401));
    const userIdx = ROLE_HIERARCHY.indexOf(req.user.role);
    if (userIdx === -1) return next(new AppError('Access denied: unrecognised role', 403));
    if (userIdx >= minIdx) return next();
    return next(new AppError(`Access denied. Required role: ${requiredRoles.join(' or ')}`, 403));
  };
};

const requireAdmin = requireRole('admin');

module.exports = { authenticate, requireRole, requireAdmin, ROLE_HIERARCHY, AppError };
