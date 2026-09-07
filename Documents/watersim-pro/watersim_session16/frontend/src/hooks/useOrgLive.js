/**
 * useOrgLive — the organisation-wide live feed for the plant screen.
 *
 * Connects to /ws/org (listen-only), reconnects with back-off, and hands each
 * message to the handler for its type:
 *
 *   plc:update    { values: [{ tagId, bindingId, nodeId, paramKey, value, quality, ts, flowsheetId }] }
 *   alarm:event   { event, transition: 'raised' | 'cleared' }
 *   task:event    { task, action }
 *   notification  { eventType, severity, subject, text, payload, at }
 *
 * Handlers are read through refs so a re-render never reconnects the socket.
 */
import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../context/AuthContext';

const WS_BASE = import.meta.env.VITE_WS_URL || 'ws://localhost:4000';
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

export function useOrgLive({ onPlcUpdate, onAlarmEvent, onTaskEvent, onNotification, onMessage } = {}) {
  const { user } = useAuth();
  const handlers = useRef({});
  handlers.current = { onPlcUpdate, onAlarmEvent, onTaskEvent, onNotification, onMessage };

  const [connected, setConnected] = useState(false);
  const [lastMessageAt, setLastMessageAt] = useState(null);

  useEffect(() => {
    if (!user || typeof WebSocket === 'undefined') return undefined;
    let ws = null;
    let retry = null;
    let delay = RECONNECT_BASE_MS;
    let closed = false;

    const connect = () => {
      const token = (() => { try { return localStorage.getItem('accessToken'); } catch { return null; } })();
      if (!token || closed) return;
      try {
        ws = new WebSocket(`${WS_BASE}/ws/org?token=${encodeURIComponent(token)}`);
      } catch {
        return;
      }
      ws.onopen = () => { delay = RECONNECT_BASE_MS; setConnected(true); };
      ws.onmessage = (evt) => {
        let msg;
        try { msg = JSON.parse(evt.data); } catch { return; }
        setLastMessageAt(Date.now());
        const h = handlers.current;
        switch (msg.type) {
          case 'plc:update':  h.onPlcUpdate?.(msg.payload?.values || []); break;
          case 'alarm:event': h.onAlarmEvent?.(msg.payload); break;
          case 'task:event':  h.onTaskEvent?.(msg.payload); break;
          case 'notification': h.onNotification?.(msg.payload); break;
          // twin:state, twin:script, twin:mode and anything newer.
          default: h.onMessage?.(msg); break;
        }
      };
      ws.onclose = () => {
        setConnected(false);
        if (closed) return;
        retry = setTimeout(connect, delay);
        delay = Math.min(RECONNECT_MAX_MS, Math.round(delay * 1.5));
      };
      ws.onerror = () => { try { ws.close(); } catch { /* already closed */ } };
    };

    connect();
    return () => {
      closed = true;
      if (retry) clearTimeout(retry);
      if (ws) { try { ws.close(1000, 'unmount'); } catch { /* ignore */ } }
    };
  }, [user]);

  return { connected, lastMessageAt };
}

export default useOrgLive;
