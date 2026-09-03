/**
 * WaterSim Pro — Siemens S7 driver (real, via the Python bridge)
 *
 * Backed by python-snap7 (ISO-on-TCP / RFC1006) through
 * backend/src/plc/bridge/plc_bridge.py. Availability is probed at runtime by
 * the registry (registry.probeAvailability()); until python-snap7 (and its
 * bundled snap7 native library) loads, the protocol is listed as an honest
 * stub with a `reason`.
 *
 * Config:  host (required), rack (default 0), slot (default 1),
 *          port (default 102), timeoutMs? (default 5000, capped 10000)
 *
 * Address grammar (case-insensitive, DB areas only — snap7.util types):
 *   db<N>.real<off>         REAL  — IEEE754 float32 at byte <off>  (4 bytes)
 *   db<N>.int<off>          INT   — signed 16-bit                  (2 bytes)
 *   db<N>.dint<off>         DINT  — signed 32-bit                  (4 bytes)
 *   db<N>.word<off>         WORD  — unsigned 16-bit                (2 bytes)
 *   db<N>.bool<byte>.<bit>  bit <bit> (0–7) of byte <byte>; reads 0/1, writes
 *                           read-modify-write the containing byte
 *
 * Values are raw device numbers; scale/offset stays in the poller.
 */
'use strict';

const { makeBridgeDriver, hostGuardError, numericConfigErrors } = require('../bridge/bridgeDriver');

const descriptor = {
  protocol: 's7',
  label:    'Siemens S7',
  status:   'stub', // dynamic — the registry reports 'available' once the Python probe passes
  configFields: [
    { key: 'host',      label: 'Host',         type: 'string', required: true,  placeholder: '192.168.0.20' },
    { key: 'rack',      label: 'Rack',         type: 'number', required: false, default: 0 },
    { key: 'slot',      label: 'Slot',         type: 'number', required: false, default: 1 },
    { key: 'port',      label: 'Port',         type: 'number', required: false, default: 102 },
    { key: 'timeoutMs', label: 'Timeout (ms)', type: 'number', required: false, default: 5000 },
  ],
  addressHint:
    "'db1.real0' (REAL at DB1 byte 0) or 'db5.int24' (INT at DB5 byte 24); " +
    "also db<N>.dint<off>, db<N>.word<off>, db<N>.bool<byte>.<bit>",
};

const WORD_RE = /^db(\d+)\.(real|int|dint|word)(\d+)$/;
const BOOL_RE = /^db(\d+)\.bool(\d+)\.([0-7])$/;

/**
 * Parse an S7 address — JS mirror of parse_s7_address in plc_bridge.py
 * (the bridge re-parses authoritatively on every read/write).
 * Returns { db, kind, offset, bit } or throws.
 */
function parseAddress(address) {
  if (typeof address !== 'string') throw new Error('S7 address must be a string');
  const a = address.trim().toLowerCase();
  let m = WORD_RE.exec(a);
  if (m) return { db: Number(m[1]), kind: m[2], offset: Number(m[3]), bit: null };
  m = BOOL_RE.exec(a);
  if (m) return { db: Number(m[1]), kind: 'bool', offset: Number(m[2]), bit: Number(m[3]) };
  throw new Error(
    `Invalid S7 address "${address}" — expected 'db<N>.real<off>' | 'db<N>.int<off>' | ` +
    "'db<N>.dint<off>' | 'db<N>.word<off>' | 'db<N>.bool<byte>.<bit>'"
  );
}

function validateConfig(config = {}) {
  const errors = [];
  if (!config.host || typeof config.host !== 'string' || !config.host.trim()) {
    errors.push('config.host is required');
  } else {
    const guard = hostGuardError(config.host);
    if (guard) errors.push(`config.host ${guard}`);
  }
  errors.push(...numericConfigErrors(config, ['rack', 'slot', 'port', 'timeoutMs']));
  return errors;
}

function validateAddress(address) {
  try { parseAddress(address); return null; } catch (err) { return err.message; }
}

module.exports = {
  ...makeBridgeDriver({
    descriptor,
    validateConfig,
    validateAddress,
    describeTarget: (config) => `${config.host}:${config.port || 102}`,
  }),
  parseAddress, // exported for tests
};
