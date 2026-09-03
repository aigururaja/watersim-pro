/**
 * Migration 007 — PLC integration
 *
 * plc_connections — one row per configured PLC endpoint (Modbus TCP, the
 *   built-in simulator, or a stub protocol). config JSONB holds driver-specific
 *   settings (host, port, unitId, …). status/last_seen/last_error are
 *   maintained by the poller (src/plc/poller.js) and the /test endpoint.
 *
 * plc_bindings — binds one node parameter on a flowsheet to one PLC tag
 *   address on a connection. UNIQUE (flowsheet_id, node_id, param_key) makes
 *   POST an upsert. Reported value = raw * scale + offset_val; writes send
 *   (value - offset_val) / scale. last_value/quality/last_read_at are the
 *   poller's latest sample (served by GET .../plc-values).
 */
'use strict';

exports.id = '007_plc_integration';

exports.up = `
CREATE TABLE plc_connections (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organisation_id  UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  name             VARCHAR(120) NOT NULL,
  protocol         VARCHAR(40) NOT NULL,
  config           JSONB NOT NULL DEFAULT '{}',
  enabled          BOOLEAN NOT NULL DEFAULT TRUE,
  status           VARCHAR(20) NOT NULL DEFAULT 'unknown',
  last_seen        TIMESTAMPTZ,
  last_error       TEXT,
  created_by       UUID REFERENCES users(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_plc_connections_org_name UNIQUE (organisation_id, name)
);
CREATE INDEX idx_plc_connections_org ON plc_connections(organisation_id);

CREATE TABLE plc_bindings (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organisation_id  UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  flowsheet_id     UUID NOT NULL REFERENCES flowsheets(id) ON DELETE CASCADE,
  node_id          VARCHAR(80) NOT NULL,
  param_key        VARCHAR(80) NOT NULL,
  connection_id    UUID NOT NULL REFERENCES plc_connections(id) ON DELETE CASCADE,
  address          VARCHAR(200) NOT NULL,
  direction        VARCHAR(12) NOT NULL DEFAULT 'read'
                     CHECK (direction IN ('read', 'write', 'read_write')),
  scale            DOUBLE PRECISION NOT NULL DEFAULT 1,
  offset_val       DOUBLE PRECISION NOT NULL DEFAULT 0,
  poll_interval_ms INTEGER,
  enabled          BOOLEAN NOT NULL DEFAULT TRUE,
  last_value       DOUBLE PRECISION,
  quality          VARCHAR(12) NOT NULL DEFAULT 'unknown',
  last_read_at     TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_plc_bindings_flowsheet_node_param UNIQUE (flowsheet_id, node_id, param_key)
);
CREATE INDEX idx_plc_bindings_flowsheet  ON plc_bindings(flowsheet_id);
CREATE INDEX idx_plc_bindings_connection ON plc_bindings(connection_id);

CREATE TRIGGER trg_plc_connections_updated BEFORE UPDATE ON plc_connections FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_plc_bindings_updated    BEFORE UPDATE ON plc_bindings    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
`;

exports.down = `
DROP TABLE IF EXISTS plc_bindings    CASCADE;
DROP TABLE IF EXISTS plc_connections CASCADE;
`;
