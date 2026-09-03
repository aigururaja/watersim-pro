const { query } = require('../db/pool');
const crypto = require('crypto');

const TokenModel = {
  /**
   * Store a hashed refresh token.
   */
  async create({ userId, expiresAt, ipAddress, userAgent }) {
    const rawToken = crypto.randomBytes(48).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');

    await query(
      `INSERT INTO refresh_tokens (user_id, token_hash, expires_at, ip_address, user_agent)
       VALUES ($1, $2, $3, $4, $5)`,
      [userId, tokenHash, expiresAt, ipAddress || null, userAgent || null]
    );

    return rawToken; // Return raw — only this moment it's available in plain text
  },

  /**
   * Find an active (non-revoked, non-expired) token by its raw value.
   */
  async findValid(rawToken) {
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    const result = await query(
      `SELECT id, user_id, expires_at
       FROM refresh_tokens
       WHERE token_hash = $1
         AND revoked = FALSE
         AND expires_at > NOW()`,
      [tokenHash]
    );
    return result.rows[0] || null;
  },

  /**
   * Revoke a single token.
   */
  async revoke(rawToken) {
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    await query(
      'UPDATE refresh_tokens SET revoked = TRUE WHERE token_hash = $1',
      [tokenHash]
    );
  },

  /**
   * Revoke all tokens for a user (logout all sessions).
   */
  async revokeAll(userId) {
    await query(
      'UPDATE refresh_tokens SET revoked = TRUE WHERE user_id = $1',
      [userId]
    );
  },
};

module.exports = TokenModel;
