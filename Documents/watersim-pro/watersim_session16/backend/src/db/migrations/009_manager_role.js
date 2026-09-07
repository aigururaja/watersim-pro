/**
 * Migration 009 — the `manager` role.
 *
 * Adds one value to the `user_role` enum, between engineer and admin in the
 * hierarchy (`backend/src/auth/roles.js`). It exists to hold the two
 * supervisory verbs the three-application plan introduces — approving a
 * maintenance task and acknowledging a critical alarm — which no existing role
 * can express without also being an administrator.
 *
 * ── WHY THIS MIGRATION DOES ONLY THIS ────────────────────────────────────────
 * `ALTER TYPE … ADD VALUE` has two Postgres rules that make it a bad neighbour:
 *   1. The new value cannot be USED in the same transaction that adds it.
 *      migrate.js wraps every migration in BEGIN/COMMIT, so a migration that
 *      added 'manager' and then inserted a manager user would fail.
 *   2. An enum value can never be dropped. `down` therefore cannot undo this.
 * So the enum change is isolated here, and the first use of the value is the
 * seed, which runs after every migration has committed.
 *
 * `IF NOT EXISTS` makes the migration safe to re-run against a database where
 * the value was added by hand.
 */
'use strict';

exports.id = '009_manager_role';

exports.up = `
ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'manager' AFTER 'engineer';
`;

/**
 * Postgres cannot remove an enum value. Rolling this back demotes any managers
 * to engineer so the application code (which will no longer know the role)
 * never meets a token carrying it, and leaves the value in the type.
 */
exports.down = `
UPDATE users SET role = 'engineer' WHERE role = 'manager';
`;
