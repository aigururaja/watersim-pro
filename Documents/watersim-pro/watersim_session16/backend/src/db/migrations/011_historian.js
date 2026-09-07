/**
 * Migration 011 — Historian, and the alarm hardening that depends on it.
 *
 * ── tag_samples ──────────────────────────────────────────────────────────────
 * Every sample the PLC poller reads, appended, never updated. Until now the
 * poller overwrote `plc_bindings.last_value` and discarded the reading; from
 * this migration nothing is discarded. The table is RANGE-partitioned by
 * month on `ts`: retention is then `DROP TABLE` of an old partition (instant,
 * no vacuum debt) and a query for last week touches one or two partitions.
 * `ensure_tag_sample_partitions()` creates the partitions for last month
 * through two months ahead; the historian job calls it daily and the poller's
 * insert path calls it once on a routing failure before retrying, so a gap can
 * only appear if the process has been down for more than two months.
 *
 * Indexes: (tag_id, ts DESC) for "this tag over this window", which is what
 * every trend and every rollup asks; BRIN on ts for the whole-table sweeps
 * the rollup job makes, at a few kilobytes per partition.
 *
 * ── tag_samples_1m / tag_samples_1h ──────────────────────────────────────────
 * Per-tag, per-bucket avg/min/max/last/count, computed by the rollup job from
 * raw (1m) and from 1m (1h). `good` is the count of good-quality samples in
 * the bucket, so availability = good / count and an average is never diluted
 * by a bad read. Keyed by (tag_id, bucket): the job upserts, so re-running a
 * window is idempotent.
 *
 * ── historian_jobs ───────────────────────────────────────────────────────────
 * One row per job with its watermark, so a restart resumes where the last
 * rollup stopped rather than from now (which would leave a hole).
 *
 * ── Alarm hardening ──────────────────────────────────────────────────────────
 * 1. `alarm_rules.kind` — 'high' | 'low' | 'range' | 'quality'. Migration 008
 *    put HIGH and LOW on one rule with one severity, and its unique index
 *    forbade a second rule per target — so "critical above 30, warning below
 *    5" was impossible. The unique index now includes `kind`, one rule per
 *    limit. Existing rows are classified from their limits.
 * 2. `kind = 'quality'` with `stale_after_s` — the comms-loss alarm, the only
 *    alarm that fires when the PLC STOPS talking. Evaluated by the quality
 *    sweep from `plc_bindings.quality / last_read_at`, never from a value.
 * 3. `uq_alarm_events_one_active` — one active event per rule is now a
 *    database guarantee, not a SELECT-then-INSERT in application code. Any
 *    historical duplicates are cleared (newest kept) before the index goes on.
 * 4. `plc_bindings.tag_id` and `alarm_rules.tag_id` (added nullable in 010)
 *    are backfilled from the registry by (flowsheet, node, param).
 */
'use strict';

exports.id = '011_historian';

exports.up = `
-- ── Raw samples ──────────────────────────────────────────────────────────────
CREATE TABLE tag_samples (
  tag_id   UUID NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  ts       TIMESTAMPTZ NOT NULL,
  value    DOUBLE PRECISION,
  quality  TEXT NOT NULL DEFAULT 'good' CHECK (quality IN ('good', 'bad', 'stale'))
) PARTITION BY RANGE (ts);

CREATE INDEX idx_tag_samples_tag_ts ON tag_samples (tag_id, ts DESC);
CREATE INDEX idx_tag_samples_ts_brin ON tag_samples USING BRIN (ts);

CREATE OR REPLACE FUNCTION ensure_tag_sample_partitions(months_back INT DEFAULT 1, months_ahead INT DEFAULT 2)
RETURNS INT
LANGUAGE plpgsql
AS $fn$
DECLARE
  m       DATE;
  lo      TIMESTAMPTZ;
  hi      TIMESTAMPTZ;
  nm      TEXT;
  created INT := 0;
BEGIN
  FOR i IN -months_back..months_ahead LOOP
    m  := (date_trunc('month', now()) + make_interval(months => i))::date;
    lo := m::timestamptz;
    hi := (m + interval '1 month')::timestamptz;
    nm := format('tag_samples_y%sm%s', to_char(m, 'YYYY'), to_char(m, 'MM'));
    IF to_regclass(nm) IS NULL THEN
      EXECUTE format('CREATE TABLE %I PARTITION OF tag_samples FOR VALUES FROM (%L) TO (%L)', nm, lo, hi);
      created := created + 1;
    END IF;
  END LOOP;
  RETURN created;
END
$fn$;

SELECT ensure_tag_sample_partitions(1, 2);

-- ── Rollups ──────────────────────────────────────────────────────────────────
CREATE TABLE tag_samples_1m (
  tag_id  UUID NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  bucket  TIMESTAMPTZ NOT NULL,
  avg     DOUBLE PRECISION,
  min     DOUBLE PRECISION,
  max     DOUBLE PRECISION,
  last    DOUBLE PRECISION,
  count   INTEGER NOT NULL DEFAULT 0,
  good    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (tag_id, bucket)
);
CREATE INDEX idx_tag_samples_1m_bucket ON tag_samples_1m (bucket);

CREATE TABLE tag_samples_1h (
  tag_id  UUID NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  bucket  TIMESTAMPTZ NOT NULL,
  avg     DOUBLE PRECISION,
  min     DOUBLE PRECISION,
  max     DOUBLE PRECISION,
  last    DOUBLE PRECISION,
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
  rows_affected BIGINT NOT NULL DEFAULT 0
);
INSERT INTO historian_jobs (name) VALUES ('rollup_1m'), ('rollup_1h'), ('retention'), ('partitions');

-- ── Alarm rules: one rule per limit, plus the comms-loss kind ────────────────
ALTER TABLE alarm_rules
  ADD COLUMN kind          TEXT NOT NULL DEFAULT 'range'
                           CHECK (kind IN ('high', 'low', 'range', 'quality')),
  ADD COLUMN stale_after_s INTEGER
                           CHECK (stale_after_s IS NULL OR stale_after_s BETWEEN 5 AND 86400);

UPDATE alarm_rules SET kind = CASE
  WHEN min_value IS NULL THEN 'high'
  WHEN max_value IS NULL THEN 'low'
  ELSE 'range' END;

ALTER TABLE alarm_rules DROP CONSTRAINT chk_alarm_rules_limit;
ALTER TABLE alarm_rules ADD CONSTRAINT chk_alarm_rules_limit CHECK (
  (kind = 'high'    AND max_value IS NOT NULL AND min_value IS NULL     AND stale_after_s IS NULL) OR
  (kind = 'low'     AND min_value IS NOT NULL AND max_value IS NULL     AND stale_after_s IS NULL) OR
  (kind = 'range'   AND min_value IS NOT NULL AND max_value IS NOT NULL AND stale_after_s IS NULL) OR
  (kind = 'quality' AND stale_after_s IS NOT NULL AND min_value IS NULL AND max_value IS NULL)
);

DROP INDEX uq_alarm_rules_target;
CREATE UNIQUE INDEX uq_alarm_rules_target
  ON alarm_rules (flowsheet_id, target_type, COALESCE(node_id, ''), param_key, kind);

-- ── Alarm events: one active event per rule, guaranteed ──────────────────────
UPDATE alarm_events e
   SET state = 'cleared', cleared_at = COALESCE(e.cleared_at, NOW())
 WHERE e.state = 'active'
   AND e.id <> (SELECT x.id FROM alarm_events x
                 WHERE x.rule_id = e.rule_id AND x.state = 'active'
                 ORDER BY x.triggered_at DESC, x.id DESC LIMIT 1);
CREATE UNIQUE INDEX uq_alarm_events_one_active ON alarm_events (rule_id) WHERE state = 'active';

-- ── Link bindings and rules to the registry where the target matches ─────────
UPDATE plc_bindings b SET tag_id = t.id
  FROM tags t
 WHERE b.tag_id IS NULL
   AND t.flowsheet_id = b.flowsheet_id AND t.node_id = b.node_id AND t.param_key = b.param_key;
UPDATE alarm_rules r SET tag_id = t.id
  FROM tags t
 WHERE r.tag_id IS NULL AND r.node_id IS NOT NULL
   AND t.flowsheet_id = r.flowsheet_id AND t.node_id = r.node_id AND t.param_key = r.param_key;
CREATE INDEX IF NOT EXISTS idx_plc_bindings_tag ON plc_bindings (tag_id) WHERE tag_id IS NOT NULL;
`;

exports.down = `
DROP INDEX IF EXISTS idx_plc_bindings_tag;
DROP INDEX IF EXISTS uq_alarm_events_one_active;
DROP INDEX IF EXISTS uq_alarm_rules_target;
CREATE UNIQUE INDEX uq_alarm_rules_target
  ON alarm_rules (flowsheet_id, target_type, COALESCE(node_id, ''), param_key);
ALTER TABLE alarm_rules DROP CONSTRAINT chk_alarm_rules_limit;
DELETE FROM alarm_rules WHERE kind = 'quality';
ALTER TABLE alarm_rules ADD CONSTRAINT chk_alarm_rules_limit CHECK (min_value IS NOT NULL OR max_value IS NOT NULL);
ALTER TABLE alarm_rules DROP COLUMN stale_after_s, DROP COLUMN kind;
DROP TABLE IF EXISTS historian_jobs;
DROP TABLE IF EXISTS tag_samples_1h;
DROP TABLE IF EXISTS tag_samples_1m;
DROP FUNCTION IF EXISTS ensure_tag_sample_partitions(INT, INT);
DROP TABLE IF EXISTS tag_samples CASCADE;
`;
