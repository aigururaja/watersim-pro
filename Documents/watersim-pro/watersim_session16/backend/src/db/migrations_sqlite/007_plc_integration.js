/**
 * Migration 007 — PLC integration (SQLite)
 * plc_connections and plc_bindings; see the Postgres file for the column notes.
 */
'use strict';

const { ID, CREATED_AT, UPDATED_AT } = require('./_helpers');

exports.id = '007_plc_integration';

exports.up = `
CREATE TABLE plc_connections (
  ${ID},
  organisation_id  TEXT NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  name             TEXT NOT NULL,
  protocol         TEXT NOT NULL,
  config           JSONB NOT NULL DEFAULT '{}',
  enabled          BOOLEAN NOT NULL DEFAULT TRUE,
  status           TEXT NOT NULL DEFAULT 'unknown',
  last_seen        TIMESTAMPTZ,
  last_error       TEXT,
  created_by       TEXT REFERENCES users(id),
  ${CREATED_AT},
  ${UPDATED_AT},
  CONSTRAINT uq_plc_connections_org_name UNIQUE (organisation_id, name)
);
CREATE INDEX idx_plc_connections_org ON plc_connections(organisation_id);

CREATE TABLE plc_bindings (
  ${ID},
  organisation_id  TEXT NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  flowsheet_id     TEXT NOT NULL REFERENCES flowsheets(id) ON DELETE CASCADE,
  node_id          TEXT NOT NULL,
  param_key        TEXT NOT NULL,
  connection_id    TEXT NOT NULL REFERENCES plc_connections(id) ON DELETE CASCADE,
  address          TEXT NOT NULL,
  direction        TEXT NOT NULL DEFAULT 'read' CHECK (direction IN ('read', 'write', 'read_write')),
  scale            REAL NOT NULL DEFAULT 1,
  offset_val       REAL NOT NULL DEFAULT 0,
  poll_interval_ms INTEGER,
  enabled          BOOLEAN NOT NULL DEFAULT TRUE,
  last_value       REAL,
  quality          TEXT NOT NULL DEFAULT 'unknown',
  last_read_at     TIMESTAMPTZ,
  ${CREATED_AT},
  ${UPDATED_AT},
  CONSTRAINT uq_plc_bindings_flowsheet_node_param UNIQUE (flowsheet_id, node_id, param_key)
);
CREATE INDEX idx_plc_bindings_flowsheet  ON plc_bindings(flowsheet_id);
CREATE INDEX idx_plc_bindings_connection ON plc_bindings(connection_id);
`;

exports.down = `
DROP TABLE IF EXISTS plc_bindings;
DROP TABLE IF EXISTS plc_connections;
`;
