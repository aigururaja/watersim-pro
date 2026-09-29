/**
 * Migration 016 — P&ID picture per flowsheet.
 *
 * A user uploads a picture of a P&ID and AI reads it to build the flowsheet.
 * The image lives in its own table, one row per flowsheet, rather than in
 * flowsheets.canvas_data: the canvas autosaves every few seconds and copies
 * canvas_data into every snapshot, and neither should carry a large image.
 *
 *   image_data  the image as a data URL (the browser downsizes it first)
 *   width/height  its pixel size, to map positions on the drawing onto the sheet
 *   placement   { x, y, scale }: where the drawing's layout lands on the sheet
 */
'use strict';

exports.id = '016_flowsheet_backgrounds';

exports.up = `
CREATE TABLE flowsheet_backgrounds (
  flowsheet_id UUID PRIMARY KEY REFERENCES flowsheets(id) ON DELETE CASCADE,
  image_data   TEXT NOT NULL,
  file_name    VARCHAR(255),
  width        INTEGER NOT NULL,
  height       INTEGER NOT NULL,
  placement    JSONB NOT NULL DEFAULT '{}',
  updated_by   UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
`;

exports.down = `
DROP TABLE IF EXISTS flowsheet_backgrounds CASCADE;
`;
