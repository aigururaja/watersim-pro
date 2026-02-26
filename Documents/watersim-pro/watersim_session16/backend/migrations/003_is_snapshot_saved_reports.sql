-- =============================================================================
-- WaterSim Pro — Migration 003
-- Adds is_snapshot column to flowsheets
-- Creates saved_reports table
-- =============================================================================

-- ── flowsheets: add is_snapshot ───────────────────────────────────────────────
ALTER TABLE flowsheets
  ADD COLUMN IF NOT EXISTS is_snapshot BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_flowsheets_is_snapshot
  ON flowsheets (project_id, is_snapshot);

-- ── saved_reports ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS saved_reports (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organisation_id  UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  run_id           UUID NOT NULL REFERENCES simulation_runs(id) ON DELETE CASCADE,
  saved_by         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label            VARCHAR(255),
  notes            TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT uq_saved_reports UNIQUE (organisation_id, run_id, saved_by)
);

CREATE INDEX IF NOT EXISTS idx_saved_reports_org   ON saved_reports (organisation_id);
CREATE INDEX IF NOT EXISTS idx_saved_reports_user  ON saved_reports (saved_by);
CREATE INDEX IF NOT EXISTS idx_saved_reports_run   ON saved_reports (run_id);
