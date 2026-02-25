const bcrypt = require('bcryptjs');
const { query, withTransaction } = require('../db');
const UserModel = require('../models/user.model');
const OrgModel = require('../models/organisation.model');
const { AppError } = require('../middleware/errorHandler');
const logger = require('../utils/logger');

const BCRYPT_ROUNDS = 12;
const VALID_ROLES = ['admin', 'engineer', 'operator', 'viewer'];

// ── Organisation ──────────────────────────────────────────────────────────────

/**
 * GET /api/v1/admin/organisation
 * Returns the current user's organisation profile.
 */
const getOrganisation = async (req, res, next) => {
  try {
    const org = await OrgModel.findById(req.user.org);
    if (!org) throw new AppError('Organisation not found', 404);
    res.json({ id: org.id, name: org.name, slug: org.slug, isActive: org.is_active });
  } catch (err) { next(err); }
};

/**
 * PATCH /api/v1/admin/organisation
 * Updates organisation name (slug is immutable after creation).
 * Admin only.
 */
const updateOrganisation = async (req, res, next) => {
  try {
    const { name } = req.body;
    if (!name || !name.trim()) throw new AppError('Organisation name is required', 422);
    if (name.trim().length > 100) throw new AppError('Name must be ≤ 100 characters', 422);

    const result = await query(
      `UPDATE organisations SET name = $1, updated_at = NOW()
       WHERE id = $2
       RETURNING id, name, slug, is_active`,
      [name.trim(), req.user.org]
    );
    if (!result.rows.length) throw new AppError('Organisation not found', 404);
    const org = result.rows[0];
    logger.info('Organisation name updated', { orgId: org.id, name: org.name, by: req.user.sub });
    res.json({ id: org.id, name: org.name, slug: org.slug, isActive: org.is_active });
  } catch (err) { next(err); }
};

// ── Members ───────────────────────────────────────────────────────────────────

/**
 * GET /api/v1/admin/members
 * Lists all users in the organisation.
 */
const listMembers = async (req, res, next) => {
  try {
    const users = await UserModel.findByOrganisation(req.user.org);
    res.json(users.map(formatUser));
  } catch (err) { next(err); }
};

/**
 * POST /api/v1/admin/members
 * Invites (creates) a new user in the same organisation.
 * Body: { email, firstName, lastName, role, password }
 * Admin only.
 */
const inviteMember = async (req, res, next) => {
  try {
    const { email, firstName, lastName, role = 'viewer', password } = req.body;

    if (!email || !firstName || !lastName)
      throw new AppError('email, firstName and lastName are required', 422);
    if (!VALID_ROLES.includes(role))
      throw new AppError(`role must be one of: ${VALID_ROLES.join(', ')}`, 422);
    if (!password || password.length < 8)
      throw new AppError('password must be at least 8 characters', 422);
    if (!/(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/.test(password))
      throw new AppError('Password must contain uppercase, lowercase, and a digit', 422);

    // Prevent creating a second admin if not admin
    if (role === 'admin' && req.user.role !== 'admin')
      throw new AppError('Only admins can create admin accounts', 403);

    // Check uniqueness within org
    const existing = await UserModel.findByEmail(email.toLowerCase(), req.user.org);
    if (existing) throw new AppError('A user with that email already exists in this organisation', 409);

    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const user = await UserModel.create({
      organisationId: req.user.org,
      email: email.toLowerCase(),
      passwordHash,
      firstName: firstName.trim(),
      lastName: lastName.trim(),
      role,
    });

    logger.info('Member invited', { userId: user.id, role, by: req.user.sub });
    res.status(201).json(formatUser(user));
  } catch (err) { next(err); }
};

/**
 * PATCH /api/v1/admin/members/:userId
 * Update role, firstName, lastName, isActive for a member.
 * Admin only.
 */
const updateMember = async (req, res, next) => {
  try {
    const { userId } = req.params;
    const { role, firstName, lastName, isActive } = req.body;

    // Fetch user, verify same org
    const existing = await UserModel.findById(userId);
    if (!existing || existing.organisation_id !== req.user.org)
      throw new AppError('User not found', 404);

    // Prevent admin from demoting themselves
    if (userId === req.user.sub && role && role !== 'admin')
      throw new AppError('You cannot change your own role', 403);

    // Prevent deactivating yourself
    if (userId === req.user.sub && isActive === false)
      throw new AppError('You cannot deactivate your own account', 403);

    if (role && !VALID_ROLES.includes(role))
      throw new AppError(`role must be one of: ${VALID_ROLES.join(', ')}`, 422);

    const fields = [];
    const values = [];
    let i = 1;

    if (role       !== undefined) { fields.push(`role = $${i++}`);       values.push(role); }
    if (firstName  !== undefined) { fields.push(`first_name = $${i++}`); values.push(firstName.trim()); }
    if (lastName   !== undefined) { fields.push(`last_name = $${i++}`);  values.push(lastName.trim()); }
    if (isActive   !== undefined) { fields.push(`is_active = $${i++}`);  values.push(Boolean(isActive)); }

    if (!fields.length) throw new AppError('No fields to update', 422);

    fields.push(`updated_at = NOW()`);
    values.push(userId);

    const result = await query(
      `UPDATE users SET ${fields.join(', ')} WHERE id = $${i}
       RETURNING id, email, first_name, last_name, role, is_active, last_login_at, created_at`,
      values
    );
    if (!result.rows.length) throw new AppError('User not found', 404);
    logger.info('Member updated', { userId, by: req.user.sub });
    res.json(formatUser(result.rows[0]));
  } catch (err) { next(err); }
};

/**
 * POST /api/v1/admin/members/:userId/reset-password
 * Admin sets a new password for a member (no old password needed).
 */
const resetMemberPassword = async (req, res, next) => {
  try {
    const { userId } = req.params;
    const { password } = req.body;

    const existing = await UserModel.findById(userId);
    if (!existing || existing.organisation_id !== req.user.org)
      throw new AppError('User not found', 404);

    if (!password || password.length < 8)
      throw new AppError('Password must be at least 8 characters', 422);
    if (!/(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/.test(password))
      throw new AppError('Password must contain uppercase, lowercase, and a digit', 422);

    const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    await query('UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2', [hash, userId]);

    // Revoke all refresh tokens for that user (force re-login)
    await query('UPDATE refresh_tokens SET revoked = TRUE WHERE user_id = $1', [userId]);

    logger.info('Member password reset', { userId, by: req.user.sub });
    res.json({ success: true, message: 'Password reset. User will need to log in again.' });
  } catch (err) { next(err); }
};

/**
 * DELETE /api/v1/admin/members/:userId
 * Permanently deletes a user (hard delete). Admin only.
 * Cannot delete yourself.
 */
const deleteMember = async (req, res, next) => {
  try {
    const { userId } = req.params;

    if (userId === req.user.sub)
      throw new AppError('You cannot delete your own account', 403);

    const existing = await UserModel.findById(userId);
    if (!existing || existing.organisation_id !== req.user.org)
      throw new AppError('User not found', 404);

    await query('DELETE FROM users WHERE id = $1', [userId]);
    logger.info('Member deleted', { userId, by: req.user.sub });
    res.json({ success: true });
  } catch (err) { next(err); }
};

// ── Stats ─────────────────────────────────────────────────────────────────────

/**
 * GET /api/v1/admin/stats
 * Quick org-level stats: member counts by role, project count.
 */
const getStats = async (req, res, next) => {
  try {
    const [memberResult, projectResult] = await Promise.all([
      query(
        `SELECT role, is_active, COUNT(*) as count
         FROM users WHERE organisation_id = $1 GROUP BY role, is_active`,
        [req.user.org]
      ),
      query(
        `SELECT COUNT(*) as count FROM projects WHERE organisation_id = $1`,
        [req.user.org]
      ),
    ]);

    const byRole = {};
    let totalActive = 0;
    let totalInactive = 0;
    for (const row of memberResult.rows) {
      if (!byRole[row.role]) byRole[row.role] = 0;
      byRole[row.role] += parseInt(row.count);
      if (row.is_active) totalActive += parseInt(row.count);
      else totalInactive += parseInt(row.count);
    }

    res.json({
      members: { total: totalActive + totalInactive, active: totalActive, inactive: totalInactive, byRole },
      projects: parseInt(projectResult.rows[0]?.count ?? 0),
    });
  } catch (err) { next(err); }
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatUser(u) {
  return {
    id:          u.id,
    email:       u.email,
    firstName:   u.first_name,
    lastName:    u.last_name,
    role:        u.role,
    isActive:    u.is_active,
    lastLoginAt: u.last_login_at,
    createdAt:   u.created_at,
  };
}

module.exports = { getOrganisation, updateOrganisation, listMembers, inviteMember, updateMember, resetMemberPassword, deleteMember, getStats };
