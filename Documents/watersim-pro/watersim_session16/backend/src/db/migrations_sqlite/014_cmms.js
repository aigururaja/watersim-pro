/**
 * Migration 014 — The CMMS boundary (SQLite)
 * api_keys, webhook_endpoints, the outbox's endpoint link and the tasks'
 * external reference. TEXT[] columns are JSON arrays.
 */
'use strict';

const { ID, CREATED_AT, UPDATED_AT, NOOP } = require('./_helpers');

exports.id = '014_cmms';

exports.up = `
CREATE TABLE api_keys (
  ${ID},
  organisation_id  TEXT NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  name             TEXT NOT NULL,
  key_prefix       TEXT NOT NULL,
  key_hash         TEXT NOT NULL UNIQUE,
  scopes           JSONB NOT NULL DEFAULT '[]',
  expires_at       TIMESTAMPTZ,
  last_used_at     TIMESTAMPTZ,
  revoked_at       TIMESTAMPTZ,
  created_by       TEXT REFERENCES users(id) ON DELETE SET NULL,
  ${CREATED_AT},
  CONSTRAINT uq_api_keys_org_name UNIQUE (organisation_id, name)
);
CREATE INDEX idx_api_keys_prefix ON api_keys (key_prefix) WHERE revoked_at IS NULL;

CREATE TABLE webhook_endpoints (
  ${ID},
  organisation_id  TEXT NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  name             TEXT NOT NULL,
  url              TEXT NOT NULL,
  secret           TEXT NOT NULL,
  event_types      JSONB NOT NULL DEFAULT '["*"]',
  enabled          BOOLEAN NOT NULL DEFAULT TRUE,
  last_status      INTEGER,
  last_delivery_at TIMESTAMPTZ,
  last_error       TEXT,
  failures         INTEGER NOT NULL DEFAULT 0,
  created_by       TEXT REFERENCES users(id) ON DELETE SET NULL,
  ${CREATED_AT},
  ${UPDATED_AT},
  CONSTRAINT uq_webhook_endpoints_org_name UNIQUE (organisation_id, name)
);

ALTER TABLE notification_outbox ADD COLUMN endpoint_id TEXT REFERENCES webhook_endpoints(id) ON DELETE CASCADE;

ALTER TABLE maintenance_tasks ADD COLUMN external_system TEXT;
ALTER TABLE maintenance_tasks ADD COLUMN external_ref    TEXT;
CREATE UNIQUE INDEX uq_maintenance_tasks_external
  ON maintenance_tasks (organisation_id, external_system, external_ref) WHERE external_ref IS NOT NULL;
`;

exports.down = `
DROP INDEX IF EXISTS uq_maintenance_tasks_external;
DROP TABLE IF EXISTS webhook_endpoints;
DROP TABLE IF EXISTS api_keys;
${NOOP}
`;
