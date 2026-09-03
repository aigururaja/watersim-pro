/**
 * PLC bridge driver integration tests — REAL Python bridge, real local servers.
 *
 * - OPC UA:      end-to-end against a local asyncua server fixture
 *                (bridge/fixtures/opcua_test_server.py, opc.tcp://127.0.0.1:48400).
 * - Siemens S7:  end-to-end against a local snap7 demo server fixture
 *                (bridge/fixtures/s7_test_server.py, port 10102).
 * - EtherNet/IP: unit tests only (validateConfig/validateAddress/probe) — no
 *                local Logix server exists; hardware integration is untested.
 * - bridgeClient: timeout → connectionLost → respawn semantics against a
 *                deliberately slow fixture (bridge/fixtures/slow_bridge.py).
 *
 * Guard: availability is probed at module load (a synchronous one-shot bridge
 * 'probe') so unavailable protocols skip their describes — LOUDLY, never
 * silently: a console.warn names exactly what is missing. beforeAll re-probes
 * through bridgeCall() and warns as well. No DB is needed by this file.
 */
'use strict';

// The fixtures listen on 127.0.0.1, which the loopback guard would reject.
process.env.PLC_ALLOW_LOCAL_HOSTS = 'true';

const { spawn, spawnSync } = require('child_process');
const path = require('path');

const { BridgeClient, bridgeCall, BRIDGE_SCRIPT } = require('../plc/bridge/bridgeClient');
const { PYTHON_BIN } = require('../reports/pySpawn');
const opcua      = require('../plc/drivers/opcua');
const s7         = require('../plc/drivers/s7');
const ethernetIp = require('../plc/drivers/ethernetIp');
const registry   = require('../plc/registry');

const FIXTURES = path.join(__dirname, '..', 'plc', 'bridge', 'fixtures');
const BRIDGE_PROTOCOLS = ['opcua', 's7', 'ethernet_ip'];

afterAll(() => { delete process.env.PLC_ALLOW_LOCAL_HOSTS; });

// ── Load-time availability gate ──────────────────────────────────────────────

/** One-shot synchronous probe so describes can be gated at registration time. */
function syncProbe() {
  try {
    const res = spawnSync(PYTHON_BIN, [BRIDGE_SCRIPT], {
      input: '{"id":1,"op":"probe"}\n',
      encoding: 'utf8',
      timeout: 20000,
      windowsHide: true,
    });
    if (res.error || !res.stdout) return null;
    const line = res.stdout.split(/\r?\n/).find((l) => l.trim());
    if (!line) return null;
    const msg = JSON.parse(line);
    return msg.ok ? msg.value : null;
  } catch {
    return null;
  }
}

const probe = syncProbe();
const available = (protocol) => !!(probe && probe[protocol] && probe[protocol].available);

/** describe when the protocol is usable, describe.skip + LOUD warn otherwise. */
function gatedDescribe(protocol, label) {
  if (available(protocol)) return describe;
  const reason = probe
    ? ((probe[protocol] && probe[protocol].reason) || `protocol '${protocol}' unavailable`)
    : `Python bridge not runnable via '${PYTHON_BIN}' (set PYTHON_BIN / install Python 3)`;
  console.warn(
    `\n[plcDrivers.test] ⚠️  SKIPPING ${label} integration tests — ${reason}\n` +
    '[plcDrivers.test]     These tests did NOT run; fix the environment to cover this driver.\n'
  );
  return describe.skip;
}

const pythonDescribe = probe ? describe : (() => {
  console.warn(
    `\n[plcDrivers.test] ⚠️  SKIPPING bridge/bridgeClient tests — Python bridge not runnable via '${PYTHON_BIN}'.\n`
  );
  return describe.skip;
})();

// Belt & braces: re-probe through the public bridgeCall path and warn loudly.
beforeAll(async () => {
  try {
    const p = await bridgeCall('probe', {}, 15000);
    for (const key of BRIDGE_PROTOCOLS) {
      if (!p[key] || !p[key].available) {
        console.warn(`[plcDrivers.test] ⚠️  '${key}' unavailable: ${(p[key] && p[key].reason) || 'unknown'}`);
      }
    }
  } catch (err) {
    console.warn(`[plcDrivers.test] ⚠️  bridge probe failed: ${err.message}`);
  }
}, 20000);

// ── Helpers ──────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Poll an async ok-check until ready. */
async function waitForReady(check, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let lastMessage = '';
  while (Date.now() < deadline) {
    try {
      const r = await check();
      if (r && r.ok) return;
      lastMessage = (r && r.message) || '';
    } catch (err) {
      lastMessage = err.message;
    }
    await sleep(400);
  }
  throw new Error(`${label} did not become ready in ${timeoutMs}ms (last: ${lastMessage})`);
}

function spawnFixture(script) {
  const child = spawn(PYTHON_BIN, [path.join(FIXTURES, script)], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  child.stdout.on('data', () => {});
  child.stderr.on('data', () => {});
  return child;
}

// ── Registry: dynamic availability ───────────────────────────────────────────

describe('Registry availability probe', () => {
  test('probeAvailability is memoized and listProtocols merges its result', async () => {
    const first = await registry.probeAvailability();
    expect(await registry.probeAvailability()).toBe(first); // memoized (same object)

    const byKey = Object.fromEntries(registry.listProtocols().map((p) => [p.protocol, p]));
    expect(byKey.modbus_tcp.status).toBe('available'); // static, never probed
    expect(byKey.simulator.status).toBe('available');

    for (const key of BRIDGE_PROTOCOLS) {
      expect(first[key]).toBeDefined();
      if (first[key].available) {
        expect(byKey[key].status).toBe('available');
        expect(byKey[key].reason).toBeUndefined();
      } else {
        expect(byKey[key].status).toBe('stub');
        expect(typeof byKey[key].reason).toBe('string');
        expect(byKey[key].reason.length).toBeGreaterThan(0);
      }
    }
  }, 20000);

  test('on this machine the probe matches the load-time probe', () => {
    if (!probe) {
      console.warn('[plcDrivers.test] ⚠️  load-time probe unavailable — skipping consistency check');
      return;
    }
    for (const key of BRIDGE_PROTOCOLS) {
      expect(typeof probe[key].available).toBe('boolean');
    }
  });
});

// ── OPC UA end-to-end ────────────────────────────────────────────────────────

gatedDescribe('opcua', 'OPC UA')('OPC UA driver (real bridge ⇄ local asyncua server)', () => {
  const ENDPOINT = 'opc.tcp://127.0.0.1:48400';
  const CONFIG   = { endpoint: ENDPOINT, timeoutMs: 5000 };
  let serverProc;

  beforeAll(async () => {
    serverProc = spawnFixture('opcua_test_server.py');
    await waitForReady(
      () => opcua.testConnection({ endpoint: ENDPOINT, timeoutMs: 2000 }),
      25000,
      'asyncua test server'
    );
  }, 30000);

  afterAll(() => {
    if (serverProc) serverProc.kill('SIGKILL');
  });

  test('testConnection reports ok with a latency', async () => {
    const r = await opcua.testConnection(CONFIG);
    expect(r.ok).toBe(true);
    expect(r.message).toMatch(/Connected to opc\.tcp:\/\/127\.0\.0\.1:48400/);
    expect(typeof r.latencyMs).toBe('number');
  }, 15000);

  test('read → write → read roundtrip on ns=2;s=TestVar', async () => {
    const client = opcua.createClient(CONFIG, { connectionId: 'test-opcua' });
    await client.connect();
    try {
      expect(await client.readTag('ns=2;s=TestVar')).toBeCloseTo(42.5, 6);
      await client.writeTag('ns=2;s=TestVar', 55);
      expect(await client.readTag('ns=2;s=TestVar')).toBeCloseTo(55, 6);
    } finally {
      await client.disconnect();
    }
  }, 20000);

  test('unknown node id is a tag-level error (connectionLost falsy), session survives', async () => {
    const client = opcua.createClient(CONFIG);
    await client.connect();
    try {
      let caught;
      try { await client.readTag('ns=2;s=NoSuchTag'); } catch (err) { caught = err; }
      expect(caught).toBeDefined();
      expect(caught.message).toMatch(/BadNodeIdUnknown|does not exist/);
      expect(!!caught.connectionLost).toBe(false);
      // Connection still healthy after the tag-level failure:
      expect(typeof await client.readTag('ns=2;s=TestVar')).toBe('number');
    } finally {
      await client.disconnect();
    }
  }, 20000);
});

// ── Siemens S7 end-to-end ────────────────────────────────────────────────────

gatedDescribe('s7', 'Siemens S7')('S7 driver (real bridge ⇄ local snap7 server)', () => {
  const CONFIG = { host: '127.0.0.1', port: 10102, rack: 0, slot: 1, timeoutMs: 5000 };
  let serverProc;
  let client;

  beforeAll(async () => {
    serverProc = spawnFixture('s7_test_server.py');
    await waitForReady(() => s7.testConnection({ ...CONFIG, timeoutMs: 2000 }), 20000, 'snap7 test server');
    client = s7.createClient(CONFIG, { connectionId: 'test-s7' });
    await client.connect();
  }, 30000);

  afterAll(async () => {
    if (client) await client.disconnect();
    if (serverProc) serverProc.kill('SIGKILL');
  });

  test('testConnection reports ok with a latency', async () => {
    const r = await s7.testConnection(CONFIG);
    expect(r.ok).toBe(true);
    expect(typeof r.latencyMs).toBe('number');
  }, 15000);

  test('reads every documented datatype from DB1', async () => {
    expect(await client.readTag('db1.real0')).toBeCloseTo(123.25, 4);
    expect(await client.readTag('db1.int4')).toBe(1234);
    expect(await client.readTag('db1.bool6.3')).toBe(1);
    expect(await client.readTag('db1.bool6.0')).toBe(0);
    expect(await client.readTag('db1.dint8')).toBe(-56789);
    expect(await client.readTag('db1.word12')).toBe(65500);
  }, 15000);

  test('write → read roundtrip (REAL and INT), addresses case-insensitive', async () => {
    await client.writeTag('db1.real0', 55.5);
    expect(await client.readTag('DB1.REAL0')).toBeCloseTo(55.5, 4);
    await client.writeTag('db1.int4', -321);
    expect(await client.readTag('db1.int4')).toBe(-321);
  }, 15000);

  test('a refused connect rejects connectionLost and leaves no python child behind', async () => {
    const c = s7.createClient({ host: '127.0.0.1', port: 1, timeoutMs: 3000 });
    let caught;
    try { await c.connect(); } catch (err) { caught = err; }
    expect(caught).toBeDefined();
    expect(caught.connectionLost).toBe(true);
    expect(c.bridge.childPid).toBeNull(); // bridge child torn down on failed connect
    await c.disconnect(); // still safe to call
  }, 15000);

  test('killing the server surfaces err.connectionLost = true', async () => {
    serverProc.kill('SIGKILL');
    serverProc = null;
    await sleep(300);
    let caught;
    try {
      await client.readTag('db1.real0');
      // A first read can still be served from the dead socket's buffers on
      // some stacks — a second read must fail.
      await client.readTag('db1.real0');
    } catch (err) { caught = err; }
    expect(caught).toBeDefined();
    expect(caught.connectionLost).toBe(true);
  }, 15000);
});

// S7 address parser — pure unit tests, run regardless of the bridge.
describe('S7 address grammar (validateAddress/parseAddress)', () => {
  test('accepts the documented grammar', () => {
    expect(s7.parseAddress('db1.real0')).toEqual({ db: 1, kind: 'real', offset: 0, bit: null });
    expect(s7.parseAddress('DB5.INT24')).toEqual({ db: 5, kind: 'int', offset: 24, bit: null });
    expect(s7.parseAddress('db2.dint8')).toEqual({ db: 2, kind: 'dint', offset: 8, bit: null });
    expect(s7.parseAddress('db10.word2')).toEqual({ db: 10, kind: 'word', offset: 2, bit: null });
    expect(s7.parseAddress('db1.bool6.7')).toEqual({ db: 1, kind: 'bool', offset: 6, bit: 7 });
    expect(s7.validateAddress('db1.real0')).toBeNull();
    expect(s7.validateAddress('db1.bool6.3')).toBeNull();
  });

  test('rejects malformed addresses', () => {
    for (const bad of [
      'db1.real',        // missing offset
      'db.real0',        // missing db number
      'db1.float0',      // unknown type
      'db1.bool6',       // bool without bit
      'db1.bool6.8',     // bit out of range
      'mb1.real0',       // wrong area
      'DB5,REAL10',      // legacy nodes7 syntax
      'hr:100',          // modbus syntax
      '',
    ]) {
      expect(s7.validateAddress(bad)).toMatch(/Invalid S7 address|must be a string/);
    }
    expect(s7.validateAddress(42)).toMatch(/must be a string/);
  });
});

// ── EtherNet/IP (unit only — no local Logix server; hardware untested) ──────

describe('EtherNet/IP driver (unit — hardware integration untested)', () => {
  test('validateConfig requires host and honours the loopback guard flag', () => {
    expect(ethernetIp.validateConfig({})).toEqual(
      expect.arrayContaining([expect.stringContaining('config.host is required')])
    );
    // Flag is 'true' for this file → loopback allowed.
    expect(ethernetIp.validateConfig({ host: '127.0.0.1' })).toEqual([]);
    expect(ethernetIp.validateConfig({ host: '192.168.0.30', slot: 0, timeoutMs: 4000 })).toEqual([]);

    const prev = process.env.PLC_ALLOW_LOCAL_HOSTS;
    delete process.env.PLC_ALLOW_LOCAL_HOSTS;
    try {
      expect(ethernetIp.validateConfig({ host: '127.0.0.1' }).join(' ')).toMatch(/loopback/);
      expect(ethernetIp.validateConfig({ host: '169.254.169.254' }).join(' ')).toMatch(/link-local|loopback/);
      expect(s7.validateConfig({ host: 'localhost' }).join(' ')).toMatch(/loopback/);
      expect(opcua.validateConfig({ endpoint: 'opc.tcp://127.0.0.1:4840' }).join(' ')).toMatch(/loopback/);
    } finally {
      process.env.PLC_ALLOW_LOCAL_HOSTS = prev;
    }
  });

  test('validateConfig rejects bad numerics', () => {
    expect(ethernetIp.validateConfig({ host: '10.0.0.5', slot: -1 }).join(' ')).toMatch(/slot/);
    expect(ethernetIp.validateConfig({ host: '10.0.0.5', timeoutMs: 99999 }).join(' ')).toMatch(/at most 10000/);
  });

  test('validateAddress accepts Logix tag paths and rejects junk', () => {
    for (const good of [
      'Pump1_Speed',
      'Program:MainProgram.Counter',
      'Tank[3].Level',
      'MyUdt.Member.Sub',
      'Matrix[1,2]',
    ]) {
      expect(ethernetIp.validateAddress(good)).toBeNull();
    }
    for (const bad of ['', '  ', '9StartsWithDigit', 'has space', 'Program:', 'Program:Main', 'a..b', 'tag[]']) {
      expect(ethernetIp.validateAddress(bad)).toMatch(/EtherNet\/IP/);
    }
  });

  test('createClient returns the standard driver interface without spawning Python', () => {
    const client = ethernetIp.createClient({ host: '192.168.0.30' });
    expect(typeof client.connect).toBe('function');
    expect(typeof client.readTag).toBe('function');
    expect(typeof client.writeTag).toBe('function');
    expect(typeof client.disconnect).toBe('function');
    expect(client.bridge.childPid).toBeNull(); // lazy — no child until first request
  });
});

// ── OPC UA config/address validation (unit) ─────────────────────────────────

describe('OPC UA validation (unit)', () => {
  test('validateConfig requires an opc.tcp:// endpoint', () => {
    expect(opcua.validateConfig({}).join(' ')).toMatch(/endpoint is required/);
    expect(opcua.validateConfig({ endpoint: 'http://10.0.0.5:4840' }).join(' ')).toMatch(/opc\.tcp/);
    expect(opcua.validateConfig({ endpoint: 'not a url' }).join(' ')).toMatch(/opc\.tcp/);
    expect(opcua.validateConfig({ endpoint: 'opc.tcp://10.0.0.5:4840' })).toEqual([]);
  });

  test('validateAddress accepts node ids and rejects junk', () => {
    expect(opcua.validateAddress('ns=2;s=Device1.FlowRate')).toBeNull();
    expect(opcua.validateAddress('ns=3;i=1005')).toBeNull();
    expect(opcua.validateAddress('i=84')).toBeNull(); // ns defaults to 0
    expect(opcua.validateAddress('FlowRate')).toMatch(/Invalid OPC UA node id/);
    expect(opcua.validateAddress('ns=2;x=1')).toMatch(/Invalid OPC UA node id/);
    expect(opcua.validateAddress('')).toMatch(/node id string/);
  });
});

// ── bridgeClient: timeout / crash / respawn semantics ───────────────────────

pythonDescribe('bridgeClient (timeout → kill → respawn)', () => {
  test('a timed-out request rejects with connectionLost and the next call respawns the child', async () => {
    const client = new BridgeClient({ scriptPath: path.join(FIXTURES, 'slow_bridge.py') });
    try {
      expect(await client.request('ping', {}, 8000)).toBe('pong');
      const pidBefore = client.childPid;
      expect(pidBefore).not.toBeNull();

      let caught;
      try { await client.request('sleep', { seconds: 30 }, 700); } catch (err) { caught = err; }
      expect(caught).toBeDefined();
      expect(caught.connectionLost).toBe(true);
      expect(caught.message).toMatch(/timed out after 700ms/);
      expect(client.childPid).toBeNull(); // child was killed

      // Next request lazily respawns a fresh child.
      expect(await client.request('ping', {}, 8000)).toBe('pong');
      expect(client.childPid).not.toBeNull();
      expect(client.childPid).not.toBe(pidBefore);
    } finally {
      client.close();
    }
  }, 25000);

  test('bad requests get error replies without killing the bridge; ping still works', async () => {
    const client = new BridgeClient();
    try {
      expect(await client.request('ping', {}, 8000)).toBe('pong');
      const pid = client.childPid;

      let caught;
      try { await client.request('no_such_op', {}, 8000); } catch (err) { caught = err; }
      expect(caught).toBeDefined();
      expect(caught.message).toMatch(/Unknown op/);
      expect(!!caught.connectionLost).toBe(false);

      // Reading without connecting is a connection-level error by contract.
      let caught2;
      try { await client.request('read', { protocol: 's7', address: 'db1.real0' }, 8000); } catch (err) { caught2 = err; }
      expect(caught2).toBeDefined();
      expect(caught2.connectionLost).toBe(true);

      expect(await client.request('ping', {}, 8000)).toBe('pong');
      expect(client.childPid).toBe(pid); // same child throughout — errors don't kill it
    } finally {
      client.close();
    }
  }, 25000);

  test('requests after close() are rejected', async () => {
    const client = new BridgeClient();
    client.close();
    await expect(client.request('ping', {}, 2000)).rejects.toMatchObject({ connectionLost: true });
  });
});
