/**
 * SafeKrit — Shadow (commissioning) mode (Phase 4)
 *
 * A PLC connection in `shadow` mode never touches its device. Every write is
 * routed into the built-in simulator's register namespace for that
 * connection, and the poller reads the same namespace, so the sequence sees
 * a plant that responds — but not the plant.
 *
 * The response comes from the reflector: a write to a drive's or valve's
 * COMMAND point (XY / XV) sets the registers of its sibling STATUS points
 * (XS run status, ZSO open switch, and ZSC as the inverse) on the same loop
 * and unit. That is the first, deliberately simple, model of "the plant
 * responds": a start becomes running, an open becomes open. The narrative's
 * control sequences (`twin/scripts.js`) then play against it end to end.
 *
 * Leaving shadow mode is a manager's act (capability task.approve), audited
 * and broadcast — a plant must never be left thinking it is talking to a
 * simulator.
 */
'use strict';

const { query } = require('../db/pool');
const { getDriver } = require('../plc/registry');

const SIM_ADDRESS = /^(sine|random|step|const|mem):/i;

/** A real-PLC address becomes a simulator register under the same name. */
const shadowAddress = (address) => (SIM_ADDRESS.test(String(address)) ? String(address) : `mem:${address}`);

/** The simulator client for a connection's shadow namespace. */
function shadowClient(connection) {
  const sim = getDriver('simulator');
  const inner = sim.createClient({}, { connectionId: connection.id || connection.connection_id, organisationId: connection.organisation_id });
  return {
    connect: () => inner.connect(),
    disconnect: () => inner.disconnect(),
    readTag: (address) => inner.readTag(shadowAddress(address)),
    writeTag: (address, value) => inner.writeTag(shadowAddress(address), value),
  };
}

/**
 * Write a command in shadow mode and reflect it onto the sibling status
 * points. Returns the list of reflected addresses.
 */
async function writeShadow(binding, rawValue) {
  const client = shadowClient({ id: binding.connection_id, organisation_id: binding.organisation_id });
  await client.connect();
  await client.writeTag(binding.address, rawValue);

  const reflected = [];
  if (binding.tag_id) {
    const t = await query('SELECT loop_tag, unit, fn, signal_type FROM tags WHERE id = $1', [binding.tag_id]);
    const tag = t.rows[0];
    if (tag && tag.signal_type === 'DO') {
      const sib = await query(
        `SELECT b.address, t.fn FROM plc_bindings b JOIN tags t ON t.id = b.tag_id
          WHERE b.connection_id = $1 AND b.enabled = TRUE AND t.loop_tag = $2 AND t.unit IS NOT DISTINCT FROM $3
            AND t.signal_type = 'DI' AND t.fn IN ('XS', 'ZSO', 'ZSC')`,
        [binding.connection_id, tag.loop_tag, tag.unit]
      );
      const on = Number(rawValue) >= 0.5 ? 1 : 0;
      for (const s of sib.rows) {
        const v = s.fn === 'ZSC' ? 1 - on : on;
        await client.writeTag(s.address, v);
        reflected.push({ address: s.address, fn: s.fn, value: v });
      }
    }
  }
  await client.disconnect();
  return reflected;
}

module.exports = { shadowAddress, shadowClient, writeShadow };
