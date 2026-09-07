/**
 * Migration: 001_initial_schema (SQLite)
 * Foundation schema — organisations, users, tokens, projects, flowsheets,
 * simulation runs, snapshots, audit logs.
 *
 * Differences from the Postgres file: enums are CHECK constraints (the
 * 'manager' role from 009 is already listed), UUIDs are TEXT filled by
 * uuid_generate_v4() (registered by the driver), arrays are JSON, INET is
 * TEXT, and updated_at is maintained by the driver on every UPDATE instead of
 * a trigger.
 */
'use strict';

const { ID, CREATED_AT, UPDATED_AT, NOW } = require('./_helpers');

exports.id = '001_initial_schema';

exports.up = `
CREATE TABLE organisations (
  ${ID},
  name       TEXT NOT NULL,
  slug       TEXT NOT NULL UNIQUE,
  settings   JSONB NOT NULL DEFAULT '{}',
  is_active  BOOLEAN NOT NULL DEFAULT TRUE,
  ${CREATED_AT},
  ${UPDATED_AT}
);
CREATE INDEX idx_organisations_slug ON organisations(slug);

CREATE TABLE users (
  ${ID},
  organisation_id  TEXT NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  email            TEXT NOT NULL,
  password_hash    TEXT NOT NULL,
  first_name       TEXT NOT NULL,
  last_name        TEXT NOT NULL,
  role             TEXT NOT NULL DEFAULT 'viewer'
                   CHECK (role IN ('admin', 'manager', 'engineer', 'operator', 'viewer')),
  is_active        BOOLEAN NOT NULL DEFAULT TRUE,
  last_login_at    TIMESTAMPTZ,
  email_verified   BOOLEAN NOT NULL DEFAULT FALSE,
  ${CREATED_AT},
  ${UPDATED_AT},
  CONSTRAINT uq_users_email_org UNIQUE (email, organisation_id)
);
CREATE INDEX idx_users_organisation ON users(organisation_id);
CREATE INDEX idx_users_email        ON users(email);

CREATE TABLE refresh_tokens (
  ${ID},
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL UNIQUE,
  expires_at  TIMESTAMPTZ NOT NULL,
  revoked     BOOLEAN NOT NULL DEFAULT FALSE,
  ${CREATED_AT},
  ip_address  TEXT,
  user_agent  TEXT
);
CREATE INDEX idx_refresh_tokens_user ON refresh_tokens(user_id);
CREATE INDEX idx_refresh_tokens_hash ON refresh_tokens(token_hash);

CREATE TABLE projects (
  ${ID},
  organisation_id  TEXT NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  created_by       TEXT NOT NULL REFERENCES users(id),
  name             TEXT NOT NULL,
  description      TEXT,
  status           TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived', 'deleted')),
  tags             JSONB NOT NULL DEFAULT '[]',
  settings         JSONB NOT NULL DEFAULT '{}',
  ${CREATED_AT},
  ${UPDATED_AT}
);
CREATE INDEX idx_projects_organisation ON projects(organisation_id);
CREATE INDEX idx_projects_created_by   ON projects(created_by);
CREATE INDEX idx_projects_status       ON projects(status);

CREATE TABLE project_members (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role       TEXT NOT NULL DEFAULT 'viewer'
             CHECK (role IN ('admin', 'manager', 'engineer', 'operator', 'viewer')),
  added_at   TIMESTAMPTZ NOT NULL DEFAULT ${NOW},
  added_by   TEXT REFERENCES users(id),
  PRIMARY KEY (project_id, user_id)
);

CREATE TABLE flowsheets (
  ${ID},
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  created_by  TEXT NOT NULL REFERENCES users(id),
  name        TEXT NOT NULL,
  description TEXT,
  canvas_data JSONB NOT NULL DEFAULT '{"nodes":[],"edges":[],"viewport":{}}',
  version     INTEGER NOT NULL DEFAULT 1,
  is_locked   BOOLEAN NOT NULL DEFAULT FALSE,
  locked_by   TEXT REFERENCES users(id),
  ${CREATED_AT},
  ${UPDATED_AT}
);
CREATE INDEX idx_flowsheets_project ON flowsheets(project_id);

CREATE TABLE flowsheet_snapshots (
  ${ID},
  flowsheet_id   TEXT NOT NULL REFERENCES flowsheets(id) ON DELETE CASCADE,
  created_by     TEXT NOT NULL REFERENCES users(id),
  label          TEXT NOT NULL,
  notes          TEXT,
  canvas_data    JSONB NOT NULL,
  version_number INTEGER NOT NULL,
  ${CREATED_AT}
);
CREATE INDEX idx_snapshots_flowsheet ON flowsheet_snapshots(flowsheet_id);

CREATE TABLE simulation_runs (
  ${ID},
  flowsheet_id  TEXT NOT NULL REFERENCES flowsheets(id) ON DELETE CASCADE,
  created_by    TEXT NOT NULL REFERENCES users(id),
  mode          TEXT NOT NULL CHECK (mode IN ('steady_state', 'dynamic')),
  status        TEXT NOT NULL DEFAULT 'idle'
                CHECK (status IN ('idle', 'running', 'completed', 'failed', 'cancelled')),
  config        JSONB NOT NULL DEFAULT '{}',
  results       JSONB,
  error_message TEXT,
  started_at    TIMESTAMPTZ,
  completed_at  TIMESTAMPTZ,
  ${CREATED_AT}
);
CREATE INDEX idx_simulation_runs_flowsheet ON simulation_runs(flowsheet_id);
CREATE INDEX idx_simulation_runs_status    ON simulation_runs(status);

CREATE TABLE audit_logs (
  ${ID},
  organisation_id  TEXT NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  user_id          TEXT REFERENCES users(id) ON DELETE SET NULL,
  action           TEXT NOT NULL,
  resource_type    TEXT,
  resource_id      TEXT,
  details          JSONB NOT NULL DEFAULT '{}',
  ip_address       TEXT,
  ${CREATED_AT}
);
CREATE INDEX idx_audit_logs_organisation ON audit_logs(organisation_id);
CREATE INDEX idx_audit_logs_user         ON audit_logs(user_id);
CREATE INDEX idx_audit_logs_resource     ON audit_logs(resource_type, resource_id);
CREATE INDEX idx_audit_logs_created      ON audit_logs(created_at DESC);
`;

exports.down = `
DROP TABLE IF EXISTS audit_logs;
DROP TABLE IF EXISTS simulation_runs;
DROP TABLE IF EXISTS flowsheet_snapshots;
DROP TABLE IF EXISTS flowsheets;
DROP TABLE IF EXISTS project_members;
DROP TABLE IF EXISTS projects;
DROP TABLE IF EXISTS refresh_tokens;
DROP TABLE IF EXISTS users;
DROP TABLE IF EXISTS organisations;
`;
