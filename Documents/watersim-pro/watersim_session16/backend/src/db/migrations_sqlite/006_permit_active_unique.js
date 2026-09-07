/**
 * Migration 006 — enforce "one active permit template per organisation" (SQLite)
 *
 * The Postgres file first repairs duplicates with DISTINCT ON; a SQLite
 * database is always created fresh, so only the partial unique index is needed.
 */
'use strict';

exports.id = '006_permit_active_unique';

exports.up = `
CREATE UNIQUE INDEX IF NOT EXISTS uq_permit_templates_one_active
  ON permit_templates(organisation_id)
  WHERE is_active = TRUE;
`;

exports.down = `
DROP INDEX IF EXISTS uq_permit_templates_one_active;
`;
