/**
 * WaterSim Pro — EtherNet/IP driver (STUB)
 *
 * Listed so the UI can offer the protocol and render its config form, but not
 * implemented: a real client needs the optional 'ethernet-ip' package
 * (Allen-Bradley CIP). See backend/src/plc/README.md for the driver interface.
 */
'use strict';

const { makeStubDriver } = require('./stubDriver');

module.exports = makeStubDriver({
  protocol:    'ethernet_ip',
  label:       'EtherNet/IP',
  packageName: 'ethernet-ip',
  configFields: [
    { key: 'host',      label: 'Host',         type: 'string', required: true,  placeholder: '192.168.0.30' },
    { key: 'port',      label: 'Port',         type: 'number', required: false, default: 44818 },
    { key: 'slot',      label: 'CPU slot',     type: 'number', required: false, default: 0 },
    { key: 'timeoutMs', label: 'Timeout (ms)', type: 'number', required: false, default: 5000 },
  ],
  addressHint: "Controller tag name, e.g. 'Pump1_Speed' or program-scoped 'Program:Main.FlowSetpoint'",
});
