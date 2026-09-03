/**
 * WaterSim Pro — Allen-Bradley EtherNet/IP driver (real, via the Python bridge)
 *
 * Backed by pycomm3's LogixDriver (CIP, ControlLogix/CompactLogix) through
 * backend/src/plc/bridge/plc_bridge.py. Availability is probed at runtime by
 * the registry (registry.probeAvailability()); until pycomm3 is installed the
 * protocol is listed as an honest stub with a `reason`.
 *
 * NOTE: unlike OPC UA and S7, this driver has no local test server — it is
 * validated against the pycomm3 API only and is untested against real
 * Logix hardware. Treat the first field deployment as a pilot.
 *
 * Config:  host (required), slot (CPU slot, default 0),
 *          timeoutMs? (default 5000, capped 10000)
 * Address: Logix tag path — controller-scoped 'Pump1_Speed', program-scoped
 *          'Program:MainProgram.Counter', array/UDT members 'Tank[3].Level'.
 * Values:  raw numbers (BOOL reads as 0/1; integral writes are sent as ints
 *          so DINT/INT/BOOL tags pack correctly). Scale/offset stays in the
 *          poller.
 */
'use strict';

const { makeBridgeDriver, hostGuardError, numericConfigErrors } = require('../bridge/bridgeDriver');

const descriptor = {
  protocol: 'ethernet_ip',
  label:    'EtherNet/IP',
  status:   'stub', // dynamic — the registry reports 'available' once the Python probe passes
  configFields: [
    { key: 'host',      label: 'Host',         type: 'string', required: true,  placeholder: '192.168.0.30' },
    { key: 'slot',      label: 'CPU slot',     type: 'number', required: false, default: 0 },
    { key: 'timeoutMs', label: 'Timeout (ms)', type: 'number', required: false, default: 5000 },
  ],
  addressHint: "Logix tag path, e.g. 'Pump1_Speed' or 'Program:MainProgram.Counter'",
};

// One tag segment: identifier, optionally with an array index like [3] or [1,2].
const SEGMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*(\[\d+(,\d+)*\])?$/;

function validateAddress(address) {
  if (typeof address !== 'string' || !address.trim()) {
    return 'EtherNet/IP address must be a tag path string';
  }
  let a = address.trim();
  const bad = () =>
    `Invalid EtherNet/IP tag path "${address}" — expected e.g. 'Pump1_Speed' or 'Program:MainProgram.Counter'`;

  // Optional program scope prefix: 'Program:<name>.<rest>'
  if (/^program:/i.test(a)) {
    const rest = a.slice('program:'.length);
    const dot = rest.indexOf('.');
    const programName = dot === -1 ? rest : rest.slice(0, dot);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(programName)) return bad();
    if (dot === -1) return bad(); // a program scope alone names no tag
    a = rest.slice(dot + 1);
  }
  const segments = a.split('.');
  if (!segments.length || !segments.every((s) => SEGMENT_RE.test(s))) return bad();
  return null;
}

function validateConfig(config = {}) {
  const errors = [];
  if (!config.host || typeof config.host !== 'string' || !config.host.trim()) {
    errors.push('config.host is required');
  } else {
    const guard = hostGuardError(config.host);
    if (guard) errors.push(`config.host ${guard}`);
  }
  errors.push(...numericConfigErrors(config, ['slot', 'timeoutMs']));
  return errors;
}

module.exports = makeBridgeDriver({
  descriptor,
  validateConfig,
  validateAddress,
  describeTarget: (config) => `${config.host}/${config.slot || 0}`,
});
