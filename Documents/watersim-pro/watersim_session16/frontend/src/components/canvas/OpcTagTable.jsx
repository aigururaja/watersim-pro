/**
 * OpcTagTable — Split Read/Write tag mapping tables with seamless live data.
 *
 * Features:
 *   - Comprehensive project tags (all nodes x all stream variables)
 *   - All OPC server tags as searchable dropdowns
 *   - Separate "Read from OPC" and "Write to OPC" sections
 *   - Auto-save to node params on every change
 *   - Auto-start live polling when connected + mappings exist
 *   - Resizable columns
 */

import React, { useState, useRef, useEffect, useLayoutEffect, useMemo, useCallback } from 'react';
import ReactDOM from 'react-dom';
import api from '../../utils/api';
import useOpcStore from '../../store/opcStore';
import { applyTransform, validateEquation } from '../../utils/opcTransform';

// ── Stream variables ─────────────────────────────────────────────────────────

const STREAM_VARS = [
  { key: 'Q',    label: 'Flow (Q)' },
  { key: 'TSS',  label: 'TSS' },
  { key: 'BOD',  label: 'BOD' },
  { key: 'COD',  label: 'COD' },
  { key: 'TN',   label: 'TN' },
  { key: 'NH4',  label: 'NH4' },
  { key: 'NO3',  label: 'NO3' },
  { key: 'NO2',  label: 'NO2' },
  { key: 'TP',   label: 'TP' },
  { key: 'DO',   label: 'DO' },
  { key: 'pH',   label: 'pH' },
  { key: 'temp', label: 'Temp' },
];

// ── Pressable button ─────────────────────────────────────────────────────────

function PressBtn({ style, onClick, disabled, children, title }) {
  const [pressed, setPressed] = useState(false);
  const bg = style?.background || '#ccc';
  const activeBg = pressed && !disabled ? darken(bg) : bg;
  return (
    <button
      style={{ ...style, background: activeBg, transition: 'background 0.1s, transform 0.1s', transform: pressed ? 'scale(0.96)' : 'scale(1)' }}
      onMouseDown={() => setPressed(true)}
      onMouseUp={() => setPressed(false)}
      onMouseLeave={() => setPressed(false)}
      onClick={onClick}
      disabled={disabled}
      title={title}
    >{children}</button>
  );
}

function darken(hex) {
  if (!hex || hex[0] !== '#') return hex;
  const num = parseInt(hex.slice(1), 16);
  const r = Math.max(0, ((num >> 16) & 0xFF) - 40);
  const g = Math.max(0, ((num >> 8) & 0xFF) - 40);
  const b = Math.max(0, (num & 0xFF) - 40);
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`;
}

function fmtVal(v) {
  if (v == null) return '\u2014';
  return typeof v === 'number' ? v.toFixed(2) : String(v);
}

// ── Build tree from flat browse nodes ────────────────────────────────────────

function buildTree(nodes) {
  const folderMap = {};
  const roots = [];
  for (const n of nodes) {
    if (n.isFolder) {
      folderMap[n.itemID || n.name] = {
        id: n.itemID || n.name,
        name: n.name || n.itemID,
        isFolder: true,
        children: [],
      };
    }
  }
  for (const n of nodes) {
    const entry = n.isFolder
      ? folderMap[n.itemID || n.name]
      : { id: n.itemID || n.name, name: n.name || n.itemID, isFolder: false };
    const parent = n.parentPath ? folderMap[n.parentPath] : null;
    if (parent) parent.children.push(entry);
    else roots.push(entry);
  }
  return roots;
}

// ── Searchable Tag Dropdown ──────────────────────────────────────────────────
// For project tags — flat list with {key, label} items

function TagDropdown({ items, loading, value, onSelect, onClose, placeholder, anchor }) {
  const [filter, setFilter] = useState('');
  const ref = useRef(null);
  const inputRef = useRef(null);
  const [pos, setPos] = useState(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // Position the dropdown using fixed coords from the anchor DOM element
  useLayoutEffect(() => {
    const el = anchor || ref.current?.parentElement;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const spaceBelow = window.innerHeight - rect.bottom;
    const showAbove = spaceBelow < 260 && rect.top > 260;
    setPos({
      top: showAbove ? undefined : rect.bottom + 2,
      bottom: showAbove ? (window.innerHeight - rect.top + 2) : undefined,
      left: rect.left,
      width: Math.max(rect.width, 260),
    });
  }, [anchor]);

  useEffect(() => { inputRef.current?.focus(); }, []);

  useEffect(() => {
    const handler = (e) => { if (ref.current && !ref.current.contains(e.target)) onCloseRef.current(); };
    const timer = setTimeout(() => document.addEventListener('mousedown', handler), 0);
    return () => { clearTimeout(timer); document.removeEventListener('mousedown', handler); };
  }, []);

  // Normalize: accept [{key,label}] or [string]
  const normalized = useMemo(() =>
    items.map(i => typeof i === 'string' ? { key: i, label: i } : i),
    [items]
  );

  const term = filter.toLowerCase();
  const filtered = term ? normalized.filter(t => t.label.toLowerCase().includes(term)) : normalized;

  const dropdown = (
    <div ref={ref} style={{
      ...DD.wrap,
      position: 'fixed',
      top: pos?.top,
      bottom: pos?.bottom,
      left: pos?.left,
      width: pos?.width || 260,
      right: 'auto',
      zIndex: 9999,
    }}>
      <input
        ref={inputRef}
        type="text"
        value={filter}
        onChange={e => setFilter(e.target.value)}
        placeholder={placeholder || 'Search...'}
        style={DD.input}
        onKeyDown={e => {
          if (e.key === 'Enter') {
            if (filtered.length > 0) onSelect(filtered[0].key);
            else if (filter.trim()) onSelect(filter.trim());
          }
          if (e.key === 'Escape') onClose();
        }}
      />
      <div style={DD.list}>
        {loading && <div style={DD.hint}>Loading tags...</div>}
        {!loading && filtered.length === 0 && (
          <div style={DD.hint}>
            {normalized.length === 0 ? 'No items available' : 'No match'}
            {filter.trim() && (
              <div style={{ marginTop: 4 }}>
                <button style={DD.useBtn} onClick={() => onSelect(filter.trim())}>Use "{filter.trim()}"</button>
              </div>
            )}
          </div>
        )}
        {filtered.slice(0, 100).map(t => (
          <div key={t.key} style={{ ...DD.item, background: t.key === value ? '#EFF6FF' : 'transparent' }} onClick={() => onSelect(t.key)}>
            <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.label}</span>
            {t.key === value && <span style={{ color: '#1D4ED8', fontSize: 10 }}>{'\u2713'}</span>}
          </div>
        ))}
        {filtered.length > 100 && <div style={DD.hint}>{filtered.length - 100} more... (type to filter)</div>}
      </div>
    </div>
  );

  // Render via portal to escape overflow clipping
  return ReactDOM.createPortal(dropdown, document.body);
}

const DD = {
  wrap:      { position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 100, background: '#fff', border: '1px solid #D1D5DB', borderRadius: 6, boxShadow: '0 8px 24px rgba(0,0,0,.15)', display: 'flex', flexDirection: 'column', minWidth: 220, maxWidth: 400 },
  input:     { padding: '6px 8px', border: 'none', borderBottom: '1px solid #E5E7EB', fontSize: 11, fontFamily: 'monospace', outline: 'none' },
  list:      { maxHeight: 220, overflowY: 'auto' },
  item:      { padding: '5px 8px', fontSize: 11, fontFamily: 'monospace', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4, borderBottom: '1px solid #F9FAFB' },
  hint:      { padding: '8px', fontSize: 11, color: '#9CA3AF', textAlign: 'center' },
  useBtn:    { background: '#1D4ED8', color: '#fff', border: 'none', borderRadius: 3, padding: '3px 8px', fontSize: 10, cursor: 'pointer', fontWeight: 600 },
};

// ── OPC Tag Tree Dropdown ────────────────────────────────────────────────────
// Shows OPC server tags in tree structure with expandable folders.
// When user types a search filter, switches to flat filtered list.

function OpcTagTreeDropdown({ tree, flatTags, loading, value, onSelect, onClose, anchor }) {
  const [filter, setFilter] = useState('');
  const [expanded, setExpanded] = useState(new Set());
  const ref = useRef(null);
  const inputRef = useRef(null);
  const [pos, setPos] = useState(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useLayoutEffect(() => {
    const el = anchor || ref.current?.parentElement;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const spaceBelow = window.innerHeight - rect.bottom;
    const showAbove = spaceBelow < 320 && rect.top > 320;
    setPos({
      top: showAbove ? undefined : rect.bottom + 2,
      bottom: showAbove ? (window.innerHeight - rect.top + 2) : undefined,
      left: rect.left,
      width: Math.max(rect.width, 300),
    });
  }, [anchor]);

  useEffect(() => { inputRef.current?.focus(); }, []);

  // Click-outside handler — use ref to avoid re-registering on every render
  useEffect(() => {
    const handler = (e) => { if (ref.current && !ref.current.contains(e.target)) onCloseRef.current(); };
    // Delay registration to avoid catching the opening click
    const timer = setTimeout(() => document.addEventListener('mousedown', handler), 0);
    return () => { clearTimeout(timer); document.removeEventListener('mousedown', handler); };
  }, []);

  const toggleFolder = (id) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  // Render a tree node recursively
  const renderNode = (node, depth = 0) => {
    if (node.isFolder) {
      const isExp = expanded.has(node.id);
      return (
        <div key={node.id}>
          <div
            style={{ ...TDD.treeItem, paddingLeft: 8 + depth * 16 }}
            onClick={() => toggleFolder(node.id)}
            onMouseEnter={e => e.currentTarget.style.background = '#F3F4F6'}
            onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
          >
            <span style={{ fontSize: 9, color: '#6B7280', marginRight: 4, width: 10, display: 'inline-block' }}>
              {isExp ? '\u25BC' : '\u25B6'}
            </span>
            <span style={{ fontSize: 11, color: '#374151', fontWeight: 600 }}>{node.name}</span>
          </div>
          {isExp && node.children && node.children.map(c => renderNode(c, depth + 1))}
        </div>
      );
    }
    // Leaf node
    const isSelected = node.id === value;
    return (
      <div
        key={node.id}
        style={{ ...TDD.treeItem, paddingLeft: 8 + depth * 16, background: isSelected ? '#EFF6FF' : 'transparent' }}
        onClick={() => onSelect(node.id)}
        onMouseEnter={e => { if (!isSelected) e.currentTarget.style.background = '#F9FAFB'; }}
        onMouseLeave={e => { if (!isSelected) e.currentTarget.style.background = 'transparent'; }}
      >
        <span style={{ fontSize: 7, color: '#9CA3AF', marginRight: 4, width: 10, display: 'inline-block', textAlign: 'center' }}>{'\u25CF'}</span>
        <span style={{ flex: 1, fontSize: 11, fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{node.name}</span>
        {isSelected && <span style={{ color: '#1D4ED8', fontSize: 10 }}>{'\u2713'}</span>}
      </div>
    );
  };

  const term = filter.toLowerCase();

  // In search mode: show flat filtered leaf tags
  const flatFiltered = term
    ? flatTags.filter(t => t.toLowerCase().includes(term))
    : null;

  const dropdown = (
    <div ref={ref} style={{
      ...TDD.wrap,
      position: 'fixed',
      top: pos?.top,
      bottom: pos?.bottom,
      left: pos?.left,
      width: pos?.width || 300,
      right: 'auto',
      zIndex: 9999,
    }}>
      <input
        ref={inputRef}
        type="text"
        value={filter}
        onChange={e => setFilter(e.target.value)}
        placeholder="Search OPC tags..."
        style={TDD.input}
        onKeyDown={e => {
          if (e.key === 'Enter') {
            if (flatFiltered && flatFiltered.length > 0) onSelect(flatFiltered[0]);
            else if (filter.trim()) onSelect(filter.trim());
          }
          if (e.key === 'Escape') onClose();
        }}
      />
      <div style={TDD.list}>
        {loading && <div style={TDD.hint}>Loading OPC tags...</div>}

        {/* Search mode: flat filtered list */}
        {!loading && flatFiltered && (
          <>
            {flatFiltered.length === 0 && (
              <div style={TDD.hint}>
                No match
                {filter.trim() && (
                  <div style={{ marginTop: 4 }}>
                    <button style={TDD.useBtn} onClick={() => onSelect(filter.trim())}>Use "{filter.trim()}"</button>
                  </div>
                )}
              </div>
            )}
            {flatFiltered.slice(0, 100).map(t => (
              <div key={t} style={{ ...TDD.flatItem, background: t === value ? '#EFF6FF' : 'transparent' }} onClick={() => onSelect(t)}>
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t}</span>
                {t === value && <span style={{ color: '#1D4ED8', fontSize: 10 }}>{'\u2713'}</span>}
              </div>
            ))}
            {flatFiltered.length > 100 && <div style={TDD.hint}>{flatFiltered.length - 100} more... (type to filter)</div>}
          </>
        )}

        {/* Tree mode: hierarchical view */}
        {!loading && !flatFiltered && (
          <>
            {tree.length === 0 && <div style={TDD.hint}>No OPC tags available</div>}
            {tree.map(node => renderNode(node))}
          </>
        )}
      </div>
      {/* Manual entry footer */}
      {filter.trim() && flatFiltered && flatFiltered.length > 0 && !flatFiltered.includes(filter.trim()) && (
        <div style={{ padding: '4px 8px', borderTop: '1px solid #E5E7EB' }}>
          <button style={TDD.useBtn} onClick={() => onSelect(filter.trim())}>Use "{filter.trim()}"</button>
        </div>
      )}
    </div>
  );

  return ReactDOM.createPortal(dropdown, document.body);
}

const TDD = {
  wrap:      { background: '#fff', border: '1px solid #D1D5DB', borderRadius: 6, boxShadow: '0 8px 24px rgba(0,0,0,.18)', display: 'flex', flexDirection: 'column', minWidth: 260, maxWidth: 440 },
  input:     { padding: '6px 8px', border: 'none', borderBottom: '1px solid #E5E7EB', fontSize: 11, fontFamily: 'monospace', outline: 'none' },
  list:      { maxHeight: 300, overflowY: 'auto' },
  treeItem:  { display: 'flex', alignItems: 'center', padding: '4px 8px', cursor: 'pointer', minHeight: 26 },
  flatItem:  { padding: '5px 8px', fontSize: 11, fontFamily: 'monospace', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4, borderBottom: '1px solid #F9FAFB' },
  hint:      { padding: '8px', fontSize: 11, color: '#9CA3AF', textAlign: 'center' },
  useBtn:    { background: '#1D4ED8', color: '#fff', border: 'none', borderRadius: 3, padding: '3px 8px', fontSize: 10, cursor: 'pointer', fontWeight: 600 },
};

// ── Resizable Column Header ──────────────────────────────────────────────────

function ResizableTh({ children, width, onResize, style }) {
  const startX = useRef(0);
  const startW = useRef(0);

  const onMouseDown = (e) => {
    e.preventDefault();
    startX.current = e.clientX;
    startW.current = width;
    const onMove = (ev) => {
      const delta = ev.clientX - startX.current;
      onResize(Math.max(60, startW.current + delta));
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  };

  return (
    <th style={{ ...style, width, minWidth: width, maxWidth: width, position: 'relative', userSelect: 'none' }}>
      {children}
      <div
        style={{ position: 'absolute', right: 0, top: 0, bottom: 0, width: 5, cursor: 'col-resize', background: 'transparent' }}
        onMouseDown={onMouseDown}
        onMouseOver={e => e.currentTarget.style.background = '#CBD5E1'}
        onMouseOut={e => e.currentTarget.style.background = 'transparent'}
      />
    </th>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// Main OPC Tag Table
// ═════════════════════════════════════════════════════════════════════════════

export default function OpcTagTable({ nodes, edges, simResults, onUpdateParam, onClose }) {
  const { protocol, endpointUrl, daServer, connStatus, markDisconnected } = useOpcStore();

  // ── Identify OPC nodes ──────────────────────────────────────────────────
  const readNodes = useMemo(() => nodes.filter(n => n.data?.opType === 'opc_read'), [nodes]);
  const writeNodes = useMemo(() => nodes.filter(n => n.data?.opType === 'opc_write'), [nodes]);

  // ── Project tags: all non-OPC nodes x 12 stream variables ───────────────
  const projectTags = useMemo(() => {
    const tags = [];
    // Node-specific tags: "NodeLabel / StreamVar"
    const nonOpcNodes = nodes.filter(n => {
      const op = n.data?.opType;
      return op && op !== 'opc_read' && op !== 'opc_write';
    });
    for (const node of nonOpcNodes) {
      for (const sv of STREAM_VARS) {
        tags.push({
          key: `${node.id}::${sv.key}`,
          label: `${node.data?.label || node.data?.opType} / ${sv.label}`,
          nodeId: node.id,
          streamVar: sv.key,
        });
      }
    }
    // If no non-OPC nodes exist, include basic 12 stream vars as fallback
    if (nonOpcNodes.length === 0) {
      for (const sv of STREAM_VARS) {
        tags.push({ key: sv.key, label: sv.label, streamVar: sv.key });
      }
    }
    return tags;
  }, [nodes]);

  const projectTagMap = useMemo(() => {
    const map = {};
    for (const t of projectTags) map[t.key] = t;
    return map;
  }, [projectTags]);

  // ── Cached OPC tag tree + flat list (fetched from server for dropdowns) ──
  const [opcTagTree, setOpcTagTree] = useState([]);   // hierarchical tree for dropdown
  const [opcTagFlat, setOpcTagFlat] = useState([]);    // flat leaf strings for search
  const [tagsLoading, setTagsLoading] = useState(false);
  const [tagsError, setTagsError] = useState(null);

  const fetchOpcTags = useCallback(async () => {
    if (connStatus !== 'connected') return;
    setTagsLoading(true);
    setTagsError(null);
    try {
      let browseNodes;
      if (protocol === 'da') {
        const { data } = await api.post('/opc/da/browse', { progId: daServer?.progId, address: daServer?.address || 'localhost' });
        browseNodes = data.nodes || [];
      } else {
        const { data } = await api.post('/opc/browse', { endpointUrl });
        browseNodes = (data.nodes || []).map(n => ({
          itemID: n.nodeId || n.browseName,
          name: n.browseName || n.nodeId,
          isFolder: !!n.isFolder,
          parentPath: n.parentPath || '',
        }));
      }
      const flat = browseNodes.filter(n => !n.isFolder).map(n => n.itemID || n.name);
      setOpcTagFlat(flat);
      setOpcTagTree(buildTree(browseNodes));
      if (flat.length === 0) setTagsError('Browse returned 0 tags');
    } catch (err) {
      setTagsError(err.response?.data?.error || err.message);
    }
    finally { setTagsLoading(false); }
  }, [connStatus, protocol, endpointUrl, daServer]);

  useEffect(() => {
    if (connStatus === 'connected' && opcTagFlat.length === 0) fetchOpcTags();
  }, [connStatus]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Parse project tag key → { nodeId, streamVar } ───────────────────────
  const parseProjectTag = useCallback((key) => {
    if (!key) return { nodeId: null, streamVar: null };
    if (key.includes('::')) {
      const [nodeId, streamVar] = key.split('::');
      return { nodeId, streamVar };
    }
    // Plain key = just a stream var (fallback mode)
    return { nodeId: null, streamVar: key };
  }, []);

  // ── Get project value for a tag key ────────────────────────────────────
  const getProjectValue = useCallback((projectTagKey) => {
    const { nodeId, streamVar } = parseProjectTag(projectTagKey);
    if (!streamVar) return null;

    if (nodeId) {
      // simResults effluent
      const ur = simResults?.results?.unitResults?.[nodeId];
      if (ur?.outputs?.effluent?.[streamVar] != null) return ur.outputs.effluent[streamVar];

      // edge streamResult
      const outEdge = edges.find(e => e.source === nodeId);
      if (outEdge?.data?.streamResult?.[streamVar] != null) return outEdge.data.streamResult[streamVar];

      // node params directly (e.g. inlet)
      const node = nodes.find(n => n.id === nodeId);
      if (node?.data?.params?.[streamVar] != null) return node.data.params[streamVar];
    } else {
      // No node context — search across all unit results
      const unitResults = simResults?.results?.unitResults;
      if (unitResults) {
        for (const [, ur] of Object.entries(unitResults)) {
          if (ur?.outputs?.effluent?.[streamVar] != null) return ur.outputs.effluent[streamVar];
        }
      }
    }
    return null;
  }, [simResults, edges, nodes, parseProjectTag]);

  // ── Build initial rows from existing node tagMappings ───────────────────
  const buildReadRows = useCallback(() => {
    const rows = [];
    for (const rn of readNodes) {
      for (const m of (rn.data.params?.tagMappings || [])) {
        if (!m.streamVar) continue;
        // Try to find matching project tag (prefer node connected upstream)
        const inEdge = edges.find(e => e.target === rn.id);
        let ptag = null;
        if (inEdge?.source) ptag = projectTags.find(t => t.nodeId === inEdge.source && t.streamVar === m.streamVar);
        if (!ptag) ptag = projectTags.find(t => t.streamVar === m.streamVar);
        rows.push({
          projectTag: ptag?.key || '',
          opcTag: m.opcTag || '',
          lastValue: m.lastValue ?? null,
          rawValue: m.rawValue ?? null,
          nodeId: rn.id,
          filter: m.filter || { min: null, max: null, equation: '' },
        });
      }
    }
    return rows;
  }, [readNodes, projectTags, edges]);

  const buildWriteRows = useCallback(() => {
    const rows = [];
    for (const wn of writeNodes) {
      for (const m of (wn.data.params?.tagMappings || [])) {
        if (!m.streamVar) continue;
        const inEdge = edges.find(e => e.target === wn.id);
        let ptag = null;
        if (inEdge?.source) ptag = projectTags.find(t => t.nodeId === inEdge.source && t.streamVar === m.streamVar);
        if (!ptag) ptag = projectTags.find(t => t.streamVar === m.streamVar);
        rows.push({
          projectTag: ptag?.key || '',
          opcTag: m.opcTag || '',
          lastValue: m.lastValue ?? null,
          nodeId: wn.id,
          manualOverride: m.manualOverride || false,
          manualValue: m.manualValue || '',
          filter: m.filter || { min: null, max: null, equation: '' },
        });
      }
    }
    return rows;
  }, [writeNodes, projectTags, edges]);

  // ── Row state ───────────────────────────────────────────────────────────
  const [readRows, setReadRows] = useState(buildReadRows);
  const [writeRows, setWriteRows] = useState(buildWriteRows);
  const [polling, setPolling] = useState(false);
  const [intervalSec, setIntervalSec] = useState(() => {
    const anyOpc = [...readNodes, ...writeNodes][0];
    return anyOpc?.data.params?.intervalSec || 5;
  });
  const [actionStatus, setActionStatus] = useState(null);
  const [lastPollTime, setLastPollTime] = useState(null);
  const [activeDropdown, setActiveDropdown] = useState(null); // {section:'read'|'write', rowIdx, field:'projectTag'|'opcTag', anchor: DOMElement}

  const pollRef = useRef(null);
  const busyRef = useRef(false);
  const readNowRef = useRef(null);
  const writeNowRef = useRef(null);
  const readRowsRef = useRef(readRows);
  readRowsRef.current = readRows;
  const writeRowsRef = useRef(writeRows);
  writeRowsRef.current = writeRows;

  // ── Column widths (resizable) ───────────────────────────────────────────
  const [colWidths, setColWidths] = useState({
    projTag: 180, opcTag: 200, projVal: 90, opcVal: 90,
  });
  const setColW = (key, w) => setColWidths(prev => ({ ...prev, [key]: w }));

  // ── Row operations ──────────────────────────────────────────────────────
  const addReadRow = () => setReadRows(prev => [...prev, { projectTag: '', opcTag: '', lastValue: null, rawValue: null, nodeId: readNodes[0]?.id || null, filter: { min: null, max: null, equation: '' } }]);
  const addWriteRow = () => setWriteRows(prev => [...prev, { projectTag: '', opcTag: '', lastValue: null, nodeId: writeNodes[0]?.id || null, manualOverride: false, manualValue: '', filter: { min: null, max: null, equation: '' } }]);
  const removeReadRow = (idx) => setReadRows(prev => prev.filter((_, i) => i !== idx));
  const removeWriteRow = (idx) => setWriteRows(prev => prev.filter((_, i) => i !== idx));
  const updateReadRow = (idx, field, value) => setReadRows(prev => prev.map((r, i) => i === idx ? { ...r, [field]: value } : r));
  const updateWriteRow = (idx, field, value) => setWriteRows(prev => prev.map((r, i) => i === idx ? { ...r, [field]: value } : r));
  const updateReadFilter = (idx, field, val) => setReadRows(prev => prev.map((r, i) => i === idx ? { ...r, filter: { ...(r.filter || {}), [field]: val } } : r));
  const updateWriteFilter = (idx, field, val) => setWriteRows(prev => prev.map((r, i) => i === idx ? { ...r, filter: { ...(r.filter || {}), [field]: val } } : r));

  // ── Filter expand/collapse ────────────────────────────────────────────
  const [expandedFilters, setExpandedFilters] = useState(new Set());
  const toggleFilter = (section, idx) => {
    const key = `${section}-${idx}`;
    setExpandedFilters(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  // ── Save to node params ─────────────────────────────────────────────────
  const saveToNodes = useCallback(() => {
    const { protocol: p, endpointUrl: ep, daServer: ds } = useOpcStore.getState();

    // Build read mappings per opc_read node
    const readMappingsMap = {};
    const streamVarOverrides = {};  // Push OPC values to upstream nodes
    for (const r of readRowsRef.current) {
      if (!r.opcTag || !r.projectTag) continue;
      const nid = r.nodeId || readNodes[0]?.id;
      if (!nid) continue;
      const parts = r.projectTag.split('::');
      const targetNodeId = parts.length > 1 ? parts[0] : null;
      const streamVar = parts.length > 1 ? parts[1] : parts[0];
      if (!streamVar) continue;
      if (!readMappingsMap[nid]) readMappingsMap[nid] = [];
      readMappingsMap[nid].push({ streamVar, opcTag: r.opcTag, lastValue: r.lastValue, rawValue: r.rawValue, filter: r.filter });

      // Track OPC overrides for upstream node params
      if (r.lastValue != null && targetNodeId) {
        streamVarOverrides[`${targetNodeId}::${streamVar}`] = r.lastValue;
      }
    }

    // Build write mappings per opc_write node
    const writeMappingsMap = {};
    for (const w of writeRowsRef.current) {
      if (!w.opcTag || !w.projectTag) continue;
      const nid = w.nodeId || writeNodes[0]?.id;
      if (!nid) continue;
      const parts = w.projectTag.split('::');
      const streamVar = parts.length > 1 ? parts[1] : parts[0];
      if (!streamVar) continue;
      if (!writeMappingsMap[nid]) writeMappingsMap[nid] = [];
      writeMappingsMap[nid].push({ streamVar, opcTag: w.opcTag, lastValue: w.lastValue, manualOverride: w.manualOverride || false, manualValue: w.manualValue || '', filter: w.filter });
    }

    for (const rn of readNodes) {
      onUpdateParam(rn.id, 'tagMappings', readMappingsMap[rn.id] || []);
      onUpdateParam(rn.id, 'protocol', p);
      onUpdateParam(rn.id, 'endpointUrl', ep);
      onUpdateParam(rn.id, 'daServer', ds);
      onUpdateParam(rn.id, 'intervalSec', intervalSec);
    }
    for (const wn of writeNodes) {
      onUpdateParam(wn.id, 'tagMappings', writeMappingsMap[wn.id] || []);
      onUpdateParam(wn.id, 'protocol', p);
      onUpdateParam(wn.id, 'endpointUrl', ep);
      onUpdateParam(wn.id, 'daServer', ds);
      onUpdateParam(wn.id, 'intervalSec', intervalSec);
    }

    // Push OPC read values to upstream node params (e.g. inlet Q = OPC value)
    // so simulation uses live OPC data for all mapped variables
    for (const [key, val] of Object.entries(streamVarOverrides)) {
      const [targetNodeId, streamVar] = key.split('::');
      onUpdateParam(targetNodeId, streamVar, val);
    }
  }, [readNodes, writeNodes, onUpdateParam, intervalSec]);

  // ── Auto-save on row changes (debounced 500ms) ─────────────────────────
  const saveTimerRef = useRef(null);
  useEffect(() => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(saveToNodes, 500);
    return () => { if (saveTimerRef.current) clearTimeout(saveTimerRef.current); };
  }, [readRows, writeRows, saveToNodes]);

  // ── Read Now ────────────────────────────────────────────────────────────
  const readNow = async () => {
    if (busyRef.current) return;
    const validRows = readRowsRef.current.filter(r => r.opcTag);
    if (validRows.length === 0) return;
    const tagIds = validRows.map(r => r.opcTag);

    busyRef.current = true;
    try {
      let values;
      if (protocol === 'da') {
        const { data } = await api.post('/opc/da/read', { progId: daServer?.progId, address: daServer?.address || 'localhost', tagIds });
        values = data.values || [];
      } else {
        const { data } = await api.post('/opc/read', { endpointUrl, tagIds });
        values = data.values || [];
      }
      // Update readRows state with latest OPC values (apply filter transforms)
      const updatedRows = readRowsRef.current.map(r => {
        const match = values.find(v => v.tagId === r.opcTag);
        if (!match) return r;
        const rawValue = match.value;
        const lastValue = r.filter ? applyTransform(rawValue, r.filter) : rawValue;
        return { ...r, lastValue, rawValue };
      });
      setReadRows(updatedRows);
      setLastPollTime(Date.now());
      const good = values.filter(v => v.isGood).length;
      setActionStatus({ type: good > 0 ? 'success' : 'error', msg: `Read ${good}/${tagIds.length}` });

      // ── Immediately persist OPC values to node params ──────────────────
      // When variables are read from OPC, they must be available in node
      // params right away so any simulation triggered uses live OPC values,
      // not stale stored values. This bypasses the 500ms debounce.
      if (good > 0) {
        const readMappingsMap = {};
        // Also collect overrides to push to upstream (inlet) nodes
        const streamVarOverrides = {};  // { nodeId::streamVar → value }

        for (const r of updatedRows) {
          if (!r.opcTag || !r.projectTag) continue;
          const nid = r.nodeId || readNodes[0]?.id;
          if (!nid) continue;
          const parts = r.projectTag.split('::');
          const targetNodeId = parts.length > 1 ? parts[0] : null;
          const streamVar = parts.length > 1 ? parts[1] : parts[0];
          if (!streamVar) continue;
          if (!readMappingsMap[nid]) readMappingsMap[nid] = [];
          readMappingsMap[nid].push({ streamVar, opcTag: r.opcTag, lastValue: r.lastValue, rawValue: r.rawValue, filter: r.filter });

          // Track OPC overrides for upstream node params (e.g. inlet Q)
          if (r.lastValue != null && targetNodeId) {
            streamVarOverrides[`${targetNodeId}::${streamVar}`] = r.lastValue;
          }
        }

        // Update opc_read node tagMappings
        for (const rn of readNodes) {
          onUpdateParam(rn.id, 'tagMappings', readMappingsMap[rn.id] || []);
        }

        // Push OPC values to the actual upstream node params (e.g. inlet Q)
        // so that getProjectValue() and simulation both use live OPC data
        for (const [key, val] of Object.entries(streamVarOverrides)) {
          const [targetNodeId, streamVar] = key.split('::');
          onUpdateParam(targetNodeId, streamVar, val);
        }
      }
    } catch (err) {
      const msg = err.response?.data?.error || err.message;
      setActionStatus({ type: 'error', msg });
      if (err.response?.status >= 500 || /not connected/i.test(msg)) { markDisconnected(msg); setPolling(false); }
    } finally { busyRef.current = false; }
  };

  // ── Write Now ───────────────────────────────────────────────────────────
  const writeNow = async () => {
    if (busyRef.current) return;

    // Build map of OPC-read values by streamVar so writes can use live OPC data
    const readValueByStreamVar = {};
    for (const r of readRowsRef.current) {
      if (r.lastValue != null && r.projectTag) {
        const parts = r.projectTag.split('::');
        const sv = parts.length > 1 ? parts[1] : parts[0];
        if (sv) readValueByStreamVar[sv] = r.lastValue;
      }
    }

    const tags = [];
    for (const w of writeRowsRef.current) {
      if (!w.opcTag || !w.projectTag) continue;
      let raw;
      if (w.manualOverride) {
        raw = w.manualValue;
      } else {
        // Priority: OPC-read value for same stream var > simulation value
        const parts = w.projectTag.split('::');
        const sv = parts.length > 1 ? parts[1] : parts[0];
        raw = readValueByStreamVar[sv] ?? getProjectValue(w.projectTag);
      }
      if (raw == null || raw === '') continue;
      const asNum = Number(raw);
      let value = (typeof raw === 'number') ? raw : (typeof raw === 'string' && raw.trim() !== '' && !isNaN(asNum)) ? asNum : raw;
      if (w.filter && typeof value === 'number') {
        value = applyTransform(value, w.filter);
      }
      tags.push({ tagId: w.opcTag, value });
    }
    if (tags.length === 0) return;

    busyRef.current = true;
    try {
      let results;
      if (protocol === 'da') {
        const { data } = await api.post('/opc/da/write', { progId: daServer?.progId, address: daServer?.address || 'localhost', tags });
        results = data.results || [];
      } else {
        const { data } = await api.post('/opc/write', { endpointUrl, tags });
        results = data.results || [];
      }
      setWriteRows(prev => prev.map(w => {
        const match = results.find(res => res.tagId === w.opcTag);
        if (match && match.isGood) {
          const written = tags.find(t => t.tagId === w.opcTag);
          return { ...w, lastValue: written?.value ?? w.lastValue };
        }
        return w;
      }));
      setLastPollTime(Date.now());
      const ok = results.filter(r => r.isGood).length;
      setActionStatus({ type: ok > 0 ? 'success' : 'error', msg: `Wrote ${ok}/${tags.length}` });
    } catch (err) {
      const msg = err.response?.data?.error || err.message;
      setActionStatus({ type: 'error', msg });
      if (err.response?.status >= 500 || /not connected/i.test(msg)) { markDisconnected(msg); setPolling(false); }
    } finally { busyRef.current = false; }
  };

  readNowRef.current = readNow;
  writeNowRef.current = writeNow;

  // ── Polling (live updates) ──────────────────────────────────────────────
  const hasMappings = readRows.some(r => r.opcTag && r.projectTag) || writeRows.some(r => r.opcTag && r.projectTag);

  useEffect(() => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    if (!polling || connStatus !== 'connected') return;
    const ms = intervalSec * 1000;
    const tick = async () => {
      await readNowRef.current();
      await writeNowRef.current();
    };
    tick();
    pollRef.current = setInterval(tick, ms);
    return () => { if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; } };
  }, [polling, intervalSec, connStatus]);

  // Auto-start polling when connected and mappings exist
  useEffect(() => {
    if (connStatus === 'connected' && hasMappings && !polling) setPolling(true);
    if (connStatus !== 'connected') setPolling(false);
  }, [connStatus, hasMappings]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current); }, []);

  // ── Dropdown handlers ───────────────────────────────────────────────────
  const handleTagSelect = (key) => {
    if (!activeDropdown) return;
    const { section, rowIdx, field } = activeDropdown;
    if (section === 'read') updateReadRow(rowIdx, field, key);
    else updateWriteRow(rowIdx, field, key);
    setActiveDropdown(null);
  };

  // ── Live pulse ──────────────────────────────────────────────────────────
  const [pulse, setPulse] = useState(false);
  useEffect(() => {
    if (!lastPollTime) return;
    setPulse(true);
    const t = setTimeout(() => setPulse(false), 600);
    return () => clearTimeout(t);
  }, [lastPollTime]);

  const isConnected = connStatus === 'connected';

  // ── Helper: get display label for a project tag key ─────────────────────
  const getProjectTagLabel = (key) => {
    if (!key) return '';
    const tag = projectTagMap[key];
    if (tag) return tag.label;
    // Fallback: try to extract stream var from key
    const parts = key.split('::');
    const sv = parts.length > 1 ? parts[1] : parts[0];
    return STREAM_VARS.find(s => s.key === sv)?.label || sv || key;
  };

  // ── Render a mapping section (read or write) ───────────────────────────
  const renderSection = (section, sectionRows, updateRow, removeRow, addRow, color, bgColor, borderColor) => {
    const isRead = section === 'read';
    const title = isRead ? 'READ FROM OPC' : 'WRITE TO OPC';
    const subtitle = isRead ? 'OPC server values \u2192 Project tags' : 'Project tag values \u2192 OPC server';
    const hasNodes = isRead ? readNodes.length > 0 : writeNodes.length > 0;

    return (
      <div style={{ marginBottom: 4 }}>
        {/* Section header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 16px', background: bgColor, borderBottom: `2px solid ${borderColor}` }}>
          <div>
            <span style={{ fontWeight: 700, fontSize: 11, color, letterSpacing: '0.05em' }}>{title}</span>
            <span style={{ fontSize: 10, color: '#9CA3AF', marginLeft: 8 }}>{subtitle}</span>
          </div>
          <PressBtn
            style={{ ...S.btn, background: color, color: '#fff', fontSize: 10, padding: '2px 10px', minHeight: 24 }}
            onClick={addRow}
            disabled={!hasNodes}
            title={hasNodes ? 'Add mapping row' : `No opc_${section} node on canvas`}
          >+ Add</PressBtn>
        </div>

        {!hasNodes && (
          <div style={{ padding: '12px 16px', textAlign: 'center', fontSize: 11, color: '#9CA3AF', fontStyle: 'italic', background: '#FAFAFA' }}>
            Add an opc_{section} node to the canvas to enable {section} mappings.
          </div>
        )}

        {hasNodes && (
          <table style={S.table}>
            <thead>
              <tr>
                <ResizableTh width={colWidths.projTag} onResize={w => setColW('projTag', w)} style={S.th}>Project Tag</ResizableTh>
                <ResizableTh width={colWidths.opcTag} onResize={w => setColW('opcTag', w)} style={S.th}>OPC Tag</ResizableTh>
                <ResizableTh width={colWidths.projVal} onResize={w => setColW('projVal', w)} style={{ ...S.th, textAlign: 'right' }}>Project Value</ResizableTh>
                <ResizableTh width={colWidths.opcVal} onResize={w => setColW('opcVal', w)} style={{ ...S.th, textAlign: 'right' }}>OPC Value</ResizableTh>
                <th style={{ ...S.th, width: 28, fontSize: 9, fontFamily: 'monospace', color: '#7C3AED' }} title="Pre/Post-processing filters">fx</th>
                <th style={{ ...S.th, width: 28 }}></th>
              </tr>
            </thead>
            <tbody>
              {sectionRows.length === 0 && (
                <tr><td colSpan={6} style={{ padding: 16, textAlign: 'center', color: '#9CA3AF', fontSize: 11, fontStyle: 'italic' }}>
                  No mappings yet. Click "+ Add" to create a mapping.
                </td></tr>
              )}
              {sectionRows.map((row, idx) => {
                const isActiveProjTag = activeDropdown?.section === section && activeDropdown?.rowIdx === idx && activeDropdown?.field === 'projectTag';
                const isActiveOpcTag  = activeDropdown?.section === section && activeDropdown?.rowIdx === idx && activeDropdown?.field === 'opcTag';
                const storedProjVal = getProjectValue(row.projectTag);
                const hasMapping = row.projectTag && row.opcTag;

                // For READ rows: when OPC provides a live value, that IS the
                // project value (since OPC overrides stored/simulation values).
                // For WRITE rows: show the simulation output value.
                const opcDriven = isRead && hasMapping && row.lastValue != null;
                const projVal   = opcDriven ? row.lastValue : storedProjVal;

                return (
                  <React.Fragment key={idx}>
                  <tr style={{ borderBottom: '1px solid #F3F4F6', background: hasMapping ? '#fff' : '#FEFCE8' }}>

                    {/* Project Tag */}
                    <td style={{ ...S.td, width: colWidths.projTag }}>
                      <div
                        style={S.tagCell}
                        onClick={(e) => setActiveDropdown(isActiveProjTag ? null : { section, rowIdx: idx, field: 'projectTag', anchor: e.currentTarget })}
                      >
                        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 11, color: row.projectTag ? '#1F2937' : '#9CA3AF' }}>
                          {row.projectTag ? getProjectTagLabel(row.projectTag) : 'Select project tag...'}
                        </span>
                        <span style={{ fontSize: 8, color: '#9CA3AF' }}>{'\u25BC'}</span>
                      </div>
                      {isActiveProjTag && (
                        <TagDropdown
                          items={projectTags}
                          loading={false}
                          value={row.projectTag}
                          onSelect={handleTagSelect}
                          onClose={() => setActiveDropdown(null)}
                          placeholder="Search project tags..."
                          anchor={activeDropdown.anchor}
                        />
                      )}
                    </td>

                    {/* OPC Tag */}
                    <td style={{ ...S.td, width: colWidths.opcTag }}>
                      <div
                        style={S.tagCell}
                        onClick={(e) => setActiveDropdown(isActiveOpcTag ? null : { section, rowIdx: idx, field: 'opcTag', anchor: e.currentTarget })}
                      >
                        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 10, fontFamily: 'monospace', color: row.opcTag ? '#1F2937' : '#9CA3AF' }}>
                          {row.opcTag || 'Select OPC tag...'}
                        </span>
                        <span style={{ fontSize: 8, color: '#9CA3AF' }}>{'\u25BC'}</span>
                      </div>
                      {isActiveOpcTag && (
                        <OpcTagTreeDropdown
                          tree={opcTagTree}
                          flatTags={opcTagFlat}
                          loading={tagsLoading}
                          value={row.opcTag}
                          onSelect={handleTagSelect}
                          onClose={() => setActiveDropdown(null)}
                          anchor={activeDropdown.anchor}
                        />
                      )}
                    </td>

                    {/* Project Value — shows live OPC value for READ-mapped vars */}
                    <td style={{ ...S.td, textAlign: 'right', width: colWidths.projVal }}>
                      <span style={{
                        fontSize: 11,
                        fontWeight: opcDriven ? 600 : 400,
                        color: opcDriven ? '#059669' : '#374151',
                        transition: 'color 0.3s',
                        ...(pulse && hasMapping ? { color: isRead ? '#047857' : '#B45309' } : {}),
                      }}>
                        {fmtVal(projVal)}
                      </span>
                      {opcDriven && (
                        <span style={{ fontSize: 8, color: '#059669', marginLeft: 2 }} title="Driven by OPC">{'\u25C0'}</span>
                      )}
                    </td>

                    {/* OPC Value (live) — shows raw value when filter active */}
                    <td style={{ ...S.td, textAlign: 'right', width: colWidths.opcVal }}>
                      {(() => {
                        const f = row.filter;
                        const hasFilter = f && (f.min != null || f.max != null || (f.equation && f.equation.trim()));
                        const showRaw = isRead && hasFilter && row.rawValue != null && row.rawValue !== row.lastValue;
                        return (
                          <>
                            <span
                              style={{ fontSize: 11, fontWeight: 600, color: isRead ? '#059669' : '#B45309', transition: 'color 0.3s', ...(pulse && hasMapping ? { color: isRead ? '#047857' : '#92400E' } : {}) }}
                              title={showRaw ? `Raw: ${row.rawValue}` : undefined}
                            >
                              {fmtVal(row.lastValue)}
                            </span>
                            {showRaw && (
                              <span style={{ fontSize: 8, color: '#7C3AED', marginLeft: 2, fontWeight: 700 }} title={`Raw: ${row.rawValue}`}>f</span>
                            )}
                          </>
                        );
                      })()}
                    </td>

                    {/* Filter toggle */}
                    <td style={S.td}>
                      {(() => {
                        const f = row.filter;
                        const hasFilter = f && (f.min != null || f.max != null || (f.equation && f.equation.trim()));
                        return (
                          <button
                            style={{
                              background: hasFilter ? '#EDE9FE' : 'none',
                              border: hasFilter ? '1px solid #C4B5FD' : '1px solid transparent',
                              color: hasFilter ? '#7C3AED' : '#9CA3AF',
                              cursor: 'pointer', fontSize: 9, padding: '1px 3px',
                              borderRadius: 3, fontWeight: 600, fontFamily: 'monospace',
                              lineHeight: 1,
                            }}
                            onClick={() => toggleFilter(section, idx)}
                            title="Configure min/max/equation filter"
                          >fx</button>
                        );
                      })()}
                    </td>

                    {/* Remove */}
                    <td style={S.td}>
                      <button style={{ background: 'none', border: 'none', color: '#DC2626', cursor: 'pointer', fontSize: 13, padding: '0 4px' }} onClick={() => removeRow(idx)} title="Remove">{'\u2715'}</button>
                    </td>
                  </tr>

                  {/* Expandable filter sub-row */}
                  {expandedFilters.has(`${section}-${idx}`) && (
                    <tr style={{ background: '#FAFAFF', borderBottom: '1px solid #E5E7EB' }}>
                      <td colSpan={6} style={{ padding: '6px 12px' }}>
                        {(() => {
                          const updateFilter = isRead ? updateReadFilter : updateWriteFilter;
                          const f = row.filter || {};
                          const eqError = validateEquation(f.equation);
                          const hasAnyFilter = f.min != null || f.max != null || (f.equation && f.equation.trim());
                          // Preview: show what the transform produces for the current raw/last value
                          const previewInput = isRead ? (row.rawValue ?? row.lastValue) : row.lastValue;
                          const previewOutput = (hasAnyFilter && previewInput != null) ? applyTransform(previewInput, f) : null;
                          return (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                              <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                                <span style={{ fontSize: 10, color: '#6B7280', fontWeight: 600, minWidth: 72 }}>
                                  {isRead ? 'Pre-process:' : 'Post-process:'}
                                </span>
                                <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 10, color: '#374151', fontWeight: 500 }}>
                                  Min
                                  <input
                                    type="number"
                                    value={f.min ?? ''}
                                    onChange={e => updateFilter(idx, 'min', e.target.value === '' ? null : Number(e.target.value))}
                                    style={{ width: 70, padding: '3px 5px', border: '1px solid #D1D5DB', borderRadius: 3, fontSize: 11, outline: 'none' }}
                                    placeholder="--"
                                  />
                                </label>
                                <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 10, color: '#374151', fontWeight: 500 }}>
                                  Max
                                  <input
                                    type="number"
                                    value={f.max ?? ''}
                                    onChange={e => updateFilter(idx, 'max', e.target.value === '' ? null : Number(e.target.value))}
                                    style={{ width: 70, padding: '3px 5px', border: '1px solid #D1D5DB', borderRadius: 3, fontSize: 11, outline: 'none' }}
                                    placeholder="--"
                                  />
                                </label>
                                <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 10, color: '#374151', fontWeight: 500 }}>
                                  Equation
                                  <input
                                    type="text"
                                    value={f.equation ?? ''}
                                    onChange={e => updateFilter(idx, 'equation', e.target.value)}
                                    style={{ width: 160, padding: '3px 5px', border: `1px solid ${eqError ? '#FCA5A5' : '#D1D5DB'}`, borderRadius: 3, fontSize: 11, fontFamily: 'monospace', outline: 'none' }}
                                    placeholder="e.g. x * 0.001"
                                  />
                                </label>
                                {eqError && <span style={{ fontSize: 9, color: '#DC2626' }}>{eqError}</span>}
                              </div>
                              {hasAnyFilter && (
                                <div style={{ fontSize: 10, color: '#6B7280', fontFamily: 'monospace', paddingLeft: 72 }}>
                                  {previewInput != null
                                    ? <span>Preview: <b style={{ color: '#374151' }}>{Number(previewInput).toFixed(2)}</b> {'\u2192'} <b style={{ color: '#7C3AED' }}>{previewOutput != null ? Number(previewOutput).toFixed(2) : '?'}</b></span>
                                    : <span style={{ fontStyle: 'italic' }}>No value yet — click Read Now to test</span>
                                  }
                                </div>
                              )}
                            </div>
                          );
                        })()}
                      </td>
                    </tr>
                  )}
                </React.Fragment>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    );
  };

  // ── Main render ─────────────────────────────────────────────────────────
  return (
    <div style={S.overlay} onClick={onClose}>
      <div style={S.dialog} onClick={e => e.stopPropagation()}>

        {/* Header */}
        <div style={S.header}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontWeight: 700, fontSize: 14, color: '#1F4E79' }}>OPC Tag Mappings</span>
            {polling && (
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: pulse ? '#16A34A' : '#86EFAC', display: 'inline-block', transition: 'background 0.3s' }} title="Live polling active" />
            )}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ fontSize: 11, display: 'flex', alignItems: 'center', gap: 4 }}>
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: isConnected ? '#16A34A' : '#9CA3AF', display: 'inline-block' }} />
              {isConnected ? 'Connected' : 'Disconnected'}
            </span>
            <button style={S.closeBtn} onClick={onClose}>{'\u2715'}</button>
          </div>
        </div>

        {/* Controls bar */}
        <div style={S.controlBar}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <label style={{ fontSize: 11, color: '#6B7280' }}>Interval:</label>
            <input type="number" min={1} max={3600} step={1} value={intervalSec}
              onChange={e => setIntervalSec(Math.max(1, Number(e.target.value)))}
              style={{ ...S.input, width: 50, textAlign: 'right', fontSize: 11 }} />
            <span style={{ fontSize: 10, color: '#9CA3AF' }}>sec</span>
          </div>
          {tagsLoading && <span style={{ fontSize: 10, color: '#6B7280' }}>Loading OPC tags...</span>}
          {isConnected && opcTagFlat.length === 0 && !tagsLoading && (
            <PressBtn style={{ ...S.btn, background: '#4F46E5', color: '#fff', fontSize: 10, padding: '2px 10px', minHeight: 24 }} onClick={fetchOpcTags}>
              {tagsError ? 'Retry Load Tags' : 'Load OPC Tags'}
            </PressBtn>
          )}
          {tagsError && <span style={{ fontSize: 10, color: '#DC2626', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={tagsError}>{tagsError}</span>}
          {!isConnected && <span style={{ fontSize: 10, color: '#9CA3AF' }}>Connect to OPC server to load tags</span>}
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center' }}>
            <PressBtn
              style={{ ...S.btn, background: '#7C3AED', color: '#fff', fontSize: 11 }}
              onClick={() => { saveToNodes(); setActionStatus({ type: 'success', msg: 'Mappings updated' }); }}
              disabled={!hasMappings}
              title="Save current mappings and OPC values to node parameters for simulation"
            >Update Mappings</PressBtn>
            {isConnected && (
              polling
                ? <PressBtn style={{ ...S.btn, background: '#DC2626', color: '#fff', fontSize: 11 }} onClick={() => setPolling(false)}>Stop Live</PressBtn>
                : <PressBtn style={{ ...S.btn, background: '#059669', color: '#fff', fontSize: 11 }} onClick={() => setPolling(true)} disabled={!hasMappings}>Start Live</PressBtn>
            )}
            {isConnected && !polling && (
              <>
                <PressBtn style={{ ...S.btn, background: '#1D4ED8', color: '#fff', fontSize: 11 }} onClick={readNow} disabled={!readRows.some(r => r.opcTag)}>Read Once</PressBtn>
                <PressBtn style={{ ...S.btn, background: '#B45309', color: '#fff', fontSize: 11 }} onClick={writeNow} disabled={!writeRows.some(r => r.opcTag)}>Write Once</PressBtn>
              </>
            )}
          </div>
        </div>

        {/* Table sections */}
        <div style={S.tableWrap}>
          {renderSection('read', readRows, updateReadRow, removeReadRow, addReadRow, '#1D4ED8', '#EFF6FF', '#BFDBFE')}
          {renderSection('write', writeRows, updateWriteRow, removeWriteRow, addWriteRow, '#B45309', '#FFFBEB', '#FDE68A')}
        </div>

        {/* Footer */}
        <div style={S.footer}>
          {actionStatus && (
            <span style={{
              fontSize: 11, fontWeight: 600, padding: '3px 8px', borderRadius: 4,
              background: actionStatus.type === 'success' ? '#ECFDF5' : '#FEF2F2',
              color: actionStatus.type === 'success' ? '#065F46' : '#991B1B',
            }}>{actionStatus.msg}</span>
          )}
          <span style={{ fontSize: 10, color: '#9CA3AF', marginLeft: 'auto' }}>
            {readRows.length} read &middot; {writeRows.length} write
            {polling && <> &middot; <span style={{ color: '#059669' }}>polling {intervalSec}s</span></>}
            {opcTagFlat.length > 0 && <> &middot; {opcTagFlat.length} OPC tags</>}
          </span>
        </div>

      </div>
    </div>
  );
}

// ── Styles ───────────────────────────────────────────────────────────────────

const S = {
  overlay:    { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 2000, display: 'flex', alignItems: 'center', justifyContent: 'center' },
  dialog:     { background: '#fff', borderRadius: 10, width: '92vw', maxWidth: 1100, maxHeight: '88vh', display: 'flex', flexDirection: 'column', boxShadow: '0 20px 60px rgba(0,0,0,.25)', resize: 'both', overflow: 'hidden' },
  header:     { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 18px', borderBottom: '1px solid #E5E7EB' },
  closeBtn:   { background: 'none', border: 'none', cursor: 'pointer', color: '#9CA3AF', fontSize: 16, minWidth: 32, minHeight: 32 },
  controlBar: { display: 'flex', alignItems: 'center', gap: 8, padding: '6px 18px', borderBottom: '1px solid #F3F4F6', background: '#FAFAFA', flexWrap: 'wrap' },
  tableWrap:  { flex: 1, overflowY: 'auto', overflowX: 'auto' },
  table:      { width: '100%', borderCollapse: 'collapse', fontSize: 12, tableLayout: 'fixed' },
  th:         { padding: '6px 8px', fontSize: 10, fontWeight: 700, color: '#6B7280', textAlign: 'left', borderBottom: '2px solid #E5E7EB', whiteSpace: 'nowrap', overflow: 'hidden' },
  td:         { padding: '4px 6px', verticalAlign: 'middle', overflow: 'hidden' },
  footer:     { padding: '8px 18px', borderTop: '1px solid #E5E7EB', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  btn:        { border: 'none', borderRadius: 5, padding: '5px 12px', fontWeight: 600, cursor: 'pointer', fontSize: 12, minHeight: 28 },
  input:      { padding: '4px 6px', border: '1px solid #D1D5DB', borderRadius: 4, fontSize: 12, outline: 'none' },
  tagCell:    { display: 'flex', alignItems: 'center', gap: 4, padding: '4px 6px', border: '1px solid #D1D5DB', borderRadius: 4, cursor: 'pointer', background: '#fff', minHeight: 26 },
};
