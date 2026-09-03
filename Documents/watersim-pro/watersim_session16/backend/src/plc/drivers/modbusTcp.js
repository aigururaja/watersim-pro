/**
 * WaterSim Pro — Modbus TCP driver (dependency-free)
 *
 * A minimal, fully working Modbus TCP client over net.Socket. MBAP framing,
 * with the function codes WaterSim needs:
 *   FC1  read coils            FC3  read holding registers
 *   FC4  read input registers  FC5  write single coil
 *   FC6  write single register FC16 write multiple registers
 *
 * Address syntax (see descriptor.addressHint):
 *   hr:100        holding register 100, uint16          (FC3 / FC6)
 *   hr:100:float  holding registers 100-101, IEEE754    (FC3 / FC16)
 *                 big-endian float (high word first)
 *   ir:30         input register 30, uint16             (FC4, read-only)
 *   ir:30:float   input registers 30-31, float          (FC4, read-only)
 *   coil:5        coil 5, 0/1                           (FC1 / FC5)
 *
 * Requests are serialised per client (one outstanding request at a time),
 * matched by MBAP transaction id, with a per-request timeout. Socket-level
 * failures (timeout, refused, reset, closed) get err.connectionLost = true so
 * the poller can distinguish "reconnect the PLC" from a per-tag Modbus
 * exception (bad address → quality 'bad').
 */
'use strict';

const net = require('net');

const DEFAULT_PORT       = 502;
const DEFAULT_UNIT_ID    = 1;
const DEFAULT_TIMEOUT_MS = 3000;
const MAX_TIMEOUT_MS     = 10000; // cap — a slow PLC must never stall polling for longer

const descriptor = {
  protocol: 'modbus_tcp',
  label:    'Modbus TCP',
  status:   'available',
  configFields: [
    { key: 'host',      label: 'Host',         type: 'string', required: true,  placeholder: '192.168.0.10' },
    { key: 'port',      label: 'Port',         type: 'number', required: false, default: DEFAULT_PORT },
    { key: 'unitId',    label: 'Unit ID',      type: 'number', required: false, default: DEFAULT_UNIT_ID },
    { key: 'timeoutMs', label: 'Timeout (ms)', type: 'number', required: false, default: DEFAULT_TIMEOUT_MS },
  ],
  addressHint:
    "'hr:100' holding register (uint16), 'hr:100:float' (2 registers, IEEE754 big-endian float), " +
    "'ir:30' input register, 'coil:5' coil. Writes: uint16 via FC6, float via FC16, coil via FC5.",
};

const MODBUS_EXCEPTIONS = {
  1: 'Illegal function',
  2: 'Illegal data address',
  3: 'Illegal data value',
  4: 'Slave device failure',
  5: 'Acknowledge',
  6: 'Slave device busy',
  8: 'Memory parity error',
  10: 'Gateway path unavailable',
  11: 'Gateway target failed to respond',
};

/** Mark an error as a connection-level failure (reconnect + backoff). */
function connErr(err) {
  err.connectionLost = true;
  return err;
}

/**
 * Parse an address string into { area: 'hr'|'ir'|'coil', addr, dtype: 'uint16'|'float' }.
 * Throws on malformed addresses.
 */
function parseAddress(address) {
  if (typeof address !== 'string') throw new Error('Address must be a string');
  const parts = address.trim().toLowerCase().split(':');
  const [area, addrStr, dtype] = parts;
  if (!['hr', 'ir', 'coil'].includes(area)) {
    throw new Error(`Invalid Modbus address "${address}" — expected hr:<n>[:float], ir:<n>[:float] or coil:<n>`);
  }
  const addr = Number(addrStr);
  if (!Number.isInteger(addr) || addr < 0 || addr > 0xffff) {
    throw new Error(`Invalid Modbus register/coil number in "${address}"`);
  }
  if (parts.length > 3 || (dtype !== undefined && dtype !== 'float')) {
    throw new Error(`Invalid Modbus datatype in "${address}" — only ":float" is supported`);
  }
  if (area === 'coil' && dtype === 'float') {
    throw new Error(`Coils cannot be read as float ("${address}")`);
  }
  return { area, addr, dtype: dtype === 'float' ? 'float' : 'uint16' };
}

/**
 * Loopback / link-local (incl. cloud metadata) hosts are rejected unless
 * PLC_ALLOW_LOCAL_HOSTS === 'true' — the test/poll paths would otherwise act
 * as a port-probe oracle against the backend host itself. Private RFC1918
 * ranges stay allowed: real PLCs live on plant LANs. See ../README.md.
 */
function isLocalHost(host) {
  const h = String(host).trim().toLowerCase();
  return h === 'localhost' || h === '::1' || h.startsWith('127.') || h.startsWith('169.254.');
}

/** Returns an array of human-readable error strings; empty array = valid. */
function validateConfig(config = {}) {
  const errors = [];
  if (!config.host || typeof config.host !== 'string' || !config.host.trim()) {
    errors.push('config.host is required');
  } else if (isLocalHost(config.host) && process.env.PLC_ALLOW_LOCAL_HOSTS !== 'true') {
    errors.push(
      'config.host must not be a loopback or link-local address ' +
      '(set PLC_ALLOW_LOCAL_HOSTS=true to allow, e.g. for local simulators)'
    );
  }
  for (const key of ['port', 'unitId', 'timeoutMs']) {
    if (config[key] !== undefined && config[key] !== null && config[key] !== '') {
      const n = Number(config[key]);
      if (!Number.isFinite(n) || n < 0) errors.push(`config.${key} must be a non-negative number`);
    }
  }
  if (config.timeoutMs !== undefined && config.timeoutMs !== null && config.timeoutMs !== '') {
    const t = Number(config.timeoutMs);
    if (Number.isFinite(t) && t > MAX_TIMEOUT_MS) {
      errors.push(`config.timeoutMs must be at most ${MAX_TIMEOUT_MS}`);
    }
  }
  return errors;
}

/** Validate an address without connecting; returns error string or null. */
function validateAddress(address) {
  try { parseAddress(address); return null; } catch (err) { return err.message; }
}

class ModbusTcpClient {
  constructor(config = {}) {
    this.host      = config.host;
    this.port      = Number(config.port)      || DEFAULT_PORT;
    this.unitId    = Number(config.unitId)    || DEFAULT_UNIT_ID;
    // Clamp defensively too — connections saved before the cap existed must
    // not stall a poll cycle for longer than MAX_TIMEOUT_MS either.
    this.timeoutMs = Math.min(Number(config.timeoutMs) || DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);

    this.socket    = null;
    this.connected = false;
    this.buffer    = Buffer.alloc(0);
    this.txn       = 0;
    this.pending   = null;              // { txnId, resolve, reject, timer }
    this.queue     = Promise.resolve(); // serialises requests
  }

  connect() {
    if (this.connected) return Promise.resolve();
    return new Promise((resolve, reject) => {
      if (!this.host) return reject(connErr(new Error('Modbus TCP: host not configured')));
      const sock = new net.Socket();
      sock.setNoDelay(true);

      const connectTimer = setTimeout(() => {
        sock.destroy();
        reject(connErr(new Error(`Modbus TCP: connect to ${this.host}:${this.port} timed out after ${this.timeoutMs}ms`)));
      }, this.timeoutMs);

      sock.once('error', (err) => {
        clearTimeout(connectTimer);
        sock.destroy();
        reject(connErr(new Error(`Modbus TCP: ${err.message}`)));
      });

      sock.connect(this.port, this.host, () => {
        clearTimeout(connectTimer);
        sock.removeAllListeners('error');
        this.socket    = sock;
        this.connected = true;
        sock.on('data',  (chunk) => this._onData(chunk));
        sock.on('error', (err)   => { this.connected = false; this._failPending(connErr(new Error(`Modbus TCP: ${err.message}`))); });
        sock.on('close', ()      => { this.connected = false; this._failPending(connErr(new Error('Modbus TCP: connection closed'))); });
        resolve();
      });
    });
  }

  _onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    // MBAP header is 7 bytes: txn(2) proto(2) length(2) unit(1); length counts unit+PDU.
    while (this.buffer.length >= 7) {
      const length   = this.buffer.readUInt16BE(4);
      const frameLen = 6 + length;
      if (this.buffer.length < frameLen) return; // wait for the rest of the frame
      const frame = this.buffer.subarray(0, frameLen);
      this.buffer = this.buffer.subarray(frameLen);

      const txnId = frame.readUInt16BE(0);
      if (this.pending && this.pending.txnId === txnId) {
        const p = this.pending;
        this.pending = null;
        clearTimeout(p.timer);
        p.settle(frame.subarray(7)); // PDU = function code + data
      }
      // Frames with unknown txn ids (late replies after a timeout) are dropped.
    }
  }

  _failPending(err) {
    if (this.pending) {
      const p = this.pending;
      this.pending = null;
      clearTimeout(p.timer);
      p.reject(err);
    }
  }

  /** Send one PDU, resolve with the response PDU. Serialised per client. */
  _request(pdu) {
    const run = () => new Promise((resolve, reject) => {
      if (!this.connected || !this.socket) {
        return reject(connErr(new Error('Modbus TCP: not connected')));
      }
      this.txn = (this.txn + 1) & 0xffff;
      const txnId = this.txn;

      const mbap = Buffer.alloc(7);
      mbap.writeUInt16BE(txnId, 0);
      mbap.writeUInt16BE(0, 2);              // protocol id = 0 (Modbus)
      mbap.writeUInt16BE(pdu.length + 1, 4); // unit id + PDU
      mbap.writeUInt8(this.unitId, 6);

      const timer = setTimeout(() => {
        this.pending = null;
        reject(connErr(new Error(`Modbus TCP: request timed out after ${this.timeoutMs}ms`)));
      }, this.timeoutMs);

      this.pending = {
        txnId,
        timer,
        reject,
        settle: (respPdu) => {
          const fc = respPdu[0];
          if (fc & 0x80) {
            const code = respPdu[1];
            // Modbus exception — a tag-level error, NOT a connection failure.
            reject(new Error(
              `Modbus exception ${code} (${MODBUS_EXCEPTIONS[code] || 'unknown'}) for function ${fc & 0x7f}`
            ));
          } else {
            resolve(respPdu);
          }
        },
      };
      this.socket.write(Buffer.concat([mbap, pdu]));
    });

    const p = this.queue.then(run, run);
    this.queue = p.catch(() => {}); // keep the chain alive after failures
    return p;
  }

  /** Read one tag; returns a number (uint16, float, or 0/1 for coils). */
  async readTag(address) {
    const { area, addr, dtype } = parseAddress(address);

    if (area === 'coil') {
      // FC1 read coils, quantity 1
      const pdu  = Buffer.from([0x01, addr >> 8, addr & 0xff, 0x00, 0x01]);
      const resp = await this._request(pdu);
      return resp[2] & 0x01;
    }

    const fc  = area === 'hr' ? 0x03 : 0x04;
    const qty = dtype === 'float' ? 2 : 1;
    const pdu  = Buffer.from([fc, addr >> 8, addr & 0xff, qty >> 8, qty & 0xff]);
    const resp = await this._request(pdu);
    const byteCount = resp[1];
    const data = resp.subarray(2, 2 + byteCount);
    if (data.length < qty * 2) {
      throw new Error(`Modbus TCP: short response reading ${address}`);
    }
    return dtype === 'float' ? data.readFloatBE(0) : data.readUInt16BE(0);
  }

  /** Write one tag. Coils via FC5, uint16 via FC6, float via FC16 (2 regs). */
  async writeTag(address, value) {
    const { area, addr, dtype } = parseAddress(address);
    const num = Number(value);
    if (!Number.isFinite(num)) throw new Error(`Cannot write non-numeric value to ${address}`);

    if (area === 'ir') {
      throw new Error(`Input registers are read-only ("${address}")`);
    }

    if (area === 'coil') {
      // FC5 write single coil: 0xFF00 = ON, 0x0000 = OFF
      const on  = num !== 0;
      const pdu = Buffer.from([0x05, addr >> 8, addr & 0xff, on ? 0xff : 0x00, 0x00]);
      await this._request(pdu);
      return;
    }

    if (dtype === 'float') {
      // FC16 write multiple registers: 2 registers, IEEE754 big-endian
      const data = Buffer.alloc(4);
      data.writeFloatBE(num, 0);
      const pdu = Buffer.concat([
        Buffer.from([0x10, addr >> 8, addr & 0xff, 0x00, 0x02, 0x04]),
        data,
      ]);
      await this._request(pdu);
      return;
    }

    // FC6 write single register (uint16, two's complement for negatives)
    const v   = Math.round(num) & 0xffff;
    const pdu = Buffer.from([0x06, addr >> 8, addr & 0xff, v >> 8, v & 0xff]);
    await this._request(pdu);
  }

  async disconnect() {
    this.connected = false;
    this._failPending(connErr(new Error('Modbus TCP: client disconnected')));
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.destroy();
      this.socket = null;
    }
  }
}

function createClient(config) {
  return new ModbusTcpClient(config);
}

/** Connectivity probe used by POST /connections/:id/test. */
async function testConnection(config = {}) {
  const errors = validateConfig(config);
  if (errors.length) return { ok: false, message: errors.join('; ') };

  const client = createClient(config);
  const start  = Date.now();
  try {
    await client.connect();
    const latencyMs = Date.now() - start;
    return { ok: true, message: `Connected to ${client.host}:${client.port}`, latencyMs };
  } catch (err) {
    return { ok: false, message: err.message };
  } finally {
    await client.disconnect().catch(() => {});
  }
}

module.exports = {
  descriptor,
  createClient,
  testConnection,
  validateConfig,
  validateAddress,
  parseAddress, // exported for tests
};
