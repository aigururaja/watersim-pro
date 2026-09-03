/**
 * Migration 006 — enforce "one active permit template per organisation"
 *
 * The activate endpoint toggles is_active across two statements; even wrapped
 * in a transaction, only a partial unique index makes the invariant impossible
 * to violate under concurrency. Before creating the index, any existing
 * violations are repaired by keeping only the newest active template per org.
 */
'use strict';

exports.id = '006_permit_active_unique';

exports.up = `
-- Repair any existing violations: keep the most recently created active
-- template per organisation, deactivate the rest.
UPDATE permit_templates t
SET is_active = FALSE
WHERE t.is_active = TRUE
  AND t.id NOT IN (
    SELECT DISTINCT ON (organisation_id) id
    FROM permit_templates
    WHERE is_active = TRUE
    ORDER BY organisation_id, created_at DESC, id DESC
  );

CREATE UNIQUE INDEX IF NOT EXISTS uq_permit_templates_one_active
  ON permit_templates(organisation_id)
  WHERE is_active;
`;

exports.down = `
DROP INDEX IF EXISTS uq_permit_templates_one_active;
`;
