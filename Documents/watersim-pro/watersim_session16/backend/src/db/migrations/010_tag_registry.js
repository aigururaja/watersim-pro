/**
 * Migration 010 — the tag registry.
 *
 * Until now a monitored point had no identity of its own: `plc_bindings` keyed
 * it as (flowsheet_id, node_id, param_key) plus a driver address, alarm rules
 * did the same, and the ITC I/O schedule's 339 ISA tags existed only as a
 * static template. Nothing could say "RFP-FT-201" and have alarms, trends,
 * bindings and maintenance tasks all mean the same thing by it.
 *
 * `tags` is that identity. One row per WIRED POINT — the thing a PLC address
 * binds to, an alarm watches, a historian samples — carrying its ISA signal tag
 * (`RFP-P-201/1.XS`), the loop or equipment tag it belongs to (`RFP-P-201`) for
 * grouping, and the canvas node/parameter it drives. The three tables that used
 * to identify points ad hoc gain a nullable `tag_id`, so existing rows keep
 * working and are linked as they are touched.
 *
 * The tag string is validated against ISA-5.1 at the API (`tags/isa.js`), not
 * here: a CHECK would have to re-encode the letter tables in SQL and drift.
 * What the schema does enforce is uniqueness within an organisation and the
 * parse-derived columns being present.
 */
'use strict';

exports.id = '010_tag_registry';

exports.up = `
CREATE TABLE tags (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organisation_id  UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  flowsheet_id     UUID REFERENCES flowsheets(id) ON DELETE SET NULL,

  -- ISA-5.1 identity
  tag              VARCHAR(48) NOT NULL,          -- full signal tag: RFP-P-201/1.XS
  loop_tag         VARCHAR(24) NOT NULL,          -- device / loop tag:  RFP-P-201
  area             VARCHAR(8)  NOT NULL,          -- RFP
  code             VARCHAR(4)  NOT NULL,          -- P | FT | XV …  (equipment or function)
  loop_no          VARCHAR(4)  NOT NULL,          -- 201
  unit             SMALLINT,                      -- 1, 2 … for duplicated devices, else NULL
  fn               VARCHAR(4)  NOT NULL,          -- ZSO | XY | XS | LT …
  fn_suffix        CHAR(1),                       -- A | B for two relays in one loop

  -- What it is
  signal_type      VARCHAR(2)  NOT NULL CHECK (signal_type IN ('DI','DO','AI','AO')),
  kind             VARCHAR(32) NOT NULL,          -- pump | butterfly_valve | level_tx …
  name             VARCHAR(200) NOT NULL,         -- device name from the schedule
  signal           VARCHAR(80) NOT NULL,          -- 'Run status', 'Open limit switch' …
  description      TEXT,

  -- Where it lives
  node_id          VARCHAR(80),                   -- canvas node this point belongs to
  param_key        VARCHAR(80),                   -- model parameter it reads/writes
  plc_node         VARCHAR(80),                   -- panel / IOT node it is wired to
  eng_unit         VARCHAR(24),
  range_min        DOUBLE PRECISION,
  range_max        DOUBLE PRECISION,

  enabled          BOOLEAN NOT NULL DEFAULT TRUE,
  created_by       UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT uq_tags_org_tag UNIQUE (organisation_id, tag)
);
CREATE INDEX idx_tags_org_loop   ON tags(organisation_id, loop_tag);
CREATE INDEX idx_tags_org_area   ON tags(organisation_id, area);
CREATE INDEX idx_tags_flowsheet  ON tags(flowsheet_id) WHERE flowsheet_id IS NOT NULL;
CREATE INDEX idx_tags_node       ON tags(flowsheet_id, node_id, param_key) WHERE node_id IS NOT NULL;

CREATE TRIGGER trg_tags_updated BEFORE UPDATE ON tags
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Link the three tables that used to identify points on their own. Nullable, so
-- every existing row is untouched; bound as rows are next written.
ALTER TABLE plc_bindings  ADD COLUMN tag_id UUID REFERENCES tags(id) ON DELETE SET NULL;
ALTER TABLE alarm_rules   ADD COLUMN tag_id UUID REFERENCES tags(id) ON DELETE SET NULL;
ALTER TABLE alarm_events  ADD COLUMN tag_id UUID REFERENCES tags(id) ON DELETE SET NULL;
CREATE INDEX idx_plc_bindings_tag ON plc_bindings(tag_id) WHERE tag_id IS NOT NULL;
CREATE INDEX idx_alarm_rules_tag  ON alarm_rules(tag_id)  WHERE tag_id IS NOT NULL;
CREATE INDEX idx_alarm_events_tag ON alarm_events(tag_id) WHERE tag_id IS NOT NULL;
`;

exports.down = `
ALTER TABLE alarm_events DROP COLUMN IF EXISTS tag_id;
ALTER TABLE alarm_rules  DROP COLUMN IF EXISTS tag_id;
ALTER TABLE plc_bindings DROP COLUMN IF EXISTS tag_id;
DROP TABLE IF EXISTS tags CASCADE;
`;
