const bcrypt = require('bcryptjs');
const { validationResult } = require('express-validator');
const UserModel = require('../models/user.model');
const OrgModel = require('../models/organisation.model');
const TokenModel = require('../models/token.model');
const { query, withTransaction } = require('../db/pool');
const jwtUtils = require('../utils/jwt');
const { AppError } = require('../middleware/auth');
const { auditLog } = require('../utils/audit');
const logger = require('../utils/logger');

const BCRYPT_ROUNDS = 12;

/** Single email normalization rule used everywhere email is read or written. */
const normalizeEmail = (email) => String(email || '').trim().toLowerCase();

// Dummy hash used to equalize timing on the org/email-miss path of login,
// so "unknown org/email" and "wrong password" take similar time.
let DUMMY_HASH = null;
async function getDummyHash() {
  if (!DUMMY_HASH) DUMMY_HASH = await bcrypt.hash('watersim-timing-equalizer', BCRYPT_ROUNDS);
  return DUMMY_HASH;
}

/**
 * POST /api/auth/register
 * Creates a new organisation + admin user in a single transaction.
 */
const register = async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(422).json({ success: false, errors: errors.array() });
    }

    const { orgName, orgSlug, email, password, firstName, lastName } = req.body;

    // Check slug uniqueness
    const existingOrg = await OrgModel.findBySlug(orgSlug);
    if (existingOrg) throw new AppError('Organisation slug is already taken', 409);

    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

    const { org, user } = await withTransaction(async (client) => {
      const orgResult = await client.query(
        'INSERT INTO organisations (name, slug) VALUES ($1, $2) RETURNING id, name, slug',
        [orgName, orgSlug]
      );
      const org = orgResult.rows[0];

      const userResult = await client.query(
        `INSERT INTO users (organisation_id, email, password_hash, first_name, last_name, role)
         VALUES ($1, $2, $3, $4, $5, 'admin')
         RETURNING id, email, first_name, last_name, role, created_at`,
        [org.id, normalizeEmail(email), passwordHash, firstName, lastName]
      );
      const user = userResult.rows[0];
      return { org, user };
    });

    logger.info('New organisation registered', { orgId: org.id, userId: user.id });

    res.status(201).json({
      success: true,
      message: 'Organisation and admin account created successfully',
      data: {
        organisation: { id: org.id, name: org.name, slug: org.slug },
        user: { id: user.id, email: user.email, firstName: user.first_name, lastName: user.last_name, role: user.role },
      },
    });
  } catch (err) {
    next(err);
  }
};

/**
 * POST /api/auth/login
 * Authenticates a user and returns access + refresh tokens.
 * Requires { email, password, orgSlug } in body.
 */
const login = async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(422).json({ success: false, errors: errors.array() });
    }

    const { password, orgSlug } = req.body;
    const email = normalizeEmail(req.body.email);

    const org = await OrgModel.findBySlug(orgSlug);
    const user = (org && org.is_active) ? await UserModel.findByEmail(email, org.id) : null;

    if (!user || !user.is_active) {
      // Timing oracle mitigation: burn a bcrypt.compare on the miss path so
      // "unknown org/email" takes roughly as long as "wrong password".
      await bcrypt.compare(password, await getDummyHash());
      auditLog(req, 'auth.login_failed', 'user', null,
        { email, orgSlug, reason: 'unknown_account' },
        { orgId: org && org.is_active ? org.id : null });
      throw new AppError('Invalid credentials', 401);
    }

    const passwordValid = await bcrypt.compare(password, user.password_hash);
    if (!passwordValid) {
      auditLog(req, 'auth.login_failed', 'user', user.id,
        { email, orgSlug, reason: 'bad_password' },
        { orgId: org.id, userId: user.id });
      throw new AppError('Invalid credentials', 401);
    }

    // Issue tokens
    const accessToken = jwtUtils.signAccess({
      sub: user.id,
      org: user.organisation_id,
      role: user.role,
    });

    const expiresAt = jwtUtils.refreshExpiryDate();
    const rawRefreshToken = await TokenModel.create({
      userId: user.id,
      expiresAt,
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
    });

    await UserModel.updateLastLogin(user.id);

    auditLog(req, 'auth.login', 'user', user.id, { email },
      { orgId: user.organisation_id, userId: user.id });

    // Refresh token in httpOnly cookie
    res.cookie('refreshToken', rawRefreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      expires: expiresAt,
      path: '/api/v1/auth',
    });

    res.json({
      success: true,
      data: {
        accessToken,
        expiresIn: 900, // 15 minutes in seconds
        user: {
          id: user.id,
          email: user.email,
          firstName: user.first_name,
          lastName: user.last_name,
          role: user.role,
          organisation: { id: org.id, name: org.name, slug: org.slug },
        },
      },
    });
  } catch (err) {
    next(err);
  }
};

/**
 * POST /api/auth/refresh
 * Issues a new access token using a valid refresh token cookie.
 */
const refresh = async (req, res, next) => {
  try {
    const rawToken = req.cookies?.refreshToken;
    if (!rawToken) throw new AppError('No refresh token provided', 401);

    const stored = await TokenModel.findValid(rawToken);
    if (!stored) throw new AppError('Invalid or expired refresh token', 401);

    // Revoke old token (token rotation)
    await TokenModel.revoke(rawToken);

    const user = await UserModel.findById(stored.user_id);
    if (!user || !user.is_active) throw new AppError('User not found or inactive', 401);

    const org = await OrgModel.findById(user.organisation_id);

    const accessToken = jwtUtils.signAccess({
      sub: user.id,
      org: user.organisation_id,
      role: user.role,
    });

    const expiresAt = jwtUtils.refreshExpiryDate();
    const newRawToken = await TokenModel.create({
      userId: user.id,
      expiresAt,
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
    });

    res.cookie('refreshToken', newRawToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      expires: expiresAt,
      path: '/api/v1/auth',
    });

    res.json({
      success: true,
      data: {
        accessToken,
        expiresIn: 900,
        user: {
          id: user.id,
          email: user.email,
          firstName: user.first_name,
          lastName: user.last_name,
          role: user.role,
          organisation: { id: org.id, name: org.name, slug: org.slug },
        },
      },
    });
  } catch (err) {
    next(err);
  }
};

/**
 * POST /api/auth/logout
 * Revokes the current refresh token.
 */
const logout = async (req, res, next) => {
  try {
    const rawToken = req.cookies?.refreshToken;
    if (rawToken) await TokenModel.revoke(rawToken);

    res.clearCookie('refreshToken', { path: '/api/v1/auth' });
    res.json({ success: true, message: 'Logged out successfully' });
  } catch (err) {
    next(err);
  }
};

/**
 * POST /api/auth/logout-all
 * Revokes all sessions for the authenticated user.
 */
const logoutAll = async (req, res, next) => {
  try {
    await TokenModel.revokeAll(req.user.sub);
    res.clearCookie('refreshToken', { path: '/api/v1/auth' });
    res.json({ success: true, message: 'All sessions revoked' });
  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/auth/me
 * Returns the current authenticated user.
 */
const me = async (req, res, next) => {
  try {
    const user = await UserModel.findById(req.user.sub);
    if (!user) throw new AppError('User not found', 404);
    const org = await OrgModel.findById(user.organisation_id);
    res.json({
      success: true,
      data: {
        user: {
          id: user.id,
          email: user.email,
          firstName: user.first_name,
          lastName: user.last_name,
          role: user.role,
          organisation: org ? { id: org.id, name: org.name, slug: org.slug } : null,
        },
      },
    });
  } catch (err) {
    next(err);
  }
};

/**
 * POST /api/auth/change-password  (authenticated)
 * Verifies the current password, enforces the register strength rules
 * (validated at the route level), updates the hash, and revokes all
 * refresh tokens so every session must log in again.
 */
const changePassword = async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(422).json({ success: false, errors: errors.array() });
    }

    const { currentPassword, newPassword } = req.body;

    const result = await query(
      'SELECT id, password_hash, is_active FROM users WHERE id = $1',
      [req.user.sub]
    );
    const user = result.rows[0];
    if (!user || !user.is_active) throw new AppError('User not found', 404);

    const valid = await bcrypt.compare(currentPassword, user.password_hash);
    if (!valid) throw new AppError('Current password is incorrect', 401);

    const newHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
    await query(
      'UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2',
      [newHash, req.user.sub]
    );

    // Revoke every refresh token — all sessions must re-authenticate.
    await TokenModel.revokeAll(req.user.sub);
    res.clearCookie('refreshToken', { path: '/api/v1/auth' });

    auditLog(req, 'auth.change_password', 'user', req.user.sub, {});
    logger.info('Password changed', { userId: req.user.sub });

    res.json({ success: true, message: 'Password changed. Please log in again.' });
  } catch (err) {
    next(err);
  }
};

module.exports = { register, login, refresh, logout, logoutAll, me, changePassword };
