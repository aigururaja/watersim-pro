/**
 * Migration 008 — Alarm system (SQLite)
 *
 * alarm_rules is created in its FINAL shape: SQLite cannot ADD or DROP a
 * table-level CHECK, so the `kind` / `stale_after_s` columns from 011, the
 * 'drift' kind from 013 and the per-limit CHECK they share live here, and the
 * unique index already includes `kind` (one rule per limit). Migrations 011
 * and 013 skip those steps. Column additions (tag_id in 010, the task policy
 * in 012) stay where they were.
 */
'use strict';

const { ID, CREATED_AT, UPDATED_AT, NOW } = require('./_helpers');

exports.id = '008_alarms';

exports.up = `
CREATE TABLE alarm_rules (
  ${ID},
  organisation_id  TEXT NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  flowsheet_id     TEXT NOT NULL REFERENCES flowsheets(id) ON DELETE CASCADE,
  name             TEXT NOT NULL,
  target_type      TEXT NOT NULL CHECK (target_type IN ('param', 'node_output', 'effluent')),
  node_id          TEXT,
  param_key        TEXT NOT NULL,
  min_value        REAL,
  max_value        REAL,
  severity         TEXT NOT NULL DEFAULT 'warning' CHECK (severity IN ('info', 'warning', 'critical')),
  enabled          BOOLEAN NOT NULL DEFAULT TRUE,
  created_by       TEXT REFERENCES users(id),
  -- 011: one rule per limit plus the comms-loss kind; 013: 'drift'
  kind             TEXT NOT NULL DEFAULT 'range' CHECK (kind IN ('high', 'low', 'range', 'quality', 'drift')),
  stale_after_s    INTEGER CHECK (stale_after_s IS NULL OR stale_after_s BETWEEN 5 AND 86400),
  ${CREATED_AT},
  ${UPDATED_AT},
  CONSTRAINT chk_alarm_rules_limit CHECK (
    (kind = 'high'    AND max_value IS NOT NULL AND min_value IS NULL     AND stale_after_s IS NULL) OR
    (kind = 'low'     AND min_value IS NOT NULL AND max_value IS NULL     AND stale_after_s IS NULL) OR
    (kind = 'range'   AND min_value IS NOT NULL AND max_value IS NOT NULL AND stale_after_s IS NULL) OR
    (kind = 'quality' AND stale_after_s IS NOT NULL AND min_value IS NULL AND max_value IS NULL) OR
    (kind = 'drift'   AND max_value IS NOT NULL AND min_value IS NULL     AND stale_after_s IS NULL)
  ),
  CONSTRAINT chk_alarm_rules_node CHECK (
    (target_type = 'effluent' AND node_id IS NULL) OR
    (target_type IN ('param', 'node_output') AND node_id IS NOT NULL)
  )
);
-- COALESCE makes NULL node_id (effluent rules) behave as a distinct, unique value.
CREATE UNIQUE INDEX uq_alarm_rules_target
  ON alarm_rules (flowsheet_id, target_type, COALESCE(node_id, ''), param_key, kind);
CREATE INDEX idx_alarm_rules_flowsheet ON alarm_rules(flowsheet_id) WHERE enabled = TRUE;
CREATE INDEX idx_alarm_rules_org       ON alarm_rules(organisation_id);

CREATE TABLE alarm_events (
  ${ID},
  organisation_id  TEXT NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  rule_id          TEXT NOT NULL REFERENCES alarm_rules(id) ON DELETE CASCADE,
  flowsheet_id     TEXT NOT NULL REFERENCES flowsheets(id) ON DELETE CASCADE,
  run_id           TEXT,
  source           TEXT NOT NULL CHECK (source IN ('simulation', 'plc')),
  state            TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'cleared')),
  severity         TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
  message          TEXT NOT NULL,
  value            REAL,
  limit_min        REAL,
  limit_max        REAL,
  triggered_at     TIMESTAMPTZ NOT NULL DEFAULT ${NOW},
  last_seen_at     TIMESTAMPTZ NOT NULL DEFAULT ${NOW},
  cleared_at       TIMESTAMPTZ,
  acknowledged     BOOLEAN NOT NULL DEFAULT FALSE,
  acknowledged_by  TEXT REFERENCES users(id),
  acknowledged_at  TIMESTAMPTZ
);
CREATE INDEX idx_alarm_events_org_time  ON alarm_events(organisation_id, triggered_at DESC);
CREATE INDEX idx_alarm_events_rule      ON alarm_events(rule_id, state);
CREATE INDEX idx_alarm_events_flowsheet ON alarm_events(flowsheet_id, state);
`;

exports.down = `
DROP TABLE IF EXISTS alarm_events;
DROP TABLE IF EXISTS alarm_rules;
`;
