/**
 * WaterSim Pro — Node manager for one plc_bridge.py child process
 *
 * The real OPC UA / S7 / EtherNet/IP drivers talk to Python (asyncua,
 * python-snap7, pycomm3) through this JSON-line RPC bridge. Each BridgeClient
 * owns at most one child process:
 *
 *   - spawned lazily (PYTHON_BIN, same convention as src/reports/pySpawn.js)
 *     on the first request(),
 *   - one JSON object per line each way, matched by a per-request id,
 *   - per-request timeout (default 5000ms, override via timeoutMs, capped at
 *     10000ms like the Modbus driver) — on timeout the child is killed, every
 *     in-flight request rejects with err.connectionLost = true, and the next
 *     request() respawns a fresh child,
 *   - child crash/exit rejects in-flight requests the same way,
 *   - reply lines are capped at 1MB — a runaway child is killed,
 *   - close() ends stdin (the bridge exits cleanly on EOF, closing PLC
 *     sessions) and hard-kills shortly after as a backstop.
 *
 * bridgeCall(op, payload, timeoutMs) is a one-shot helper (spawn → request →
 * teardown) for probe/test style calls that don't need a persistent session.
 */
'use strict';

const { spawn } = require('child_process');
const path = require('path');
const { PYTHON_BIN } = require('../../reports/pySpawn');

const BRIDGE_SCRIPT = path.join(__dirname, 'plc_bridge.py');

const DEFAULT_TIMEOUT_MS = 5000;
const MAX_TIMEOUT_MS     = 10000; // cap — a slow bridge must never stall polling for longer
// connect/test may legitimately exceed the data-op cap (e.g. pycomm3 uploads
// the controller's whole tag list on open; slow links, cold sessions).
const MAX_CONNECT_TIMEOUT_MS = 30000;
const MAX_LINE_BYTES     = 1024 * 1024; // 1MB reply-line cap
const CLOSE_GRACE_MS     = 1500;  // stdin EOF → hard kill backstop
const STDERR_TAIL_BYTES  = 4096;  // kept for diagnostics in exit errors

// Host-wide bound on live bridge Python children: every persistent client and
// every one-shot owns a python process (asyncua import alone is tens of MB
// RSS), and the write route mints a client per HTTP request — without a cap an
// authenticated user firing parallel writes at a blackholed PLC pins hundreds
// of interpreters (same risk pySpawn guards with its semaphore).
const MAX_BRIDGE_CHILDREN = (() => {
  const n = Number(process.env.PLC_BRIDGE_MAX_CHILDREN);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 32;
})();
let liveChildren = 0;

/** Mark an error as a connection-level failure (poller reconnect + backoff). */
function connErr(message) {
  const err = new Error(message);
  err.connectionLost = true;
  return err;
}

/** Clamp a requested timeout to (0, max]; default 5000ms. */
function clampTimeoutMs(timeoutMs, max = MAX_TIMEOUT_MS) {
  const n = Number(timeoutMs);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(n, max);
}

class BridgeClient {
  /**
   * @param {object} [options]
   * @param {number} [options.timeoutMs]  default per-request timeout
   * @param {string} [options.scriptPath] bridge script override (tests only)
   */
  constructor({ timeoutMs, scriptPath } = {}) {
    this.defaultTimeoutMs = clampTimeoutMs(timeoutMs);
    this.scriptPath       = scriptPath || BRIDGE_SCRIPT;
    this.child            = null;
    this.buffer           = '';
    this.stderrTail       = '';
    this.nextId           = 1;
    this.pending          = new Map(); // id -> { resolve, reject, timer }
    this.closed           = false;
  }

  /** pid of the current child, or null (exposed for tests). */
  get childPid() {
    return this.child ? this.child.pid : null;
  }

  _spawnChild() {
    if (liveChildren >= MAX_BRIDGE_CHILDREN) {
      throw connErr(
        `PLC bridge: too many concurrent bridge processes (${liveChildren}/${MAX_BRIDGE_CHILDREN}) — ` +
        'retry shortly, or raise PLC_BRIDGE_MAX_CHILDREN'
      );
    }
    const child = spawn(PYTHON_BIN, [this.scriptPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      // Force UTF-8 stdio in the child: without it, piped Python on Windows
      // decodes stdin with the ANSI code page and a non-ASCII address or
      // password either crash-loops the child (UnicodeDecodeError) or
      // silently mojibakes credentials.
      env: { ...process.env, PYTHONUTF8: '1' },
    });
    liveChildren++;
    // Decrement exactly once, on 'exit' OR 'error' (a failed spawn emits
    // 'error' with no 'exit'). Both survive the deliberate
    // removeAllListeners('close') in _killChild()/close(), so the counter
    // cannot leak.
    let counted = true;
    const releaseChildSlot = () => { if (counted) { counted = false; liveChildren--; } };
    child.once('exit', releaseChildSlot);
    child.once('error', releaseChildSlot);
    this.child      = child;
    this.buffer     = '';
    this.stderrTail = '';

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      if (this.child === child) this._onData(chunk);
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-STDERR_TAIL_BYTES);
    });
    child.on('error', (err) => {
      if (this.child === child) this.child = null;
      this._failAll(connErr(
        `PLC bridge: failed to spawn ${PYTHON_BIN}: ${err.message}. ` +
        'Set PYTHON_BIN if Python lives elsewhere.'
      ));
    });
    child.on('close', () => {
      if (this.child !== child) return; // already replaced/killed deliberately
      this.child = null;
      const tail = this.stderrTail.trim();
      this._failAll(connErr(
        `PLC bridge: bridge process exited unexpectedly${tail ? ` — ${tail.slice(0, 300)}` : ''}`
      ));
    });
    // A broken stdin pipe surfaces via the close handler above.
    child.stdin.on('error', () => {});
  }

  _onData(chunk) {
    this.buffer += chunk;
    let idx;
    while ((idx = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, idx).replace(/\r$/, '');
      this.buffer = this.buffer.slice(idx + 1);
      if (!line.trim()) continue;

      let msg;
      try { msg = JSON.parse(line); } catch { continue; } // never trust the wire

      const p = this.pending.get(msg.id);
      if (!p) continue; // late reply after a timeout — drop it
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.ok) {
        p.resolve(msg.value);
      } else {
        const err = new Error(msg.error || 'PLC bridge error');
        err.connectionLost = !!msg.connectionLost;
        p.reject(err);
      }
    }
    if (this.buffer.length > MAX_LINE_BYTES) {
      this._killChild();
      this._failAll(connErr('PLC bridge: reply exceeded the 1MB line cap'));
    }
  }

  /** Reject every in-flight request (connection-level failure). */
  _failAll(err) {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }

  /** Detach + hard-kill the current child (it is being replaced/abandoned). */
  _killChild() {
    const child = this.child;
    this.child = null;
    if (!child) return;
    child.removeAllListeners('close');
    child.on('close', () => {}); // swallow — this exit is intentional
    try { child.stdin.destroy(); } catch { /* already gone */ }
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
  }

  /**
   * Send one request; resolves with the reply's `value`.
   * Rejects with err.connectionLost = true on timeout / child crash, or with
   * the bridge's own classification on an error reply.
   */
  request(op, payload = {}, timeoutMs = undefined) {
    if (this.closed) return Promise.reject(connErr('PLC bridge: client closed'));
    try {
      if (!this.child) this._spawnChild();
    } catch (err) {
      return Promise.reject(err); // over the bridge-children cap
    }

    const child = this.child;
    const id = this.nextId++;
    // connect/test may run long device handshakes (tag-list uploads); data ops
    // keep the strict cap so a slow bridge can never stall polling.
    const maxMs = (op === 'connect' || op === 'test') ? MAX_CONNECT_TIMEOUT_MS : MAX_TIMEOUT_MS;
    const t  = clampTimeoutMs(timeoutMs !== undefined ? timeoutMs : this.defaultTimeoutMs, maxMs);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        // A hung bridge cannot be trusted for the other in-flight requests
        // either: kill it, fail everything, respawn lazily on the next call.
        this._killChild();
        this._failAll(connErr('PLC bridge: bridge killed after a request timeout'));
        reject(connErr(`PLC bridge: '${op}' timed out after ${t}ms`));
      }, t);
      if (timer.unref) timer.unref();

      this.pending.set(id, { resolve, reject, timer });
      try {
        child.stdin.write(`${JSON.stringify({ id, op, ...payload })}\n`);
      } catch (err) {
        this.pending.delete(id);
        clearTimeout(timer);
        this._killChild();
        reject(connErr(`PLC bridge: failed to write request: ${err.message}`));
      }
    });
  }

  /** Terminate the child (clean EOF first, hard kill as a backstop). */
  close() {
    this.closed = true;
    const child = this.child;
    this.child = null;
    if (!child) return;
    child.removeAllListeners('close');
    child.on('close', () => {});
    try { child.stdin.end(); } catch { /* already gone */ }
    const killTimer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* already exited */ }
    }, CLOSE_GRACE_MS);
    if (killTimer.unref) killTimer.unref();
    this._failAll(connErr('PLC bridge: client closed'));
  }
}

// Small semaphore for one-shot calls (probe/test): each spawns a fresh
// interpreter, so a burst of tests must queue instead of forking a pile of
// pythons at once. Persistent clients are bounded by MAX_BRIDGE_CHILDREN.
const ONE_SHOT_LIMIT = 4;
let oneShotActive = 0;
const oneShotWaiters = [];

async function withOneShotSlot(fn) {
  while (oneShotActive >= ONE_SHOT_LIMIT) {
    await new Promise((resolve) => oneShotWaiters.push(resolve));
  }
  oneShotActive++;
  try {
    return await fn();
  } finally {
    oneShotActive--;
    const next = oneShotWaiters.shift();
    if (next) next();
  }
}

/**
 * One-shot helper: spawn a bridge, run a single op, tear the child down.
 * Used for 'probe' (registry availability) and 'test' (connection probe).
 * At most ONE_SHOT_LIMIT run concurrently; excess calls queue.
 */
async function bridgeCall(op, payload = {}, timeoutMs = undefined) {
  return withOneShotSlot(async () => {
    const client = new BridgeClient({ timeoutMs });
    try {
      return await client.request(op, payload, timeoutMs);
    } finally {
      client.close();
    }
  });
}

module.exports = {
  BridgeClient,
  bridgeCall,
  clampTimeoutMs,
  BRIDGE_SCRIPT,
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  MAX_CONNECT_TIMEOUT_MS,
};
