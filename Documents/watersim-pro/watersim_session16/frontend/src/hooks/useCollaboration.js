/**
 * useCollaboration — WebSocket hook for real-time canvas collaboration.
 *
 * Features:
 * - Auto-connects on mount, reconnects on disconnect (exponential back-off)
 * - Exposes sendEvent(type, payload) for outbound events
 * - Exposes presence list (peers) and remoteCursors map
 * - Exposes simBanner: { displayName } when a peer is running a simulation, or null
 * - Exposes wsConnected boolean for connection status UI
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import { useAuth } from '../context/AuthContext';
import useLiveSimStore from '../store/liveSimStore';

const WS_BASE = import.meta.env.VITE_WS_URL || 'ws://localhost:4000';

const RECONNECT_BASE_MS   = 1_000;
const RECONNECT_MAX_MS    = 30_000;
const RECONNECT_FACTOR    = 1.5;

export function useCollaboration(flowsheetId, { onRemoteEvent } = {}) {
  const { user }  = useAuth();
  const wsRef    = useRef(null);
  const retryRef = useRef(null);
  const delayRef = useRef(RECONNECT_BASE_MS);
  const onRemoteEventRef = useRef(onRemoteEvent);

  const [presence, setPresence]           = useState([]);    // all peers including self
  const [self, setSelf]                   = useState(null);
  const [remoteCursors, setRemoteCursors] = useState({});    // { [userId]: { x, y, color, displayName } }
  const [simBanner, setSimBanner]         = useState(null);  // { displayName } or null
  const [wsConnected, setWsConnected]     = useState(false); // WebSocket connection status

  // Keep callback ref fresh
  useEffect(() => { onRemoteEventRef.current = onRemoteEvent; }, [onRemoteEvent]);

  const connect = useCallback(() => {
    if (!flowsheetId || !user) {
      console.warn('[WS] Cannot connect: missing flowsheetId or user', { flowsheetId, hasUser: !!user });
      return;
    }
    // Token is stored in sessionStorage by AuthContext
    const token = sessionStorage.getItem('accessToken');
    if (!token) {
      console.warn('[WS] Cannot connect: no accessToken in sessionStorage');
      return;
    }

    const url = `${WS_BASE}/ws/flowsheets/${flowsheetId}?token=${encodeURIComponent(token)}`;
    console.log('[WS] Connecting to', url.replace(/token=[^&]+/, 'token=***'));
    const ws  = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => {
      console.log('[WS] Connected successfully');
      delayRef.current = RECONNECT_BASE_MS; // reset back-off on successful connect
      setWsConnected(true);
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

        // ── Live simulation events ──────────────────────────────
        case 'sim:live:started':
          console.log('[WS] Received sim:live:started', payload);
          useLiveSimStore.getState().onStarted(payload);
          setSimBanner({ displayName: payload?.startedBy || 'A collaborator', live: true });
          break;
        case 'sim:live:step':
          useLiveSimStore.getState().onSteps({ steps: [payload.step] });
          break;
        case 'sim:live:steps':
          useLiveSimStore.getState().onSteps(payload);
          break;
        case 'sim:live:paused':
          useLiveSimStore.getState().onPaused();
          break;
        case 'sim:live:resumed':
          useLiveSimStore.getState().onResumed();
          break;
        case 'sim:live:cancelled':
          useLiveSimStore.getState().onCancelled();
          setSimBanner(null);
          break;
        case 'sim:live:error':
          console.error('[WS] Received sim:live:error', payload);
          useLiveSimStore.getState().onError(payload);
          setSimBanner(null);
          break;
        case 'sim:live:speed-changed':
          useLiveSimStore.getState().onSpeedChanged(payload);
          break;

        default:
          break;
      }
    };

    ws.onclose = (evt) => {
      console.warn('[WS] Connection closed', { code: evt.code, reason: evt.reason });
      wsRef.current = null;
      setWsConnected(false);
      setRemoteCursors({});
      // Schedule reconnect
      retryRef.current = setTimeout(() => {
        delayRef.current = Math.min(delayRef.current * RECONNECT_FACTOR, RECONNECT_MAX_MS);
        connect();
      }, delayRef.current);
    };

    ws.onerror = (err) => {
      console.error('[WS] Connection error', err);
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
        setWsConnected(false);
      }
    };
  }, [connect]);

  // ── Send event ────────────────────────────────────────────────────────────
  const sendEvent = useCallback((type, payload) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      console.log('[WS] Sending', type);
      ws.send(JSON.stringify({ type, payload }));
    } else {
      console.error('[WS] Cannot send — WebSocket not connected', {
        type,
        hasWs: !!ws,
        readyState: ws?.readyState,
      });
    }
  }, []);

  return {
    sendEvent,
    presence,
    self,
    remoteCursors,
    simBanner,
    wsConnected,
  };
}
