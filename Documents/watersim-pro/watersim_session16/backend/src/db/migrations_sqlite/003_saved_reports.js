/**
 * Migration: 003_saved_reports (SQLite)
 * Saved/bookmarked report references.
 */
'use strict';

const { ID, CREATED_AT } = require('./_helpers');

exports.id = '003_saved_reports';

exports.up = `
CREATE TABLE saved_reports (
  ${ID},
  organisation_id TEXT NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  run_id          TEXT NOT NULL REFERENCES simulation_runs(id) ON DELETE CASCADE,
  saved_by        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label           TEXT,
  notes           TEXT,
  ${CREATED_AT},
  CONSTRAINT uq_saved_reports_org_run_user UNIQUE (organisation_id, run_id, saved_by)
);
CREATE INDEX idx_saved_reports_org  ON saved_reports(organisation_id, created_at DESC);
CREATE INDEX idx_saved_reports_user ON saved_reports(saved_by);
CREATE INDEX idx_saved_reports_run  ON saved_reports(run_id);
`;

exports.down = `
DROP TABLE IF EXISTS saved_reports;
`;
