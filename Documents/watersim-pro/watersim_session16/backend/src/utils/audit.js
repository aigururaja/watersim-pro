/**
 * WaterSim Pro — Audit logging
 *
 * Writes to the audit_logs table (migration 001):
 *   organisation_id UUID NOT NULL, user_id UUID NULL, action VARCHAR(100),
 *   resource_type VARCHAR(100), resource_id UUID, details JSONB, ip_address INET
 *
 * Fire-and-forget: never throws, never fails the request. If the write fails
 * it is logged at warn level and dropped.
 */

'use strict';

const { pool } = require('../db/pool');
const logger = require('./logger');

/**
 * Record an audit event for the current request.
 *
 * @param {object} req          Express request (used for req.user and req.ip)
 * @param {string} action       e.g. 'project.create', 'auth.login_failed'
 * @param {string} [resourceType]  e.g. 'project', 'user'
 * @param {string} [resourceId]    UUID of the affected resource (or null)
 * @param {object} [details]       extra JSON context
 * @param {object} [actor]         optional override { orgId, userId } for
 *                                 unauthenticated flows (e.g. login)
 */
function auditLog(req, action, resourceType = null, resourceId = null, details = {}, actor = {}) {
  try {
    const orgId = actor.orgId || req.user?.org || req.user?.organisationId || null;
    const userId = actor.userId || req.user?.sub || req.user?.id || null;

    // organisation_id is NOT NULL — without an org there is nothing to attribute.
    if (!orgId) return;

    pool
      .query(
        `INSERT INTO audit_logs
           (organisation_id, user_id, action, resource_type, resource_id, details, ip_address)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          orgId,
          userId,
          String(action).slice(0, 100),
          resourceType ? String(resourceType).slice(0, 100) : null,
          resourceId || null,
          JSON.stringify(details || {}),
          req.ip || null,
        ]
      )
      .catch((err) => logger.warn('Audit log write failed', { action, err: err.message }));
  } catch (err) {
    logger.warn('Audit log error', { action, err: err.message });
  }
}

module.exports = { auditLog };
