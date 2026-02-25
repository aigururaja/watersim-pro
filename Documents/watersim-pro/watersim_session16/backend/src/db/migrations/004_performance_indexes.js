'use strict';
/**
 * Migration 004 — Performance Indexes
 * Session 16: Add composite indexes to support cursor-based pagination
 * and common filter combinations on simulation_runs.
 *
 * All are CONCURRENTLY safe (non-blocking on large tables).
 */

const { query } = require('../pool');

async function up() {
  // Primary sort index for cursor pagination: DESC on completed_at
  // Covers: ORDER BY sr.completed_at DESC (all list queries)
  await query(`
    CREATE INDEX CONCURRENTLY IF NOT EXISTS
      idx_sim_runs_completed_at_desc
    ON simulation_runs (completed_at DESC NULLS LAST)
    WHERE status = 'completed';
  `);

  // Composite: flowsheet → project join + cursor sort
  // Covers: WHERE f.project_id = ? ORDER BY sr.completed_at DESC
  await query(`
    CREATE INDEX CONCURRENTLY IF NOT EXISTS
      idx_sim_runs_flowsheet_completed
    ON simulation_runs (flowsheet_id, completed_at DESC NULLS LAST)
    WHERE status = 'completed';
  `);

  // Mode filter + cursor sort
  // Covers: WHERE sr.mode = ? ORDER BY sr.completed_at DESC
  await query(`
    CREATE INDEX CONCURRENTLY IF NOT EXISTS
      idx_sim_runs_mode_completed
    ON simulation_runs (mode, completed_at DESC NULLS LAST)
    WHERE status = 'completed';
  `);

  // Partial index on compliance (JSONB boolean)
  // Covers the compliance='pass' filter common in reports list
  await query(`
    CREATE INDEX CONCURRENTLY IF NOT EXISTS
      idx_sim_runs_compliant_true
    ON simulation_runs (completed_at DESC NULLS LAST)
    WHERE status = 'completed'
      AND (results->'summary'->>'compliant')::boolean = true;
  `);

  await query(`
    CREATE INDEX CONCURRENTLY IF NOT EXISTS
      idx_sim_runs_compliant_false
    ON simulation_runs (completed_at DESC NULLS LAST)
    WHERE status = 'completed'
      AND (results->'summary'->>'compliant')::boolean = false;
  `);

  // saved_reports: fast lookup by run_id for JOIN in RUN_SELECT
  await query(`
    CREATE INDEX CONCURRENTLY IF NOT EXISTS
      idx_saved_reports_run_saved_by
    ON saved_reports (run_id, saved_by);
  `);

  console.log('[migration 004] performance indexes created');
}

async function down() {
  await query(`DROP INDEX IF EXISTS idx_sim_runs_completed_at_desc;`);
  await query(`DROP INDEX IF EXISTS idx_sim_runs_flowsheet_completed;`);
  await query(`DROP INDEX IF EXISTS idx_sim_runs_mode_completed;`);
  await query(`DROP INDEX IF EXISTS idx_sim_runs_compliant_true;`);
  await query(`DROP INDEX IF EXISTS idx_sim_runs_compliant_false;`);
  await query(`DROP INDEX IF EXISTS idx_saved_reports_run_saved_by;`);
  console.log('[migration 004] performance indexes dropped');
}

module.exports = { up, down };
