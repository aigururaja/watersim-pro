/**
 * Migration 013 — Digital twin (Phase 4).
 *
 *   twin_config          one row per flowsheet that has a twin: whether the
 *                        server loop runs it, how often, and the |z| past
 *                        which a residual is drift.
 *   twin_state           the latest solve: a compact summary and per-node
 *                        metrics, the measured parameters that were merged in,
 *                        the residual summary, and the error if it failed.
 *   twin_residuals       one row per instrument per solve: what the model said,
 *                        what the transmitter said, the difference, and its z
 *                        against the running spread of that instrument's
 *                        residuals. This is the twin's actual product.
 *   twin_residual_stats  Welford running mean / M2 per instrument, so z needs
 *                        no scan of history.
 *   equipment_counters   run hours, starts and trips per drive per day,
 *                        derived from XS / XA transitions in the historian —
 *                        the feed predictive maintenance needs (Phase 5).
 *   plc_connections.mode 'live' talks to the device; 'shadow' routes every
 *                        write to the simulator register namespace and reads
 *                        from it, so a control sequence can be exercised
 *                        against a responding plant that is not the plant.
 *   alarm_rules.kind     gains 'drift' — max_value is the |z| limit.
 */
'use strict';

exports.id = '013_twin';

exports.up = `
CREATE TABLE twin_config (
  flowsheet_id     UUID PRIMARY KEY REFERENCES flowsheets(id) ON DELETE CASCADE,
  organisation_id  UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  enabled          BOOLEAN NOT NULL DEFAULT FALSE,
  cadence_s        INTEGER NOT NULL DEFAULT 60 CHECK (cadence_s BETWEEN 5 AND 3600),
  drift_z          DOUBLE PRECISION NOT NULL DEFAULT 3 CHECK (drift_z > 0),
  updated_by       UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_twin_config_org ON twin_config (organisation_id) WHERE enabled = TRUE;
CREATE TRIGGER trg_twin_config_updated BEFORE UPDATE ON twin_config FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE twin_state (
  flowsheet_id      UUID PRIMARY KEY REFERENCES flowsheets(id) ON DELETE CASCADE,
  organisation_id   UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  seq               BIGINT NOT NULL DEFAULT 0,
  solved_at         TIMESTAMPTZ,
  duration_ms       INTEGER,
  summary           JSONB,
  node_metrics      JSONB,
  node_params       JSONB,
  measured          JSONB,
  residuals         JSONB,
  error             TEXT,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE twin_residuals (
  tag_id     UUID NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  ts         TIMESTAMPTZ NOT NULL,
  modelled   DOUBLE PRECISION,
  measured   DOUBLE PRECISION,
  residual   DOUBLE PRECISION,
  z          DOUBLE PRECISION
);
CREATE INDEX idx_twin_residuals_tag_ts ON twin_residuals (tag_id, ts DESC);

CREATE TABLE twin_residual_stats (
  tag_id      UUID PRIMARY KEY REFERENCES tags(id) ON DELETE CASCADE,
  n           INTEGER NOT NULL DEFAULT 0,
  mean        DOUBLE PRECISION NOT NULL DEFAULT 0,
  m2          DOUBLE PRECISION NOT NULL DEFAULT 0,
  last_z      DOUBLE PRECISION,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE equipment_counters (
  tag_id      UUID NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  day         DATE NOT NULL,
  run_hours   DOUBLE PRECISION NOT NULL DEFAULT 0,
  starts      INTEGER NOT NULL DEFAULT 0,
  trips       INTEGER NOT NULL DEFAULT 0,
  last_state  SMALLINT,
  last_ts     TIMESTAMPTZ,
  PRIMARY KEY (tag_id, day)
);
CREATE INDEX idx_equipment_counters_day ON equipment_counters (day);
INSERT INTO historian_jobs (name) VALUES ('counters') ON CONFLICT (name) DO NOTHING;

ALTER TABLE plc_connections
  ADD COLUMN mode TEXT NOT NULL DEFAULT 'live' CHECK (mode IN ('live', 'shadow')),
  ADD COLUMN mode_changed_by UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN mode_changed_at TIMESTAMPTZ;

ALTER TABLE alarm_rules DROP CONSTRAINT IF EXISTS alarm_rules_kind_check;
ALTER TABLE alarm_rules ADD CONSTRAINT chk_alarm_rules_kind CHECK (kind IN ('high', 'low', 'range', 'quality', 'drift'));
ALTER TABLE alarm_rules DROP CONSTRAINT chk_alarm_rules_limit;
ALTER TABLE alarm_rules ADD CONSTRAINT chk_alarm_rules_limit CHECK (
  (kind = 'high'    AND max_value IS NOT NULL AND min_value IS NULL     AND stale_after_s IS NULL) OR
  (kind = 'low'     AND min_value IS NOT NULL AND max_value IS NULL     AND stale_after_s IS NULL) OR
  (kind = 'range'   AND min_value IS NOT NULL AND max_value IS NOT NULL AND stale_after_s IS NULL) OR
  (kind = 'quality' AND stale_after_s IS NOT NULL AND min_value IS NULL AND max_value IS NULL) OR
  (kind = 'drift'   AND max_value IS NOT NULL AND min_value IS NULL     AND stale_after_s IS NULL)
);
`;

exports.down = `
DELETE FROM alarm_rules WHERE kind = 'drift';
ALTER TABLE alarm_rules DROP CONSTRAINT chk_alarm_rules_limit;
ALTER TABLE alarm_rules ADD CONSTRAINT chk_alarm_rules_limit CHECK (
  (kind = 'high'    AND max_value IS NOT NULL AND min_value IS NULL     AND stale_after_s IS NULL) OR
  (kind = 'low'     AND min_value IS NOT NULL AND max_value IS NULL     AND stale_after_s IS NULL) OR
  (kind = 'range'   AND min_value IS NOT NULL AND max_value IS NOT NULL AND stale_after_s IS NULL) OR
  (kind = 'quality' AND stale_after_s IS NOT NULL AND min_value IS NULL AND max_value IS NULL)
);
ALTER TABLE alarm_rules DROP CONSTRAINT IF EXISTS chk_alarm_rules_kind;
ALTER TABLE alarm_rules ADD CONSTRAINT alarm_rules_kind_check CHECK (kind IN ('high', 'low', 'range', 'quality'));
ALTER TABLE plc_connections DROP COLUMN IF EXISTS mode_changed_at, DROP COLUMN IF EXISTS mode_changed_by, DROP COLUMN IF EXISTS mode;
DELETE FROM historian_jobs WHERE name = 'counters';
DROP TABLE IF EXISTS equipment_counters;
DROP TABLE IF EXISTS twin_residual_stats;
DROP TABLE IF EXISTS twin_residuals;
DROP TABLE IF EXISTS twin_state;
DROP TABLE IF EXISTS twin_config;
`;
