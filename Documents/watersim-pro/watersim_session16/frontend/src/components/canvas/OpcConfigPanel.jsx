/**
 * OpcConfigPanel — Rich configuration panel for OPC Read / OPC Write nodes.
 *
 * Replaces the standard ParamPanel when an OPC node is selected.
 * Features:
 * - Protocol selector: OPC DA (classic COM/DCOM) or OPC UA (modern)
 * - Server discovery (DA: registry scan, UA: endpoint discovery)
 * - OPC server connection (connect/disconnect, status)
 * - Communication mode (synchronous with interval, or asynchronous)
 * - Tag mapping table (stream variable <-> OPC tag)
 * - OPC tag browser (UA: tree, DA: hierarchical tree) with manual fallback
 * - Read Now / Write Now action buttons
 */

import React, { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import api from '../../utils/api';

// ── Pressable button with visual click feedback ──────────────────────────────

function PressBtn({ style, onClick, disabled, children, title }) {
  const [pressed, setPressed] = useState(false);
  const bg = style?.background || '#ccc';
  const activeBg = pressed && !disabled ? darkenColor(bg) : bg;
  return (
    <button
      style={{ ...style, background: activeBg, transition: 'background 0.1s, transform 0.1s', transform: pressed ? 'scale(0.96)' : 'scale(1)' }}
      onMouseDown={() => setPressed(true)}
      onMouseUp={() => setPressed(false)}
      onMouseLeave={() => setPressed(false)}
      onClick={onClick}
      disabled={disabled}
      title={title}
    >
      {children}
    </button>
  );
}

function darkenColor(hex) {
  // Simple darken: reduce each RGB channel by ~20%
  if (!hex || hex[0] !== '#') return hex;
  const num = parseInt(hex.slice(1), 16);
  const r = Math.max(0, ((num >> 16) & 0xFF) - 40);
  const g = Math.max(0, ((num >> 8) & 0xFF) - 40);
  const b = Math.max(0, (num & 0xFF) - 40);
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`;
}

// ── Stream variables available for mapping ───────────────────────────────────

const STREAM_VARS = [
  { key: 'Q',    label: 'Flow (Q) — m³/d' },
  { key: 'TSS',  label: 'TSS — mg/L' },
  { key: 'BOD',  label: 'BOD — mg/L' },
  { key: 'COD',  label: 'COD — mg/L' },
  { key: 'TN',   label: 'TN — mg/L' },
  { key: 'NH4',  label: 'NH₄ — mg/L' },
  { key: 'NO3',  label: 'NO₃ — mg/L' },
  { key: 'NO2',  label: 'NO₂ — mg/L' },
  { key: 'TP',   label: 'TP — mg/L' },
  { key: 'DO',   label: 'DO — mg/L' },
  { key: 'pH',   label: 'pH' },
  { key: 'temp', label: 'Temp — °C' },
];

// ── OPC Tag Browser Modal (UA tree + DA flat) ────────────────────────────────

function TagBrowser({ protocol, endpointUrl, daServer, onSelect, onClose }) {
  const [tree, setTree] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [expandedNodes, setExpandedNodes] = useState(new Set());
  const [childrenMap, setChildrenMap] = useState({});
  const [manualTag, setManualTag] = useState('');
  const [filter, setFilter] = useState('');

  useEffect(() => {
    if (protocol === 'da') {
      loadDaTags();
    } else {
      loadChildren(null);
    }
  }, []);

  // UA: load children of a node
  const loadChildren = async (nodeId) => {
    setLoading(true);
    setError(null);
    try {
      const { data } = await api.post('/opc/browse', { endpointUrl, nodeId: nodeId || undefined });
      if (nodeId) {
        setChildrenMap(prev => ({ ...prev, [nodeId]: data.nodes || [] }));
      } else {
        setTree(data.nodes || []);
      }
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setLoading(false);
    }
  };

  // DA: load tags and build tree from flat browse results
  const loadDaTags = async () => {
    setLoading(true);
    setError(null);
    try {
      const { data } = await api.post('/opc/da/browse', {
        progId: daServer?.progId,
        address: daServer?.address || 'localhost',
      });
      // Backend returns flat list with folders (isFolder=true) and leaves,
      // each with a parentPath field indicating which folder they belong to.
      // Build a nested tree: folders contain children, leaves are selectable.
      const nodes = data.nodes || [];
      const folderMap = {}; // folder itemID -> tree node
      const roots = [];

      // First pass: create all folder nodes
      for (const n of nodes) {
        if (!n.isFolder) continue;
        folderMap[n.itemID || n.name] = {
          nodeId: n.itemID || n.name,
          displayName: n.name || n.itemID,
          isFolder: true,
          children: [],
        };
      }

      // Second pass: place all nodes (folders + leaves) under their parent
      for (const n of nodes) {
        const treeNode = n.isFolder
          ? folderMap[n.itemID || n.name]
          : { nodeId: n.itemID || n.name, displayName: n.name || n.itemID, isFolder: false, children: [] };

        const parent = n.parentPath ? folderMap[n.parentPath] : null;
        if (parent) {
          parent.children.push(treeNode);
        } else {
          roots.push(treeNode);
        }
      }

      setTree(roots);
      // Pre-load children into childrenMap for folder expansion
      const cMap = {};
      for (const [, folder] of Object.entries(folderMap)) {
        if (folder.children.length > 0) {
          cMap[folder.nodeId] = folder.children;
        }
      }
      setChildrenMap(cMap);
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setLoading(false);
    }
  };

  const toggleExpand = (nodeId) => {
    const next = new Set(expandedNodes);
    if (next.has(nodeId)) {
      next.delete(nodeId);
    } else {
      next.add(nodeId);
      if (!childrenMap[nodeId]) loadChildren(nodeId);
    }
    setExpandedNodes(next);
  };

  const renderNode = (node, depth = 0) => {
    const isExpanded = expandedNodes.has(node.nodeId);
    // For DA tree: use inline children; for UA: use childrenMap from API
    const children = node.children || childrenMap[node.nodeId] || [];

    return (
      <div key={node.nodeId}>
        <div
          style={{ ...S.treeItem, paddingLeft: 12 + depth * 16 }}
          onClick={() => {
            if (node.isFolder) {
              toggleExpand(node.nodeId);
            } else {
              onSelect(node.nodeId);
            }
          }}
        >
          <span style={{ marginRight: 6, fontSize: 12 }}>
            {node.isFolder ? (isExpanded ? '▼' : '▶') : '•'}
          </span>
          <span style={{ flex: 1, fontSize: 12 }}>{node.displayName || node.browseName}</span>
          {!node.isFolder && (
            <span style={{ fontSize: 10, color: '#9CA3AF' }}>{node.nodeId}</span>
          )}
        </div>
        {isExpanded && children.map(child => renderNode(child, depth + 1))}
      </div>
    );
  };

  // Filter: for DA tree, search recursively; for UA flat, search top-level
  const matchesFilter = (node, term) => {
    if ((node.displayName || node.nodeId || '').toLowerCase().includes(term)) return true;
    const children = node.children || [];
    return children.some(c => matchesFilter(c, term));
  };
  const filteredTree = filter
    ? tree.filter(n => matchesFilter(n, filter.toLowerCase()))
    : tree;

  return (
    <div style={S.browserOverlay}>
      <div style={S.browserModal}>
        <div style={S.browserHeader}>
          <span style={{ fontWeight: 700, fontSize: 13 }}>
            Browse {protocol === 'da' ? 'DA' : 'UA'} Tags
          </span>
          <button style={S.closeBtn} onClick={onClose}>✕</button>
        </div>

        {error && (
          <div style={S.browserError}>
            Browse failed: {error}
            <div style={{ marginTop: 8, fontSize: 12 }}>Enter tag ID manually below:</div>
          </div>
        )}

        {/* Filter input for DA tag tree */}
        {protocol === 'da' && !error && (
          <div style={{ padding: '6px 16px', borderBottom: '1px solid #E5E7EB' }}>
            <input
              type="text"
              placeholder="Filter tags..."
              value={filter}
              onChange={e => setFilter(e.target.value)}
              style={{ ...S.manualInput, width: '100%' }}
            />
          </div>
        )}

        {/* Tree / list view */}
        <div style={S.treeContainer}>
          {loading && tree.length === 0 && <div style={{ padding: 12, fontSize: 12, color: '#9CA3AF' }}>Loading...</div>}
          {filteredTree.map(node => renderNode(node))}
        </div>

        {/* Manual tag entry fallback */}
        <div style={S.manualEntry}>
          <input
            type="text"
            placeholder={protocol === 'da' ? 'Manual item ID (e.g., Random.Int1)' : 'Manual tag ID (e.g., ns=2;s=Flow.PV)'}
            value={manualTag}
            onChange={e => setManualTag(e.target.value)}
            style={S.manualInput}
          />
          <PressBtn
            style={{ ...S.btn, background: '#1D4ED8', color: '#fff', fontSize: 11 }}
            onClick={() => { if (manualTag.trim()) onSelect(manualTag.trim()); }}
            disabled={!manualTag.trim()}
          >
            Use Tag
          </PressBtn>
        </div>
      </div>
    </div>
  );
}

// ── Main OPC Config Panel ────────────────────────────────────────────────────

export default function OpcConfigPanel({ node, edges, unitResult, onUpdateParam, onClose }) {
  const isRead = node.data.opType === 'opc_read';
  const params = node.data.params || {};

  // ── Protocol selection (DA vs UA) ──────────────────────────────────────────
  const [protocol, setProtocol] = useState(params.protocol || 'ua');

  // ── UA state ──────────────────────────────────────────────────────────────
  const [endpointUrl, setEndpointUrl] = useState(params.endpointUrl || '');

  // ── DA state ──────────────────────────────────────────────────────────────
  const [daServer, setDaServer] = useState(params.daServer || null); // { progId, clsid, name, address }
  const [daUser, setDaUser] = useState('QCSApp');     // DCOM username (not persisted)
  const [daPassword, setDaPassword] = useState('');   // Windows password for DCOM NTLM auth (not persisted)

  // ── Shared state ──────────────────────────────────────────────────────────
  const [connStatus, setConnStatus] = useState(params._connStatus || 'disconnected');
  const [connError, setConnError] = useState(null);

  // Discovery
  const [discoveryHost, setDiscoveryHost] = useState('localhost');
  const [discoveredServers, setDiscoveredServers] = useState([]);
  const [discovering, setDiscovering] = useState(false);
  const [discoveryError, setDiscoveryError] = useState(null);

  const [mode, setMode] = useState(params.mode || 'sync');
  const [intervalSec, setIntervalSec] = useState(params.intervalSec || 5);
  const [tagMappings, setTagMappings] = useState(() => {
    const saved = params.tagMappings || [];
    console.log('[OPC Init] node=%s, params.tagMappings=%d entries: %o', node.id, saved.length, saved);
    return saved;
  });
  const [manualOverrides, setManualOverrides] = useState(() =>
    (params.tagMappings || []).map(m => ({ enabled: m.manualOverride ?? false, value: m.manualValue ?? '' }))
  );
  const [browseRow, setBrowseRow] = useState(null);
  const [polling, setPolling] = useState(false);
  const [actionStatus, setActionStatus] = useState(null);
  const pollRef = useRef(null);

  // Refs to always call the latest readNow/writeNow (avoids stale closures in setInterval)
  const readNowRef = useRef(null);
  const writeNowRef = useRef(null);
  const busyRef = useRef(false); // prevent overlapping poll ticks

  // ── Compute input stream values for this node (for write) ─────────────────
  const inputStreamValues = useMemo(() => {
    // Source 1: inbound edge streamResult (live simulation data)
    if (edges) {
      const inEdge = edges.find(e => e.target === node.id);
      if (inEdge?.data?.streamResult) return inEdge.data.streamResult;
    }
    // Source 2: unitResult outputs from simulation run
    if (unitResult?.outputs?.effluent) return unitResult.outputs.effluent;
    return {};
  }, [edges, node.id, unitResult]);

  // ── Restore connection status on mount ────────────────────────────────────
  // Try backend status check first; if route unavailable, trust saved status
  useEffect(() => {
    const checkStatus = async () => {
      try {
        if (protocol === 'da') {
          if (!daServer?.progId) return;
          const { data } = await api.get('/opc/da/status', {
            params: { progId: daServer.progId, address: daServer.address || 'localhost' },
          });
          setConnStatus(data.status === 'connected' ? 'connected' : 'disconnected');
        } else {
          if (!endpointUrl.trim()) return;
          const { data } = await api.get('/opc/status', { params: { endpointUrl } });
          setConnStatus(data.status === 'connected' ? 'connected' : 'disconnected');
        }
      } catch (_) {
        // If route 404 or network error, keep the saved status from params
      }
    };
    checkStatus();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Reset connection when protocol changes
  const switchProtocol = (p) => {
    if (p === protocol) return;
    stopPolling();
    setConnStatus('disconnected');
    setConnError(null);
    setDiscoveredServers([]);
    setDiscoveryError(null);
    setProtocol(p);
  };

  // ── Save to node params ────────────────────────────────────────────────────
  const save = useCallback(() => {
    // Merge manual override info into tagMappings for persistence
    const enrichedMappings = tagMappings.map((m, idx) => ({
      ...m,
      manualOverride: manualOverrides[idx]?.enabled || false,
      manualValue: manualOverrides[idx]?.value || '',
    }));
    console.log('[OPC Save] tagMappings=%d, enriched=%o', enrichedMappings.length, enrichedMappings);
    const cfg = { protocol, endpointUrl, daServer, mode, intervalSec, tagMappings: enrichedMappings, _connStatus: connStatus };
    for (const [k, v] of Object.entries(cfg)) {
      onUpdateParam(node.id, k, v);
    }
  }, [protocol, endpointUrl, daServer, mode, intervalSec, tagMappings, manualOverrides, connStatus, node.id, onUpdateParam]);

  // ── Auto-save on unmount ──────────────────────────────────────────────────
  const saveRef = useRef(save);
  saveRef.current = save; // Synchronous — always the latest save on unmount (useEffect would lag 1 render)
  useEffect(() => () => { saveRef.current(); }, []);

  // Keep a ref for manualOverrides so readNow auto-save never captures stale closure
  const manualOverridesRef = useRef(manualOverrides);
  manualOverridesRef.current = manualOverrides;

  // ── Connect / Disconnect ───────────────────────────────────────────────────
  const handleConnect = async () => {
    setConnStatus('connecting');
    setConnError(null);
    try {
      if (protocol === 'da') {
        if (!daServer?.progId) throw new Error('Select a DA server first');
        await api.post('/opc/da/connect', {
          progId: daServer.progId,
          address: daServer.address || discoveryHost || 'localhost',
          credentials: (daUser || daPassword) ? { user: daUser || undefined, password: daPassword || undefined } : undefined,
        });
      } else {
        if (!endpointUrl.trim()) return;
        await api.post('/opc/connect', { endpointUrl });
      }
      setConnStatus('connected');
    } catch (err) {
      setConnStatus('error');
      setConnError(err.response?.data?.error || err.message);
    }
  };

  const handleDisconnect = async () => {
    try {
      if (protocol === 'da' && daServer?.progId) {
        await api.post('/opc/da/disconnect', { progId: daServer.progId, address: daServer.address });
      } else {
        await api.post('/opc/disconnect', { endpointUrl });
      }
    } catch (_) { /* ignore */ }
    setConnStatus('disconnected');
    setConnError(null);
    stopPolling();
  };

  // ── Discover Servers ──────────────────────────────────────────────────────
  const handleDiscover = async () => {
    setDiscovering(true);
    setDiscoveryError(null);
    setDiscoveredServers([]);
    try {
      const host = discoveryHost.trim() || 'localhost';
      if (protocol === 'da') {
        const { data } = await api.post('/opc/da/discover', { hostname: host });
        setDiscoveredServers(data.servers || []);
        if ((data.servers || []).length === 0) {
          setDiscoveryError('No OPC DA servers found on this host.');
        }
      } else {
        const { data } = await api.post('/opc/discover', { hostname: host });
        setDiscoveredServers(data.servers || []);
        if ((data.servers || []).length === 0) {
          setDiscoveryError('No OPC UA servers found on this host.');
        }
      }
    } catch (err) {
      setDiscoveryError(err.response?.data?.error || err.message);
    } finally {
      setDiscovering(false);
    }
  };

  const selectUaServer = (epUrl) => setEndpointUrl(epUrl);

  const selectDaServer = (srv) => {
    setDaServer({ ...srv, address: discoveryHost.trim() || 'localhost' });
  };

  // ── Tag Mapping CRUD ───────────────────────────────────────────────────────
  const addMapping = () => {
    setTagMappings(prev => [...prev, { streamVar: 'Q', opcTag: '', lastValue: null }]);
    setManualOverrides(prev => [...prev, { enabled: false, value: '' }]);
  };

  const updateMapping = (idx, field, value) => {
    setTagMappings(prev => prev.map((m, i) => {
      if (i !== idx) return m;
      const updated = { ...m, [field]: value };
      // When changing stream variable, auto-populate OPC tag from existing or saved mappings
      if (field === 'streamVar') {
        const fromCurrent = prev.find((om, oi) => oi !== idx && om.streamVar === value && om.opcTag);
        const fromSaved = (params.tagMappings || []).find(sm => sm.streamVar === value && sm.opcTag);
        const lookup = fromCurrent || fromSaved;
        if (lookup) {
          updated.opcTag = lookup.opcTag;
          updated.lastValue = lookup.lastValue ?? null;
        } else {
          // No known mapping — clear tag for fresh selection
          updated.opcTag = '';
          updated.lastValue = null;
        }
      }
      return updated;
    }));
  };

  const removeMapping = (idx) => {
    setTagMappings(prev => prev.filter((_, i) => i !== idx));
    setManualOverrides(prev => prev.filter((_, i) => i !== idx));
  };

  const toggleManualOverride = (idx) => {
    setManualOverrides(prev => prev.map((o, i) => i === idx ? { ...o, enabled: !o.enabled } : o));
  };

  const updateManualValue = (idx, value) => {
    setManualOverrides(prev => prev.map((o, i) => i === idx ? { ...o, value } : o));
  };

  const handleBrowseSelect = (tagId) => {
    if (browseRow !== null) updateMapping(browseRow, 'opcTag', tagId);
    setBrowseRow(null);
  };

  // ── Read Now ───────────────────────────────────────────────────────────────
  const readNow = async () => {
    if (busyRef.current) return; // skip if previous operation in flight
    const withTag = tagMappings.filter(m => m.opcTag);
    const tagIds = withTag.map(m => m.opcTag);
    console.log('[OPC Read] mappings=%d, withTag=%d, tagIds=%o', tagMappings.length, withTag.length, tagIds);
    if (tagIds.length === 0) return;

    busyRef.current = true;
    try {
      let values;
      if (protocol === 'da') {
        const { data } = await api.post('/opc/da/read', {
          progId: daServer?.progId,
          address: daServer?.address || 'localhost',
          tagIds,
        });
        values = data.values || [];
      } else {
        const { data } = await api.post('/opc/read', { endpointUrl, tagIds });
        values = data.values || [];
      }
      const good = values.filter(v => v.isGood);
      const bad = values.filter(v => !v.isGood);
      setTagMappings(prev => {
        const updated = prev.map(m => {
          const match = values.find(v => v.tagId === m.opcTag);
          return match ? { ...m, lastValue: match.value } : m;
        });
        // Auto-save read values to node params so simulation model can use them
        const curOverrides = manualOverridesRef.current; // use ref, never stale
        setTimeout(() => {
          const enriched = updated.map((m, idx) => ({
            ...m,
            manualOverride: curOverrides[idx]?.enabled || false,
            manualValue: curOverrides[idx]?.value || '',
          }));
          onUpdateParam(node.id, 'tagMappings', enriched);
        }, 0);
        return updated;
      });
      const msg = bad.length === 0
        ? `Read ${good.length}/${tagIds.length} tags OK`
        : `Read ${good.length}/${tagIds.length} — ${bad.map(b => `${b.tagId}: ${b.error || 'Bad'}`).join(', ')}`;
      setActionStatus({ type: good.length > 0 ? 'success' : 'error', msg });
      if (!polling) setTimeout(() => setActionStatus(null), 3000);
    } catch (err) {
      const msg = err.response?.data?.error || err.message;
      setActionStatus({ type: 'error', msg });
      // Server error (500) or "Not connected" → session is dead, auto-disconnect
      if (err.response?.status >= 500 || /not connected/i.test(msg)) {
        setConnStatus('disconnected');
        setConnError('Session lost — reconnect to continue');
      }
      if (!polling) setTimeout(() => setActionStatus(null), 3000);
    } finally {
      busyRef.current = false;
    }
  };

  // ── Write Now ──────────────────────────────────────────────────────────────
  const writeNow = async () => {
    if (busyRef.current) return; // skip if previous operation in flight
    // Also check unitResult writePayload as a third source of sim values
    const writePayload = (!isRead && unitResult?.metrics?.writePayload) || [];
    const payloadMap = {};
    for (const wp of writePayload) {
      if (wp.opcTag && wp.value != null) payloadMap[wp.opcTag] = wp.value;
    }

    const withTag = tagMappings.filter(m => m.opcTag);
    const tags = [];
    const skippedNoValue = [];
    for (let i = 0; i < tagMappings.length; i++) {
      const m = tagMappings[i];
      if (!m.opcTag) continue;

      const override = manualOverrides[i];
      let raw;
      if (override?.enabled) {
        // Manual override: use the text box value
        raw = override.value;
      } else {
        // Default: use simulation stream value from edge, then unitResult, then writePayload
        raw = inputStreamValues[m.streamVar];
        if (raw == null) raw = payloadMap[m.opcTag];
      }
      // Allow 0 values — only skip truly empty/null
      if (raw == null || raw === '') { skippedNoValue.push(m.streamVar); continue; }

      // Coerce: preserve numeric types, don't force strings to NaN
      const asNum = Number(raw);
      const value = (typeof raw === 'number') ? raw
        : (typeof raw === 'string' && raw.trim() !== '' && !isNaN(asNum)) ? asNum
        : raw;
      tags.push({ tagId: m.opcTag, value });
    }

    console.log('[OPC Write] mappings=%d, withTag=%d, withValue=%d, skippedNoValue=%o, tags=%o',
      tagMappings.length, withTag.length, tags.length, skippedNoValue, tags);

    if (tags.length === 0) {
      const hasNoSim = Object.keys(inputStreamValues).length === 0 && writePayload.length === 0;
      const detail = skippedNoValue.length > 0
        ? `${skippedNoValue.length} tag(s) skipped (no value for: ${skippedNoValue.join(', ')})`
        : '';
      setActionStatus({ type: 'error', msg: hasNoSim ? 'No stream values — run simulation' : `No tags with values to write. ${detail}` });
      if (!polling) setTimeout(() => setActionStatus(null), 4000);
      return;
    }

    busyRef.current = true;
    try {
      let results;
      if (protocol === 'da') {
        const { data } = await api.post('/opc/da/write', {
          progId: daServer?.progId,
          address: daServer?.address || 'localhost',
          tags,
        });
        results = data.results || [];
      } else {
        const { data } = await api.post('/opc/write', { endpointUrl, tags });
        results = data.results || [];
      }
      const ok = results.filter(r => r.isGood).length;
      const failed = results.filter(r => !r.isGood);
      const skipNote = skippedNoValue.length > 0 ? ` (${skippedNoValue.length} skipped: no value)` : '';
      const msg = ok === tags.length
        ? `Wrote ${ok}/${tags.length} tags OK${skipNote}`
        : `Wrote ${ok}/${tags.length} — ${failed.map(f => `${f.tagId}: ${f.error || 'Bad'}`).join(', ')}${skipNote}`;
      setActionStatus({ type: ok === tags.length ? 'success' : 'error', msg });
      if (!polling) setTimeout(() => setActionStatus(null), 2000);
    } catch (err) {
      const msg = err.response?.data?.error || err.message;
      setActionStatus({ type: 'error', msg });
      // Server error (500) or "Not connected" → session is dead, auto-disconnect
      if (err.response?.status >= 500 || /not connected/i.test(msg)) {
        setConnStatus('disconnected');
        setConnError('Session lost — reconnect to continue');
      }
      if (!polling) setTimeout(() => setActionStatus(null), 3000);
    } finally {
      busyRef.current = false;
    }
  };

  // ── Continuous Polling (Read / Write at sample rate) ─────────────────────
  // Keep refs pointing to the latest functions so setInterval never goes stale
  readNowRef.current = readNow;
  writeNowRef.current = writeNow;

  const startPolling = () => { if (!polling) setPolling(true); };
  const stopPolling = () => { setPolling(false); setActionStatus(null); };

  // Manage the interval via effect — recreated whenever polling/interval/mode changes
  useEffect(() => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    if (!polling || connStatus !== 'connected') return;

    const effectiveMs = intervalSec * 1000;
    const tick = async () => {
      if (isRead) await readNowRef.current();
      else await writeNowRef.current();
    };
    tick(); // immediate first execution
    pollRef.current = setInterval(tick, effectiveMs);

    return () => { if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; } };
  }, [polling, intervalSec, isRead, connStatus]); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-start polling when connected and at least one tag is configured
  useEffect(() => {
    if (connStatus === 'connected' && tagMappings.some(m => m.opcTag)) {
      setPolling(true);
    }
  }, [connStatus]); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-stop polling when disconnected
  useEffect(() => {
    if (connStatus !== 'connected') setPolling(false);
  }, [connStatus]);

  // Cleanup on unmount
  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current); }, []);

  // ── Render ─────────────────────────────────────────────────────────────────
  const statusDot = {
    disconnected: '#9CA3AF',
    connecting: '#F59E0B',
    connected: '#16A34A',
    error: '#DC2626',
  }[connStatus];

  const canConnect = protocol === 'da'
    ? !!daServer?.progId
    : !!endpointUrl.trim();

  return (
    <div>
      {/* Header */}
      <div style={S.panelHdr}>
        <div>
          <div style={{ fontWeight: 700, fontSize: 13, color: '#1F4E79' }}>{node.data.label}</div>
          <div style={{ fontSize: 11, color: '#9CA3AF' }}>{isRead ? 'OPC Read' : 'OPC Write'}</div>
        </div>
        <button style={S.closeBtn} onClick={() => { save(); onClose(); }}>✕</button>
      </div>

      {/* ── Protocol Toggle (DA / UA) ─────────────────────────────── */}
      <div style={S.section}>
        <div style={S.secTitle}>Protocol</div>
        <div style={S.protocolToggle}>
          <button
            style={{
              ...S.protocolBtn,
              ...(protocol === 'da' ? S.protocolActive : S.protocolInactive),
            }}
            onClick={() => switchProtocol('da')}
          >
            OPC DA
          </button>
          <button
            style={{
              ...S.protocolBtn,
              ...(protocol === 'ua' ? S.protocolActive : S.protocolInactive),
            }}
            onClick={() => switchProtocol('ua')}
          >
            OPC UA
          </button>
        </div>
        <div style={{ fontSize: 10, color: '#9CA3AF', marginTop: 4 }}>
          {protocol === 'da'
            ? 'Classic OPC (COM/DCOM) — Windows only'
            : 'Modern OPC Unified Architecture'}
        </div>
      </div>

      {/* ── Server Discovery ──────────────────────────────────────── */}
      <div style={S.section}>
        <div style={S.secTitle}>Server Discovery</div>
        <div style={{ display: 'flex', gap: 4, marginBottom: 6 }}>
          <input
            type="text"
            placeholder="localhost or IP address"
            value={discoveryHost}
            onChange={e => setDiscoveryHost(e.target.value)}
            style={{ ...S.input, flex: 1 }}
          />
          <PressBtn
            style={{ ...S.btn, background: '#4F46E5', color: '#fff', whiteSpace: 'nowrap' }}
            onClick={handleDiscover}
            disabled={discovering}
          >
            {discovering ? 'Searching...' : 'Discover'}
          </PressBtn>
        </div>

        {discoveryError && (
          <div style={{ fontSize: 11, color: '#DC2626', marginBottom: 6, padding: '4px 8px', background: '#FEF2F2', borderRadius: 4 }}>
            {discoveryError}
          </div>
        )}

        {/* DA server list */}
        {protocol === 'da' && discoveredServers.length > 0 && (
          <div style={S.serverList}>
            {discoveredServers.map((srv, si) => (
              <div
                key={si}
                style={{
                  ...S.serverItem,
                  background: daServer?.progId === srv.progId ? '#EFF6FF' : '#fff',
                  border: daServer?.progId === srv.progId ? '1px solid #3B82F6' : '1px solid #E5E7EB',
                }}
                onClick={() => selectDaServer(srv)}
              >
                <span style={{ fontSize: 14, color: daServer?.progId === srv.progId ? '#3B82F6' : '#9CA3AF' }}>
                  {daServer?.progId === srv.progId ? '●' : '○'}
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 11, fontWeight: 600, color: '#1F2937' }}>{srv.name || srv.progId}</div>
                  <div style={{ fontSize: 10, color: '#6B7280' }}>ProgID: {srv.progId}</div>
                  <div style={{ fontSize: 10, color: '#9CA3AF', wordBreak: 'break-all' }}>CLSID: {srv.clsid}</div>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* UA server list */}
        {protocol === 'ua' && discoveredServers.length > 0 && (
          <div style={S.serverList}>
            {discoveredServers.map((srv, si) => (
              <div key={si}>
                <div style={{ fontSize: 11, fontWeight: 700, color: '#374151', padding: '4px 0 2px' }}>
                  {srv.serverName}
                </div>
                {(srv.endpoints || []).map((ep, ei) => (
                  <div
                    key={ei}
                    style={{
                      ...S.serverItem,
                      background: endpointUrl === ep.endpointUrl ? '#EFF6FF' : '#fff',
                      border: endpointUrl === ep.endpointUrl ? '1px solid #3B82F6' : '1px solid #E5E7EB',
                    }}
                    onClick={() => selectUaServer(ep.endpointUrl)}
                  >
                    <span style={{ fontSize: 14, color: endpointUrl === ep.endpointUrl ? '#3B82F6' : '#9CA3AF' }}>
                      {endpointUrl === ep.endpointUrl ? '●' : '○'}
                    </span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 11, color: '#1F2937', wordBreak: 'break-all' }}>{ep.endpointUrl}</div>
                      <div style={{ fontSize: 10, color: '#9CA3AF' }}>Security: {ep.securityMode} / {ep.securityPolicy}</div>
                    </div>
                  </div>
                ))}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── Connection ────────────────────────────────────────────── */}
      <div style={S.section}>
        <div style={S.secTitle}>Connection</div>

        {/* UA: endpoint URL input */}
        {protocol === 'ua' && (
          <div style={{ display: 'flex', gap: 4, marginBottom: 6 }}>
            <input
              type="text"
              placeholder="opc.tcp://192.168.1.100:4840"
              value={endpointUrl}
              onChange={e => setEndpointUrl(e.target.value)}
              style={{ ...S.input, flex: 1 }}
            />
          </div>
        )}

        {/* DA: selected server info */}
        {protocol === 'da' && daServer && (
          <div style={{ fontSize: 11, color: '#374151', marginBottom: 6, padding: '4px 8px', background: '#F3F4F6', borderRadius: 4 }}>
            <strong>{daServer.name || daServer.progId}</strong>
            <div style={{ fontSize: 10, color: '#6B7280' }}>{daServer.progId} @ {daServer.address || 'localhost'}</div>
          </div>
        )}
        {protocol === 'da' && !daServer && (
          <div style={{ fontSize: 11, color: '#9CA3AF', fontStyle: 'italic', marginBottom: 6 }}>
            Discover and select a DA server above
          </div>
        )}

        {/* DA: DCOM credentials (username + password) for NTLM authentication */}
        {protocol === 'da' && daServer && (
          <>
            <div style={{ display: 'flex', gap: 4, marginBottom: 4, alignItems: 'center' }}>
              <label style={{ fontSize: 11, color: '#6B7280', whiteSpace: 'nowrap', width: 62 }}>User:</label>
              <input
                type="text"
                placeholder="Username (e.g., QCSApp)"
                value={daUser}
                onChange={e => setDaUser(e.target.value)}
                style={{ ...S.input, flex: 1, fontSize: 11 }}
              />
            </div>
            <div style={{ display: 'flex', gap: 4, marginBottom: 6, alignItems: 'center' }}>
              <label style={{ fontSize: 11, color: '#6B7280', whiteSpace: 'nowrap', width: 62 }}>Password:</label>
              <input
                type="password"
                placeholder="Windows password"
                value={daPassword}
                onChange={e => setDaPassword(e.target.value)}
                style={{ ...S.input, flex: 1, fontSize: 11 }}
              />
            </div>
          </>
        )}

        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          {connStatus !== 'connected' ? (
            <PressBtn
              style={{ ...S.btn, background: '#1D4ED8', color: '#fff' }}
              onClick={handleConnect}
              disabled={connStatus === 'connecting' || !canConnect}
            >
              {connStatus === 'connecting' ? 'Connecting...' : 'Connect'}
            </PressBtn>
          ) : (
            <PressBtn style={{ ...S.btn, background: '#DC2626', color: '#fff' }} onClick={handleDisconnect}>
              Disconnect
            </PressBtn>
          )}
          <span style={{ fontSize: 11, display: 'flex', alignItems: 'center', gap: 4 }}>
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: statusDot, display: 'inline-block' }} />
            {connStatus}
          </span>
        </div>
        {connError && <div style={{ fontSize: 11, color: '#DC2626', marginTop: 4 }}>{connError}</div>}
      </div>

      {/* ── Communication Mode ───────────────────────────────────── */}
      <div style={S.section}>
        <div style={S.secTitle}>Communication Mode</div>
        <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
          <label style={S.radioLabel}>
            <input type="radio" name={`mode-${node.id}`} value="sync" checked={mode === 'sync'} onChange={() => setMode('sync')} />
            Synchronous
          </label>
          <label style={S.radioLabel}>
            <input type="radio" name={`mode-${node.id}`} value="async" checked={mode === 'async'} onChange={() => setMode('async')} />
            Asynchronous
          </label>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <label style={{ fontSize: 12, color: '#374151' }}>Interval:</label>
          <input
            type="number" min={1} max={3600} step={1}
            value={intervalSec}
            onChange={e => setIntervalSec(Math.max(1, Number(e.target.value)))}
            style={{ ...S.input, width: 60, textAlign: 'right' }}
          />
          <span style={{ fontSize: 11, color: '#6B7280' }}>sec</span>
          {connStatus === 'connected' && (
            polling
              ? <PressBtn style={{ ...S.btn, background: '#DC2626', color: '#fff', marginLeft: 'auto' }} onClick={stopPolling}>Stop</PressBtn>
              : <PressBtn style={{ ...S.btn, background: '#059669', color: '#fff', marginLeft: 'auto' }} onClick={startPolling}>Start</PressBtn>
          )}
        </div>
        {polling && connStatus === 'connected' && (
          <div style={{ fontSize: 10, color: '#059669', marginTop: 4 }}>
            Polling active — {isRead ? 'reading' : 'writing'} every {intervalSec}s
          </div>
        )}
      </div>

      {/* ── Sim Data Status ──────────────────────────────────────── */}
      {!isRead && (() => {
        const hasSimValues = Object.keys(inputStreamValues).length > 0;
        const inEdge = edges?.find(e => e.target === node.id);
        const hasInboundEdge = !!inEdge;
        const edgeHasStream = !!inEdge?.data?.streamResult;
        return (
          <div style={{ padding: '6px 14px', borderBottom: '1px solid #E5E7EB', fontSize: 10 }}>
            {hasSimValues ? (
              <div style={{ color: '#065F46', background: '#ECFDF5', padding: '3px 6px', borderRadius: 3 }}>
                <strong>Stream values:</strong>{' '}
                {Object.entries(inputStreamValues).slice(0, 5).map(([k, v]) => `${k}=${typeof v === 'number' ? v.toFixed(1) : v}`).join(', ')}
                {Object.keys(inputStreamValues).length > 5 ? '...' : ''}
              </div>
            ) : (
              <div style={{ color: '#991B1B', background: '#FEF2F2', padding: '3px 6px', borderRadius: 3 }}>
                {!hasInboundEdge
                  ? <><strong>No input edge.</strong> Connect a process node to this OPC Write node first.</>
                  : <><strong>No stream data.</strong> Run simulation to populate stream values for writing.</>}
              </div>
            )}
          </div>
        );
      })()}

      {/* ── Tag Mapping Table ────────────────────────────────────── */}
      <div style={S.section}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
          <div style={S.secTitle}>Tag Mappings</div>
          <PressBtn style={{ ...S.btn, background: '#1D4ED8', color: '#fff', fontSize: 11, padding: '3px 8px' }} onClick={addMapping}>
            + Add
          </PressBtn>
        </div>

        {tagMappings.length === 0 && (
          <div style={{ fontSize: 12, color: '#9CA3AF', fontStyle: 'italic', padding: '8px 0' }}>
            No tag mappings configured. Click "+ Add" to map stream variables to OPC tags.
          </div>
        )}

        {tagMappings.map((mapping, idx) => (
          <div key={idx} style={S.mappingRow}>
            <select
              value={mapping.streamVar}
              onChange={e => updateMapping(idx, 'streamVar', e.target.value)}
              style={{ ...S.input, width: 80, fontSize: 11 }}
            >
              {STREAM_VARS.map(sv => (
                <option key={sv.key} value={sv.key}>{sv.key}</option>
              ))}
            </select>

            <span style={{ fontSize: 14, color: '#9CA3AF' }}>{isRead ? '←' : '→'}</span>

            <div style={{ flex: 1, display: 'flex', gap: 2 }}>
              <input
                type="text"
                placeholder={protocol === 'da' ? 'Random.Int1' : 'ns=2;s=Tag.PV'}
                value={mapping.opcTag}
                onChange={e => updateMapping(idx, 'opcTag', e.target.value)}
                style={{ ...S.input, flex: 1, fontSize: 11 }}
              />
              <PressBtn
                style={{ ...S.btn, background: '#F3F4F6', color: '#374151', fontSize: 10, padding: '2px 6px' }}
                onClick={() => setBrowseRow(idx)}
                disabled={connStatus !== 'connected'}
                title="Browse OPC tags"
              >
                ...
              </PressBtn>
            </div>

            {isRead ? (
              mapping.lastValue != null && (
                <span style={{ fontSize: 10, color: '#059669', fontWeight: 600, minWidth: 40, textAlign: 'right' }}>
                  {typeof mapping.lastValue === 'number' ? mapping.lastValue.toFixed(2) : String(mapping.lastValue)}
                </span>
              )
            ) : (
              <>
                {/* Sim value (read-only) */}
                <span style={{
                  fontSize: 10, fontWeight: 600, minWidth: 48, textAlign: 'right',
                  color: manualOverrides[idx]?.enabled ? '#9CA3AF' : '#1D4ED8',
                  textDecoration: manualOverrides[idx]?.enabled ? 'line-through' : 'none',
                }} title={`Sim: ${inputStreamValues[mapping.streamVar] ?? '—'}`}>
                  {inputStreamValues[mapping.streamVar] != null
                    ? (typeof inputStreamValues[mapping.streamVar] === 'number'
                        ? inputStreamValues[mapping.streamVar].toFixed(2)
                        : String(inputStreamValues[mapping.streamVar]))
                    : '—'}
                </span>

                {/* Manual override checkbox */}
                <label style={{ display: 'flex', alignItems: 'center', gap: 2, fontSize: 10, color: '#6B7280', whiteSpace: 'nowrap', cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={manualOverrides[idx]?.enabled || false}
                    onChange={() => toggleManualOverride(idx)}
                    style={{ width: 12, height: 12 }}
                  />
                  Man.
                </label>

                {/* Manual value input (only when checkbox enabled) */}
                {manualOverrides[idx]?.enabled && (
                  <input
                    type="text"
                    placeholder="val"
                    value={manualOverrides[idx]?.value ?? ''}
                    onChange={e => updateManualValue(idx, e.target.value)}
                    style={{ ...S.input, width: 50, fontSize: 11, textAlign: 'right' }}
                  />
                )}
              </>
            )}

            <button
              style={{ ...S.btn, background: 'none', color: '#DC2626', fontSize: 14, padding: '0 4px', minHeight: 'auto' }}
              onClick={() => removeMapping(idx)}
              title="Remove mapping"
            >
              ✕
            </button>
          </div>
        ))}
      </div>

      {/* ── Actions ──────────────────────────────────────────────── */}
      <div style={S.section}>
        <div style={{ display: 'flex', gap: 6 }}>
          {isRead ? (
            <PressBtn
              style={{ ...S.btn, background: '#1D4ED8', color: '#fff', flex: 1 }}
              onClick={readNow}
              disabled={connStatus !== 'connected' || tagMappings.length === 0}
            >
              Read Now
            </PressBtn>
          ) : (
            <PressBtn
              style={{ ...S.btn, background: '#B45309', color: '#fff', flex: 1 }}
              onClick={writeNow}
              disabled={connStatus !== 'connected' || tagMappings.length === 0}
            >
              Write Now
            </PressBtn>
          )}
        </div>
        <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
          <PressBtn
            style={{ ...S.btn, background: '#059669', color: '#fff', flex: 1 }}
            onClick={() => { save(); setActionStatus({ type: 'success', msg: 'Config saved' }); setTimeout(() => setActionStatus(null), 1500); }}
          >
            Save
          </PressBtn>
          <PressBtn
            style={{ ...S.btn, background: '#6B7280', color: '#fff', flex: 1 }}
            onClick={() => { save(); onClose(); }}
          >
            Save &amp; Close
          </PressBtn>
        </div>
        {actionStatus && (
          <div style={{
            marginTop: 6, fontSize: 11, fontWeight: 600, padding: '4px 8px', borderRadius: 4,
            background: actionStatus.type === 'success' ? '#ECFDF5' : '#FEF2F2',
            color: actionStatus.type === 'success' ? '#065F46' : '#991B1B',
          }}>
            {actionStatus.msg}
          </div>
        )}
      </div>

      {/* ── Tag Browser Modal ────────────────────────────────────── */}
      {browseRow !== null && connStatus === 'connected' && (
        <TagBrowser
          protocol={protocol}
          endpointUrl={endpointUrl}
          daServer={daServer}
          onSelect={handleBrowseSelect}
          onClose={() => setBrowseRow(null)}
        />
      )}
    </div>
  );
}

// ── Styles ───────────────────────────────────────────────────────────────────

const S = {
  panelHdr:     { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 14px', borderBottom: '1px solid #E5E7EB' },
  closeBtn:     { background: 'none', border: 'none', cursor: 'pointer', color: '#9CA3AF', fontSize: 16, minWidth: 32, minHeight: 32 },
  section:      { padding: '10px 14px', borderBottom: '1px solid #F3F4F6' },
  secTitle:     { fontSize: 11, fontWeight: 700, color: '#9CA3AF', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 },
  btn:          { border: 'none', borderRadius: 5, padding: '5px 10px', fontWeight: 600, cursor: 'pointer', fontSize: 12, minHeight: 30 },
  input:        { padding: '5px 8px', border: '1px solid #D1D5DB', borderRadius: 4, fontSize: 12, outline: 'none' },
  radioLabel:   { display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, color: '#374151', cursor: 'pointer' },
  mappingRow:   { display: 'flex', alignItems: 'center', gap: 4, marginBottom: 6 },

  // Protocol toggle
  protocolToggle: { display: 'flex', gap: 0, borderRadius: 6, overflow: 'hidden', border: '1px solid #D1D5DB' },
  protocolBtn:    { flex: 1, padding: '6px 0', fontWeight: 700, fontSize: 12, cursor: 'pointer', border: 'none', textAlign: 'center', transition: 'all 0.15s' },
  protocolActive:   { background: '#1D4ED8', color: '#fff' },
  protocolInactive: { background: '#F9FAFB', color: '#6B7280' },

  // Server discovery
  serverList:     { maxHeight: 180, overflowY: 'auto', border: '1px solid #E5E7EB', borderRadius: 6, padding: 4, background: '#F9FAFB' },
  serverItem:     { display: 'flex', alignItems: 'flex-start', gap: 6, padding: '6px 8px', borderRadius: 4, cursor: 'pointer', marginBottom: 2 },

  // Tag browser
  browserOverlay: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 2000, display: 'flex', alignItems: 'center', justifyContent: 'center' },
  browserModal:   { background: '#fff', borderRadius: 10, width: 420, maxHeight: '70vh', display: 'flex', flexDirection: 'column', boxShadow: '0 20px 60px rgba(0,0,0,.25)' },
  browserHeader:  { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 16px', borderBottom: '1px solid #E5E7EB' },
  browserError:   { padding: '8px 16px', background: '#FEF2F2', color: '#991B1B', fontSize: 12, borderBottom: '1px solid #FECACA' },
  treeContainer:  { flex: 1, overflowY: 'auto', minHeight: 150, maxHeight: 350 },
  treeItem:       { display: 'flex', alignItems: 'center', padding: '4px 12px', cursor: 'pointer', fontSize: 12, color: '#374151', borderBottom: '1px solid #F9FAFB' },
  manualEntry:    { display: 'flex', gap: 6, padding: '10px 16px', borderTop: '1px solid #E5E7EB' },
  manualInput:    { flex: 1, padding: '5px 8px', border: '1px solid #D1D5DB', borderRadius: 4, fontSize: 12 },
};
