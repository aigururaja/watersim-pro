# PLC driver framework

Live plant data enters WaterSim Pro through **drivers** — one module per
industrial protocol, registered in `registry.js`. Two drivers are fully
working out of the box:

| Protocol      | Module                  | Status      |
| ------------- | ----------------------- | ----------- |
| `modbus_tcp`  | `drivers/modbusTcp.js`  | available — dependency-free Modbus TCP over `net.Socket` |
| `simulator`   | `drivers/simulator.js`  | available — built-in virtual PLC, no network |
| `opcua`       | `drivers/opcua.js`      | stub — needs the optional `node-opcua` package |
| `s7`          | `drivers/s7.js`         | stub — needs the optional `nodes7` package |
| `ethernet_ip` | `drivers/ethernetIp.js` | stub — needs the optional `ethernet-ip` package |

Stubs are *honest*: they appear in `GET /api/v1/plc/protocols` with
`status: 'stub'` and a complete `configFields`/`addressHint` so the UI can
render their forms, but `createClient()` throws a clear error naming the
missing optional package.

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
(10.x, 172.16–31.x, 192.168.x) are **not** blocked. However, the Modbus TCP
driver's `validateConfig` rejects hosts that point back at the backend host
itself or at link-local/cloud-metadata ranges — `localhost`, `127.*`, `::1`
and `169.254.*` — because the connection test/poll paths would otherwise act
as an internal port-probe oracle for anyone with the engineer role.

Set the environment variable `PLC_ALLOW_LOCAL_HOSTS=true` to lift that
restriction (e.g. for a Modbus simulator running on the same machine in
development or CI).

Validation is a guardrail, not a boundary: in production, additionally
restrict the backend's egress with network policy / firewall rules so it can
only reach the OT subnets that actually host PLCs.

## Adding a new protocol

1. Create `drivers/myProtocol.js` implementing the interface above
   (`drivers/stubDriver.js` shows the minimal shape; `drivers/modbusTcp.js`
   is a full worked example including request serialisation and timeouts).
2. Register it in `registry.js`: `require` it and add it to the `DRIVERS`
   array. There is no other registration — routes, poller and UI all discover
   protocols through `listProtocols()`/`getDriver()`.
3. If the implementation needs an npm package, keep the dependency optional:
   `require` it lazily inside `createClient` and throw a clear error naming
   the package when it is not installed (see the stub drivers) so the rest of
   the platform keeps working without it.
4. Add unit tests in `src/__tests__/plc.test.js` — for network protocols,
   spin up a minimal in-process mock server the way the Modbus tests do.

## Upgrading a stub

Replace the module with a real implementation but **keep the same `protocol`
key and `configFields` keys** — existing `plc_connections` rows store config
under those keys, and bindings reference connections by id. Flip
`descriptor.status` to `'available'` and the UI will start offering it for
live use.
