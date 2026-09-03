/**
 * WaterSim Pro — Siemens S7 driver (STUB)
 *
 * Listed so the UI can offer the protocol and render its config form, but not
 * implemented: a real client needs the optional 'nodes7' package (ISO-on-TCP /
 * RFC1006). See backend/src/plc/README.md for the driver interface.
 */
'use strict';

const { makeStubDriver } = require('./stubDriver');

module.exports = makeStubDriver({
  protocol:    's7',
  label:       'Siemens S7',
  packageName: 'nodes7',
  configFields: [
    { key: 'host',      label: 'Host',         type: 'string', required: true,  placeholder: '192.168.0.20' },
    { key: 'port',      label: 'Port',         type: 'number', required: false, default: 102 },
    { key: 'rack',      label: 'Rack',         type: 'number', required: false, default: 0 },
    { key: 'slot',      label: 'Slot',         type: 'number', required: false, default: 1 },
    { key: 'timeoutMs', label: 'Timeout (ms)', type: 'number', required: false, default: 5000 },
  ],
  addressHint: "S7 address, e.g. 'DB5,REAL10' (data block 5, REAL at byte 10), 'MW20', 'I0.1', 'Q0.4'",
});
