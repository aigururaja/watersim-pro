/**
 * Migration 016 — P&ID picture per flowsheet (SQLite)
 */
'use strict';

const { CREATED_AT, UPDATED_AT } = require('./_helpers');

exports.id = '016_flowsheet_backgrounds';

exports.up = `
CREATE TABLE flowsheet_backgrounds (
  flowsheet_id TEXT PRIMARY KEY REFERENCES flowsheets(id) ON DELETE CASCADE,
  image_data   TEXT NOT NULL,
  file_name    TEXT,
  width        INTEGER NOT NULL,
  height       INTEGER NOT NULL,
  placement    JSONB NOT NULL DEFAULT '{}',
  updated_by   TEXT REFERENCES users(id) ON DELETE SET NULL,
  ${CREATED_AT},
  ${UPDATED_AT}
);
`;

exports.down = `
DROP TABLE IF EXISTS flowsheet_backgrounds;
`;
