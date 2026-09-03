# PLC driver framework

Live plant data enters WaterSim Pro through **drivers** — one module per
industrial protocol, registered in `registry.js`:

| Protocol      | Module                  | Status      |
| ------------- | ----------------------- | ----------- |
| `modbus_tcp`  | `drivers/modbusTcp.js`  | available — dependency-free Modbus TCP over `net.Socket` |
| `simulator`   | `drivers/simulator.js`  | available — built-in virtual PLC, no network |
| `opcua`       | `drivers/opcua.js`      | dynamic — real driver via the Python bridge (`asyncua`) |
| `s7`          | `drivers/s7.js`         | dynamic — real driver via the Python bridge (`python-snap7`) |
| `ethernet_ip` | `drivers/ethernetIp.js` | dynamic — real driver via the Python bridge (`pycomm3`); untested against real Logix hardware |

`modbus_tcp` and `simulator` are implemented in Node and statically
`'available'`. The other three are **real drivers backed by a Python bridge**
(below); their listed status is dynamic — `'available'` when the runtime
availability probe passes, otherwise an honest `'stub'` with an additive
`reason` field (e.g. `"Python package 'asyncua' not installed — pip install
-r backend/requirements-plc.txt"`) so the UI can still render their forms and
tell the user exactly what is missing.

## The Python bridge (opcua / s7 / ethernet_ip)

Mature open-source clients for these protocols live in Python, so the three
drivers shell out to `bridge/plc_bridge.py` — a persistent JSON-line RPC
child process — instead of reimplementing the protocols in Node:

```
poller / routes ──▶ drivers/opcua.js ─┐
                    drivers/s7.js ────┼─▶ bridge/bridgeDriver.js (shared client)
                    drivers/ethernetIp.js ┘        │
                                                   ▼
                                    bridge/bridgeClient.js (per-client child manager)
                                                   │  spawn(PYTHON_BIN, [plc_bridge.py])
                                                   ▼  JSON line per request/reply on stdio
                                    bridge/plc_bridge.py
                                       ├─ asyncua      (OPC UA, background event loop)
                                       ├─ python-snap7 (S7 ISO-on-TCP)
                                       └─ pycomm3      (EtherNet/IP LogixDriver)
```

- **Process model** — each Node PLC client (`createClient()`) owns one bridge
  child, spawned lazily on the first request and killed on `disconnect()`.
  `testConnection` and the availability probe use short-lived one-shot
  children (`bridgeCall`). `PYTHON_BIN` selects the interpreter (default
  `python3`, `python` on Windows — same convention as `src/reports/pySpawn.js`).
- **Wire protocol** — one JSON object per line each way, matched by request
  id: ops `probe`, `test`, `connect`, `read`, `write`, `disconnect`, `ping`.
  See the docstring at the top of `bridge/plc_bridge.py`.
- **Failure semantics** — the bridge classifies errors: socket/session-level
  failures reply `connectionLost: true` (the poller drops its client and
  reconnects with backoff), tag-level failures (bad node id, unknown tag,
  address out of range) reply `connectionLost: false` (only that binding goes
  quality `'bad'`). A non-finite read (NaN/Infinity — faulted analog sensors)
  is a tag-level error too, never a lost connection. A bridge child that
  times out or crashes is killed and every in-flight request rejects with
  `err.connectionLost = true`; the next request respawns a fresh child.
  Per-request timeout: 5000 ms default, `config.timeoutMs` override, capped
  at 10000 ms for data ops like the Modbus driver; `connect`/`test` get 3×
  the configured budget (ceiling 30 s) because device handshakes can be slow
  (pycomm3 uploads the controller's full tag list on open).
- **Process bounds** — at most `PLC_BRIDGE_MAX_CHILDREN` (default 32) bridge
  Python processes may be alive at once (excess requests fail fast with a
  clear error), and one-shot probe/test calls are additionally serialized
  through a 4-slot semaphore — the same fork-bomb guard as
  `src/reports/pySpawn.js`. Children are spawned with `PYTHONUTF8=1` (and the
  bridge reconfigures its stdio to UTF-8) so non-ASCII addresses/credentials
  survive Windows code pages.
- **Values are raw** — drivers return raw numeric device values (booleans as
  0/1); scale/offset is applied by the poller/routes, never in the driver.
- **S7 bit writes & write serialization** — `db<N>.bool<byte>.<bit>` writes
  read-modify-write the containing byte (a protocol-level `S7WLBit` write
  would be atomic on real CPUs, but the snap7 demo server used as the dev/CI
  simulator mishandles it and clobbers sibling bits). To keep concurrent
  writers from reverting each other's bits, the write route serializes all
  writes per connection (single-backend-instance scope, like the poller).
  Writers outside this backend instance can still race the RMW window.

### Availability probing

`registry.probeAvailability()` runs one bridge `probe` op that checks, per
protocol, that the Python package imports (and for snap7, that its native
library loads). A probe the bridge *answered* is memoized for the process
lifetime; a bridge-LEVEL failure (spawn error, timeout — often transient at
boot) is cached only for 30 s, after which the next caller re-probes, so one
slow start can't misreport installed protocols until restart. The result is
merged into `listProtocols()`. The probe is fired-and-forgotten when the
poller starts and awaited by `GET /api/v1/plc/protocols`, so even the first
API response is accurate. Install the packages with:

```
pip install -r backend/requirements-plc.txt
```

(`backend/Dockerfile.prod` installs them into the production image; on
musl/Alpine the snap7 wheel may not ship the native library, in which case
the probe reports `s7` unavailable with that reason.)

### Bridge address grammars

- **`opcua`** — OPC UA node id: `ns=2;s=Device1.FlowRate`, `ns=3;i=1005`
  (string, numeric, `g=<guid>` and `b=<bytestring>` identifiers accepted; the
  `ns=<n>;` prefix defaults to namespace 0). Config: `endpoint`
  (`opc.tcp://` URL, required), `username`/`password` (optional), `timeoutMs`.
  Writes are coerced to the node's variant type (Boolean/int/float).
- **`s7`** — DB-area addresses, case-insensitive, using `snap7.util`
  getters/setters:

  | Address                  | Type | Size |
  | ------------------------ | ---- | ---- |
  | `db<N>.real<byteOffset>` | REAL — IEEE754 float32 | 4 bytes |
  | `db<N>.int<off>`         | INT — signed 16-bit    | 2 bytes |
  | `db<N>.dint<off>`        | DINT — signed 32-bit   | 4 bytes |
  | `db<N>.word<off>`        | WORD — unsigned 16-bit | 2 bytes |
  | `db<N>.bool<byte>.<bit>` | one bit (0–7) of a byte; writes read-modify-write the byte | 1 byte |

  e.g. `db1.real0`, `db5.int24`, `db1.bool6.3`. Config: `host` (required),
  `rack` (default 0), `slot` (default 1), `port` (default 102), `timeoutMs`.
- **`ethernet_ip`** — Logix tag path: controller-scoped `Pump1_Speed`,
  program-scoped `Program:MainProgram.Counter`, array/UDT members
  `Tank[3].Level`. Config: `host` (required), `slot` (CPU slot, default 0),
  `timeoutMs`. **Untested against real hardware** — validated against the
  pycomm3 API only (no local test server exists); treat the first field
  deployment as a pilot.

## Driver interface

A driver is a CommonJS module exporting:

```js
module.exports = {
  // Self-description consumed by the registry and the frontend.
  descriptor: {
    protocol: 'my_protocol',          // unique key stored in plc_connections.protocol
    label: 'My Protocol',             // human-readable name
    status: 'available',              // 'available' | 'stub'
    configFields: [                   // renders the connection form in the UI
      { key: 'host', label: 'Host', type: 'string', required: true, placeholder: '10.0.0.5' },
      { key: 'port', label: 'Port', type: 'number', required: false, default: 502 },
      // type: 'string' | 'number' | 'password' — password values are masked
      // as '•••' in every API response.
    ],
    addressHint: "how tag addresses look, e.g. 'hr:100' or 'ns=2;s=Tag'",
  },

  // Return an UNCONNECTED client. Must be cheap and synchronous.
  //
  // The optional second argument is a context object:
  //   { connectionId, organisationId }
  // identifying the plc_connections row the client is being built for. Every
  // caller (poller, write endpoint, test endpoint) passes it. Drivers that
  // keep any process-level state MUST namespace it by context.connectionId so
  // no value ever leaks between connections (and therefore between
  // organisations) — the simulator keys its shared in-memory map as
  // `${context.connectionId || 'default'}::${key}` for exactly this reason.
  // Stateless drivers may ignore the argument.
  createClient(config, context = {}) { return new MyClient(config); },

  // Probe connectivity for POST /api/v1/plc/connections/:id/test.
  // Never throws — resolves { ok: boolean, message: string, latencyMs?: number }.
  // Receives the same optional context as createClient; both built-in drivers
  // ignore it (their probes touch no per-connection state).
  async testConnection(config, context = {}) { ... },

  // Return an array of human-readable error strings; [] means valid.
  // Called by POST/PATCH /api/v1/plc/connections before saving config.
  validateConfig(config) { return []; },

  // Optional: validate a tag address without connecting.
  // Return an error string, or null when the address is well-formed.
  validateAddress(address) { return null; },
};
```

The **client** returned by `createClient(config)` must implement:

```js
await client.connect();              // establish the session (idempotent)
const raw = await client.readTag(address);   // -> number (raw, unscaled)
await client.writeTag(address, raw);         // raw number in device units
await client.disconnect();           // release sockets/sessions (never throws)
```

Rules the poller (`poller.js`) relies on:

- `readTag`/`writeTag` reject on failure. Set `err.connectionLost = true` on
  socket-level failures (timeout, refused, reset, closed) — the poller then
  drops its cached client, marks remaining tags `stale` and reconnects with
  exponential backoff. Errors *without* that flag are treated as tag-level
  (e.g. a Modbus "illegal data address" exception) and mark only that binding
  `bad` while the connection stays up.
- Clients are cached per connection and reused across poll cycles; `connect()`
  is called once, so keep sessions open until `disconnect()`.
- Raw values are numbers. Scaling to engineering units
  (`value = raw * scale + offset_val`, and the inverse on write) happens in
  the poller/routes, never in the driver.

## Network egress & local-host policy

PLCs legitimately live on private plant LANs, so RFC1918 addresses
(10.x, 172.16–31.x, 192.168.x) are **not** blocked. However, every network
driver's `validateConfig` rejects hosts that point back at the backend host
itself or at link-local/cloud-metadata ranges — `localhost`, `127.*`, `::1`,
`169.254.*` — including evasive literal forms: the any-addresses `0.0.0.0` /
`::` (which connect to loopback), `0.*`, IPv4-mapped IPv6
(`::ffff:127.0.0.1`, `::ffff:7f00:1`), pure decimal/hex integer IPv4
literals (`2130706433`, `0x7f000001`), trailing dots and bracketed IPv6.
Otherwise the connection test/poll paths would act as an internal port-probe
oracle for anyone with the engineer role. The guard covers the Modbus
`host`, the S7 and EtherNet/IP `host`, and the host inside the OPC UA
`endpoint` URL (same rule everywhere, shared via `modbusTcp.isLocalHost`).
Known residual: a DNS name that *resolves* to loopback (e.g. localtest.me)
passes — validation is synchronous and does not resolve names; rely on
egress network policy for that class.

Set the environment variable `PLC_ALLOW_LOCAL_HOSTS=true` to lift that
restriction (e.g. for a Modbus/OPC UA/S7 simulator running on the same
machine in development or CI — the PLC driver test suite does exactly this).

Validation is a guardrail, not a boundary: in production, additionally
restrict the backend's egress with network policy / firewall rules so it can
only reach the OT subnets that actually host PLCs.

## Adding a new protocol

For a **native Node driver** (like Modbus TCP):

1. Create `drivers/myProtocol.js` implementing the interface above
   (`drivers/modbusTcp.js` is a full worked example including request
   serialisation and timeouts).
2. Register it in `registry.js`: `require` it and add it to the `DRIVERS`
   array. There is no other registration — routes, poller and UI all discover
   protocols through `listProtocols()`/`getDriver()`.
3. Add tests in `src/__tests__/plc.test.js` — for network protocols, spin up
   a minimal in-process mock server the way the Modbus tests do.

For a **bridge-backed driver** (a protocol with a good Python client):

1. Add a handler class to `bridge/plc_bridge.py` (probe/connect/read/write/
   disconnect — copy the shape of `S7Handler`), register it in
   `HANDLER_TYPES` and `PROTOCOLS`, and keep the connectionLost
   classification honest (socket/session failures ⇒ `connection_lost=True`,
   bad-address failures ⇒ `False`).
2. Create `drivers/myProtocol.js` from `makeBridgeDriver()` in
   `bridge/bridgeDriver.js`, supplying the descriptor plus per-protocol
   `validateConfig` (reuse `hostGuardError`/`numericConfigErrors`) and
   `validateAddress` (mirror the Python address parser).
3. Register the driver in `registry.js` **and add its protocol key to
   `BRIDGE_PROTOCOLS`** so the availability probe covers it; make the
   `probe()` in the Python handler name the missing pip package in `reason`.
4. Pin the Python dependency in `backend/requirements-plc.txt` (installed by
   `backend/Dockerfile.prod`).
5. Add integration tests in `src/__tests__/plcDrivers.test.js`; if the Python
   ecosystem offers a local test server (asyncua and snap7 do), add a fixture
   under `bridge/fixtures/` and test end-to-end.

**Config compatibility**: when upgrading or replacing a driver, keep the same
`protocol` key and `configFields` keys — existing `plc_connections` rows
store config under those keys, and bindings reference connections by id.
