/**
 * Migration 013 — Digital twin (SQLite)
 *
 * As the Postgres file. The alarm_rules constraint change ('drift') is
 * already part of 008's CHECK, so it is not repeated here.
 */
'use strict';

const { CREATED_AT, UPDATED_AT, NOW, NOOP } = require('./_helpers');

exports.id = '013_twin';

exports.up = `
CREATE TABLE twin_config (
  flowsheet_id     TEXT PRIMARY KEY REFERENCES flowsheets(id) ON DELETE CASCADE,
  organisation_id  TEXT NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  enabled          BOOLEAN NOT NULL DEFAULT FALSE,
  cadence_s        INTEGER NOT NULL DEFAULT 60 CHECK (cadence_s BETWEEN 5 AND 3600),
  drift_z          REAL NOT NULL DEFAULT 3 CHECK (drift_z > 0),
  updated_by       TEXT REFERENCES users(id) ON DELETE SET NULL,
  ${CREATED_AT},
  ${UPDATED_AT}
);
CREATE INDEX idx_twin_config_org ON twin_config (organisation_id) WHERE enabled = TRUE;

CREATE TABLE twin_state (
  flowsheet_id      TEXT PRIMARY KEY REFERENCES flowsheets(id) ON DELETE CASCADE,
  organisation_id   TEXT NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  seq               INTEGER NOT NULL DEFAULT 0,
  solved_at         TIMESTAMPTZ,
  duration_ms       INTEGER,
  summary           JSONB,
  node_metrics      JSONB,
  node_params       JSONB,
  measured          JSONB,
  residuals         JSONB,
  error             TEXT,
  ${UPDATED_AT}
);

CREATE TABLE twin_residuals (
  tag_id     TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  ts         TIMESTAMPTZ NOT NULL,
  modelled   REAL,
  measured   REAL,
  residual   REAL,
  z          REAL
);
CREATE INDEX idx_twin_residuals_tag_ts ON twin_residuals (tag_id, ts DESC);

CREATE TABLE twin_residual_stats (
  tag_id      TEXT PRIMARY KEY REFERENCES tags(id) ON DELETE CASCADE,
  n           INTEGER NOT NULL DEFAULT 0,
  mean        REAL NOT NULL DEFAULT 0,
  m2          REAL NOT NULL DEFAULT 0,
  last_z      REAL,
  ${UPDATED_AT}
);

CREATE TABLE equipment_counters (
  tag_id      TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  day         DATE NOT NULL,
  run_hours   REAL NOT NULL DEFAULT 0,
  starts      INTEGER NOT NULL DEFAULT 0,
  trips       INTEGER NOT NULL DEFAULT 0,
  last_state  INTEGER,
  last_ts     TIMESTAMPTZ,
  PRIMARY KEY (tag_id, day)
);
CREATE INDEX idx_equipment_counters_day ON equipment_counters (day);
INSERT INTO historian_jobs (name) VALUES ('counters') ON CONFLICT (name) DO NOTHING;

ALTER TABLE plc_connections ADD COLUMN mode TEXT NOT NULL DEFAULT 'live' CHECK (mode IN ('live', 'shadow'));
ALTER TABLE plc_connections ADD COLUMN mode_changed_by TEXT REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE plc_connections ADD COLUMN mode_changed_at TIMESTAMPTZ;
`;

exports.down = `
DELETE FROM alarm_rules WHERE kind = 'drift';
DELETE FROM historian_jobs WHERE name = 'counters';
DROP TABLE IF EXISTS equipment_counters;
DROP TABLE IF EXISTS twin_residual_stats;
DROP TABLE IF EXISTS twin_residuals;
DROP TABLE IF EXISTS twin_state;
DROP TABLE IF EXISTS twin_config;
${NOOP}
`;

// Keep the ISO default available to future edits of this file.
void NOW;
