/**
 * SafeKrit — Audit logging
 *
 * Writes to the audit_logs table (migration 001):
 *   organisation_id UUID NOT NULL, user_id UUID NULL, action VARCHAR(100),
 *   resource_type VARCHAR(100), resource_id UUID, details JSONB, ip_address INET
 *
 * Fire-and-forget: never throws, never fails the request. If the write fails
 * it is logged at warn level and dropped.
 *
 * Two entry points:
 *   auditLog(req, …)      an action a PERSON took, attributed from the request
 *   auditSystem({ … })    an action the SYSTEM took — the PLC poller marking a
 *                         connection stale, the evaluator raising an alarm, the
 *                         notification worker sending a message. These have no
 *                         Express request and, before this existed, could not
 *                         be audited at all: auditLog silently returned when it
 *                         found no organisation on `req.user`.
 *
 * A system entry has user_id NULL and carries `details.source` naming the
 * component, so the audit page can show "poller" or "alarm-evaluator" where a
 * user's name would be.
 */

'use strict';

const { pool } = require('../db/pool');
const logger = require('./logger');

function write(orgId, userId, action, resourceType, resourceId, details, ip) {
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
        ip || null,
      ]
    )
    .catch((err) => logger.warn('Audit log write failed', { action, err: err.message }));
}

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

    // Carry the request id when the middleware set one, so an audit row can be
    // joined back to the request log line that produced it.
    const withReq = req.id ? { ...details, requestId: req.id } : details;
    write(orgId, userId, action, resourceType, resourceId, withReq, req.ip);
  } catch (err) {
    logger.warn('Audit log error', { action, err: err.message });
  }
}

/**
 * Record an audit event the system took on its own, with no request behind it.
 *
 * @param {object} entry
 * @param {string} entry.orgId          organisation the action belongs to (required)
 * @param {string} entry.source         component name: 'poller' | 'alarm-evaluator' | 'notifier' | …
 * @param {string} entry.action         e.g. 'plc_connection.stale', 'alarm.raised'
 * @param {string} [entry.resourceType]
 * @param {string} [entry.resourceId]
 * @param {object} [entry.details]
 */
function auditSystem({ orgId, source, action, resourceType = null, resourceId = null, details = {} } = {}) {
  try {
    if (!orgId || !action) return;
    write(orgId, null, action, resourceType, resourceId, { ...details, source: String(source || 'system') }, null);
  } catch (err) {
    logger.warn('Audit system-log error', { action, err: err.message });
  }
}

module.exports = { auditLog, auditSystem };
