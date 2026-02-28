/**
 * Zustand store for global OPC connection state.
 *
 * Holds protocol, server, credentials, and connection status
 * shared across all OPC components (connection dialog, tag table).
 * Tag mappings remain on individual opc_read/opc_write nodes.
 */

import { create } from 'zustand';
import api from '../utils/api';

const useOpcStore = create((set, get) => ({
  // ── Connection state ──────────────────────────────────────────────
  protocol:     'da',            // 'da' | 'ua'
  endpointUrl:  '',              // UA endpoint
  daServer:     null,            // { progId, clsid, name, address }
  connStatus:   'disconnected',  // 'disconnected' | 'connecting' | 'connected' | 'error'
  connError:    null,

  // ── Discovery state ───────────────────────────────────────────────
  discoveryHost:     'localhost',
  discoveredServers: [],
  discovering:       false,
  discoveryError:    null,

  // ── DA credentials (not persisted to flowsheet) ───────────────────
  daUser:     'QCSApp',
  daPassword: '',

  // ── Setters ───────────────────────────────────────────────────────
  setProtocol: (p) => {
    if (p === get().protocol) return;
    set({ protocol: p, connStatus: 'disconnected', connError: null, discoveredServers: [], discoveryError: null });
  },
  setEndpointUrl:   (url) => set({ endpointUrl: url }),
  setDaServer:      (srv) => set({ daServer: srv }),
  setDiscoveryHost: (h)   => set({ discoveryHost: h }),
  setDaUser:        (u)   => set({ daUser: u }),
  setDaPassword:    (p)   => set({ daPassword: p }),

  // ── Discover servers ──────────────────────────────────────────────
  discover: async () => {
    const { protocol, discoveryHost } = get();
    set({ discovering: true, discoveryError: null, discoveredServers: [] });
    try {
      const host = discoveryHost.trim() || 'localhost';
      const route = protocol === 'da' ? '/opc/da/discover' : '/opc/discover';
      const { data } = await api.post(route, { hostname: host });
      const servers = data.servers || [];
      set({ discoveredServers: servers, discovering: false });
      if (servers.length === 0) {
        set({ discoveryError: `No OPC ${protocol === 'da' ? 'DA' : 'UA'} servers found.` });
      }
    } catch (err) {
      set({ discoveryError: err.response?.data?.error || err.message, discovering: false });
    }
  },

  // ── Connect ───────────────────────────────────────────────────────
  connect: async () => {
    const { protocol, endpointUrl, daServer, discoveryHost, daUser, daPassword } = get();
    set({ connStatus: 'connecting', connError: null });
    try {
      if (protocol === 'da') {
        if (!daServer?.progId) throw new Error('Select a DA server first');
        await api.post('/opc/da/connect', {
          progId: daServer.progId,
          address: daServer.address || discoveryHost || 'localhost',
          credentials: (daUser || daPassword)
            ? { user: daUser || undefined, password: daPassword || undefined }
            : undefined,
        });
      } else {
        if (!endpointUrl.trim()) throw new Error('Enter an endpoint URL');
        await api.post('/opc/connect', { endpointUrl });
      }
      set({ connStatus: 'connected' });
    } catch (err) {
      set({ connStatus: 'error', connError: err.response?.data?.error || err.message });
    }
  },

  // ── Disconnect ────────────────────────────────────────────────────
  disconnect: async () => {
    const { protocol, endpointUrl, daServer } = get();
    try {
      if (protocol === 'da' && daServer?.progId) {
        await api.post('/opc/da/disconnect', { progId: daServer.progId, address: daServer.address });
      } else if (endpointUrl) {
        await api.post('/opc/disconnect', { endpointUrl });
      }
    } catch (_) { /* ignore */ }
    set({ connStatus: 'disconnected', connError: null });
  },

  // ── Check status (restore on load) ────────────────────────────────
  checkStatus: async () => {
    const { protocol, endpointUrl, daServer } = get();
    try {
      if (protocol === 'da') {
        if (!daServer?.progId) return;
        const { data } = await api.get('/opc/da/status', {
          params: { progId: daServer.progId, address: daServer.address || 'localhost' },
        });
        set({ connStatus: data.status === 'connected' ? 'connected' : 'disconnected' });
      } else {
        if (!endpointUrl.trim()) return;
        const { data } = await api.get('/opc/status', { params: { endpointUrl } });
        set({ connStatus: data.status === 'connected' ? 'connected' : 'disconnected' });
      }
    } catch (_) { /* keep existing status */ }
  },

  // ── Mark disconnected (called on 500 / session-lost errors) ───────
  markDisconnected: (errorMsg) => {
    set({ connStatus: 'disconnected', connError: errorMsg || 'Session lost — reconnect to continue' });
  },

  // ── Hydrate from existing OPC node (called once on flowsheet load) ─
  hydrateFromNode: (params) => {
    if (!params) return;
    const updates = {};
    if (params.protocol) updates.protocol = params.protocol;
    if (params.endpointUrl) updates.endpointUrl = params.endpointUrl;
    if (params.daServer) updates.daServer = params.daServer;
    set(updates);
  },
}));

export default useOpcStore;
