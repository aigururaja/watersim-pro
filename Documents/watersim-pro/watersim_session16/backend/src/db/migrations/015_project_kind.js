/**
 * Migration 015 — Monitoring projects and twin projects are different things.
 *
 *   projects.kind               'monitoring'  the plant as built and wired:
 *                                             PLC bindings, tags, the live
 *                                             view. Created from Operations.
 *                               'twin'        a model to run beside it, or a
 *                                             design study. Created from the
 *                                             Digital Twin, or IMPORTED from a
 *                                             monitoring project.
 *   projects.source_project_id  the monitoring project a twin was imported from.
 *   flowsheets.source_flowsheet_id
 *                               the live flowsheet a twin flowsheet was copied
 *                               from. The twin loop reads its MEASURED values
 *                               (PLC bindings, drift rules, instrument tags)
 *                               through this link, so an imported twin compares
 *                               its model with the real plant without carrying
 *                               its own bindings.
 *
 * Existing projects that already have PLC bindings are monitoring projects;
 * everything else stays a twin (the default), which is what they were.
 */
'use strict';

exports.id = '015_project_kind';

exports.up = `
ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS kind VARCHAR(20) NOT NULL DEFAULT 'twin',
  ADD COLUMN IF NOT EXISTS source_project_id UUID REFERENCES projects(id) ON DELETE SET NULL;
ALTER TABLE projects ADD CONSTRAINT chk_projects_kind CHECK (kind IN ('monitoring', 'twin'));
CREATE INDEX IF NOT EXISTS idx_projects_org_kind ON projects(organisation_id, kind);

ALTER TABLE flowsheets
  ADD COLUMN IF NOT EXISTS source_flowsheet_id UUID REFERENCES flowsheets(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_flowsheets_source ON flowsheets(source_flowsheet_id);

UPDATE projects SET kind = 'monitoring'
 WHERE id IN (SELECT DISTINCT f.project_id FROM flowsheets f JOIN plc_bindings b ON b.flowsheet_id = f.id);
`;

exports.down = `
ALTER TABLE flowsheets DROP COLUMN IF EXISTS source_flowsheet_id;
ALTER TABLE projects DROP CONSTRAINT IF EXISTS chk_projects_kind;
ALTER TABLE projects DROP COLUMN IF EXISTS source_project_id;
ALTER TABLE projects DROP COLUMN IF EXISTS kind;
`;
