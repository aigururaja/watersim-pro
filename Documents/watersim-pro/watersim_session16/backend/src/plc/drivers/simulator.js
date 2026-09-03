/**
 * WaterSim Pro — Simulator driver (built-in virtual PLC)
 *
 * No network, no hardware: values are computed from Date.now(), so any number
 * of clients see the same signal. Useful for demos, dev and tests.
 *
 * Address syntax (see descriptor.addressHint):
 *   sine:min,max,periodSec   sinusoid between min and max
 *   random:min,max           uniform random on every read
 *   step:min,max,periodSec   square wave alternating min/max every periodSec
 *   const:value              a constant
 *   mem:<key>                in-memory register (readable/writable, default 0)
 *
 * writeTag stores into a module-level in-memory map, namespaced per connection:
 * createClient(config, context) keys every entry as
 * `${context.connectionId || 'default'}::<key>` so two connections (and
 * therefore two organisations) can never read or tamper with each other's
 * values. Clients created with the same connectionId (e.g. the poller's cached
 * client and the write endpoint's one-shot client) still share state.
 * 'mem:<key>' writes land under <key>; writes to any other address are stored
 * under the full address string.
 */
'use strict';

const descriptor = {
  protocol: 'simulator',
  label:    'Simulator (built-in virtual PLC)',
  status:   'available',
  configFields: [],
  addressHint:
    "'sine:min,max,periodSec' | 'random:min,max' | 'step:min,max,periodSec' | " +
    "'const:value' | 'mem:<key>' (writable in-memory register)",
};

// Module-level so a value written via the write endpoint is visible to the
// poller's cached client — but every entry is namespaced by connectionId
// (`${connectionId || 'default'}::${key}`), so distinct connections never
// share (or leak) values.
const memory = new Map();

function parseNums(argStr, count, address) {
  const nums = String(argStr || '').split(',').map((s) => Number(s.trim()));
  if (nums.length !== count || nums.some((n) => !Number.isFinite(n))) {
    throw new Error(`Invalid simulator address "${address}" — expected ${count} numeric argument(s)`);
  }
  return nums;
}

function parseAddress(address) {
  if (typeof address !== 'string' || !address.includes(':')) {
    throw new Error(`Invalid simulator address "${address}"`);
  }
  const idx  = address.indexOf(':');
  const kind = address.slice(0, idx).trim().toLowerCase();
  const args = address.slice(idx + 1).trim();

  switch (kind) {
    case 'sine': {
      const [min, max, periodSec] = parseNums(args, 3, address);
      return { kind, min, max, periodSec };
    }
    case 'step': {
      const [min, max, periodSec] = parseNums(args, 3, address);
      return { kind, min, max, periodSec };
    }
    case 'random': {
      const [min, max] = parseNums(args, 2, address);
      return { kind, min, max };
    }
    case 'const': {
      const [value] = parseNums(args, 1, address);
      return { kind, value };
    }
    case 'mem': {
      if (!args) throw new Error(`Invalid simulator address "${address}" — mem needs a key`);
      return { kind, key: args };
    }
    default:
      throw new Error(
        `Invalid simulator address "${address}" — expected sine:|random:|step:|const:|mem:`
      );
  }
}

function computeValue(parsed, namespace) {
  const t = Date.now() / 1000; // seconds
  switch (parsed.kind) {
    case 'sine': {
      const mid = (parsed.min + parsed.max) / 2;
      const amp = (parsed.max - parsed.min) / 2;
      const period = parsed.periodSec > 0 ? parsed.periodSec : 60;
      return mid + amp * Math.sin((2 * Math.PI * t) / period);
    }
    case 'random':
      return parsed.min + Math.random() * (parsed.max - parsed.min);
    case 'step': {
      const period = parsed.periodSec > 0 ? parsed.periodSec : 60;
      return Math.floor(t / period) % 2 === 0 ? parsed.min : parsed.max;
    }
    case 'const':
      return parsed.value;
    case 'mem': {
      const v = memory.get(`${namespace}::${parsed.key}`);
      return v === undefined ? 0 : v;
    }
    default:
      throw new Error(`Unknown simulator address kind "${parsed.kind}"`);
  }
}

class SimulatorClient {
  constructor(context = {}) {
    // Per-connection namespace: entries in the shared map never cross
    // connections (and therefore never cross organisations).
    this.namespace = context.connectionId || 'default';
  }

  async connect() { /* nothing to do — always connected */ }

  async readTag(address) {
    return computeValue(parseAddress(address), this.namespace);
  }

  async writeTag(address, value) {
    const num = Number(value);
    if (!Number.isFinite(num)) throw new Error(`Cannot write non-numeric value to ${address}`);
    const parsed = parseAddress(address);
    memory.set(`${this.namespace}::${parsed.kind === 'mem' ? parsed.key : address}`, num);
  }

  async disconnect() { /* nothing to do */ }
}

function createClient(_config, context = {}) {
  return new SimulatorClient(context);
}

async function testConnection(_config = {}) {
  return { ok: true, message: 'Simulator ready', latencyMs: 0 };
}

/** The simulator has no config — anything goes. */
function validateConfig(_config = {}) {
  return [];
}

function validateAddress(address) {
  try { parseAddress(address); return null; } catch (err) { return err.message; }
}

module.exports = {
  descriptor,
  createClient,
  testConnection,
  validateConfig,
  validateAddress,
  _memory: memory, // exported for tests
};
