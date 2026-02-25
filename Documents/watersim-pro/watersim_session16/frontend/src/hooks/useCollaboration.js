/**
 * useCollaboration — WebSocket hook for real-time canvas collaboration.
 *
 * Features:
 * - Auto-connects on mount, reconnects on disconnect (exponential back-off)
 * - Exposes sendEvent(type, payload) for outbound events
 * - Exposes presence list (peers) and remoteCursors map
 * - Exposes simBanner: { displayName } when a peer is running a simulation, or null
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import useAuthStore from '../store/authStore';

const WS_BASE = import.meta.env.VITE_WS_URL || 'ws://localhost:4000';

const RECONNECT_BASE_MS   = 1_000;
const RECONNECT_MAX_MS    = 30_000;
const RECONNECT_FACTOR    = 1.5;

export function useCollaboration(flowsheetId, { onRemoteEvent } = {}) {
  const user     = useAuthStore(s => s.user);
  const wsRef    = useRef(null);
  const retryRef = useRef(null);
  const delayRef = useRef(RECONNECT_BASE_MS);
  const onRemoteEventRef = useRef(onRemoteEvent);

  const [presence, setPresence]           = useState([]);    // all peers including self
  const [self, setSelf]                   = useState(null);
  const [remoteCursors, setRemoteCursors] = useState({});    // { [userId]: { x, y, color, displayName } }
  const [simBanner, setSimBanner]         = useState(null);  // { displayName } or null

  // Keep callback ref fresh
  useEffect(() => { onRemoteEventRef.current = onRemoteEvent; }, [onRemoteEvent]);

  const connect = useCallback(() => {
    if (!flowsheetId || !user) return;
    const token = localStorage.getItem('accessToken');
    if (!token) return;

    const url = `${WS_BASE}/ws/flowsheets/${flowsheetId}?token=${encodeURIComponent(token)}`;
    const ws  = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => {
      delayRef.current = RECONNECT_BASE_MS; // reset back-off on successful connect
    };

    ws.onmessage = (evt) => {
      let msg;
      try { msg = JSON.parse(evt.data); } catch { return; }

      const { type, payload, from, peers, joined, left, self: selfInfo } = msg;

      switch (type) {
        case 'presence:init':
          if (selfInfo) setSelf(selfInfo);
          if (peers)    setPresence(peers);
          break;

        case 'presence:update':
          if (peers) setPresence(peers);
          break;

        case 'cursor:move':
          if (payload) {
            setRemoteCursors(prev => ({
              ...prev,
              [payload.userId]: {
                x:           payload.x,
                y:           payload.y,
                color:       payload.color,
                displayName: payload.displayName,
              },
            }));
          }
          break;

        case 'sim:running':
          setSimBanner({ displayName: payload?.displayName || 'A collaborator' });
          break;

        case 'sim:result':
          setSimBanner(null);
          // Forward result data to canvas handler so it can update UI
          if (onRemoteEventRef.current) onRemoteEventRef.current({ type, payload, from });
          break;

        case 'node:add':
        case 'node:delete':
        case 'node:move':
        case 'edge:add':
        case 'edge:delete':
        case 'params:update':
          if (onRemoteEventRef.current) onRemoteEventRef.current({ type, payload, from });
          break;

        default:
          break;
      }
    };

    ws.onclose = () => {
      wsRef.current = null;
      // Remove stale cursors for peers that might have left
      setRemoteCursors({});
      // Schedule reconnect
      retryRef.current = setTimeout(() => {
        delayRef.current = Math.min(delayRef.current * RECONNECT_FACTOR, RECONNECT_MAX_MS);
        connect();
      }, delayRef.current);
    };

    ws.onerror = () => {
      ws.close();
    };
  }, [flowsheetId, user]);

  // Connect on mount / flowsheetId change
  useEffect(() => {
    connect();
    return () => {
      clearTimeout(retryRef.current);
      if (wsRef.current) {
        wsRef.current.onclose = null; // suppress reconnect on intentional unmount
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [connect]);

  // ── Send event ────────────────────────────────────────────────────────────
  const sendEvent = useCallback((type, payload) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type, payload }));
    }
  }, []);

  return {
    sendEvent,
    presence,   // array of { userId, displayName, color, initials }
    self,       // this user's peer info
    remoteCursors,
    simBanner,
  };
}
