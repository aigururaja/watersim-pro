/**
 * Shared fragments for the SQLite migrations.
 *
 * Files in this directory starting with `_` are not migrations (migrate.js
 * skips them). Every SQLite deployment starts from an empty file, so these
 * migrations create each table in its final shape where Postgres later
 * ALTERed a table-level constraint (SQLite has no ADD/DROP CONSTRAINT); the
 * migration that changed it in Postgres is then a no-op here. Column additions
 * stay in the migration that introduced them.
 */
'use strict';

/** ISO-8601 UTC with milliseconds — the same shape NOW() and bound Dates produce. */
const NOW = "(strftime('%Y-%m-%dT%H:%M:%fZ','now'))";

/** UUID v4 from the function the driver registers (crypto.randomUUID). */
const UUID = '(uuid_generate_v4())';

/** Column fragments used on nearly every table. */
const ID         = `id TEXT PRIMARY KEY DEFAULT ${UUID}`;
const CREATED_AT = `created_at TIMESTAMPTZ NOT NULL DEFAULT ${NOW}`;
const UPDATED_AT = `updated_at TIMESTAMPTZ NOT NULL DEFAULT ${NOW}`;

/** A migration that has nothing to do on SQLite. */
const NOOP = 'SELECT 1;';

module.exports = { NOW, UUID, ID, CREATED_AT, UPDATED_AT, NOOP };
