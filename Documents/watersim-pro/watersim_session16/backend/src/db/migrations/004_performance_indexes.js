/**
 * Migration 004 — Performance Indexes
 * Session 16: Add composite indexes to support cursor-based pagination
 * and common filter combinations on simulation_runs.
 *
 * NOTE: The migration runner wraps each migration in a transaction, so these
 * are created without CONCURRENTLY (which cannot run inside a transaction block).
 * IF NOT EXISTS keeps the migration idempotent.
 */
'use strict';

exports.id = '004_performance_indexes';

exports.up = `
CREATE INDEX IF NOT EXISTS idx_sim_runs_completed_at_desc
  ON simulation_runs (completed_at DESC NULLS LAST)
  WHERE status = 'completed';

CREATE INDEX IF NOT EXISTS idx_sim_runs_flowsheet_completed
  ON simulation_runs (flowsheet_id, completed_at DESC NULLS LAST)
  WHERE status = 'completed';

CREATE INDEX IF NOT EXISTS idx_sim_runs_mode_completed
  ON simulation_runs (mode, completed_at DESC NULLS LAST)
  WHERE status = 'completed';

CREATE INDEX IF NOT EXISTS idx_sim_runs_compliant_true
  ON simulation_runs (completed_at DESC NULLS LAST)
  WHERE status = 'completed'
    AND (results->'summary'->>'compliant')::boolean = true;

CREATE INDEX IF NOT EXISTS idx_sim_runs_compliant_false
  ON simulation_runs (completed_at DESC NULLS LAST)
  WHERE status = 'completed'
    AND (results->'summary'->>'compliant')::boolean = false;

CREATE INDEX IF NOT EXISTS idx_saved_reports_run_saved_by
  ON saved_reports (run_id, saved_by);
`;

exports.down = `
DROP INDEX IF EXISTS idx_sim_runs_completed_at_desc;
DROP INDEX IF EXISTS idx_sim_runs_flowsheet_completed;
DROP INDEX IF EXISTS idx_sim_runs_mode_completed;
DROP INDEX IF EXISTS idx_sim_runs_compliant_true;
DROP INDEX IF EXISTS idx_sim_runs_compliant_false;
DROP INDEX IF EXISTS idx_saved_reports_run_saved_by;
`;
