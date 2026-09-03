/**
 * PLC integration tests — drivers, connections API, bindings API, poller.
 *
 * Driver tests are pure unit tests (no DB). The Modbus framing test runs the
 * real client against a minimal in-process mock Modbus TCP server. API tests
 * follow the helpers.js patterns (real DB, fresh org per describe block).
 */
'use strict';

// The Modbus tests run a mock server on 127.0.0.1, which the loopback guard
// in modbusTcp.validateConfig would reject — allow local hosts for the whole
// file (the SSRF regression test unsets/restores the flag around itself).
process.env.PLC_ALLOW_LOCAL_HOSTS = 'true';

// Record poller broadcasts (real implementation still runs — it is a no-op
// without WS rooms) so tests can assert what stale/bad pushes carry.
jest.mock('../collab/wsServer', () => {
  const actual = jest.requireActual('../collab/wsServer');
  return { ...actual, broadcastToRoom: jest.fn(actual.broadcastToRoom) };
});

const net = require('net');
const {
  request, app, createTestUser, loginAs, makeProject, makeFlowsheet,
} = require('./helpers');

const simulator = require('../plc/drivers/simulator');
const modbus    = require('../plc/drivers/modbusTcp');
const { getDriver, listProtocols } = require('../plc/registry');
const poller    = require('../plc/poller');
const { broadcastToRoom } = require('../collab/wsServer');
const { query } = require('../db/pool');

afterAll(() => { delete process.env.PLC_ALLOW_LOCAL_HOSTS; });

// ── Simulator driver ─────────────────────────────────────────────────────────

describe('Simulator driver', () => {
  const client = simulator.createClient({});

  beforeAll(() => client.connect());

  test('sine stays within [min, max]', async () => {
    for (let i = 0; i < 10; i++) {
      const v = await client.readTag('sine:2,8,60');
      expect(v).toBeGreaterThanOrEqual(2);
      expect(v).toBeLessThanOrEqual(8);
    }
  });

  test('const returns the exact value', async () => {
    expect(await client.readTag('const:42.5')).toBe(42.5);
    expect(await client.readTag('const:-3')).toBe(-3);
  });

  test('random stays within [min, max]', async () => {
    for (let i = 0; i < 10; i++) {
      const v = await client.readTag('random:1,2');
      expect(v).toBeGreaterThanOrEqual(1);
      expect(v).toBeLessThanOrEqual(2);
    }
  });

  test('step returns min or max', async () => {
    const v = await client.readTag('step:0,100,10');
    expect([0, 100]).toContain(v);
  });

  test('mem write/read roundtrip; unset mem reads 0', async () => {
    expect(await client.readTag('mem:unset-key-xyz')).toBe(0);
    await client.writeTag('mem:pumpSpeed', 7.25);
    expect(await client.readTag('mem:pumpSpeed')).toBe(7.25);
    // shared across client instances built for the SAME connection context
    // (both here use the 'default' namespace)
    const other = simulator.createClient({});
    await other.connect();
    expect(await other.readTag('mem:pumpSpeed')).toBe(7.25);
  });

  test('mem values are namespaced per connection — writes never leak across connections', async () => {
    const a = simulator.createClient({}, { connectionId: 'conn-A', organisationId: 'org-A' });
    const b = simulator.createClient({}, { connectionId: 'conn-B', organisationId: 'org-B' });
    await a.connect();
    await b.connect();

    await a.writeTag('mem:x', 111);
    expect(await a.readTag('mem:x')).toBe(111);
    expect(await b.readTag('mem:x')).toBe(0);   // connection B cannot read A's value

    await b.writeTag('mem:x', 222);
    expect(await b.readTag('mem:x')).toBe(222);
    expect(await a.readTag('mem:x')).toBe(111); // …and cannot tamper with it

    // A second client for the same connection shares state (poller's cached
    // client vs the write endpoint's one-shot client).
    const a2 = simulator.createClient({}, { connectionId: 'conn-A' });
    await a2.connect();
    expect(await a2.readTag('mem:x')).toBe(111);

    // The default (no-context) namespace is isolated from both.
    expect(await client.readTag('mem:x')).toBe(0);
  });

  test('rejects malformed addresses', async () => {
    await expect(client.readTag('bogus:1')).rejects.toThrow(/Invalid simulator address/);
    await expect(client.readTag('sine:1,2')).rejects.toThrow(/numeric argument/);
    expect(simulator.validateAddress('nope')).toMatch(/Invalid/);
    expect(simulator.validateAddress('sine:0,10,60')).toBeNull();
  });

  test('testConnection is always ok', async () => {
    const r = await simulator.testConnection({});
    expect(r.ok).toBe(true);
  });
});

// ── Modbus TCP driver vs in-process mock server ──────────────────────────────

/**
 * Minimal Modbus TCP server: MBAP framing, FC3 (read holding registers),
 * FC6 (write single register), FC16 (write multiple registers). Everything
 * else answers a Modbus exception (illegal data address).
 */
function startMockModbusServer() {
  const registers = new Map(); // addr -> uint16
  return new Promise((resolve) => {
    const server = net.createServer((socket) => {
      let buf = Buffer.alloc(0);
      socket.on('data', (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        while (buf.length >= 7) {
          const len = buf.readUInt16BE(4);
          const frameLen = 6 + len;
          if (buf.length < frameLen) return;
          const frame = buf.subarray(0, frameLen);
          buf = buf.subarray(frameLen);

          const txn  = frame.readUInt16BE(0);
          const unit = frame[6];
          const fc   = frame[7];
          let respPdu;

          if (fc === 3) {
            const addr = frame.readUInt16BE(8);
            const qty  = frame.readUInt16BE(10);
            const data = Buffer.alloc(qty * 2);
            for (let k = 0; k < qty; k++) data.writeUInt16BE(registers.get(addr + k) || 0, k * 2);
            respPdu = Buffer.concat([Buffer.from([3, qty * 2]), data]);
          } else if (fc === 6) {
            const addr = frame.readUInt16BE(8);
            registers.set(addr, frame.readUInt16BE(10));
            respPdu = Buffer.from(frame.subarray(7, 13)); // echo request
          } else if (fc === 16) {
            const addr = frame.readUInt16BE(8);
            const qty  = frame.readUInt16BE(10);
            for (let k = 0; k < qty; k++) registers.set(addr + k, frame.readUInt16BE(13 + k * 2));
            respPdu = Buffer.from([16, frame[8], frame[9], frame[10], frame[11]]);
          } else {
            respPdu = Buffer.from([fc | 0x80, 2]); // exception: illegal data address
          }

          const mbap = Buffer.alloc(7);
          mbap.writeUInt16BE(txn, 0);
          mbap.writeUInt16BE(0, 2);
          mbap.writeUInt16BE(respPdu.length + 1, 4);
          mbap.writeUInt8(unit, 6);
          socket.write(Buffer.concat([mbap, respPdu]));
        }
      });
    });
    server.listen(0, '127.0.0.1', () =>
      resolve({ server, registers, port: server.address().port }));
  });
}

describe('Modbus TCP driver (mock server)', () => {
  let mock, client;

  beforeAll(async () => {
    mock = await startMockModbusServer();
    mock.registers.set(100, 1234);
    client = modbus.createClient({ host: '127.0.0.1', port: mock.port, timeoutMs: 2000 });
    await client.connect();
  });

  afterAll(async () => {
    await client.disconnect();
    await new Promise((r) => mock.server.close(r));
  });

  test('FC3 reads a holding register (uint16)', async () => {
    expect(await client.readTag('hr:100')).toBe(1234);
  });

  test('FC6 write single register roundtrip', async () => {
    await client.writeTag('hr:200', 77);
    expect(mock.registers.get(200)).toBe(77);
    expect(await client.readTag('hr:200')).toBe(77);
  });

  test('FC16 float write / FC3 float read roundtrip (2 registers, big-endian)', async () => {
    await client.writeTag('hr:300:float', 3.14159);
    const v = await client.readTag('hr:300:float');
    expect(v).toBeCloseTo(3.14159, 4);
    // Big-endian: high word stored first
    const hi = mock.registers.get(300);
    const lo = mock.registers.get(301);
    const check = Buffer.alloc(4);
    check.writeUInt16BE(hi, 0);
    check.writeUInt16BE(lo, 2);
    expect(check.readFloatBE(0)).toBeCloseTo(3.14159, 4);
  });

  test('Modbus exception surfaces as a tag-level error (not connectionLost)', async () => {
    let err;
    try { await client.readTag('ir:5'); } catch (e) { err = e; }
    expect(err).toBeDefined();
    expect(err.message).toMatch(/Modbus exception 2/);
    expect(err.connectionLost).toBeUndefined();
  });

  test('address parsing rejects malformed addresses', () => {
    expect(() => modbus.parseAddress('xx:1')).toThrow(/Invalid Modbus address/);
    expect(() => modbus.parseAddress('hr:notanumber')).toThrow(/register/);
    expect(() => modbus.parseAddress('coil:1:float')).toThrow(/float/);
    expect(modbus.parseAddress('hr:100:float')).toEqual({ area: 'hr', addr: 100, dtype: 'float' });
  });

  test('testConnection reports ok + latency against the mock, failure when down', async () => {
    const ok = await modbus.testConnection({ host: '127.0.0.1', port: mock.port });
    expect(ok.ok).toBe(true);
    expect(typeof ok.latencyMs).toBe('number');

    const bad = await modbus.testConnection({ host: '127.0.0.1', port: 1, timeoutMs: 500 });
    expect(bad.ok).toBe(false);
    expect(bad.message).toBeTruthy();
  });

  test('validateConfig requires host', () => {
    expect(modbus.validateConfig({})).toEqual(expect.arrayContaining([expect.stringMatching(/host/)]));
    expect(modbus.validateConfig({ host: '10.0.0.1' })).toEqual([]);
  });

  test('validateConfig caps timeoutMs at 10000 (a slow PLC must not stall polling)', () => {
    expect(modbus.validateConfig({ host: '10.0.0.1', timeoutMs: 20000 })).toEqual(
      expect.arrayContaining([expect.stringMatching(/timeoutMs must be at most 10000/)])
    );
    expect(modbus.validateConfig({ host: '10.0.0.1', timeoutMs: 10000 })).toEqual([]);
  });

  test('validateConfig blocks loopback/link-local hosts unless PLC_ALLOW_LOCAL_HOSTS=true', () => {
    const prev = process.env.PLC_ALLOW_LOCAL_HOSTS;
    try {
      delete process.env.PLC_ALLOW_LOCAL_HOSTS;
      for (const host of ['localhost', '127.0.0.1', '127.9.9.9', '::1', '169.254.169.254']) {
        expect(modbus.validateConfig({ host })).toEqual(
          expect.arrayContaining([expect.stringMatching(/loopback or link-local/)])
        );
      }
      // Private plant LANs (RFC1918) stay allowed — PLCs legitimately live there.
      expect(modbus.validateConfig({ host: '192.168.0.10' })).toEqual([]);
      expect(modbus.validateConfig({ host: '10.0.0.1' })).toEqual([]);
      expect(modbus.validateConfig({ host: '172.16.5.5' })).toEqual([]);

      process.env.PLC_ALLOW_LOCAL_HOSTS = 'true';
      expect(modbus.validateConfig({ host: '127.0.0.1' })).toEqual([]);
      expect(modbus.validateConfig({ host: 'localhost' })).toEqual([]);
    } finally {
      if (prev === undefined) delete process.env.PLC_ALLOW_LOCAL_HOSTS;
      else process.env.PLC_ALLOW_LOCAL_HOSTS = prev;
    }
  });
});

// ── Registry / protocol listing ──────────────────────────────────────────────

describe('Protocol registry', () => {
  test('lists modbus_tcp + simulator as available and 3 honest stubs', () => {
    const protocols = listProtocols();
    const byKey = Object.fromEntries(protocols.map((p) => [p.protocol, p]));

    expect(byKey.modbus_tcp.status).toBe('available');
    expect(byKey.simulator.status).toBe('available');
    expect(byKey.simulator.label).toBe('Simulator (built-in virtual PLC)');

    const stubs = protocols.filter((p) => p.status === 'stub').map((p) => p.protocol).sort();
    expect(stubs).toEqual(['ethernet_ip', 'opcua', 's7']);

    for (const p of protocols) {
      expect(Array.isArray(p.configFields)).toBe(true);
      expect(typeof p.addressHint).toBe('string');
    }
  });

  test('stub createClient throws a clear error naming the optional package', () => {
    expect(() => getDriver('opcua').createClient({})).toThrow(
      /OPC UA driver requires the optional 'node-opcua' package — see backend\/src\/plc\/README\.md/
    );
    expect(() => getDriver('s7').createClient({})).toThrow(/nodes7/);
    expect(() => getDriver('ethernet_ip').createClient({})).toThrow(/ethernet-ip/);
  });

  test('getDriver returns null for unknown protocols', () => {
    expect(getDriver('nope')).toBeNull();
  });
});

// ── Connections API ──────────────────────────────────────────────────────────

describe('PLC connections API', () => {
  let agent;

  beforeAll(async () => {
    const eng = await createTestUser('plc.conn@test.example', 'PlcPass123!', 'engineer');
    agent = await loginAs(eng);
  });

  test('GET /protocols requires auth and returns the registry', async () => {
    const anon = await request(app).get('/api/v1/plc/protocols');
    expect(anon.status).toBe(401);

    const res = await agent.get('/api/v1/plc/protocols');
    expect(res.status).toBe(200);
    expect(res.body.map((p) => p.protocol)).toEqual(
      expect.arrayContaining(['modbus_tcp', 'simulator', 'opcua', 's7', 'ethernet_ip'])
    );
  });

  test('CRUD lifecycle + duplicate name conflict + test endpoint', async () => {
    const created = await agent.post('/api/v1/plc/connections')
      .send({ name: 'Sim PLC', protocol: 'simulator', config: {} });
    expect(created.status).toBe(201);
    const id = created.body.id;
    expect(created.body.status).toBe('unknown');
    expect(created.body.enabled).toBe(true);

    const dup = await agent.post('/api/v1/plc/connections')
      .send({ name: 'Sim PLC', protocol: 'simulator' });
    expect(dup.status).toBe(409);

    const list = await agent.get('/api/v1/plc/connections');
    expect(list.status).toBe(200);
    expect(list.body.some((c) => c.id === id)).toBe(true);

    const patched = await agent.patch(`/api/v1/plc/connections/${id}`)
      .send({ name: 'Sim PLC renamed', enabled: false });
    expect(patched.status).toBe(200);
    expect(patched.body.name).toBe('Sim PLC renamed');
    expect(patched.body.enabled).toBe(false);

    const tested = await agent.post(`/api/v1/plc/connections/${id}/test`).send({});
    expect(tested.status).toBe(200);
    expect(tested.body.ok).toBe(true);
    expect(typeof tested.body.latencyMs).toBe('number');

    const del = await agent.delete(`/api/v1/plc/connections/${id}`);
    expect(del.status).toBe(200);
    const after = await agent.get('/api/v1/plc/connections');
    expect(after.body.some((c) => c.id === id)).toBe(false);
  });

  test('rejects unknown protocols and invalid driver config', async () => {
    const bad = await agent.post('/api/v1/plc/connections')
      .send({ name: 'Nope', protocol: 'dnp3' });
    expect(bad.status).toBe(422);

    const noHost = await agent.post('/api/v1/plc/connections')
      .send({ name: 'Modbus no host', protocol: 'modbus_tcp', config: { port: 502 } });
    expect(noHost.status).toBe(422);
  });

  test('masks password config fields as ••• in responses', async () => {
    const created = await agent.post('/api/v1/plc/connections')
      .send({
        name: 'OPC UA server',
        protocol: 'opcua',
        config: { endpoint: 'opc.tcp://10.0.0.5:4840', username: 'svc', password: 'hunter2' },
      });
    expect(created.status).toBe(201);
    expect(created.body.config.password).toBe('•••');
    expect(created.body.config.endpoint).toBe('opc.tcp://10.0.0.5:4840');

    const list = await agent.get('/api/v1/plc/connections');
    const row = list.body.find((c) => c.id === created.body.id);
    expect(row.config.password).toBe('•••');

    // Sending the mask back on PATCH keeps the stored secret.
    const patched = await agent.patch(`/api/v1/plc/connections/${created.body.id}`)
      .send({ config: { endpoint: 'opc.tcp://10.0.0.5:4840', username: 'svc', password: '•••' } });
    expect(patched.status).toBe(200);
    const { query } = require('../db/pool');
    const stored = await query('SELECT config FROM plc_connections WHERE id = $1', [created.body.id]);
    expect(stored.rows[0].config.password).toBe('hunter2');
  });

  test('RBAC: operator gets 403 on POST, 200 on GET', async () => {
    const op = await createTestUser('plc.op@test.example', 'PlcPass123!', 'operator');
    const opAgent = await loginAs(op);

    const post = await opAgent.post('/api/v1/plc/connections')
      .send({ name: 'Op PLC', protocol: 'simulator' });
    expect(post.status).toBe(403);

    const get = await opAgent.get('/api/v1/plc/connections');
    expect(get.status).toBe(200);
  });

  test('org isolation: org B cannot see, patch or delete org A connections', async () => {
    const created = await agent.post('/api/v1/plc/connections')
      .send({ name: 'Org A private PLC', protocol: 'simulator' });
    expect(created.status).toBe(201);
    const idA = created.body.id;

    const engB = await createTestUser('plc.orgb@test.example', 'PlcPass123!', 'engineer');
    const agentB = await loginAs(engB);

    const listB = await agentB.get('/api/v1/plc/connections');
    expect(listB.status).toBe(200);
    expect(listB.body.some((c) => c.id === idA)).toBe(false);

    expect((await agentB.patch(`/api/v1/plc/connections/${idA}`).send({ name: 'stolen' })).status).toBe(404);
    expect((await agentB.delete(`/api/v1/plc/connections/${idA}`)).status).toBe(404);
    expect((await agentB.post(`/api/v1/plc/connections/${idA}/test`).send({})).status).toBe(404);
  });
});

// ── Bindings API + values + write + poller ───────────────────────────────────

describe('PLC bindings API', () => {
  let agent, project, flowsheet, connection;

  const base = () => `/api/v1/projects/${project.id}/flowsheets/${flowsheet.id}`;

  beforeAll(async () => {
    const eng = await createTestUser('plc.bind@test.example', 'PlcPass123!', 'engineer');
    agent = await loginAs(eng);
    project = await makeProject(agent, 'PLC Binding Project');
    flowsheet = await makeFlowsheet(agent, project.id, 'PLC Flowsheet');
    const res = await agent.post('/api/v1/plc/connections')
      .send({ name: 'Bind Sim', protocol: 'simulator', config: {} });
    expect(res.status).toBe(201);
    connection = res.body;
  });

  test('POST creates a binding; repeat POST upserts on (node, param)', async () => {
    const first = await agent.post(`${base()}/plc-bindings`).send({
      nodeId: 'node-1', paramKey: 'flowRate', connectionId: connection.id,
      address: 'const:5', direction: 'read', scale: 2, offset: 1,
    });
    expect(first.status).toBe(201);
    expect(first.body.offset_val).toBe(1);
    expect(first.body.scale).toBe(2);
    expect(first.body.quality).toBe('unknown');

    const upsert = await agent.post(`${base()}/plc-bindings`).send({
      nodeId: 'node-1', paramKey: 'flowRate', connectionId: connection.id,
      address: 'const:7', direction: 'read', scale: 3, offset: 0,
    });
    expect(upsert.status).toBe(201);
    expect(upsert.body.id).toBe(first.body.id); // same row, updated

    const list = await agent.get(`${base()}/plc-bindings`);
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(1);
    expect(list.body[0].address).toBe('const:7');
    expect(list.body[0].connection_name).toBe('Bind Sim');
    expect(list.body[0].connection_protocol).toBe('simulator');
  });

  test('rejects addresses the driver cannot parse', async () => {
    const res = await agent.post(`${base()}/plc-bindings`).send({
      nodeId: 'node-1', paramKey: 'badAddr', connectionId: connection.id, address: 'bogus:1',
    });
    expect(res.status).toBe(422);
  });

  test('rejects connections from another org', async () => {
    const engB = await createTestUser('plc.bindb@test.example', 'PlcPass123!', 'engineer');
    const agentB = await loginAs(engB);
    const connB = await agentB.post('/api/v1/plc/connections')
      .send({ name: 'Org B sim', protocol: 'simulator' });
    expect(connB.status).toBe(201);

    const res = await agent.post(`${base()}/plc-bindings`).send({
      nodeId: 'node-2', paramKey: 'level', connectionId: connB.body.id, address: 'const:1',
    });
    expect(res.status).toBe(404);
  });

  test('GET /plc-values returns the latest columns', async () => {
    const res = await agent.get(`${base()}/plc-values`);
    expect(res.status).toBe(200);
    const row = res.body.find((v) => v.nodeId === 'node-1' && v.paramKey === 'flowRate');
    expect(row).toBeDefined();
    expect(row).toHaveProperty('bindingId');
    expect(row).toHaveProperty('value');
    expect(row).toHaveProperty('quality');
    expect(row).toHaveProperty('lastReadAt');
  });

  test('poller tick reads via the driver, scales, persists and reports good quality', async () => {
    // binding is address const:7, scale 3, offset 0 → value 21
    await poller.tick();
    const res = await agent.get(`${base()}/plc-values`);
    const row = res.body.find((v) => v.nodeId === 'node-1' && v.paramKey === 'flowRate');
    expect(row.quality).toBe('good');
    expect(row.value).toBe(21);
    expect(row.lastReadAt).toBeTruthy();

    // connection was marked online with last_seen
    const conns = await agent.get('/api/v1/plc/connections');
    const c = conns.body.find((x) => x.id === connection.id);
    expect(c.status).toBe('online');
    expect(c.last_seen).toBeTruthy();
    await poller.stopPoller(); // drop cached clients so jest exits cleanly
  });

  test('PATCH updates a binding; write endpoint applies inverse scaling', async () => {
    const list = await agent.get(`${base()}/plc-bindings`);
    const binding = list.body[0];

    const patched = await agent.patch(`${base()}/plc-bindings/${binding.id}`).send({
      address: 'mem:pump1', direction: 'read_write', scale: 2, offset: 1,
    });
    expect(patched.status).toBe(200);
    expect(patched.body.direction).toBe('read_write');

    // value 11 → raw (11-1)/2 = 5 written to the simulator memory
    const write = await agent.post(`${base()}/plc-bindings/${binding.id}/write`).send({ value: 11 });
    expect(write.status).toBe(200);
    expect(write.body.ok).toBe(true);
    expect(write.body.rawValue).toBe(5);

    // Read back through a client with the SAME connection context — simulator
    // memory is namespaced per connection.
    const sim = simulator.createClient({}, { connectionId: connection.id });
    await sim.connect();
    expect(await sim.readTag('mem:pump1')).toBe(5);

    const values = await agent.get(`${base()}/plc-values`);
    const row = values.body.find((v) => v.bindingId === binding.id);
    expect(row.value).toBe(11);
    expect(row.quality).toBe('good');
  });

  test('write refuses read-only bindings', async () => {
    const created = await agent.post(`${base()}/plc-bindings`).send({
      nodeId: 'node-3', paramKey: 'doSetpoint', connectionId: connection.id,
      address: 'mem:ro', direction: 'read',
    });
    expect(created.status).toBe(201);
    const res = await agent.post(`${base()}/plc-bindings/${created.body.id}/write`).send({ value: 1 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/read-only/);
  });

  test('RBAC: operator (other org) cannot create bindings; viewer path denied on write role gate', async () => {
    const op = await createTestUser('plc.bindop@test.example', 'PlcPass123!', 'operator');
    const opAgent = await loginAs(op);
    const res = await opAgent.post(`${base()}/plc-bindings`).send({
      nodeId: 'x', paramKey: 'y', connectionId: connection.id, address: 'const:1',
    });
    expect(res.status).toBe(403); // requireRole(engineer) fails before org lookup
  });

  test('org isolation: org B cannot list or delete org A bindings', async () => {
    const engB = await createTestUser('plc.bindiso@test.example', 'PlcPass123!', 'engineer');
    const agentB = await loginAs(engB);

    const listB = await agentB.get(`${base()}/plc-bindings`);
    expect(listB.status).toBe(404); // flowsheet not in org B

    const list = await agent.get(`${base()}/plc-bindings`);
    const target = list.body[0];
    const delB = await agentB.delete(`${base()}/plc-bindings/${target.id}`);
    expect(delB.status).toBe(404);
  });

  test('DELETE removes a binding; deleting the connection cascades the rest', async () => {
    const list = await agent.get(`${base()}/plc-bindings`);
    expect(list.body.length).toBeGreaterThan(0);
    const del = await agent.delete(`${base()}/plc-bindings/${list.body[0].id}`);
    expect(del.status).toBe(200);

    const delConn = await agent.delete(`/api/v1/plc/connections/${connection.id}`);
    expect(delConn.status).toBe(200);
    const after = await agent.get(`${base()}/plc-bindings`);
    expect(after.status).toBe(200);
    expect(after.body).toHaveLength(0);
  });
});

// ── Poller regressions: retained values, finiteness, cross-connection isolation ──

describe('Poller regressions', () => {
  let agent, project, flowsheet;

  const base = () => `/api/v1/projects/${project.id}/flowsheets/${flowsheet.id}`;

  /** Values the poller broadcast for one binding since the last mockClear(). */
  const pushedFor = (bindingId) => broadcastToRoom.mock.calls
    .filter(([room]) => room === flowsheet.id)
    .flatMap(([, msg]) => msg?.payload?.values || [])
    .filter((v) => v.bindingId === bindingId);

  const restValue = async (bindingId) => {
    const res = await agent.get(`${base()}/plc-values`);
    return res.body.find((v) => v.bindingId === bindingId);
  };

  const makeConnection = async (name, protocol, config = {}) => {
    const res = await agent.post('/api/v1/plc/connections').send({ name, protocol, config });
    expect(res.status).toBe(201);
    return res.body;
  };

  const makeBinding = async (payload) => {
    const res = await agent.post(`${base()}/plc-bindings`).send(payload);
    expect(res.status).toBe(201);
    return res.body;
  };

  beforeAll(async () => {
    const eng = await createTestUser('plc.poller@test.example', 'PlcPass123!', 'engineer');
    agent = await loginAs(eng);
    project = await makeProject(agent, 'PLC Poller Project');
    flowsheet = await makeFlowsheet(agent, project.id, 'PLC Poller Flowsheet');
  });

  afterAll(async () => { await poller.stopPoller(); });

  test('two connections with the same mem:x address never see each other\'s writes', async () => {
    const c1 = await makeConnection('Iso Sim 1', 'simulator');
    const c2 = await makeConnection('Iso Sim 2', 'simulator');
    const b1 = await makeBinding({
      nodeId: 'iso-1', paramKey: 'p', connectionId: c1.id, address: 'mem:x', direction: 'read_write',
    });
    const b2 = await makeBinding({
      nodeId: 'iso-2', paramKey: 'p', connectionId: c2.id, address: 'mem:x', direction: 'read',
    });

    // Write 5 through connection 1's binding…
    const write = await agent.post(`${base()}/plc-bindings/${b1.id}/write`).send({ value: 5 });
    expect(write.status).toBe(200);

    // …poll, and connection 2's mem:x must still read 0.
    await poller.tick();
    expect(await restValue(b1.id)).toMatchObject({ value: 5 });
    expect(await restValue(b2.id)).toMatchObject({ value: 0, quality: 'good' });
  });

  test('connection-down: stale broadcast carries the retained last_value (matches REST)', async () => {
    // Port 1 on loopback refuses instantly; PLC_ALLOW_LOCAL_HOSTS is set for the file.
    const conn = await makeConnection('Dead Modbus', 'modbus_tcp',
      { host: '127.0.0.1', port: 1, timeoutMs: 500 });
    const b = await makeBinding({
      nodeId: 'stale-1', paramKey: 'p', connectionId: conn.id, address: 'hr:1', direction: 'read',
    });
    // Simulate a previous good read whose value must be retained.
    await query(`UPDATE plc_bindings SET last_value = 42, quality = 'good' WHERE id = $1`, [b.id]);

    broadcastToRoom.mockClear();
    await poller.tick();

    const pushed = pushedFor(b.id);
    expect(pushed.length).toBeGreaterThan(0);
    expect(pushed[0]).toMatchObject({ value: 42, quality: 'stale' }); // NOT value: null

    expect(await restValue(b.id)).toMatchObject({ value: 42, quality: 'stale' });

    // Stop dialing the dead endpoint in later tests' ticks.
    await agent.patch(`/api/v1/plc/connections/${conn.id}`).send({ enabled: false });
  });

  test('tag-level failure: bad broadcast carries the retained last_value (matches REST)', async () => {
    const mock = await startMockModbusServer();
    mock.registers.set(100, 50);
    try {
      const conn = await makeConnection('Mock Modbus', 'modbus_tcp',
        { host: '127.0.0.1', port: mock.port, timeoutMs: 2000 });
      const b = await makeBinding({
        nodeId: 'bad-1', paramKey: 'p', connectionId: conn.id, address: 'hr:100', direction: 'read',
      });

      await poller.tick(); // good read → last_value 50
      expect(await restValue(b.id)).toMatchObject({ value: 50, quality: 'good' });

      // Repoint at an address the device rejects (mock answers FC4 with a
      // Modbus exception → tag-level error, connection stays up).
      const patched = await agent.patch(`${base()}/plc-bindings/${b.id}`).send({ address: 'ir:5' });
      expect(patched.status).toBe(200);
      await query(`UPDATE plc_bindings SET last_read_at = NOW() - INTERVAL '1 hour' WHERE id = $1`, [b.id]);

      broadcastToRoom.mockClear();
      await poller.tick();

      const pushed = pushedFor(b.id);
      expect(pushed.length).toBeGreaterThan(0);
      expect(pushed[0]).toMatchObject({ value: 50, quality: 'bad' }); // retained value, NOT null

      expect(await restValue(b.id)).toMatchObject({ value: 50, quality: 'bad' });

      await agent.patch(`/api/v1/plc/connections/${conn.id}`).send({ enabled: false });
    } finally {
      // Drop the poller's cached client first so the mock server can close.
      await poller.stopPoller();
      await new Promise((r) => mock.server.close(r));
    }
  });

  test('non-finite scaled values are bad quality — never stored or broadcast as good', async () => {
    const conn = await makeConnection('Inf Sim', 'simulator');
    const b = await makeBinding({
      nodeId: 'inf-1', paramKey: 'p', connectionId: conn.id, address: 'const:5', direction: 'read',
    });

    await poller.tick(); // good read → last_value 5
    expect(await restValue(b.id)).toMatchObject({ value: 5, quality: 'good' });

    // raw 1e308 * scale 10 = Infinity → must be treated as a bad read.
    const patched = await agent.patch(`${base()}/plc-bindings/${b.id}`)
      .send({ address: 'const:1e308', scale: 10 });
    expect(patched.status).toBe(200);
    await query(`UPDATE plc_bindings SET last_read_at = NOW() - INTERVAL '1 hour' WHERE id = $1`, [b.id]);

    broadcastToRoom.mockClear();
    await poller.tick();

    const pushed = pushedFor(b.id);
    expect(pushed.length).toBeGreaterThan(0);
    expect(pushed[0]).toMatchObject({ value: 5, quality: 'bad' }); // retained finite value

    expect(await restValue(b.id)).toMatchObject({ value: 5, quality: 'bad' }); // last_value untouched
  });
});
