/**
 * Migration 008 — Alarm system
 *
 * alarm_rules — one row per configured limit on a flowsheet target:
 *   target_type 'param'       → a node model parameter (node_id + param_key)
 *   target_type 'node_output' → quality of water leaving a node (node_id + Stream field)
 *   target_type 'effluent'    → plant discharge quality (node_id NULL + Stream field)
 *   At least one of min_value / max_value must be set. The unique index uses
 *   COALESCE(node_id, '') so effluent rules (node_id NULL) collide like any
 *   other duplicate target instead of NULL never equalling NULL.
 *
 * alarm_events — the state machine's records. One 'active' row per breached
 *   rule at a time; recovery flips it to 'cleared' (cleared_at set), and a
 *   re-breach opens a NEW row. run_id links simulation-sourced events to the
 *   run that raised them; PLC-sourced events carry source='plc'.
 */
'use strict';

exports.id = '008_alarms';

exports.up = `
CREATE TABLE alarm_rules (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id  UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  flowsheet_id     UUID NOT NULL REFERENCES flowsheets(id) ON DELETE CASCADE,
  name             VARCHAR(120) NOT NULL,
  target_type      TEXT NOT NULL CHECK (target_type IN ('param', 'node_output', 'effluent')),
  node_id          TEXT,
  param_key        TEXT NOT NULL,
  min_value        DOUBLE PRECISION,
  max_value        DOUBLE PRECISION,
  severity         TEXT NOT NULL DEFAULT 'warning' CHECK (severity IN ('info', 'warning', 'critical')),
  enabled          BOOLEAN NOT NULL DEFAULT TRUE,
  created_by       UUID REFERENCES users(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_alarm_rules_limit CHECK (min_value IS NOT NULL OR max_value IS NOT NULL),
  CONSTRAINT chk_alarm_rules_node CHECK (
    (target_type = 'effluent' AND node_id IS NULL) OR
    (target_type IN ('param', 'node_output') AND node_id IS NOT NULL)
  )
);
-- COALESCE makes NULL node_id (effluent rules) behave as a distinct, unique value.
CREATE UNIQUE INDEX uq_alarm_rules_target
  ON alarm_rules (flowsheet_id, target_type, COALESCE(node_id, ''), param_key);
CREATE INDEX idx_alarm_rules_flowsheet ON alarm_rules(flowsheet_id) WHERE enabled = TRUE;
CREATE INDEX idx_alarm_rules_org       ON alarm_rules(organisation_id);

CREATE TABLE alarm_events (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id  UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  rule_id          UUID NOT NULL REFERENCES alarm_rules(id) ON DELETE CASCADE,
  flowsheet_id     UUID NOT NULL REFERENCES flowsheets(id) ON DELETE CASCADE,
  run_id           UUID,
  source           TEXT NOT NULL CHECK (source IN ('simulation', 'plc')),
  state            TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'cleared')),
  severity         TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
  message          TEXT NOT NULL,
  value            DOUBLE PRECISION,
  limit_min        DOUBLE PRECISION,
  limit_max        DOUBLE PRECISION,
  triggered_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  cleared_at       TIMESTAMPTZ,
  acknowledged     BOOLEAN NOT NULL DEFAULT FALSE,
  acknowledged_by  UUID REFERENCES users(id),
  acknowledged_at  TIMESTAMPTZ
);
CREATE INDEX idx_alarm_events_org_time  ON alarm_events(organisation_id, triggered_at DESC);
CREATE INDEX idx_alarm_events_rule      ON alarm_events(rule_id, state);
CREATE INDEX idx_alarm_events_flowsheet ON alarm_events(flowsheet_id, state);

CREATE TRIGGER trg_alarm_rules_updated BEFORE UPDATE ON alarm_rules FOR EACH ROW EXECUTE FUNCTION set_updated_at();
`;

exports.down = `
DROP TABLE IF EXISTS alarm_events CASCADE;
DROP TABLE IF EXISTS alarm_rules  CASCADE;
`;
