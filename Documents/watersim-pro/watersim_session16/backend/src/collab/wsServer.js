/**
 * WaterSim Pro — Real-time Collaboration WebSocket Server
 * Mounted on the same HTTP server as Express.
 * Uses the `ws` package (no socket.io dependency).
 *
 * Rooms are keyed by flowsheetId.
 * Auth: JWT validated on upgrade handshake.
 */

const { WebSocketServer } = require('ws');
const { parse: parseUrl } = require('url');
const jwtUtils = require('../utils/jwt');
const logger   = require('../utils/logger');

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

// ── Main setup function ──────────────────────────────────────────────────────
function attachWsServer(httpServer) {
  const wss = new WebSocketServer({ noServer: true });

  // -- Upgrade: validate JWT from ?token= query param -----------------------
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
    if (!match) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }

    const flowsheetId = match[1];
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req, { user, flowsheetId });
    });
  });

  // -- Connection handler ---------------------------------------------------
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
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }

      const { type, payload } = msg;
      if (!type) return;

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
            payload: { ...payload, userId: peer.userId, color: peer.color, displayName: peer.displayName },
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

module.exports = { attachWsServer };
