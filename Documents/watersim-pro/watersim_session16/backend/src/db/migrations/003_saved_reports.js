/**
 * Migration: 003_saved_reports
 * Saved/bookmarked report references — users can pin completed simulation
 * runs to a reports list with an optional label and notes.
 */
'use strict';

exports.id = '003_saved_reports';

exports.up = `
CREATE TABLE saved_reports (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organisation_id UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  run_id          UUID NOT NULL REFERENCES simulation_runs(id) ON DELETE CASCADE,
  saved_by        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label           VARCHAR(255),
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_saved_reports_org_run_user UNIQUE (organisation_id, run_id, saved_by)
);
CREATE INDEX idx_saved_reports_org  ON saved_reports(organisation_id, created_at DESC);
CREATE INDEX idx_saved_reports_user ON saved_reports(saved_by);
CREATE INDEX idx_saved_reports_run  ON saved_reports(run_id);
`;

exports.down = `
DROP TABLE IF EXISTS saved_reports CASCADE;
`;
