/**
 * Migration 012 — Maintenance workflow and notifications (Phase 2).
 *
 * ── The workflow ─────────────────────────────────────────────────────────────
 * An alarm becomes a task, a task reaches a person, and a manager signs it
 * off — with the trail to prove it.
 *
 *   maintenance_tasks   one row per work item. `state` moves only through
 *                       maintenance/tasks.js transition(): open → assigned →
 *                       in_progress → completed → approved | rejected
 *                       (→ in_progress again), or cancelled. A critical alarm's
 *                       task additionally needs a manager's ACKNOWLEDGEMENT
 *                       (requires_ack, acknowledged_by/at) — a separate act
 *                       from approving the finished work (open question 8:
 *                       both are recorded, neither is implied by the other).
 *                       UNIQUE on source_event_id: one task per alarm event,
 *                       whoever raises it first (the evaluator or a person).
 *   task_transitions    every state change, with who did it and why. The
 *                       audit_logs row is written as well; this table is the
 *                       task's own readable history.
 *   task_comments       discussion on a task.
 *
 * ── Per-rule policy ──────────────────────────────────────────────────────────
 * `alarm_rules.create_task` etc. let the EVALUATOR raise the task, not a
 * person. Existing critical rules are switched on (open question 3: critical
 * auto-creates, warnings are opt-in); the assignee role defaults to engineer.
 *
 * ── Notifications ────────────────────────────────────────────────────────────
 *   notification_channels       a user's addresses per channel (email defaults
 *                               to the login email; WhatsApp needs an E.164
 *                               number). `verified` is informational until a
 *                               verification flow exists.
 *   notification_subscriptions  org policy: (role | user) × event_type ×
 *                               min_severity → channels[]. `event_type` may be
 *                               a prefix ending in '.' ('alarm.' matches
 *                               alarm.raised and alarm.cleared).
 *   notification_outbox         one row per message per recipient per channel.
 *                               A worker drains it with exponential backoff;
 *                               `dedupe_key` stops a re-evaluated alarm from
 *                               mailing the same person twice.
 */
'use strict';

exports.id = '012_maintenance';

exports.up = `
-- ── People ───────────────────────────────────────────────────────────────────
ALTER TABLE users ADD COLUMN phone_e164 VARCHAR(20)
  CHECK (phone_e164 IS NULL OR phone_e164 ~ '^\\+[1-9][0-9]{6,14}$');

-- ── Per-rule task policy ─────────────────────────────────────────────────────
ALTER TABLE alarm_rules
  ADD COLUMN create_task            BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN task_assignee_role     TEXT CHECK (task_assignee_role IN ('operator', 'engineer', 'manager')),
  ADD COLUMN task_requires_approval BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN task_due_within_h      INTEGER CHECK (task_due_within_h IS NULL OR task_due_within_h BETWEEN 1 AND 8760),
  ADD COLUMN task_priority          TEXT CHECK (task_priority IN ('low', 'medium', 'high', 'urgent'));
UPDATE alarm_rules SET create_task = TRUE WHERE severity = 'critical';

-- ── Tasks ────────────────────────────────────────────────────────────────────
CREATE SEQUENCE maintenance_tasks_number_seq;

CREATE TABLE maintenance_tasks (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id   UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  number            BIGINT NOT NULL DEFAULT nextval('maintenance_tasks_number_seq'),
  flowsheet_id      UUID REFERENCES flowsheets(id) ON DELETE SET NULL,
  tag_id            UUID REFERENCES tags(id) ON DELETE SET NULL,
  source_event_id   UUID REFERENCES alarm_events(id) ON DELETE SET NULL,
  source_rule_id    UUID REFERENCES alarm_rules(id) ON DELETE SET NULL,
  title             VARCHAR(200) NOT NULL,
  description       TEXT,
  priority          TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('low', 'medium', 'high', 'urgent')),
  severity          TEXT CHECK (severity IN ('info', 'warning', 'critical')),
  state             TEXT NOT NULL DEFAULT 'open'
                    CHECK (state IN ('open', 'assigned', 'in_progress', 'completed', 'approved', 'rejected', 'cancelled')),
  requires_approval BOOLEAN NOT NULL DEFAULT TRUE,
  requires_ack      BOOLEAN NOT NULL DEFAULT FALSE,
  acknowledged_by   UUID REFERENCES users(id) ON DELETE SET NULL,
  acknowledged_at   TIMESTAMPTZ,
  assigned_role     TEXT CHECK (assigned_role IN ('operator', 'engineer', 'manager')),
  assigned_to       UUID REFERENCES users(id) ON DELETE SET NULL,
  assigned_at       TIMESTAMPTZ,
  due_at            TIMESTAMPTZ,
  started_at        TIMESTAMPTZ,
  completed_at      TIMESTAMPTZ,
  completion_note   TEXT,
  approved_by       UUID REFERENCES users(id) ON DELETE SET NULL,
  approved_at       TIMESTAMPTZ,
  rejected_reason   TEXT,
  closed_at         TIMESTAMPTZ,
  created_by        UUID REFERENCES users(id) ON DELETE SET NULL,
  created_source    TEXT NOT NULL DEFAULT 'user' CHECK (created_source IN ('user', 'evaluator', 'sweep', 'cmms')),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX uq_maintenance_tasks_event ON maintenance_tasks (source_event_id) WHERE source_event_id IS NOT NULL;
CREATE INDEX idx_maintenance_tasks_org_state ON maintenance_tasks (organisation_id, state, created_at DESC);
CREATE INDEX idx_maintenance_tasks_assignee  ON maintenance_tasks (assigned_to) WHERE state IN ('assigned', 'in_progress', 'rejected');
CREATE INDEX idx_maintenance_tasks_due       ON maintenance_tasks (due_at) WHERE closed_at IS NULL;
CREATE TRIGGER trg_maintenance_tasks_updated BEFORE UPDATE ON maintenance_tasks FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE task_transitions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id       UUID NOT NULL REFERENCES maintenance_tasks(id) ON DELETE CASCADE,
  action        TEXT NOT NULL,
  from_state    TEXT,
  to_state      TEXT NOT NULL,
  actor_id      UUID REFERENCES users(id) ON DELETE SET NULL,
  actor_source  TEXT NOT NULL DEFAULT 'user' CHECK (actor_source IN ('user', 'evaluator', 'sweep', 'cmms', 'system')),
  note          TEXT,
  details       JSONB NOT NULL DEFAULT '{}',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_task_transitions_task ON task_transitions (task_id, created_at);

CREATE TABLE task_comments (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id     UUID NOT NULL REFERENCES maintenance_tasks(id) ON DELETE CASCADE,
  author_id   UUID REFERENCES users(id) ON DELETE SET NULL,
  body        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_task_comments_task ON task_comments (task_id, created_at);

-- ── Notifications ────────────────────────────────────────────────────────────
CREATE TABLE notification_channels (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel     TEXT NOT NULL CHECK (channel IN ('email', 'whatsapp')),
  address     TEXT NOT NULL,
  verified    BOOLEAN NOT NULL DEFAULT FALSE,
  enabled     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_notification_channels_user_channel UNIQUE (user_id, channel)
);
CREATE TRIGGER trg_notification_channels_updated BEFORE UPDATE ON notification_channels FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE notification_subscriptions (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id  UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  user_id          UUID REFERENCES users(id) ON DELETE CASCADE,
  role             TEXT CHECK (role IN ('viewer', 'operator', 'engineer', 'manager', 'admin')),
  event_type       TEXT NOT NULL,
  min_severity     TEXT NOT NULL DEFAULT 'warning' CHECK (min_severity IN ('info', 'warning', 'critical')),
  channels         TEXT[] NOT NULL DEFAULT ARRAY['email']::TEXT[],
  enabled          BOOLEAN NOT NULL DEFAULT TRUE,
  created_by       UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_notification_subscriptions_target CHECK ((user_id IS NULL) <> (role IS NULL))
);
CREATE INDEX idx_notification_subscriptions_org ON notification_subscriptions (organisation_id) WHERE enabled = TRUE;
CREATE TRIGGER trg_notification_subscriptions_updated BEFORE UPDATE ON notification_subscriptions FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE notification_outbox (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id  UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  user_id          UUID REFERENCES users(id) ON DELETE SET NULL,
  channel          TEXT NOT NULL CHECK (channel IN ('email', 'whatsapp', 'webhook')),
  address          TEXT NOT NULL,
  event_type       TEXT NOT NULL,
  template         TEXT NOT NULL,
  subject          TEXT,
  body             TEXT NOT NULL,
  payload          JSONB NOT NULL DEFAULT '{}',
  state            TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'sending', 'sent', 'failed', 'dead')),
  attempts         INTEGER NOT NULL DEFAULT 0,
  next_attempt_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_at          TIMESTAMPTZ,
  last_error       TEXT,
  dedupe_key       TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
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
DROP SEQUENCE IF EXISTS maintenance_tasks_number_seq;
ALTER TABLE alarm_rules
  DROP COLUMN IF EXISTS create_task,
  DROP COLUMN IF EXISTS task_assignee_role,
  DROP COLUMN IF EXISTS task_requires_approval,
  DROP COLUMN IF EXISTS task_due_within_h,
  DROP COLUMN IF EXISTS task_priority;
ALTER TABLE users DROP COLUMN IF EXISTS phone_e164;
`;
