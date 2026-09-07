/**
 * Migration 015 — Monitoring projects and twin projects are different things (SQLite)
 */
'use strict';

const { NOOP } = require('./_helpers');

exports.id = '015_project_kind';

exports.up = `
ALTER TABLE projects ADD COLUMN kind TEXT NOT NULL DEFAULT 'twin' CHECK (kind IN ('monitoring', 'twin'));
ALTER TABLE projects ADD COLUMN source_project_id TEXT REFERENCES projects(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_projects_org_kind ON projects(organisation_id, kind);

ALTER TABLE flowsheets ADD COLUMN source_flowsheet_id TEXT REFERENCES flowsheets(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_flowsheets_source ON flowsheets(source_flowsheet_id);

UPDATE projects SET kind = 'monitoring'
 WHERE id IN (SELECT DISTINCT f.project_id FROM flowsheets f JOIN plc_bindings b ON b.flowsheet_id = f.id);
`;

exports.down = `
DROP INDEX IF EXISTS idx_flowsheets_source;
DROP INDEX IF EXISTS idx_projects_org_kind;
${NOOP}
`;
