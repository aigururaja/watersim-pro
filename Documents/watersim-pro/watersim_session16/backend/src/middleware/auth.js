const jwtUtils = require('../utils/jwt');
const { AppError } = require('./errorHandler');

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

const requireRole = (...requiredRoles) => (req, res, next) => {
  if (!req.user) return next(new AppError('Not authenticated', 401));
  const userIdx = ROLE_HIERARCHY.indexOf(req.user.role);
  const minIdx = Math.min(...requiredRoles.map(r => ROLE_HIERARCHY.indexOf(r)));
  if (userIdx >= minIdx) return next();
  return next(new AppError(`Access denied. Required role: ${requiredRoles.join(' or ')}`, 403));
};

const requireAdmin    = requireRole('admin');
const requireEngineer = requireRole('engineer');
const requireOperator = requireRole('operator');

const sameOrgOnly = (req, res, next) => {
  const targetOrg = req.params.orgId || req.body.organisationId;
  if (targetOrg && targetOrg !== req.user.org)
    return next(new AppError('Access denied: cross-organisation request', 403));
  next();
};

module.exports = { authenticate, requireRole, requireAdmin, requireEngineer, requireOperator, sameOrgOnly, ROLE_HIERARCHY };
