/**
 * Migration 009 — the `manager` role (SQLite)
 *
 * Postgres extends the user_role enum here. The SQLite schema lists 'manager'
 * in the role CHECK from 001, so there is nothing to do.
 */
'use strict';

const { NOOP } = require('./_helpers');

exports.id = '009_manager_role';

exports.up = NOOP;

exports.down = `
UPDATE users SET role = 'engineer' WHERE role = 'manager';
`;
