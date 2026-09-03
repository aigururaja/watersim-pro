/**
 * WaterSim Pro — factory for Python-bridge-backed PLC drivers
 *
 * Builds the shared parts of the OPC UA / S7 / EtherNet/IP drivers: a
 * createClient() whose client owns one plc_bridge.py child process and speaks
 * the standard driver interface (connect / readTag / writeTag / disconnect,
 * with err.connectionLost = true on bridge/socket-level failures so the
 * poller reconnects with backoff), and a testConnection() that runs a
 * one-shot bridge 'test' (connect + disconnect, reporting latencyMs).
 *
 * Per-protocol specifics (descriptor, validateConfig, validateAddress) are
 * supplied by the driver modules in ../drivers/.
 */
'use strict';

const {
  BridgeClient, bridgeCall, clampTimeoutMs, MAX_TIMEOUT_MS, MAX_CONNECT_TIMEOUT_MS,
} = require('./bridgeClient');
const { isLocalHost } = require('../drivers/modbusTcp');

/**
 * Loopback/metadata host guard, shared with the Modbus driver: loopback and
 * link-local hosts are rejected unless PLC_ALLOW_LOCAL_HOSTS === 'true'.
 * Returns an error string (without the field name prefix) or null.
 */
function hostGuardError(host) {
  if (isLocalHost(host) && process.env.PLC_ALLOW_LOCAL_HOSTS !== 'true') {
    return 'must not be a loopback or link-local address ' +
           '(set PLC_ALLOW_LOCAL_HOSTS=true to allow, e.g. for local simulators)';
  }
  return null;
}

/**
 * Validate optional numeric config fields (present ⇒ finite and >= 0);
 * 'timeoutMs', when listed, is additionally capped at MAX_TIMEOUT_MS.
 */
function numericConfigErrors(config, keys) {
  const errors = [];
  for (const key of keys) {
    const v = config[key];
    if (v === undefined || v === null || v === '') continue;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) {
      errors.push(`config.${key} must be a non-negative number`);
    } else if (key === 'timeoutMs' && n > MAX_TIMEOUT_MS) {
      errors.push(`config.timeoutMs must be at most ${MAX_TIMEOUT_MS}`);
    }
  }
  return errors;
}

class BridgePlcClient {
  constructor(protocol, config) {
    this.protocol  = protocol;
    this.config    = config || {};
    this.timeoutMs = clampTimeoutMs(this.config.timeoutMs);
    this.bridge    = new BridgeClient({ timeoutMs: this.timeoutMs });
  }

  async connect() {
    try {
      // Connect gets 3× the data-op budget (ceiling MAX_CONNECT_TIMEOUT_MS):
      // e.g. pycomm3 uploads the controller's full tag list on open, which on
      // a large ControlLogix or slow link deterministically exceeds 10s.
      const connectMs = Math.min(this.timeoutMs * 3, MAX_CONNECT_TIMEOUT_MS);
      await this.bridge.request(
        'connect', { protocol: this.protocol, config: this.config }, connectMs);
    } catch (err) {
      // Never leave an idle Python child behind on a failed connect: every
      // caller (poller backoff, write route, test) discards this client and
      // builds a fresh one on retry, so the bridge can be torn down here.
      this.bridge.close();
      throw err;
    }
  }

  /** Returns the RAW numeric device value — scale/offset is the poller's job. */
  async readTag(address) {
    const value = await this.bridge.request('read', { protocol: this.protocol, address });
    const num = Number(value);
    if (!Number.isFinite(num)) {
      throw new Error(`PLC bridge returned a non-numeric value for ${address}`);
    }
    return num;
  }

  async writeTag(address, value) {
    await this.bridge.request('write', { protocol: this.protocol, address, value });
  }

  /** Never throws. Politely closes the device session, then the child. */
  async disconnect() {
    if (this.bridge.childPid !== null) { // no child, nothing to say goodbye to
      try {
        await this.bridge.request('disconnect', { protocol: this.protocol }, 2000);
      } catch {
        // Bridge already dead/hung — close() below hard-kills it anyway.
      }
    }
    this.bridge.close();
  }
}

/**
 * @param {object} spec
 * @param {object} spec.descriptor       full driver descriptor (status 'stub'
 *                                       statically; the registry flips it to
 *                                       'available' after a successful probe)
 * @param {function} spec.validateConfig  (config) -> string[]
 * @param {function} spec.validateAddress (address) -> string|null
 * @param {function} [spec.describeTarget] (config) -> string for test messages
 */
function makeBridgeDriver({ descriptor, validateConfig, validateAddress, describeTarget }) {
  const { protocol, label } = descriptor;

  function createClient(config, _context = {}) {
    return new BridgePlcClient(protocol, config);
  }

  /** Connectivity probe for POST /connections/:id/test. Never throws. */
  async function testConnection(config = {}, _context = {}) {
    const errors = validateConfig(config);
    if (errors.length) return { ok: false, message: errors.join('; ') };

    // Give the Node-side watchdog slack over the in-bridge connect timeout so
    // the bridge's own (better) error message wins when it can — with the
    // connect-level ceiling, since 'test' performs a full device handshake.
    const nodeTimeoutMs = Math.min(
      clampTimeoutMs(config.timeoutMs) * 3 + 2000, MAX_CONNECT_TIMEOUT_MS);
    try {
      const result = await bridgeCall('test', { protocol, config }, nodeTimeoutMs);
      const target = describeTarget ? describeTarget(config) : label;
      return {
        ok: true,
        message: `Connected to ${target}`,
        latencyMs: result && Number.isFinite(result.latencyMs) ? result.latencyMs : undefined,
      };
    } catch (err) {
      return { ok: false, message: err.message };
    }
  }

  return { descriptor, createClient, testConnection, validateConfig, validateAddress };
}

module.exports = { makeBridgeDriver, BridgePlcClient, hostGuardError, numericConfigErrors };
