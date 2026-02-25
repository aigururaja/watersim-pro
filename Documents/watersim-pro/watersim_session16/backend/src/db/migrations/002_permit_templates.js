/**
 * Migration: 002_permit_templates
 * Org-level permit limit configuration.
 */
'use strict';

exports.id = '002_permit_templates';

exports.up = `
CREATE TABLE permit_templates (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organisation_id  UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  created_by       UUID NOT NULL REFERENCES users(id),
  name             VARCHAR(255) NOT NULL,
  description      TEXT,
  is_active        BOOLEAN NOT NULL DEFAULT FALSE,
  permit_limits    JSONB NOT NULL DEFAULT '{}',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_permit_templates_org    ON permit_templates(organisation_id);
CREATE INDEX idx_permit_templates_active ON permit_templates(organisation_id, is_active);
CREATE TRIGGER trg_permit_templates_updated BEFORE UPDATE ON permit_templates FOR EACH ROW EXECUTE FUNCTION set_updated_at();

INSERT INTO permit_templates (organisation_id, created_by, name, description, is_active, permit_limits)
SELECT o.id, u.id,
  'Default (US EPA Secondary)',
  'US EPA secondary treatment effluent limits (40 CFR Part 133).',
  TRUE,
  '{"BOD":30,"TSS":30,"TN":10,"TP":1,"NH4":5,"NO3":null,"pH_min":6.0,"pH_max":9.0}'::jsonb
FROM organisations o
JOIN users u ON u.organisation_id = o.id AND u.role = 'admin'
WHERE o.slug = 'demo-org'
LIMIT 1;
`;

exports.down = `
DROP TABLE IF EXISTS permit_templates CASCADE;
`;
