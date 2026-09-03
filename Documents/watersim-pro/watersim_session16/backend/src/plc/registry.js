/**
 * WaterSim Pro — PLC driver registry
 *
 * Every driver self-describes via its descriptor:
 *   { protocol, label, status: 'available'|'stub', configFields: [...], addressHint }
 * and exposes createClient(config), testConnection(config), validateConfig(config)
 * and validateAddress(address). See ./README.md for the full driver interface
 * and how to add a new protocol.
 */
'use strict';

const modbusTcp  = require('./drivers/modbusTcp');
const simulator  = require('./drivers/simulator');
const opcua      = require('./drivers/opcua');
const s7         = require('./drivers/s7');
const ethernetIp = require('./drivers/ethernetIp');

const DRIVERS = [modbusTcp, simulator, opcua, s7, ethernetIp];

const byProtocol = new Map(DRIVERS.map((d) => [d.descriptor.protocol, d]));

/** Return the driver module for a protocol, or null when unknown. */
function getDriver(protocol) {
  return byProtocol.get(protocol) || null;
}

/** Descriptors of every registered protocol (for the UI). */
function listProtocols() {
  return DRIVERS.map((d) => d.descriptor);
}

module.exports = { getDriver, listProtocols };
