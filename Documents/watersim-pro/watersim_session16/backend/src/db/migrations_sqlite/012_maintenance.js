/**
 * Migration 012 — Maintenance workflow and notifications (SQLite)
 *
 * As the Postgres file, except:
 *   - maintenance_tasks.number has no sequence; maintenance/tasks.js assigns
 *     MAX(number)+1 in the INSERT (one writer at a time in SQLite).
 *   - the phone number CHECK uses REGEXP (registered by the driver).
 *   - channels (TEXT[]) is a JSON array.
 */
'use strict';

const { ID, CREATED_AT, UPDATED_AT, NOW, NOOP } = require('./_helpers');

exports.id = '012_maintenance';

exports.up = `
-- ── People ───────────────────────────────────────────────────────────────────
ALTER TABLE users ADD COLUMN phone_e164 TEXT
  CHECK (phone_e164 IS NULL OR phone_e164 REGEXP '^\\+[1-9][0-9]{6,14}$');

-- ── Per-rule task policy ─────────────────────────────────────────────────────
ALTER TABLE alarm_rules ADD COLUMN create_task            BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE alarm_rules ADD COLUMN task_assignee_role     TEXT CHECK (task_assignee_role IN ('operator', 'engineer', 'manager'));
ALTER TABLE alarm_rules ADD COLUMN task_requires_approval BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE alarm_rules ADD COLUMN task_due_within_h      INTEGER CHECK (task_due_within_h IS NULL OR task_due_within_h BETWEEN 1 AND 8760);
ALTER TABLE alarm_rules ADD COLUMN task_priority          TEXT CHECK (task_priority IN ('low', 'medium', 'high', 'urgent'));
UPDATE alarm_rules SET create_task = TRUE WHERE severity = 'critical';

-- ── Tasks ────────────────────────────────────────────────────────────────────
CREATE TABLE maintenance_tasks (
  ${ID},
  organisation_id   TEXT NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  number            INTEGER NOT NULL DEFAULT 0,
  flowsheet_id      TEXT REFERENCES flowsheets(id) ON DELETE SET NULL,
  tag_id            TEXT REFERENCES tags(id) ON DELETE SET NULL,
  source_event_id   TEXT REFERENCES alarm_events(id) ON DELETE SET NULL,
  source_rule_id    TEXT REFERENCES alarm_rules(id) ON DELETE SET NULL,
  title             TEXT NOT NULL,
  description       TEXT,
  priority          TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('low', 'medium', 'high', 'urgent')),
  severity          TEXT CHECK (severity IN ('info', 'warning', 'critical')),
  state             TEXT NOT NULL DEFAULT 'open'
                    CHECK (state IN ('open', 'assigned', 'in_progress', 'completed', 'approved', 'rejected', 'cancelled')),
  requires_approval BOOLEAN NOT NULL DEFAULT TRUE,
  requires_ack      BOOLEAN NOT NULL DEFAULT FALSE,
  acknowledged_by   TEXT REFERENCES users(id) ON DELETE SET NULL,
  acknowledged_at   TIMESTAMPTZ,
  assigned_role     TEXT CHECK (assigned_role IN ('operator', 'engineer', 'manager')),
  assigned_to       TEXT REFERENCES users(id) ON DELETE SET NULL,
  assigned_at       TIMESTAMPTZ,
  due_at            TIMESTAMPTZ,
  started_at        TIMESTAMPTZ,
  completed_at      TIMESTAMPTZ,
  completion_note   TEXT,
  approved_by       TEXT REFERENCES users(id) ON DELETE SET NULL,
  approved_at       TIMESTAMPTZ,
  rejected_reason   TEXT,
  closed_at         TIMESTAMPTZ,
  created_by        TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_source    TEXT NOT NULL DEFAULT 'user' CHECK (created_source IN ('user', 'evaluator', 'sweep', 'cmms')),
  ${CREATED_AT},
  ${UPDATED_AT}
);
CREATE UNIQUE INDEX uq_maintenance_tasks_event ON maintenance_tasks (source_event_id) WHERE source_event_id IS NOT NULL;
CREATE INDEX idx_maintenance_tasks_org_state ON maintenance_tasks (organisation_id, state, created_at DESC);
CREATE INDEX idx_maintenance_tasks_assignee  ON maintenance_tasks (assigned_to) WHERE state IN ('assigned', 'in_progress', 'rejected');
CREATE INDEX idx_maintenance_tasks_due       ON maintenance_tasks (due_at) WHERE closed_at IS NULL;
CREATE INDEX idx_maintenance_tasks_number    ON maintenance_tasks (number);

CREATE TABLE task_transitions (
  ${ID},
  task_id       TEXT NOT NULL REFERENCES maintenance_tasks(id) ON DELETE CASCADE,
  action        TEXT NOT NULL,
  from_state    TEXT,
  to_state      TEXT NOT NULL,
  actor_id      TEXT REFERENCES users(id) ON DELETE SET NULL,
  actor_source  TEXT NOT NULL DEFAULT 'user' CHECK (actor_source IN ('user', 'evaluator', 'sweep', 'cmms', 'system')),
  note          TEXT,
  details       JSONB NOT NULL DEFAULT '{}',
  ${CREATED_AT}
);
CREATE INDEX idx_task_transitions_task ON task_transitions (task_id, created_at);

CREATE TABLE task_comments (
  ${ID},
  task_id     TEXT NOT NULL REFERENCES maintenance_tasks(id) ON DELETE CASCADE,
  author_id   TEXT REFERENCES users(id) ON DELETE SET NULL,
  body        TEXT NOT NULL,
  ${CREATED_AT}
);
CREATE INDEX idx_task_comments_task ON task_comments (task_id, created_at);

-- ── Notifications ────────────────────────────────────────────────────────────
CREATE TABLE notification_channels (
  ${ID},
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel     TEXT NOT NULL CHECK (channel IN ('email', 'whatsapp')),
  address     TEXT NOT NULL,
  verified    BOOLEAN NOT NULL DEFAULT FALSE,
  enabled     BOOLEAN NOT NULL DEFAULT TRUE,
  ${CREATED_AT},
  ${UPDATED_AT},
  CONSTRAINT uq_notification_channels_user_channel UNIQUE (user_id, channel)
);

CREATE TABLE notification_subscriptions (
  ${ID},
  organisation_id  TEXT NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  user_id          TEXT REFERENCES users(id) ON DELETE CASCADE,
  role             TEXT CHECK (role IN ('viewer', 'operator', 'engineer', 'manager', 'admin')),
  event_type       TEXT NOT NULL,
  min_severity     TEXT NOT NULL DEFAULT 'warning' CHECK (min_severity IN ('info', 'warning', 'critical')),
  channels         JSONB NOT NULL DEFAULT '["email"]',
  enabled          BOOLEAN NOT NULL DEFAULT TRUE,
  created_by       TEXT REFERENCES users(id) ON DELETE SET NULL,
  ${CREATED_AT},
  ${UPDATED_AT},
  CONSTRAINT chk_notification_subscriptions_target CHECK ((user_id IS NULL) <> (role IS NULL))
);
CREATE INDEX idx_notification_subscriptions_org ON notification_subscriptions (organisation_id) WHERE enabled = TRUE;

CREATE TABLE notification_outbox (
  ${ID},
  organisation_id  TEXT NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  user_id          TEXT REFERENCES users(id) ON DELETE SET NULL,
  channel          TEXT NOT NULL CHECK (channel IN ('email', 'whatsapp', 'webhook')),
  address          TEXT NOT NULL,
  event_type       TEXT NOT NULL,
  template         TEXT NOT NULL,
  subject          TEXT,
  body             TEXT NOT NULL,
  payload          JSONB NOT NULL DEFAULT '{}',
  state            TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'sending', 'sent', 'failed', 'dead')),
  attempts         INTEGER NOT NULL DEFAULT 0,
  next_attempt_at  TIMESTAMPTZ NOT NULL DEFAULT ${NOW},
  sent_at          TIMESTAMPTZ,
  last_error       TEXT,
  dedupe_key       TEXT,
  ${CREATED_AT}
);
CREATE INDEX idx_notification_outbox_due ON notification_outbox (next_attempt_at) WHERE state IN ('pending', 'failed');
CREATE INDEX idx_notification_outbox_org ON notification_outbox (organisation_id, created_at DESC);
CREATE UNIQUE INDEX uq_notification_outbox_dedupe ON notification_outbox (dedupe_key) WHERE dedupe_key IS NOT NULL;
`;

exports.down = `
DROP TABLE IF EXISTS notification_outbox;
DROP TABLE IF EXISTS notification_subscriptions;
DROP TABLE IF EXISTS notification_channels;
DROP TABLE IF EXISTS task_comments;
DROP TABLE IF EXISTS task_transitions;
DROP TABLE IF EXISTS maintenance_tasks;
${NOOP}
`;
