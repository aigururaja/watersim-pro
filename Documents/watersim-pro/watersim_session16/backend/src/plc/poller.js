/**
 * SafeKrit — PLC poller
 *
 * Started from server.js after listen, stopped in shutdown. Every tick it
 * loads enabled read/read_write bindings joined with enabled connections,
 * groups them by connection, reads due tags through a cached client per
 * connection (reconnecting with exponential backoff on failure), persists
 * last_value / quality / last_read_at per binding and connection
 * status / last_seen / last_error, then broadcasts fresh samples to each
 * flowsheet's WebSocket room as:
 *
 *   { type: 'plc:update',
 *     payload: { flowsheetId, values: [{ bindingId, nodeId, paramKey, value, quality, ts }] } }
 *
 * Scheduling: the loop ticks every 500ms; each binding is read when its
 * pollIntervalMs (default 2000, clamped to a minimum of 500) has elapsed
 * since its last sample — so the default cadence is one read every 2s and
 * per-binding overrides down to 500ms are honoured.
 *
 * Quality semantics:
 *   good  — read succeeded this cycle
 *   bad   — the device answered with a tag-level error (e.g. Modbus exception)
 *   stale — the connection is down; last_value is kept but no longer current
 *
 * In NODE_ENV==='test' startPoller() is a no-op unless called with
 * { force: true }.
 */
'use strict';

const { query } = require('../db/pool');
const { getDriver, probeAvailability } = require('./registry');
const { broadcastToRoom, broadcastToOrg } = require('../collab/wsServer');
const { evaluateParamValue } = require('../alarms/evaluator');
const { recordSamples, backfillBindingTags } = require('../historian');
const { shadowClient } = require('../twin/shadow');
const logger = require('../utils/logger');

const TICK_MS            = 500;    // scheduler resolution
const DEFAULT_POLL_MS    = 2000;   // per-binding default interval
const MIN_POLL_MS        = 500;    // per-binding floor
const BACKOFF_BASE_MS    = 1000;   // first reconnect delay after a failure
const BACKOFF_MAX_MS     = 30000;  // cap

// connectionId -> { client, configKey, failCount, backoffUntil }
const clients = new Map();

let timer   = null;
let ticking = false;
// Bindings created after the registry, or tags created after the binding, are
// linked on this cadence so their history starts without a restart.
let lastBackfillAt = 0;
const BACKFILL_EVERY_MS = 60_000;

function effectiveIntervalMs(binding) {
  const ms = Number(binding.poll_interval_ms) || DEFAULT_POLL_MS;
  return Math.max(MIN_POLL_MS, ms);
}

function configKeyOf(conn) {
  // Mode is part of the key so flipping live ↔ shadow rebuilds the client.
  return `${conn.protocol}:${conn.mode || 'live'}:${JSON.stringify(conn.config || {})}`;
}

async function dropClient(connectionId) {
  const entry = clients.get(connectionId);
  if (!entry) return;
  clients.delete(connectionId);
  if (entry.client) await entry.client.disconnect().catch(() => {});
}

/** Get (or build) a connected, cached client for a connection row. */
async function getClientFor(conn) {
  let entry = clients.get(conn.connection_id);
  const key = configKeyOf(conn);

  if (entry && entry.configKey !== key) {
    // Config changed since the client was built — rebuild.
    await dropClient(conn.connection_id);
    entry = undefined;
  }
  if (entry && entry.backoffUntil > Date.now()) return null; // still backing off
  if (entry && entry.client) return entry.client;

  const driver = getDriver(conn.protocol);
  if (!driver) throw new Error(`Unknown protocol "${conn.protocol}"`);

  const failCount = entry ? entry.failCount : 0;
  try {
    // Shadow mode (Phase 4): the device is never contacted; reads come from
    // the simulator registers the shadow writes land in.
    const client = conn.mode === 'shadow'
      ? shadowClient({ id: conn.connection_id, organisation_id: conn.organisation_id })
      : driver.createClient(conn.config || {}, {
        connectionId:   conn.connection_id,
        organisationId: conn.organisation_id,
      });
    await client.connect();
    clients.set(conn.connection_id, { client, configKey: key, failCount: 0, backoffUntil: 0 });
    return client;
  } catch (err) {
    const nextFailCount = failCount + 1;
    const delay = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.min(nextFailCount - 1, 10));
    clients.set(conn.connection_id, {
      client: null, configKey: key, failCount: nextFailCount, backoffUntil: Date.now() + delay,
    });
    throw err;
  }
}

/** After a mid-poll connection loss: drop the client and start backoff. */
async function invalidateClient(connectionId) {
  const entry = clients.get(connectionId);
  const failCount = (entry ? entry.failCount : 0) + 1;
  const delay = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.min(failCount - 1, 10));
  if (entry && entry.client) await entry.client.disconnect().catch(() => {});
  clients.set(connectionId, {
    client: null,
    configKey: entry ? entry.configKey : '',
    failCount,
    backoffUntil: Date.now() + delay,
  });
}

async function setConnectionOk(connectionId) {
  await query(
    `UPDATE plc_connections SET status = 'online', last_seen = NOW(), last_error = NULL WHERE id = $1`,
    [connectionId]
  );
}

async function setConnectionError(connectionId, message) {
  await query(
    `UPDATE plc_connections SET status = 'error', last_error = $2 WHERE id = $1`,
    [connectionId, String(message).slice(0, 2000)]
  );
}

/** One scheduler pass. Exported for tests. */
async function tick() {
  const { rows } = await query(
    `SELECT b.id, b.flowsheet_id, b.node_id, b.param_key, b.address, b.direction,
            b.scale, b.offset_val, b.poll_interval_ms, b.last_read_at, b.last_value,
            b.tag_id, b.quality,
            c.id AS connection_id, c.protocol, c.config, c.organisation_id, c.mode
     FROM plc_bindings b
     JOIN plc_connections c ON c.id = b.connection_id
     WHERE b.enabled = TRUE
       AND c.enabled = TRUE
       AND b.direction IN ('read', 'read_write')`
  );

  const now = Date.now();

  // Drop cached clients whose connections no longer have pollable bindings.
  const liveConnIds = new Set(rows.map((r) => r.connection_id));
  for (const id of [...clients.keys()]) {
    if (!liveConnIds.has(id)) await dropClient(id);
  }

  // Only bindings whose interval has elapsed are due this tick.
  const due = rows.filter((b) => {
    const last = b.last_read_at ? new Date(b.last_read_at).getTime() : 0;
    return now - last >= effectiveIntervalMs(b) - TICK_MS / 2;
  });
  if (!due.length) return;

  // Group by connection so each PLC is polled over one cached client.
  const byConnection = new Map();
  for (const b of due) {
    if (!byConnection.has(b.connection_id)) byConnection.set(b.connection_id, []);
    byConnection.get(b.connection_id).push(b);
  }

  // flowsheetId -> [{ bindingId, nodeId, paramKey, value, quality, ts, tagId, flowsheetId }]
  const updatesByFlowsheet = new Map();
  // organisationId -> the same objects, for the organisation-wide live room.
  const updatesByOrg = new Map();
  // Historian: every good sample, and the FIRST bad/stale sample after the
  // quality changed — a link that is down for an hour is one row saying so,
  // not one row per tick. Only bindings linked to a registry tag are kept.
  const samples = [];
  const pushUpdate = (binding, value, quality) => {
    const ts = new Date().toISOString();
    if (!updatesByFlowsheet.has(binding.flowsheet_id)) updatesByFlowsheet.set(binding.flowsheet_id, []);
    const update = {
      bindingId:   binding.id,
      nodeId:      binding.node_id,
      paramKey:    binding.param_key,
      value,
      quality,
      ts,
      tagId:       binding.tag_id || null,
      flowsheetId: binding.flowsheet_id,
    };
    updatesByFlowsheet.get(binding.flowsheet_id).push(update);
    if (binding.organisation_id) {
      if (!updatesByOrg.has(binding.organisation_id)) updatesByOrg.set(binding.organisation_id, []);
      updatesByOrg.get(binding.organisation_id).push(update);
    }
    if (binding.tag_id && (quality === 'good' || binding.quality !== quality)) {
      samples.push({ tagId: binding.tag_id, ts, value: quality === 'good' ? value : null, quality });
    }
  };

  // Poll connection groups concurrently so one unreachable/slow PLC (which
  // can block for timeoutMs per connect attempt) never delays the others.
  // The global `ticking` guard in startPoller still prevents overlapping
  // scheduler passes.
  await Promise.allSettled(
    [...byConnection].map(([connectionId, bindings]) =>
      pollConnection(connectionId, bindings, pushUpdate).catch((err) => {
        logger.warn('PLC poller: connection group failed', { connectionId, err: err.message });
      })
    )
  );

  for (const [flowsheetId, values] of updatesByFlowsheet) {
    try {
      broadcastToRoom(flowsheetId, { type: 'plc:update', payload: { flowsheetId, values } });
    } catch (err) {
      logger.warn('PLC poller: broadcast failed', { flowsheetId, err: err.message });
    }
  }

  for (const [orgId, values] of updatesByOrg) {
    try {
      broadcastToOrg(orgId, { type: 'plc:update', payload: { values } });
    } catch (err) {
      logger.warn('PLC poller: org broadcast failed', { orgId, err: err.message });
    }
  }

  // One batched insert per tick; recordSamples never throws.
  if (samples.length) await recordSamples(samples);

  if (now - lastBackfillAt > BACKFILL_EVERY_MS) {
    lastBackfillAt = now;
    backfillBindingTags().catch((err) => logger.debug('PLC poller: registry link skipped', { err: err.message }));
  }
}

/** Poll one connection's due bindings over its cached client. */
async function pollConnection(connectionId, bindings, pushUpdate) {
  const conn = bindings[0];

  let client;
  try {
    client = await getClientFor(conn);
  } catch (err) {
    await setConnectionError(connectionId, err.message).catch(() => {});
    await markStale(bindings, pushUpdate);
    return;
  }
  if (!client) return; // backing off — leave last values in place

  let connectionLost = false;
  let lastError = null;

  for (const binding of bindings) {
    if (connectionLost) { await markStale([binding], pushUpdate); continue; }
    try {
      const raw = await client.readTag(binding.address);
      const value = raw * (Number(binding.scale) || 1) + (Number(binding.offset_val) || 0);
      if (!Number.isFinite(value)) {
        // Infinity/NaN would serialize to JSON null downstream — treat the
        // read as bad quality: keep last_value, never broadcast it as good.
        await query(
          `UPDATE plc_bindings SET quality = 'bad', last_read_at = NOW() WHERE id = $1`,
          [binding.id]
        ).catch(() => {});
        pushUpdate(binding, binding.last_value !== undefined ? binding.last_value : null, 'bad');
        continue;
      }
      await query(
        `UPDATE plc_bindings SET last_value = $1, quality = 'good', last_read_at = NOW() WHERE id = $2`,
        [value, binding.id]
      );
      pushUpdate(binding, value, 'good');

      // Live alarm check on the good sample. Fire-and-forget: the evaluator
      // caches the flowsheet's enabled 'param' rules (~10s) and early-exits
      // before any write when there are none, so a plant with no alarms pays
      // nothing per tick and a slow DB never stalls the poll loop.
      evaluateParamValue({
        flowsheetId:    binding.flowsheet_id,
        organisationId: binding.organisation_id,
        nodeId:         binding.node_id,
        paramKey:       binding.param_key,
      }, value).catch((err) => logger.warn('Alarm PLC evaluation failed', {
        bindingId: binding.id, err: err.message,
      }));
    } catch (err) {
      lastError = err.message;
      if (err.connectionLost) {
        connectionLost = true;
        await invalidateClient(connectionId);
        await markStale([binding], pushUpdate);
      } else {
        // Tag-level failure (bad address etc.) — connection itself is fine.
        // Push the retained last_value (may be null if never read) so WS
        // clients keep showing the same reading REST serves.
        await query(
          `UPDATE plc_bindings SET quality = 'bad', last_read_at = NOW() WHERE id = $1`,
          [binding.id]
        ).catch(() => {});
        pushUpdate(binding, binding.last_value !== undefined ? binding.last_value : null, 'bad');
      }
    }
  }

  if (connectionLost) {
    await setConnectionError(connectionId, lastError || 'connection lost').catch(() => {});
  } else {
    // The device answered (even if some tags errored) — connection is up.
    await setConnectionOk(connectionId).catch(() => {});
  }
}

/** Mark bindings stale (keep last_value; do not bump last_read_at forward). */
async function markStale(bindings, pushUpdate) {
  for (const binding of bindings) {
    await query(
      `UPDATE plc_bindings SET quality = 'stale' WHERE id = $1 AND quality != 'stale'`,
      [binding.id]
    ).catch(() => {});
    pushUpdate(binding, binding.last_value !== undefined ? binding.last_value : null, 'stale');
  }
}

/**
 * The built-in simulator keeps its writable registers in process memory, so
 * a restart would forget every Start and Open ever commanded and the demo
 * plant would boot with everything stopped. Restore each write binding's
 * last commanded value into its register before the first poll — the same
 * thing a real PLC does by simply still being there.
 */
async function primeSimulatorRegisters() {
  const { rows } = await query(
    `SELECT b.address, b.last_value, b.scale, b.offset_val, c.id AS connection_id, c.organisation_id
       FROM plc_bindings b JOIN plc_connections c ON c.id = b.connection_id
      WHERE c.protocol = 'simulator' AND b.enabled = TRUE AND b.direction IN ('write', 'read_write')
        AND b.address ILIKE 'mem:%' AND b.last_value IS NOT NULL`
  );
  const sim = getDriver('simulator');
  let n = 0;
  for (const b of rows) {
    try {
      const client = sim.createClient({}, { connectionId: b.connection_id, organisationId: b.organisation_id });
      const raw = (Number(b.last_value) - (Number(b.offset_val) || 0)) / (Number(b.scale) || 1);
      await client.writeTag(b.address, raw);
      n += 1;
    } catch (err) {
      logger.debug('Simulator register not primed', { address: b.address, err: err.message });
    }
  }
  if (n) logger.info('Simulator registers restored from last commanded values', { count: n });
  return n;
}

/**
 * Start the poll loop. No-op when already running, and skipped entirely under
 * NODE_ENV==='test' unless { force: true }.
 */
function startPoller({ force = false, tickMs = TICK_MS } = {}) {
  if (timer) return;
  if (process.env.NODE_ENV === 'test' && !force) return;

  // Warm the bridge-driver availability probe (memoized, never rejects) so
  // GET /plc/protocols is accurate without paying for the first probe inline.
  probeAvailability().catch(() => {});
  primeSimulatorRegisters().catch((err) => logger.warn('Simulator priming failed', { err: err.message }));

  timer = setInterval(async () => {
    if (ticking) return; // never overlap slow cycles
    ticking = true;
    try {
      await tick();
    } catch (err) {
      logger.error('PLC poller tick failed', { error: err.message });
    } finally {
      ticking = false;
    }
  }, tickMs);
  timer.unref();
  logger.info('PLC poller started', { tickMs });
}

/** Stop the loop and disconnect every cached client. */
async function stopPoller() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  for (const id of [...clients.keys()]) {
    await dropClient(id);
  }
  logger.info('PLC poller stopped');
}

module.exports = { startPoller, stopPoller, tick, primeSimulatorRegisters, _clients: clients };
