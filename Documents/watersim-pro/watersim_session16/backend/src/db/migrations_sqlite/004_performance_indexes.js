/**
 * Migration 004 — Performance Indexes (SQLite)
 *
 * Composite indexes for cursor pagination on simulation_runs. SQLite has no
 * NULLS LAST in index definitions (ORDER BY supports it, which is what the
 * queries use), and the compliance flag is read with the JSON operators.
 */
'use strict';

exports.id = '004_performance_indexes';

exports.up = `
CREATE INDEX IF NOT EXISTS idx_sim_runs_completed_at_desc
  ON simulation_runs (completed_at DESC)
  WHERE status = 'completed';

CREATE INDEX IF NOT EXISTS idx_sim_runs_flowsheet_completed
  ON simulation_runs (flowsheet_id, completed_at DESC)
  WHERE status = 'completed';

CREATE INDEX IF NOT EXISTS idx_sim_runs_mode_completed
  ON simulation_runs (mode, completed_at DESC)
  WHERE status = 'completed';

CREATE INDEX IF NOT EXISTS idx_sim_runs_compliant_true
  ON simulation_runs (completed_at DESC)
  WHERE status = 'completed'
    AND (results->'summary'->>'compliant') = 1;

CREATE INDEX IF NOT EXISTS idx_sim_runs_compliant_false
  ON simulation_runs (completed_at DESC)
  WHERE status = 'completed'
    AND (results->'summary'->>'compliant') = 0;

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
