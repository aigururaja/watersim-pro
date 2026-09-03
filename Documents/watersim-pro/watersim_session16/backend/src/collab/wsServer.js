/**
 * WaterSim Pro — Real-time Collaboration WebSocket Server
 * Mounted on the same HTTP server as Express.
 * Uses the `ws` package (no socket.io dependency).
 *
 * Rooms are keyed by flowsheetId.
 * Auth: JWT validated on upgrade handshake, then flowsheet→project→org
 * ownership verified against the DB before the upgrade completes.
 */

const { WebSocketServer } = require('ws');
const { parse: parseUrl } = require('url');
const jwtUtils = require('../utils/jwt');
const logger   = require('../utils/logger');
const { pool } = require('../db/pool');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ── Colour palette for presence avatars ─────────────────────────────────────
const PRESENCE_COLORS = [
  '#4F46E5', '#0891B2', '#16A34A', '#D97706',
  '#BE123C', '#7C3AED', '#0D9488', '#B45309',
];
let colorIdx = 0;
const nextColor = () => PRESENCE_COLORS[colorIdx++ % PRESENCE_COLORS.length];

// ── In-memory room registry ──────────────────────────────────────────────────
// rooms: Map<flowsheetId, Map<ws, { userId, displayName, color, initials }>>
const rooms = new Map();

function getRoom(flowsheetId) {
  if (!rooms.has(flowsheetId)) rooms.set(flowsheetId, new Map());
  return rooms.get(flowsheetId);
}

function buildPresenceList(room) {
  return [...room.values()].map(({ userId, displayName, color, initials }) => ({
    userId, displayName, color, initials,
  }));
}

// ── Broadcast helpers ────────────────────────────────────────────────────────
function broadcast(room, message, excludeWs = null) {
  const raw = JSON.stringify(message);
  for (const [ws] of room) {
    if (ws !== excludeWs && ws.readyState === 1 /* OPEN */) {
      ws.send(raw);
    }
  }
}

function sendTo(ws, message) {
  if (ws.readyState === 1) ws.send(JSON.stringify(message));
}

/**
 * Server-originated broadcast to every client in a flowsheet room (used by the
 * PLC poller for 'plc:update'). Bypasses the client-message allowlist by
 * design — that allowlist only guards messages RECEIVED from clients, and
 * 'plc:update' is deliberately absent from it so clients can never forge live
 * PLC values (unknown types are dropped in the message handler).
 * Returns the number of clients in the room (0 when the room is empty).
 */
function broadcastToRoom(flowsheetId, message) {
  const room = rooms.get(flowsheetId);
  if (!room || room.size === 0) return 0;
  broadcast(room, message);
  return room.size;
}

// ── Per-connection throttle map (for cursor + node:move) ────────────────────
// throttles: Map<ws, Map<eventType, { timer, pending }>>
const throttles = new Map();

function throttledBroadcast(room, ws, message, delayMs = 50) {
  if (!throttles.has(ws)) throttles.set(ws, new Map());
  const connThrottles = throttles.get(ws);
  const key = message.type;

  if (connThrottles.has(key)) {
    const state = connThrottles.get(key);
    state.pending = message;           // update pending payload
    return;
  }
  // Send immediately, then lock for delayMs
  broadcast(room, message, ws);
  connThrottles.set(key, { pending: null, timer: setTimeout(() => {
    const state = connThrottles.get(key);
    if (state?.pending) broadcast(room, state.pending, ws);
    connThrottles.delete(key);
  }, delayMs) });
}

function cleanThrottles(ws) {
  const m = throttles.get(ws);
  if (m) {
    for (const { timer } of m.values()) clearTimeout(timer);
    throttles.delete(ws);
  }
}

// ── Message allowlist + shape validation ─────────────────────────────────────
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isFiniteNum   = (v) => typeof v === 'number' && Number.isFinite(v);

// type → payload validator. Anything not listed here is dropped.
const MESSAGE_VALIDATORS = {
  'node:move':     (p) => isPlainObject(p) && typeof p.id === 'string'
                          && isPlainObject(p.position)
                          && isFiniteNum(p.position.x) && isFiniteNum(p.position.y),
  'node:add':      (p) => isPlainObject(p) && typeof p.id === 'string',
  'node:delete':   (p) => isPlainObject(p) && typeof p.id === 'string',
  'edge:add':      (p) => isPlainObject(p) && typeof p.id === 'string',
  'edge:delete':   (p) => isPlainObject(p) && typeof p.id === 'string',
  'params:update': (p) => isPlainObject(p) && typeof p.nodeId === 'string'
                          && isPlainObject(p.params),
  'sim:running':   (p) => isPlainObject(p),
  'sim:result':    (p) => isPlainObject(p),
  'cursor:move':   (p) => isPlainObject(p) && isFiniteNum(p.x) && isFiniteNum(p.y),
};

// ── Per-connection rate limiting (token bucket) ─────────────────────────────
const RATE_PER_SEC = 50;   // sustained messages/sec
const BURST        = 100;  // bucket capacity

function makeBucket() {
  return { tokens: BURST, last: Date.now() };
}

function takeToken(bucket) {
  const now = Date.now();
  bucket.tokens = Math.min(BURST, bucket.tokens + ((now - bucket.last) / 1000) * RATE_PER_SEC);
  bucket.last = now;
  if (bucket.tokens < 1) return false;
  bucket.tokens -= 1;
  return true;
}

// ── Heartbeat ────────────────────────────────────────────────────────────────
const HEARTBEAT_INTERVAL_MS = 30_000;

// ── Main setup function ──────────────────────────────────────────────────────
function attachWsServer(httpServer) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });

  // -- Upgrade: validate JWT from ?token= query param ------------------------
  httpServer.on('upgrade', (req, socket, head) => {
    const { pathname, query } = parseUrl(req.url, true);

    // Only handle /ws/* paths
    if (!pathname.startsWith('/ws/')) {
      socket.destroy();
      return;
    }

    const token = query.token;
    if (!token) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    let user;
    try {
      user = jwtUtils.verifyAccess(token);
    } catch {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    // Extract flowsheetId from /ws/flowsheets/:flowsheetId
    const match = pathname.match(/^\/ws\/flowsheets\/([^/]+)$/);
    if (!match || !UUID_RE.test(match[1])) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }
    const flowsheetId = match[1];

    // Tenancy check: the flowsheet must belong to a project in the user's org.
    pool.query(
      `SELECT f.id
       FROM flowsheets f
       JOIN projects p ON p.id = f.project_id
       WHERE f.id = $1 AND p.organisation_id = $2 AND p.status != 'deleted'`,
      [flowsheetId, user.org]
    ).then((r) => {
      if (socket.destroyed) return;
      if (!r.rows.length) {
        logger.warn('WS upgrade rejected: flowsheet not in user org', {
          userId: user.sub || user.id, flowsheetId,
        });
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req, { user, flowsheetId });
      });
    }).catch((err) => {
      logger.error('WS upgrade org check failed', { err: err.message });
      if (!socket.destroyed) {
        socket.write('HTTP/1.1 500 Internal Server Error\r\n\r\n');
        socket.destroy();
      }
    });
  });

  // -- Heartbeat: ping every 30s, drop sockets that miss a pong --------------
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) {
        // terminate() emits 'close', which removes the socket from its room
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      try { ws.ping(); } catch { /* socket already gone */ }
    }
  }, HEARTBEAT_INTERVAL_MS);
  heartbeat.unref();
  wss.on('close', () => clearInterval(heartbeat));

  // -- Connection handler ----------------------------------------------------
  wss.on('connection', (ws, _req, { user, flowsheetId }) => {
    const room     = getRoom(flowsheetId);
    const initials = (user.name || user.email || 'U')
      .split(/\s+/)
      .map(w => w[0])
      .join('')
      .toUpperCase()
      .slice(0, 2);

    const peer = {
      userId:      user.sub || user.id,
      displayName: user.name || user.email,
      color:       nextColor(),
      initials,
    };

    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    const bucket = makeBucket();

    room.set(ws, peer);
    logger.info('WS connected', { userId: peer.userId, flowsheetId, online: room.size });

    // Send joiner their own peer info + full presence list
    sendTo(ws, {
      type:    'presence:init',
      self:    peer,
      peers:   buildPresenceList(room),
    });

    // Announce join to everyone else
    broadcast(room, {
      type:     'presence:update',
      peers:    buildPresenceList(room),
      joined:   peer,
    }, ws);

    // -- Message handler ----------------------------------------------------
    ws.on('message', (raw) => {
      // Rate limit before doing any work; close abusive connections.
      if (!takeToken(bucket)) {
        logger.warn('WS rate limit exceeded — closing connection', {
          userId: peer.userId, flowsheetId,
        });
        ws.close(1008, 'Rate limit exceeded');
        return;
      }

      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      if (!isPlainObject(msg)) return;

      const { type, payload } = msg;

      // Allowlist + shape check — never re-broadcast unvalidated input.
      const validate = typeof type === 'string' ? MESSAGE_VALIDATORS[type] : null;
      if (!validate) {
        logger.warn('WS dropped message with unknown type', {
          userId: peer.userId, flowsheetId, type: String(type).slice(0, 50),
        });
        return;
      }
      if (!validate(payload)) {
        logger.warn('WS dropped malformed message', { userId: peer.userId, flowsheetId, type });
        return;
      }

      switch (type) {
        // Canvas mutations — broadcast to room (exclude sender)
        case 'node:move':
          throttledBroadcast(room, ws, { type, payload, from: peer.userId }, 50);
          break;

        case 'node:add':
        case 'node:delete':
        case 'edge:add':
        case 'edge:delete':
        case 'params:update':
          broadcast(room, { type, payload, from: peer.userId }, ws);
          break;

        // Simulation lifecycle
        case 'sim:running':
          broadcast(room, {
            type,
            payload: { ...payload, displayName: peer.displayName },
            from: peer.userId,
          }, ws);
          break;

        case 'sim:result':
          broadcast(room, { type, payload, from: peer.userId }, ws);
          break;

        // Remote cursor (throttled at 50 ms)
        case 'cursor:move':
          throttledBroadcast(room, ws, {
            type,
            payload: { x: payload.x, y: payload.y, userId: peer.userId, color: peer.color, displayName: peer.displayName },
          }, 50);
          break;

        default:
          break;
      }
    });

    // -- Disconnect ---------------------------------------------------------
    ws.on('close', () => {
      room.delete(ws);
      cleanThrottles(ws);
      logger.info('WS disconnected', { userId: peer.userId, flowsheetId, online: room.size });
      if (room.size === 0) {
        rooms.delete(flowsheetId);
      } else {
        broadcast(room, {
          type:  'presence:update',
          peers: buildPresenceList(room),
          left:  peer,
        });
      }
    });

    ws.on('error', (err) => {
      logger.warn('WS error', { userId: peer.userId, err: err.message });
    });
  });

  logger.info('WebSocket collaboration server attached');
  return wss;
}

module.exports = { attachWsServer, broadcastToRoom };
