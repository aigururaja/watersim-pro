const { query, withTransaction } = require('../db');

const UserModel = {
  /**
   * Find a user by email within an organisation.
   */
  async findByEmail(email, organisationId) {
    const result = await query(
      `SELECT id, organisation_id, email, password_hash, first_name, last_name,
              role, is_active, last_login_at, email_verified, created_at
       FROM users
       WHERE email = $1 AND organisation_id = $2`,
      [email.toLowerCase(), organisationId]
    );
    return result.rows[0] || null;
  },

  /**
   * Find a user by ID.
   */
  async findById(id) {
    const result = await query(
      `SELECT id, organisation_id, email, first_name, last_name,
              role, is_active, last_login_at, email_verified, created_at
       FROM users WHERE id = $1`,
      [id]
    );
    return result.rows[0] || null;
  },

  /**
   * Create a new user.
   */
  async create({ organisationId, email, passwordHash, firstName, lastName, role = 'viewer' }) {
    const result = await query(
      `INSERT INTO users (organisation_id, email, password_hash, first_name, last_name, role)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, organisation_id, email, first_name, last_name, role, is_active, created_at`,
      [organisationId, email.toLowerCase(), passwordHash, firstName, lastName, role]
    );
    return result.rows[0];
  },

  /**
   * Update last_login_at timestamp.
   */
  async updateLastLogin(id) {
    await query('UPDATE users SET last_login_at = NOW() WHERE id = $1', [id]);
  },

  /**
   * Find all users in an organisation (no password hash).
   */
  async findByOrganisation(organisationId) {
    const result = await query(
      `SELECT id, email, first_name, last_name, role, is_active, last_login_at, created_at, updated_at
       FROM users WHERE organisation_id = $1 ORDER BY created_at ASC`,
      [organisationId]
    );
    return result.rows;
  },
};

module.exports = UserModel;
