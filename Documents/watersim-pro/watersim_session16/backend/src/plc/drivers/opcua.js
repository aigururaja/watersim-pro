/**
 * WaterSim Pro — OPC UA driver (real, via the Python bridge)
 *
 * Backed by the asyncua package through backend/src/plc/bridge/plc_bridge.py:
 * each client owns one bridge child that keeps a connected asyncua Client on a
 * dedicated event loop. Availability is probed at runtime by the registry
 * (registry.probeAvailability()); until asyncua is installed the protocol is
 * listed as an honest stub with a `reason`.
 *
 * Config:  endpoint (opc.tcp:// URL, required), username?, password?,
 *          timeoutMs? (default 5000, capped 10000)
 * Address: OPC UA node id — 'ns=2;s=Device1.FlowRate' or 'ns=3;i=1005'
 *          (string, numeric, guid 'g=…' and bytestring 'b=…' ids accepted).
 * Values:  raw numbers (Booleans read as 0/1; writes are coerced to the
 *          node's variant type by the bridge). Scale/offset stays in the poller.
 */
'use strict';

const { makeBridgeDriver, hostGuardError, numericConfigErrors } = require('../bridge/bridgeDriver');

const descriptor = {
  protocol: 'opcua',
  label:    'OPC UA',
  status:   'stub', // dynamic — the registry reports 'available' once the Python probe passes
  configFields: [
    { key: 'endpoint',  label: 'Endpoint URL', type: 'string',   required: true,  placeholder: 'opc.tcp://192.168.0.10:4840' },
    { key: 'username',  label: 'Username',     type: 'string',   required: false },
    { key: 'password',  label: 'Password',     type: 'password', required: false },
    { key: 'timeoutMs', label: 'Timeout (ms)', type: 'number',   required: false, default: 5000 },
  ],
  addressHint: "OPC UA node id, e.g. 'ns=2;s=Device1.FlowRate' or 'ns=3;i=1005'",
};

/** Extract the hostname from an opc.tcp:// endpoint URL, or null. */
function endpointHost(endpoint) {
  try {
    const url = new URL(String(endpoint));
    if (url.protocol !== 'opc.tcp:') return null;
    // WHATWG URL keeps brackets on IPv6 hostnames for non-special schemes.
    return url.hostname.replace(/^\[|\]$/g, '');
  } catch {
    return null;
  }
}

function validateConfig(config = {}) {
  const errors = [];
  if (!config.endpoint || typeof config.endpoint !== 'string' || !config.endpoint.trim()) {
    errors.push('config.endpoint is required');
  } else {
    const host = endpointHost(config.endpoint.trim());
    if (!host) {
      errors.push("config.endpoint must be an opc.tcp:// URL, e.g. 'opc.tcp://192.168.0.10:4840'");
    } else {
      const guard = hostGuardError(host);
      if (guard) errors.push(`config.endpoint host ${guard}`);
    }
  }
  errors.push(...numericConfigErrors(config, ['timeoutMs']));
  return errors;
}

// 'ns=<n>;' prefix optional (defaults to namespace 0), then one identifier:
// s=<string> | i=<numeric> | g=<guid> | b=<base64 bytestring>.
const NODE_ID_RE = /^(ns=\d+;)?(s=.+|i=\d+|g=[0-9a-fA-F-]{36}|b=.+)$/;

function validateAddress(address) {
  if (typeof address !== 'string' || !address.trim()) {
    return 'OPC UA address must be a node id string';
  }
  if (!NODE_ID_RE.test(address.trim())) {
    return `Invalid OPC UA node id "${address}" — expected e.g. 'ns=2;s=Device1.FlowRate' or 'ns=3;i=1005'`;
  }
  return null;
}

module.exports = makeBridgeDriver({
  descriptor,
  validateConfig,
  validateAddress,
  describeTarget: (config) => String(config.endpoint || 'OPC UA server'),
});
