/**
 * Device gateway — reads a live value for a parameter binding.
 *
 * Each protocol driver returns a RAW numeric value; readBinding() applies
 * scaling (raw * factor + offset). Optional third-party libraries are lazily
 * required so a missing package degrades to a clear "driver not installed"
 * error instead of crashing the server. HTTP and generic-TCP use Node
 * built-ins and always work.
 */
'use strict';

function opt(name) { try { return require(name); } catch { return null; } }

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label || 'operation'} timed out after ${ms}ms`)), ms)),
  ]);
}

// tiny $.a.b[0] resolver
function jget(obj, path) {
  if (!path) return obj;
  const parts = String(path).replace(/^\$\.?/, '').split(/[.[\]]/).filter(Boolean);
  let cur = obj;
  for (const p of parts) cur = cur == null ? undefined : cur[p];
  return cur;
}

// ── Modbus register decoding ────────────────────────────────────────────────
function wordCount(dtype) { return ['INT32', 'UINT32', 'FLOAT32'].includes(dtype) ? 2 : 1; }
function decodeRegs(regs, dtype, wordOrder) {
  if (dtype === 'BOOL') return regs[0] ? 1 : 0;
  let buf = Buffer.alloc(regs.length * 2);
  regs.forEach((r, i) => buf.writeUInt16BE(r & 0xffff, i * 2));
  if (regs.length >= 2) {
    if (wordOrder === 'Word-swapped') buf = Buffer.from([buf[2], buf[3], buf[0], buf[1]]);
    else if (wordOrder === 'Little-endian') buf = Buffer.from([buf[3], buf[2], buf[1], buf[0]]);
  }
  switch (dtype) {
    case 'INT16':   return buf.readInt16BE(0);
    case 'UINT16':  return buf.readUInt16BE(0);
    case 'INT32':   return buf.readInt32BE(0);
    case 'UINT32':  return buf.readUInt32BE(0);
    case 'FLOAT32': return buf.readFloatBE(0);
    default:        return buf.readUInt16BE(0);
  }
}

// ── Drivers: async (config) => rawNumber ────────────────────────────────────
const drivers = {
  http_rest: (c) => new Promise((resolve, reject) => {
    if (!c.url) return reject(new Error('URL is required'));
    const lib = c.url.startsWith('https') ? require('https') : require('http');
    const req = lib.request(c.url, { method: c.method || 'GET' }, (res) => {
      let d = ''; res.on('data', (x) => (d += x));
      res.on('end', () => {
        try {
          const v = c.jsonPath ? jget(JSON.parse(d), c.jsonPath) : parseFloat(d);
          const n = Number(v);
          if (Number.isNaN(n)) return reject(new Error('response did not yield a number'));
          resolve(n);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(5000, () => { req.destroy(); reject(new Error('HTTP timed out')); });
    req.end();
  }),

  generic_tcp: (c) => new Promise((resolve, reject) => {
    const net = require('net');
    const sock = net.connect({ host: c.host, port: Number(c.port) || 0 });
    let buf = '';
    sock.setTimeout(5000);
    sock.on('connect', () => { if (c.query) sock.write(String(c.query).replace(/\\n/g, '\n').replace(/\\r/g, '\r')); });
    sock.on('data', (d) => {
      buf += d.toString();
      if (/[\r\n]/.test(buf) || buf.length > 256) {
        try {
          const v = c.parse === 'JSON path' ? jget(JSON.parse(buf), c.jsonPath) : parseFloat(buf);
          const n = Number(v);
          sock.destroy();
          if (Number.isNaN(n)) return reject(new Error('could not parse a number'));
          resolve(n);
        } catch (e) { sock.destroy(); reject(e); }
      }
    });
    sock.on('timeout', () => { sock.destroy(); reject(new Error('TCP timed out')); });
    sock.on('error', reject);
  }),

  modbus_tcp: async (c) => {
    const ModbusRTU = opt('modbus-serial');
    if (!ModbusRTU) throw new Error('Driver not installed — run: npm i modbus-serial');
    const client = new ModbusRTU();
    await withTimeout(client.connectTCP(c.host, { port: Number(c.port) || 502 }), 5000, 'connect');
    client.setID(Number(c.unitId) || 1); client.setTimeout(3000);
    try { return await readModbus(client, c); }
    finally { try { client.close(() => {}); } catch { /* ignore */ } }
  },

  modbus_rtu: async (c) => {
    const ModbusRTU = opt('modbus-serial');
    if (!ModbusRTU) throw new Error('Driver not installed — run: npm i modbus-serial');
    const client = new ModbusRTU();
    await withTimeout(client.connectRTUBuffered(c.serialPort, {
      baudRate: Number(c.baud) || 9600, parity: c.parity || 'none',
    }), 5000, 'connect');
    client.setID(Number(c.unitId) || 1); client.setTimeout(3000);
    try { return await readModbus(client, c); }
    finally { try { client.close(() => {}); } catch { /* ignore */ } }
  },

  siemens_s7: (c) => new Promise((resolve, reject) => {
    const snap7 = opt('node-snap7');
    if (!snap7) return reject(new Error('Driver not installed — run: npm i node-snap7'));
    const client = new snap7.S7Client();
    const size = { REAL: 4, DINT: 4, INT: 2, WORD: 2, BOOL: 1 }[c.dtype] || 4;
    client.ConnectTo(c.host, Number(c.rack) || 0, Number(c.slot) || 1, (err) => {
      if (err) return reject(new Error('S7 connect failed: ' + client.ErrorText(err)));
      const done = (err2, buf) => {
        try { client.Disconnect(); } catch { /* ignore */ }
        if (err2) return reject(new Error('S7 read failed: ' + client.ErrorText(err2)));
        resolve(decodeS7(buf, c));
      };
      const area = (c.area || 'DB')[0];
      if (area === 'D') client.DBRead(Number(c.db) || 1, Number(c.byte) || 0, size, done);
      else {
        const areaId = area === 'M' ? snap7.S7AreaMK : area === 'I' ? snap7.S7AreaPE : snap7.S7AreaPA;
        client.ReadArea(areaId, 0, Number(c.byte) || 0, size, snap7.S7WLByte, done);
      }
    });
  }),

  opc_ua: async (c) => {
    const O = opt('node-opcua');
    if (!O) throw new Error('Driver not installed — run: npm i node-opcua');
    const client = O.OPCUAClient.create({ endpointMustExist: false, connectionStrategy: { maxRetry: 1 } });
    await withTimeout(client.connect(c.endpoint), 6000, 'OPC UA connect');
    let session;
    try {
      session = await client.createSession();
      const dv = await session.read({ nodeId: c.nodeId, attributeId: O.AttributeIds.Value });
      const v = Number(dv.value.value);
      if (Number.isNaN(v)) throw new Error('value is not numeric');
      return v;
    } finally {
      try { if (session) await session.close(); } catch { /* ignore */ }
      try { await client.disconnect(); } catch { /* ignore */ }
    }
  },

  ethernet_ip: async (c) => {
    const EIP = opt('ethernet-ip');
    if (!EIP) throw new Error('Driver not installed — run: npm i ethernet-ip');
    const { Controller, Tag } = EIP;
    const plc = new Controller();
    await withTimeout(plc.connect(c.host, 0), 6000, 'EtherNet/IP connect');
    try {
      const tag = new Tag(c.tag);
      await plc.readTag(tag);
      return Number(tag.value);
    } finally { try { plc.destroy(); } catch { /* ignore */ } }
  },

  mqtt: (c) => new Promise((resolve, reject) => {
    const mqtt = opt('mqtt');
    if (!mqtt) return reject(new Error('Driver not installed — run: npm i mqtt'));
    const client = mqtt.connect(c.broker, { connectTimeout: 5000, reconnectPeriod: 0 });
    const finish = (fn, arg) => { try { client.end(true); } catch { /* ignore */ } fn(arg); };
    const timer = setTimeout(() => finish(reject, new Error('no message within 6s')), 6000);
    client.on('connect', () => client.subscribe(c.topic, (e) => { if (e) { clearTimeout(timer); finish(reject, e); } }));
    client.on('message', (_t, payload) => {
      clearTimeout(timer);
      try {
        const s = payload.toString();
        const v = c.jsonPath ? jget(JSON.parse(s), c.jsonPath) : parseFloat(s);
        const n = Number(v);
        if (Number.isNaN(n)) return finish(reject, new Error('payload not numeric'));
        finish(resolve, n);
      } catch (e) { finish(reject, e); }
    });
    client.on('error', (e) => { clearTimeout(timer); finish(reject, e); });
  }),

  serial_embedded: (c) => new Promise((resolve, reject) => {
    const sp = opt('serialport');
    if (!sp) return reject(new Error('Driver not installed — run: npm i serialport'));
    const SerialPort = sp.SerialPort || sp;
    const port = new SerialPort({ path: c.serialPort, baudRate: Number(c.baud) || 115200 }, (e) => { if (e) reject(e); });
    let buf = '';
    const timer = setTimeout(() => { try { port.close(); } catch { /* ignore */ } reject(new Error('no serial line within 6s')); }, 6000);
    port.on('data', (d) => {
      buf += d.toString();
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      const line = buf.slice(0, nl).trim();
      clearTimeout(timer); try { port.close(); } catch { /* ignore */ }
      try {
        let v;
        if (c.format === 'JSON key') v = JSON.parse(line)[c.key];
        else if (c.format === 'CSV field') v = line.split(',')[Number(c.key) || 0];
        else v = parseFloat(line);
        const n = Number(v);
        if (Number.isNaN(n)) return reject(new Error('line not numeric'));
        resolve(n);
      } catch (e) { reject(e); }
    });
    port.on('error', reject);
  }),

  bacnet: (c) => new Promise((resolve, reject) => {
    const bac = opt('node-bacnet') || opt('bacstack');
    if (!bac) return reject(new Error('Driver not installed — run: npm i node-bacnet'));
    const Client = bac.default || bac;
    const client = new Client({ apduTimeout: 6000 });
    const typeMap = { 'analog-input': 0, 'analog-value': 2, 'binary-input': 3, 'binary-value': 5 };
    client.readProperty(c.host, { type: typeMap[c.objectType] ?? 0, instance: Number(c.instance) || 0 }, 85, (err, value) => {
      try { client.close(); } catch { /* ignore */ }
      if (err) return reject(new Error('BACnet read failed: ' + err.message));
      const v = Number(value?.values?.[0]?.value);
      if (Number.isNaN(v)) return reject(new Error('value not numeric'));
      resolve(v);
    });
  }),
};

async function readModbus(client, c) {
  const addr = Number(c.address) || 0;
  const rt = c.regType || '';
  if (rt.startsWith('Coil'))     return (await client.readCoils(addr, 1)).data[0] ? 1 : 0;
  if (rt.startsWith('Discrete')) return (await client.readDiscreteInputs(addr, 1)).data[0] ? 1 : 0;
  const n = wordCount(c.dtype);
  const regs = rt.startsWith('Input')
    ? (await client.readInputRegisters(addr, n)).data
    : (await client.readHoldingRegisters(addr, n)).data;
  return decodeRegs(regs, c.dtype, c.wordOrder);
}

function decodeS7(buf, c) {
  switch (c.dtype) {
    case 'REAL': return buf.readFloatBE(0);
    case 'DINT': return buf.readInt32BE(0);
    case 'INT':  return buf.readInt16BE(0);
    case 'WORD': return buf.readUInt16BE(0);
    case 'BOOL': return (buf[0] >> (Number(c.bit) || 0)) & 1;
    default:     return buf.readFloatBE(0);
  }
}

function applyScale(raw, scale) {
  const f = scale?.factor ?? 1;
  const o = scale?.offset ?? 0;
  return Number(raw) * Number(f) + Number(o);
}
// engineering value → raw value to send to the device
function unScale(value, scale) {
  const f = scale?.factor ?? 1;
  const o = scale?.offset ?? 0;
  return (Number(value) - Number(o)) / (Number(f) || 1);
}

function encodeRegs(raw, dtype, wordOrder) {
  if (dtype === 'BOOL') return [raw ? 1 : 0];
  let buf;
  if (['INT32', 'UINT32', 'FLOAT32'].includes(dtype)) {
    buf = Buffer.alloc(4);
    if (dtype === 'FLOAT32') buf.writeFloatBE(Number(raw), 0);
    else if (dtype === 'INT32') buf.writeInt32BE(raw | 0, 0);
    else buf.writeUInt32BE(raw >>> 0, 0);
    if (wordOrder === 'Word-swapped') buf = Buffer.from([buf[2], buf[3], buf[0], buf[1]]);
    else if (wordOrder === 'Little-endian') buf = Buffer.from([buf[3], buf[2], buf[1], buf[0]]);
  } else {
    buf = Buffer.alloc(2);
    if (dtype === 'INT16') buf.writeInt16BE(raw | 0, 0);
    else buf.writeUInt16BE((raw | 0) & 0xffff, 0);
  }
  const regs = [];
  for (let i = 0; i < buf.length; i += 2) regs.push(buf.readUInt16BE(i));
  return regs;
}

async function writeModbus(client, c, raw) {
  const addr = Number(c.address) || 0;
  const rt = c.regType || '';
  if (rt.startsWith('Coil')) return client.writeCoil(addr, !!raw);
  if (rt.startsWith('Input') || rt.startsWith('Discrete')) throw new Error(`${rt} is read-only`);
  const regs = encodeRegs(raw, c.dtype, c.wordOrder);
  return regs.length === 1 ? client.writeRegister(addr, regs[0]) : client.writeRegisters(addr, regs);
}

// ── Write drivers: async (config, rawValue) => void ─────────────────────────
const writeDrivers = {
  http_rest: (c, raw) => new Promise((resolve, reject) => {
    if (!c.url) return reject(new Error('URL is required'));
    const lib = c.url.startsWith('https') ? require('https') : require('http');
    const body = c.jsonPath ? JSON.stringify({ value: raw }) : String(raw);
    const req = lib.request(c.url, {
      method: c.method && c.method !== 'GET' ? c.method : 'POST',
      headers: { 'Content-Type': c.jsonPath ? 'application/json' : 'text/plain', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => { res.on('data', () => {}); res.on('end', () => resolve()); });
    req.on('error', reject);
    req.setTimeout(5000, () => { req.destroy(); reject(new Error('HTTP write timed out')); });
    req.write(body); req.end();
  }),

  generic_tcp: (c, raw) => new Promise((resolve, reject) => {
    const net = require('net');
    const sock = net.connect({ host: c.host, port: Number(c.port) || 0 });
    sock.setTimeout(5000);
    sock.on('connect', () => { sock.write(String(raw) + '\n'); sock.end(); resolve(); });
    sock.on('timeout', () => { sock.destroy(); reject(new Error('TCP write timed out')); });
    sock.on('error', reject);
  }),

  modbus_tcp: async (c, raw) => {
    const ModbusRTU = opt('modbus-serial');
    if (!ModbusRTU) throw new Error('Driver not installed — run: npm i modbus-serial');
    const client = new ModbusRTU();
    await withTimeout(client.connectTCP(c.host, { port: Number(c.port) || 502 }), 5000, 'connect');
    client.setID(Number(c.unitId) || 1); client.setTimeout(3000);
    try { await writeModbus(client, c, raw); }
    finally { try { client.close(() => {}); } catch { /* ignore */ } }
  },

  modbus_rtu: async (c, raw) => {
    const ModbusRTU = opt('modbus-serial');
    if (!ModbusRTU) throw new Error('Driver not installed — run: npm i modbus-serial');
    const client = new ModbusRTU();
    await withTimeout(client.connectRTUBuffered(c.serialPort, { baudRate: Number(c.baud) || 9600, parity: c.parity || 'none' }), 5000, 'connect');
    client.setID(Number(c.unitId) || 1); client.setTimeout(3000);
    try { await writeModbus(client, c, raw); }
    finally { try { client.close(() => {}); } catch { /* ignore */ } }
  },

  opc_ua: async (c, raw) => {
    const O = opt('node-opcua');
    if (!O) throw new Error('Driver not installed — run: npm i node-opcua');
    const client = O.OPCUAClient.create({ endpointMustExist: false, connectionStrategy: { maxRetry: 1 } });
    await withTimeout(client.connect(c.endpoint), 6000, 'OPC UA connect');
    let session;
    try {
      session = await client.createSession();
      await session.write({
        nodeId: c.nodeId, attributeId: O.AttributeIds.Value,
        value: { value: { dataType: O.DataType.Double, value: Number(raw) } },
      });
    } finally {
      try { if (session) await session.close(); } catch { /* ignore */ }
      try { await client.disconnect(); } catch { /* ignore */ }
    }
  },

  mqtt: (c, raw) => new Promise((resolve, reject) => {
    const mqtt = opt('mqtt');
    if (!mqtt) return reject(new Error('Driver not installed — run: npm i mqtt'));
    const client = mqtt.connect(c.broker, { connectTimeout: 5000, reconnectPeriod: 0 });
    const timer = setTimeout(() => { try { client.end(true); } catch { /* ignore */ } reject(new Error('MQTT connect timeout')); }, 6000);
    client.on('connect', () => {
      const payload = c.jsonPath ? JSON.stringify({ value: raw }) : String(raw);
      client.publish(c.topic, payload, { qos: Number(c.qos) || 0 }, (e) => {
        clearTimeout(timer); try { client.end(true); } catch { /* ignore */ }
        e ? reject(e) : resolve();
      });
    });
    client.on('error', (e) => { clearTimeout(timer); reject(e); });
  }),

  siemens_s7: (c, raw) => new Promise((resolve, reject) => {
    const snap7 = opt('node-snap7');
    if (!snap7) return reject(new Error('Driver not installed — run: npm i node-snap7'));
    const client = new snap7.S7Client();
    const buf = Buffer.alloc({ REAL: 4, DINT: 4, INT: 2, WORD: 2, BOOL: 1 }[c.dtype] || 4);
    if (c.dtype === 'REAL') buf.writeFloatBE(Number(raw), 0);
    else if (c.dtype === 'DINT') buf.writeInt32BE(raw | 0, 0);
    else if (c.dtype === 'INT') buf.writeInt16BE(raw | 0, 0);
    else if (c.dtype === 'BOOL') buf[0] = raw ? (1 << (Number(c.bit) || 0)) : 0;
    else buf.writeUInt16BE((raw | 0) & 0xffff, 0);
    client.ConnectTo(c.host, Number(c.rack) || 0, Number(c.slot) || 1, (err) => {
      if (err) return reject(new Error('S7 connect failed: ' + client.ErrorText(err)));
      const done = (e2) => { try { client.Disconnect(); } catch { /* ignore */ } e2 ? reject(new Error('S7 write failed: ' + client.ErrorText(e2))) : resolve(); };
      const area = (c.area || 'DB')[0];
      if (area === 'D') client.DBWrite(Number(c.db) || 1, Number(c.byte) || 0, buf.length, buf, done);
      else {
        const areaId = area === 'M' ? snap7.S7AreaMK : area === 'I' ? snap7.S7AreaPE : snap7.S7AreaPA;
        client.WriteArea(areaId, 0, Number(c.byte) || 0, buf.length, snap7.S7WLByte, buf, done);
      }
    });
  }),

  ethernet_ip: async (c, raw) => {
    const EIP = opt('ethernet-ip');
    if (!EIP) throw new Error('Driver not installed — run: npm i ethernet-ip');
    const { Controller, Tag } = EIP;
    const plc = new Controller();
    await withTimeout(plc.connect(c.host, 0), 6000, 'EtherNet/IP connect');
    try { const tag = new Tag(c.tag); tag.value = Number(raw); await plc.writeTag(tag); }
    finally { try { plc.destroy(); } catch { /* ignore */ } }
  },

  serial_embedded: (c, raw) => new Promise((resolve, reject) => {
    const sp = opt('serialport');
    if (!sp) return reject(new Error('Driver not installed — run: npm i serialport'));
    const SerialPort = sp.SerialPort || sp;
    const port = new SerialPort({ path: c.serialPort, baudRate: Number(c.baud) || 115200 }, (e) => { if (e) reject(e); });
    port.write(String(raw) + '\n', (e) => {
      try { port.close(); } catch { /* ignore */ }
      e ? reject(e) : resolve();
    });
  }),

  bacnet: (c, raw) => new Promise((resolve, reject) => {
    const bac = opt('node-bacnet') || opt('bacstack');
    if (!bac) return reject(new Error('Driver not installed — run: npm i node-bacnet'));
    const Client = bac.default || bac;
    const client = new Client({ apduTimeout: 6000 });
    const typeMap = { 'analog-input': 0, 'analog-value': 2, 'binary-input': 3, 'binary-value': 5 };
    client.writeProperty(c.host, { type: typeMap[c.objectType] ?? 2, instance: Number(c.instance) || 0 }, 85,
      [{ type: 4, value: Number(raw) }], (err) => {
        try { client.close(); } catch { /* ignore */ }
        err ? reject(new Error('BACnet write failed: ' + err.message)) : resolve();
      });
  }),
};

async function readBinding(binding) {
  const driver = drivers[binding.protocol];
  if (!driver) throw new Error(`Unknown protocol: ${binding.protocol}`);
  const raw = await withTimeout(driver(binding.config || {}), 8000, binding.protocol);
  return { raw, value: applyScale(raw, binding.scale) };
}

async function writeBinding(binding, value) {
  const driver = writeDrivers[binding.protocol];
  if (!driver) throw new Error(`Write not supported for: ${binding.protocol}`);
  const raw = unScale(value, binding.scale);
  await withTimeout(driver(binding.config || {}, raw), 8000, binding.protocol);
  return { wrote: Number(value), raw };
}

// Which optional drivers have their package installed.
function driverStatus() {
  const pkgs = {
    http_rest: true, generic_tcp: true,
    opc_ua: !!opt('node-opcua'),
    modbus_tcp: !!opt('modbus-serial'), modbus_rtu: !!opt('modbus-serial'),
    siemens_s7: !!opt('node-snap7'),
    ethernet_ip: !!opt('ethernet-ip'),
    mqtt: !!opt('mqtt'),
    serial_embedded: !!opt('serialport'),
    bacnet: !!(opt('node-bacnet') || opt('bacstack')),
  };
  return pkgs;
}

module.exports = { drivers, writeDrivers, readBinding, writeBinding, applyScale, driverStatus };
