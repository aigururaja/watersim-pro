/**
 * Migration 005 — project_type + flowsheet snapshot columns
 *
 * The application code (routes/projects.js, routes/flowsheets.js) and tests
 * reference columns that the initial schema never created:
 *   - projects.project_type   (wastewater | water_purification | combined)
 *   - flowsheets.is_snapshot  (snapshots are stored as flowsheet rows)
 *   - flowsheets.snapshot_tag (label for a snapshot; unique per project)
 * This migration adds them so those endpoints work.
 */
'use strict';

exports.id = '005_project_type_and_snapshots';

exports.up = `
ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS project_type VARCHAR(50) NOT NULL DEFAULT 'wastewater';

ALTER TABLE flowsheets
  ADD COLUMN IF NOT EXISTS is_snapshot  BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS snapshot_tag VARCHAR(255);

CREATE UNIQUE INDEX IF NOT EXISTS uq_flowsheets_project_snapshot_tag
  ON flowsheets (project_id, snapshot_tag)
  WHERE is_snapshot = true;
`;

exports.down = `
DROP INDEX IF EXISTS uq_flowsheets_project_snapshot_tag;
ALTER TABLE flowsheets DROP COLUMN IF EXISTS snapshot_tag;
ALTER TABLE flowsheets DROP COLUMN IF EXISTS is_snapshot;
ALTER TABLE projects   DROP COLUMN IF EXISTS project_type;
`;
