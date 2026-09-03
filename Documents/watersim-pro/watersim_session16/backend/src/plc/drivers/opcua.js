/**
 * WaterSim Pro — OPC UA driver (STUB)
 *
 * Listed so the UI can offer the protocol and render its config form, but not
 * implemented: a real client needs the optional 'node-opcua' package. See
 * backend/src/plc/README.md for the driver interface and how to wire it in.
 */
'use strict';

const { makeStubDriver } = require('./stubDriver');

module.exports = makeStubDriver({
  protocol:    'opcua',
  label:       'OPC UA',
  packageName: 'node-opcua',
  configFields: [
    { key: 'endpoint',     label: 'Endpoint URL',    type: 'string',   required: true,  placeholder: 'opc.tcp://192.168.0.10:4840' },
    { key: 'securityMode', label: 'Security mode',   type: 'string',   required: false, default: 'None', placeholder: 'None | Sign | SignAndEncrypt' },
    { key: 'username',     label: 'Username',        type: 'string',   required: false },
    { key: 'password',     label: 'Password',        type: 'password', required: false },
    { key: 'timeoutMs',    label: 'Timeout (ms)',    type: 'number',   required: false, default: 5000 },
  ],
  addressHint: "OPC UA node id, e.g. 'ns=2;s=Device1.FlowRate' or 'ns=3;i=1005'",
});
