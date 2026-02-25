const jwt = require('jsonwebtoken');
const config = require('../config');

const jwtUtils = {
  /**
   * Sign a short-lived access token.
   * Payload: { sub: userId, org: organisationId, role }
   */
  signAccess(payload) {
    return jwt.sign(payload, config.jwt.secret, {
      expiresIn: config.jwt.accessExpiresIn,
      issuer: 'watersim-pro',
      audience: 'watersim-client',
    });
  },

  /**
   * Verify and decode an access token.
   * Throws if invalid or expired.
   */
  verifyAccess(token) {
    return jwt.verify(token, config.jwt.secret, {
      issuer: 'watersim-pro',
      audience: 'watersim-client',
    });
  },

  /**
   * Parse ms/s duration string to Date.
   * Used to set refresh token DB expiry.
   */
  refreshExpiryDate() {
    const raw = config.jwt.refreshExpiresIn;
    const units = { s: 1, m: 60, h: 3600, d: 86400 };
    const match = raw.match(/^(\d+)([smhd])$/);
    if (!match) throw new Error(`Invalid refreshExpiresIn format: ${raw}`);
    const seconds = parseInt(match[1], 10) * units[match[2]];
    return new Date(Date.now() + seconds * 1000);
  },
};

module.exports = jwtUtils;
