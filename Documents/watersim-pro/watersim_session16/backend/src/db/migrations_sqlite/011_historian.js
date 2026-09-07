/**
 * Migration 011 — Historian, and the alarm hardening that depends on it (SQLite)
 *
 * tag_samples is a plain table (no partitions): retention is a DELETE on
 * `ts`, which the second index serves. The rollup tables and job watermarks
 * are as in Postgres. The alarm_rules changes (kind, stale_after_s, the
 * per-limit CHECK, the unique index with kind) were folded into 008; the
 * one-active-event guarantee and the registry backfill are here.
 */
'use strict';

exports.id = '011_historian';

exports.up = `
-- ── Raw samples ──────────────────────────────────────────────────────────────
CREATE TABLE tag_samples (
  tag_id   TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  ts       TIMESTAMPTZ NOT NULL,
  value    REAL,
  quality  TEXT NOT NULL DEFAULT 'good' CHECK (quality IN ('good', 'bad', 'stale'))
);
CREATE INDEX idx_tag_samples_tag_ts ON tag_samples (tag_id, ts DESC);
CREATE INDEX idx_tag_samples_ts     ON tag_samples (ts);

-- ── Rollups ──────────────────────────────────────────────────────────────────
CREATE TABLE tag_samples_1m (
  tag_id  TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  bucket  TIMESTAMPTZ NOT NULL,
  avg     REAL,
  min     REAL,
  max     REAL,
  last    REAL,
  count   INTEGER NOT NULL DEFAULT 0,
  good    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (tag_id, bucket)
);
CREATE INDEX idx_tag_samples_1m_bucket ON tag_samples_1m (bucket);

CREATE TABLE tag_samples_1h (
  tag_id  TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  bucket  TIMESTAMPTZ NOT NULL,
  avg     REAL,
  min     REAL,
  max     REAL,
  last    REAL,
  count   INTEGER NOT NULL DEFAULT 0,
  good    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (tag_id, bucket)
);
CREATE INDEX idx_tag_samples_1h_bucket ON tag_samples_1h (bucket);

CREATE TABLE historian_jobs (
  name          TEXT PRIMARY KEY,
  watermark     TIMESTAMPTZ,
  last_run_at   TIMESTAMPTZ,
  last_error    TEXT,
  rows_affected INTEGER NOT NULL DEFAULT 0
);
INSERT INTO historian_jobs (name) VALUES ('rollup_1m'), ('rollup_1h'), ('retention'), ('partitions');

-- ── Alarm events: one active event per rule, guaranteed ──────────────────────
CREATE UNIQUE INDEX uq_alarm_events_one_active ON alarm_events (rule_id) WHERE state = 'active';

-- ── Link bindings and rules to the registry where the target matches ─────────
UPDATE plc_bindings SET tag_id = t.id
  FROM tags t
 WHERE plc_bindings.tag_id IS NULL
   AND t.flowsheet_id = plc_bindings.flowsheet_id
   AND t.node_id = plc_bindings.node_id AND t.param_key = plc_bindings.param_key;
UPDATE alarm_rules SET tag_id = t.id
  FROM tags t
 WHERE alarm_rules.tag_id IS NULL AND alarm_rules.node_id IS NOT NULL
   AND t.flowsheet_id = alarm_rules.flowsheet_id
   AND t.node_id = alarm_rules.node_id AND t.param_key = alarm_rules.param_key;
`;

exports.down = `
DROP INDEX IF EXISTS uq_alarm_events_one_active;
DROP TABLE IF EXISTS historian_jobs;
DROP TABLE IF EXISTS tag_samples_1h;
DROP TABLE IF EXISTS tag_samples_1m;
DROP TABLE IF EXISTS tag_samples;
`;
