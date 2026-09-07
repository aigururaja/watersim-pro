/**
 * Migration 014 — The CMMS boundary (Phase 5).
 *
 *   api_keys            service credentials. The key itself (`wsk_<prefix>_<secret>`)
 *                       is shown once at creation; only its SHA-256 is kept.
 *                       `scopes` names what the key may do (assets:read,
 *                       history:read, counters:read, events:read, workorders:write).
 *   webhook_endpoints   where outbound events go, with the HMAC secret (also
 *                       shown once) and the event types they subscribe to.
 *                       Deliveries ride the Phase 2 outbox on channel 'webhook'.
 *   maintenance_tasks   external_system / external_ref link a task to the work
 *                       order the CMMS holds for it, so a status coming back
 *                       finds its task.
 */
'use strict';

exports.id = '014_cmms';

exports.up = `
CREATE TABLE api_keys (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id  UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  name             VARCHAR(120) NOT NULL,
  key_prefix       VARCHAR(16) NOT NULL,
  key_hash         VARCHAR(64) NOT NULL UNIQUE,
  scopes           TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  expires_at       TIMESTAMPTZ,
  last_used_at     TIMESTAMPTZ,
  revoked_at       TIMESTAMPTZ,
  created_by       UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_api_keys_org_name UNIQUE (organisation_id, name)
);
CREATE INDEX idx_api_keys_prefix ON api_keys (key_prefix) WHERE revoked_at IS NULL;

CREATE TABLE webhook_endpoints (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id  UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  name             VARCHAR(120) NOT NULL,
  url              TEXT NOT NULL,
  secret           VARCHAR(128) NOT NULL,
  event_types      TEXT[] NOT NULL DEFAULT ARRAY['*']::TEXT[],
  enabled          BOOLEAN NOT NULL DEFAULT TRUE,
  last_status      INTEGER,
  last_delivery_at TIMESTAMPTZ,
  last_error       TEXT,
  failures         INTEGER NOT NULL DEFAULT 0,
  created_by       UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_webhook_endpoints_org_name UNIQUE (organisation_id, name)
);
CREATE TRIGGER trg_webhook_endpoints_updated BEFORE UPDATE ON webhook_endpoints FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE notification_outbox ADD COLUMN endpoint_id UUID REFERENCES webhook_endpoints(id) ON DELETE CASCADE;

ALTER TABLE maintenance_tasks
  ADD COLUMN external_system TEXT,
  ADD COLUMN external_ref    TEXT;
CREATE UNIQUE INDEX uq_maintenance_tasks_external
  ON maintenance_tasks (organisation_id, external_system, external_ref) WHERE external_ref IS NOT NULL;
`;

exports.down = `
DROP INDEX IF EXISTS uq_maintenance_tasks_external;
ALTER TABLE maintenance_tasks DROP COLUMN IF EXISTS external_ref, DROP COLUMN IF EXISTS external_system;
ALTER TABLE notification_outbox DROP COLUMN IF EXISTS endpoint_id;
DROP TABLE IF EXISTS webhook_endpoints;
DROP TABLE IF EXISTS api_keys;
`;
