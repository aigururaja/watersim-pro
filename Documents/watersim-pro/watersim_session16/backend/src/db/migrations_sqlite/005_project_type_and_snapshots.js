/**
 * Migration 005 — project_type + flowsheet snapshot columns (SQLite)
 */
'use strict';

const { NOOP } = require('./_helpers');

exports.id = '005_project_type_and_snapshots';

exports.up = `
ALTER TABLE projects   ADD COLUMN project_type TEXT NOT NULL DEFAULT 'wastewater';
ALTER TABLE flowsheets ADD COLUMN is_snapshot  BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE flowsheets ADD COLUMN snapshot_tag TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS uq_flowsheets_project_snapshot_tag
  ON flowsheets (project_id, snapshot_tag)
  WHERE is_snapshot = TRUE;
`;

// SQLite cannot drop a column that an index refers to; a SQLite rollback is
// "delete the file and migrate again".
exports.down = `
DROP INDEX IF EXISTS uq_flowsheets_project_snapshot_tag;
${NOOP}
`;
