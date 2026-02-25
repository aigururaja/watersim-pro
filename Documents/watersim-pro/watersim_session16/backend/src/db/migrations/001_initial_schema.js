/**
 * Migration: 001_initial_schema
 * Foundation schema — organisations, users, tokens, projects, flowsheets,
 * simulation runs, snapshots, audit logs.
 */
'use strict';

exports.id = '001_initial_schema';

exports.up = `
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TYPE user_role        AS ENUM ('admin', 'engineer', 'operator', 'viewer');
CREATE TYPE project_status   AS ENUM ('active', 'archived', 'deleted');
CREATE TYPE simulation_mode  AS ENUM ('steady_state', 'dynamic');
CREATE TYPE simulation_status AS ENUM ('idle', 'running', 'completed', 'failed', 'cancelled');

CREATE TABLE organisations (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name       VARCHAR(255) NOT NULL,
  slug       VARCHAR(100) NOT NULL UNIQUE,
  settings   JSONB NOT NULL DEFAULT '{}',
  is_active  BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_organisations_slug ON organisations(slug);

CREATE TABLE users (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organisation_id  UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  email            VARCHAR(320) NOT NULL,
  password_hash    VARCHAR(255) NOT NULL,
  first_name       VARCHAR(100) NOT NULL,
  last_name        VARCHAR(100) NOT NULL,
  role             user_role NOT NULL DEFAULT 'viewer',
  is_active        BOOLEAN NOT NULL DEFAULT TRUE,
  last_login_at    TIMESTAMPTZ,
  email_verified   BOOLEAN NOT NULL DEFAULT FALSE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_users_email_org UNIQUE (email, organisation_id)
);
CREATE INDEX idx_users_organisation ON users(organisation_id);
CREATE INDEX idx_users_email        ON users(email);

CREATE TABLE refresh_tokens (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  VARCHAR(255) NOT NULL UNIQUE,
  expires_at  TIMESTAMPTZ NOT NULL,
  revoked     BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ip_address  INET,
  user_agent  TEXT
);
CREATE INDEX idx_refresh_tokens_user ON refresh_tokens(user_id);
CREATE INDEX idx_refresh_tokens_hash ON refresh_tokens(token_hash);

CREATE TABLE projects (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organisation_id  UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  created_by       UUID NOT NULL REFERENCES users(id),
  name             VARCHAR(255) NOT NULL,
  description      TEXT,
  status           project_status NOT NULL DEFAULT 'active',
  tags             TEXT[] NOT NULL DEFAULT '{}',
  settings         JSONB NOT NULL DEFAULT '{}',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_projects_organisation ON projects(organisation_id);
CREATE INDEX idx_projects_created_by   ON projects(created_by);
CREATE INDEX idx_projects_status       ON projects(status);

CREATE TABLE project_members (
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role       user_role NOT NULL DEFAULT 'viewer',
  added_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  added_by   UUID REFERENCES users(id),
  PRIMARY KEY (project_id, user_id)
);

CREATE TABLE flowsheets (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  project_id  UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  created_by  UUID NOT NULL REFERENCES users(id),
  name        VARCHAR(255) NOT NULL,
  description TEXT,
  canvas_data JSONB NOT NULL DEFAULT '{"nodes":[],"edges":[],"viewport":{}}',
  version     INTEGER NOT NULL DEFAULT 1,
  is_locked   BOOLEAN NOT NULL DEFAULT FALSE,
  locked_by   UUID REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_flowsheets_project ON flowsheets(project_id);

CREATE TABLE flowsheet_snapshots (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  flowsheet_id   UUID NOT NULL REFERENCES flowsheets(id) ON DELETE CASCADE,
  created_by     UUID NOT NULL REFERENCES users(id),
  label          VARCHAR(255) NOT NULL,
  notes          TEXT,
  canvas_data    JSONB NOT NULL,
  version_number INTEGER NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_snapshots_flowsheet ON flowsheet_snapshots(flowsheet_id);

CREATE TABLE simulation_runs (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  flowsheet_id  UUID NOT NULL REFERENCES flowsheets(id) ON DELETE CASCADE,
  created_by    UUID NOT NULL REFERENCES users(id),
  mode          simulation_mode NOT NULL,
  status        simulation_status NOT NULL DEFAULT 'idle',
  config        JSONB NOT NULL DEFAULT '{}',
  results       JSONB,
  error_message TEXT,
  started_at    TIMESTAMPTZ,
  completed_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_simulation_runs_flowsheet ON simulation_runs(flowsheet_id);
CREATE INDEX idx_simulation_runs_status    ON simulation_runs(status);

CREATE TABLE audit_logs (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organisation_id  UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  user_id          UUID REFERENCES users(id) ON DELETE SET NULL,
  action           VARCHAR(100) NOT NULL,
  resource_type    VARCHAR(100),
  resource_id      UUID,
  details          JSONB NOT NULL DEFAULT '{}',
  ip_address       INET,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_audit_logs_organisation ON audit_logs(organisation_id);
CREATE INDEX idx_audit_logs_user         ON audit_logs(user_id);
CREATE INDEX idx_audit_logs_resource     ON audit_logs(resource_type, resource_id);
CREATE INDEX idx_audit_logs_created      ON audit_logs(created_at DESC);

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_organisations_updated BEFORE UPDATE ON organisations FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_users_updated         BEFORE UPDATE ON users         FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_projects_updated      BEFORE UPDATE ON projects      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_flowsheets_updated    BEFORE UPDATE ON flowsheets    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
`;

exports.down = `
DROP TABLE IF EXISTS audit_logs           CASCADE;
DROP TABLE IF EXISTS simulation_runs      CASCADE;
DROP TABLE IF EXISTS flowsheet_snapshots  CASCADE;
DROP TABLE IF EXISTS flowsheets           CASCADE;
DROP TABLE IF EXISTS project_members      CASCADE;
DROP TABLE IF EXISTS projects             CASCADE;
DROP TABLE IF EXISTS refresh_tokens       CASCADE;
DROP TABLE IF EXISTS users                CASCADE;
DROP TABLE IF EXISTS organisations        CASCADE;
DROP FUNCTION IF EXISTS set_updated_at   CASCADE;
DROP TYPE IF EXISTS simulation_status    CASCADE;
DROP TYPE IF EXISTS simulation_mode      CASCADE;
DROP TYPE IF EXISTS project_status       CASCADE;
DROP TYPE IF EXISTS user_role            CASCADE;
`;
