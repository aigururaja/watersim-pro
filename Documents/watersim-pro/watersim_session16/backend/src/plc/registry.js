/**
 * WaterSim Pro — PLC driver registry
 *
 * Every driver self-describes via its descriptor:
 *   { protocol, label, status: 'available'|'stub', configFields: [...], addressHint }
 * and exposes createClient(config, context), testConnection(config),
 * validateConfig(config) and validateAddress(address). See ./README.md for the
 * full driver interface and how to add a new protocol.
 *
 * modbus_tcp and simulator are implemented in Node and statically 'available'.
 * opcua / s7 / ethernet_ip run through the Python bridge
 * (./bridge/plc_bridge.py) and their status is DYNAMIC: probeAvailability()
 * runs one bridge 'probe' (memoized per process) checking that Python and the
 * per-protocol package (asyncua / python-snap7 / pycomm3) are importable.
 * listProtocols() merges the cached result — 'available' when the probe
 * passed, otherwise 'stub' plus an additive `reason` field explaining what is
 * missing. The probe is fired-and-forgotten at poller start and awaited by
 * GET /api/v1/plc/protocols so the first API response is already accurate.
 */
'use strict';

const modbusTcp  = require('./drivers/modbusTcp');
const simulator  = require('./drivers/simulator');
const opcua      = require('./drivers/opcua');
const s7         = require('./drivers/s7');
const ethernetIp = require('./drivers/ethernetIp');
const { bridgeCall } = require('./bridge/bridgeClient');

const DRIVERS = [modbusTcp, simulator, opcua, s7, ethernetIp];

const byProtocol = new Map(DRIVERS.map((d) => [d.descriptor.protocol, d]));

/** Protocols served by the Python bridge (dynamic availability). */
const BRIDGE_PROTOCOLS = ['opcua', 's7', 'ethernet_ip'];

const PROBE_TIMEOUT_MS = 10000;
const PROBE_RETRY_MS   = 30000; // min gap before re-probing after a bridge-level failure

// protocol -> { available: boolean, reason?: string }; null until probed.
let probeCache    = null;
let probePromise  = null; // memoized while valid — see retry rules below
let lastProbeFail = 0;    // ms timestamp of the last bridge-level probe failure

/**
 * Probe the Python bridge for opcua/s7/ethernet_ip availability. Memoized:
 * a successful probe (the bridge answered, even if it reports packages
 * missing) is cached for the process lifetime. A bridge-LEVEL failure
 * (spawn error, probe timeout — often transient: cold interpreter start,
 * boot-time load) is cached only for PROBE_RETRY_MS, after which the next
 * caller re-probes, so one slow boot doesn't misreport installed protocols
 * as unavailable until restart. Never rejects.
 */
function probeAvailability() {
  if (!probePromise) {
    // After a bridge-level failure, serve the cached negative result during
    // the cool-down instead of re-spawning Python on every caller.
    if (lastProbeFail && Date.now() - lastProbeFail < PROBE_RETRY_MS) {
      return Promise.resolve(probeCache);
    }
    probePromise = (async () => {
      try {
        const result = await bridgeCall('probe', {}, PROBE_TIMEOUT_MS);
        const cache = {};
        for (const protocol of BRIDGE_PROTOCOLS) {
          const r = (result && result[protocol]) || {};
          cache[protocol] = r.available
            ? { available: true }
            : { available: false, reason: r.reason || `'${protocol}' unavailable in the Python bridge` };
        }
        probeCache = cache;
        lastProbeFail = 0;
      } catch (err) {
        const reason =
          `Python PLC bridge unavailable (${err.message}) — install Python 3 and ` +
          "'pip install -r backend/requirements-plc.txt'";
        probeCache = Object.fromEntries(
          BRIDGE_PROTOCOLS.map((p) => [p, { available: false, reason }])
        );
        // Transient-failure guard: allow a re-probe after the cool-down
        // instead of latching "install Python" for the process lifetime.
        lastProbeFail = Date.now();
        probePromise = null;
      }
      return probeCache;
    })();
  }
  return probePromise || Promise.resolve(probeCache);
}

/** Return the driver module for a protocol, or null when unknown. */
function getDriver(protocol) {
  return byProtocol.get(protocol) || null;
}

/**
 * Descriptors of every registered protocol (for the UI), with bridge-protocol
 * status merged from the availability probe: 'available' after a passed
 * probe, otherwise 'stub' + `reason`. Call (and await) probeAvailability()
 * first for an accurate answer — before any probe, bridge protocols report
 * 'stub' with a "not probed yet" reason.
 */
function listProtocols() {
  return DRIVERS.map((d) => {
    const desc = { ...d.descriptor };
    if (!BRIDGE_PROTOCOLS.includes(desc.protocol)) return desc;

    const probed = probeCache && probeCache[desc.protocol];
    if (probed && probed.available) {
      desc.status = 'available';
    } else {
      desc.status = 'stub';
      desc.reason = probed
        ? probed.reason
        : 'Python bridge availability not probed yet — retry in a moment';
    }
    return desc;
  });
}

module.exports = { getDriver, listProtocols, probeAvailability };
