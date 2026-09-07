/**
 * Migration 010 — the tag registry (SQLite)
 * One row per wired point with its ISA-5.1 identity; see the Postgres file.
 */
'use strict';

const { ID, CREATED_AT, UPDATED_AT, NOOP } = require('./_helpers');

exports.id = '010_tag_registry';

exports.up = `
CREATE TABLE tags (
  ${ID},
  organisation_id  TEXT NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  flowsheet_id     TEXT REFERENCES flowsheets(id) ON DELETE SET NULL,

  -- ISA-5.1 identity
  tag              TEXT NOT NULL,
  loop_tag         TEXT NOT NULL,
  area             TEXT NOT NULL,
  code             TEXT NOT NULL,
  loop_no          TEXT NOT NULL,
  unit             INTEGER,
  fn               TEXT NOT NULL,
  fn_suffix        TEXT,

  -- What it is
  signal_type      TEXT NOT NULL CHECK (signal_type IN ('DI','DO','AI','AO')),
  kind             TEXT NOT NULL,
  name             TEXT NOT NULL,
  signal           TEXT NOT NULL,
  description      TEXT,

  -- Where it lives
  node_id          TEXT,
  param_key        TEXT,
  plc_node         TEXT,
  eng_unit         TEXT,
  range_min        REAL,
  range_max        REAL,

  enabled          BOOLEAN NOT NULL DEFAULT TRUE,
  created_by       TEXT REFERENCES users(id) ON DELETE SET NULL,
  ${CREATED_AT},
  ${UPDATED_AT},

  CONSTRAINT uq_tags_org_tag UNIQUE (organisation_id, tag)
);
CREATE INDEX idx_tags_org_loop   ON tags(organisation_id, loop_tag);
CREATE INDEX idx_tags_org_area   ON tags(organisation_id, area);
CREATE INDEX idx_tags_flowsheet  ON tags(flowsheet_id) WHERE flowsheet_id IS NOT NULL;
CREATE INDEX idx_tags_node       ON tags(flowsheet_id, node_id, param_key) WHERE node_id IS NOT NULL;

ALTER TABLE plc_bindings  ADD COLUMN tag_id TEXT REFERENCES tags(id) ON DELETE SET NULL;
ALTER TABLE alarm_rules   ADD COLUMN tag_id TEXT REFERENCES tags(id) ON DELETE SET NULL;
ALTER TABLE alarm_events  ADD COLUMN tag_id TEXT REFERENCES tags(id) ON DELETE SET NULL;
CREATE INDEX idx_plc_bindings_tag ON plc_bindings(tag_id) WHERE tag_id IS NOT NULL;
CREATE INDEX idx_alarm_rules_tag  ON alarm_rules(tag_id)  WHERE tag_id IS NOT NULL;
CREATE INDEX idx_alarm_events_tag ON alarm_events(tag_id) WHERE tag_id IS NOT NULL;
`;

exports.down = `
DROP INDEX IF EXISTS idx_alarm_events_tag;
DROP INDEX IF EXISTS idx_alarm_rules_tag;
DROP INDEX IF EXISTS idx_plc_bindings_tag;
DROP TABLE IF EXISTS tags;
${NOOP}
`;
