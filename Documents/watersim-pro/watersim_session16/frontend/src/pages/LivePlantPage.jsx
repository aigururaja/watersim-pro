/**
 * WaterSim Pro — LivePlantPage
 * The screen on the wall. Every process area of the plant with its measured
 * points, its drives drawn by the canvas's own symbols in their measured
 * state, the active alarms, the health of every PLC link, the maintenance
 * load, and the trends someone pinned — updating live from the organisation's
 * WebSocket room.
 *
 * Route: /live
 *
 * Cold start and once-a-minute reconciliation: GET /live/snapshot. In between,
 * plc:update / alarm:event / task:event / notification arrive on the socket.
 * Control (start/stop/open/close) goes through the existing PLC write
 * endpoint after a confirmation; the server audits it.
 */
import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Link } from 'react-router-dom';
import {
  Monitor, Radio, RefreshCw, Loader2, BellRing, Check, Wifi, WifiOff, ClipboardList, AlertTriangle, Pin, X,
} from 'lucide-react';
import AppLayout from '../components/layout/AppLayout';
import EmptyState from '../components/EmptyState';
import Sparkline from '../components/live/Sparkline';
import EquipmentCard, { InstrumentCard } from '../components/live/EquipmentCard';
import ControlDialog from '../components/live/ControlDialog';
import MimicView from '../components/mimic/MimicView';
import { MimicDefs } from '../components/mimic/MimicSymbols';
import { familyOf, layoutBounds, NODE_W } from '../components/mimic/mimicLayout';
import api from '../services/api';
import { useAuth } from '../context/AuthContext';
import { useOrgLive } from '../hooks/useOrgLive';
import { severityMeta, relTime, absTime } from '../components/alarms/alarmState';
import { readPins } from './TrendsPage';

const RECONCILE_MS = 60_000;

function SeverityPill({ severity }) {
  const s = severityMeta(severity);
  const Icon = s.icon;
  return (
    <span data-severity={s.key} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold border"
      style={{ background: s.bg, color: s.color, borderColor: s.border }}>
      <Icon className="w-3 h-3" aria-hidden="true" />{s.label}
    </span>
  );
}

function ConnChip({ c }) {
  const tone = !c.enabled ? 'text-gray-500 bg-gray-50 border-gray-200'
    : c.status === 'online' ? 'text-emerald-700 bg-emerald-50 border-emerald-200'
      : c.status === 'error' ? 'text-red-700 bg-red-50 border-red-200'
        : 'text-gray-600 bg-gray-50 border-gray-200';
  return (
    <span className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-lg border text-[11px] ${tone}`} title={c.lastError || (c.lastSeen ? `Last seen ${absTime(c.lastSeen)}` : 'Never seen')} data-connection={c.id}>
      {c.status === 'online' ? <Wifi className="w-3 h-3" /> : <WifiOff className="w-3 h-3" />}
      <span className="font-medium">{c.name}</span>
      <span className="text-[10px] opacity-80">{c.protocol}</span>
      <span className="font-mono text-[10px]">{c.good}/{c.bindings} good{c.stale ? ` · ${c.stale} stale` : ''}{c.bad ? ` · ${c.bad} bad` : ''}</span>
    </span>
  );
}

export default function LivePlantPage() {
  const { can } = useAuth();
  const canAck = typeof can === 'function' && can('alarm.ack');
  const canControl = typeof can === 'function' && can('control.write');

  const [snap, setSnap] = useState(null);
  const [tags, setTags] = useState(new Map());       // tagId → tag with live value
  const [equipment, setEquipment] = useState([]);
  const [alarms, setAlarms] = useState([]);
  const [tasks, setTasks] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [toast, setToast] = useState(null);
  const [control, setControl] = useState(null);     // { equipment, action }
  const [writing, setWriting] = useState(false);
  const [writeError, setWriteError] = useState(null);
  const [acking, setAcking] = useState(new Set());
  const [pins] = useState(readPins);
  const [pinned, setPinned] = useState([]);
  const [lastUpdate, setLastUpdate] = useState(null);
  // Schematic (the mimic) or the area cards; remembered per browser.
  const [view, setView] = useState(() => { try { return localStorage.getItem('ws.liveView') || 'schematic'; } catch { return 'schematic'; } });
  const [canvas, setCanvas] = useState(null);    // { nodes, edges } of the plant flowsheet
  const [selectedNode, setSelectedNode] = useState(null);
  const chooseView = (v) => { setView(v); try { localStorage.setItem('ws.liveView', v); } catch { /* private mode */ } };

  const showToast = useCallback((msg, ok = true) => { setToast({ msg, ok }); setTimeout(() => setToast(null), 4000); }, []);

  // ── Cold start / reconcile ──
  const reqRef = useRef(0);
  const load = useCallback(async (silent = false) => {
    const seq = ++reqRef.current;
    if (!silent) setLoading(true);
    try {
      const { data } = await api.get('/live/snapshot');
      if (seq !== reqRef.current) return;
      setSnap(data);
      setTags(new Map((data.tags || []).map((t) => [t.id, t])));
      setEquipment(data.equipment || []);
      setAlarms(data.alarms?.active || []);
      setTasks(data.tasks || null);
      setLastUpdate(Date.now());
      setError(null);
    } catch (err) {
      if (seq !== reqRef.current) return;
      setError(err.response?.data?.error || err.message || 'Could not load the plant');
    } finally {
      if (seq === reqRef.current) setLoading(false);
    }
  }, []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { const t = setInterval(() => load(true), RECONCILE_MS); return () => clearInterval(t); }, [load]);

  // The plant drawing: the flowsheet with the most bound points.
  const plant = snap?.flowsheets?.[0] || null;
  useEffect(() => {
    if (!plant?.id || !plant?.projectId) { setCanvas(null); return undefined; }
    let cancelled = false;
    api.get(`/projects/${plant.projectId}/flowsheets/${plant.id}`)
      .then(({ data }) => {
        if (cancelled) return;
        const c = data?.canvas_data || data?.canvasData || data?.data?.canvas_data || {};
        setCanvas({ nodes: Array.isArray(c.nodes) ? c.nodes : [], edges: Array.isArray(c.edges) ? c.edges : [] });
      })
      .catch(() => { if (!cancelled) setCanvas(null); });
    return () => { cancelled = true; };
  }, [plant?.id, plant?.projectId]);

  // ── Pinned trends ──
  const loadPins = useCallback(async () => {
    if (!pins.length) return;
    try {
      const { data } = await api.get(`/tags/history?ids=${pins.map((p) => p.tagId).join(',')}&range=6h&bucket=1m`);
      setPinned(data.series || []);
    } catch { /* the sparklines simply stay empty */ }
  }, [pins]);
  useEffect(() => { loadPins(); const t = setInterval(loadPins, RECONCILE_MS); return () => clearInterval(t); }, [loadPins]);

  // ── Live feed ──
  const applyValues = useCallback((values) => {
    if (!values?.length) return;
    setLastUpdate(Date.now());
    setTags((prev) => {
      let changed = false;
      const next = new Map(prev);
      for (const v of values) {
        const id = v.tagId;
        if (!id || !next.has(id)) continue;
        const t = next.get(id);
        next.set(id, { ...t, value: v.value, quality: v.quality, at: v.ts });
        changed = true;
      }
      return changed ? next : prev;
    });
    setEquipment((prev) => {
      const byTag = new Map(values.filter((v) => v.tagId).map((v) => [v.tagId, v]));
      let changed = false;
      const next = prev.map((e) => {
        let out = e;
        const touch = (sigKey, field, value) => {
          const sig = e[sigKey];
          const v = sig && byTag.get(sig.tagId);
          if (!v) return;
          const bit = v.value == null ? null : v.value >= 0.5;
          out = { ...out, [field]: bit, [sigKey]: { ...sig, value: v.value, quality: v.quality, at: v.ts }, quality: v.quality, at: v.ts };
          changed = true;
        };
        touch('status', 'running'); touch('trip', 'tripped'); touch('openSwitch', 'opened'); touch('closeSwitch', 'closed');
        return out;
      });
      return changed ? next : prev;
    });
  }, []);

  const onAlarmEvent = useCallback(({ event, transition }) => {
    if (!event) return;
    setLastUpdate(Date.now());
    setAlarms((prev) => {
      if (transition === 'cleared' || event.state === 'cleared') return prev.filter((a) => a.id !== event.id);
      const exists = prev.some((a) => a.id === event.id);
      const row = { id: event.id, severity: event.severity, message: event.message, value: event.value, triggeredAt: event.triggeredAt,
        acknowledged: !!event.acknowledged, ruleName: event.ruleName, flowsheetId: event.flowsheetId, source: event.source };
      return exists ? prev.map((a) => (a.id === event.id ? { ...a, ...row } : a)) : [row, ...prev];
    });
    if (transition === 'raised') showToast(`${event.severity === 'critical' ? 'CRITICAL' : 'Alarm'}: ${event.message}`, false);
  }, [showToast]);

  const onTaskEvent = useCallback(({ task, action }) => {
    setLastUpdate(Date.now());
    if (action === 'created' && task) showToast(`${task.number} raised: ${task.title}`);
    load(true);
  }, [load, showToast]);

  const onNotification = useCallback((n) => {
    if (n?.eventType?.startsWith('task.')) showToast(n.subject);
  }, [showToast]);

  const { connected } = useOrgLive({ onPlcUpdate: applyValues, onAlarmEvent, onTaskEvent, onNotification });

  // ── Actions ──
  const ack = async (a) => {
    setAcking((s) => new Set(s).add(a.id));
    try {
      await api.post(`/alarms/events/${a.id}/ack`);
      setAlarms((prev) => prev.map((x) => (x.id === a.id ? { ...x, acknowledged: true } : x)));
    } catch (err) {
      showToast(err.response?.data?.error || 'Acknowledge failed', false);
    } finally {
      setAcking((s) => { const n = new Set(s); n.delete(a.id); return n; });
    }
  };

  const confirmControl = async (value) => {
    const { equipment: e } = control;
    setWriting(true); setWriteError(null);
    try {
      await api.post(`/projects/${e.command.projectId}/flowsheets/${e.command.flowsheetId}/plc-bindings/${e.command.bindingId}/write`, { value });
      showToast(`${e.key}: ${value ? 'start' : 'stop'} command written`);
      setControl(null);
    } catch (err) {
      setWriteError(err.response?.data?.error || 'The PLC refused the write');
    } finally {
      setWriting(false);
    }
  };

  // ── Derived views ──
  const tagList = useMemo(() => [...tags.values()], [tags]);
  const areas = useMemo(() => (snap?.areas || []).map((a) => ({
    ...a,
    analog: tagList.filter((t) => t.area === a.code && t.signalType === 'AI'),
    equipment: equipment.filter((e) => e.area === a.code),
    alarms: alarms.filter((x) => x.area === a.code).length,
  })), [snap, tagList, equipment, alarms]);
  const counts = useMemo(() => ({
    critical: alarms.filter((a) => a.severity === 'critical').length,
    warning: alarms.filter((a) => a.severity === 'warning').length,
    unack: alarms.filter((a) => !a.acknowledged).length,
  }), [alarms]);
  const comms = snap?.comms;

  // Measured state per canvas node, from the bound tags on it: contacts become
  // running / tripped / opened / closed, a level transmitter becomes a level,
  // analogue readings keep their span for the dials.
  const nodeStates = useMemo(() => {
    const m = new Map();
    const at = (id) => { if (!m.has(id)) m.set(id, { readings: {} }); return m.get(id); };
    for (const t of tagList) {
      if (!t.nodeId) continue;
      const s = at(t.nodeId);
      const bit = t.value == null ? null : t.value >= 0.5;
      if (t.signalType === 'DI') {
        if (t.fn === 'XS') s.running = s.running === true ? true : bit;
        else if (t.fn === 'XA') s.tripped = s.tripped === true ? true : bit;
        else if (t.fn === 'ZSO') s.opened = bit;
        else if (t.fn === 'ZSC') s.closed = bit;
      } else if (t.signalType === 'AI') {
        if (t.fn === 'LT' && t.value != null) s.level = Number(t.value);
        s.readings[t.fn] = { value: t.value, quality: t.quality, rangeMin: t.rangeMin, rangeMax: t.rangeMax, at: t.at, tag: t.tag };
      }
      if (t.quality && t.quality !== 'good' && t.signalType !== 'DO') s.quality = t.quality;
    }
    return m;
  }, [tagList]);
  // No plant flowsheet to draw (nothing bound yet) → the area cards are the only view.
  const effectiveView = plant ? view : 'areas';

  // Which canvas nodes belong to each area: the node's own area, plus the
  // nodes its bound tags name. An area with nodes is drawn as its piece of the
  // flow; one without (nothing on the canvas yet) falls back to cards.
  const areaNodes = useMemo(() => {
    const m = new Map();
    const onCanvas = new Set((canvas?.nodes || []).map((n) => n.id));
    const add = (code, id) => { if (!code || !onCanvas.has(id)) return; if (!m.has(code)) m.set(code, new Set()); m.get(code).add(id); };
    for (const n of canvas?.nodes || []) add(n.data?.area, n.id);
    for (const t of tagList) add(t.area, t.nodeId);
    return m;
  }, [canvas, tagList]);
  // Areas in the order the water meets them (left to right on the sheet).
  const areaList = useMemo(() => {
    if (!canvas) return areas;
    const pos = new Map(canvas.nodes.map((n) => [n.id, n.position || { x: 0, y: 0 }]));
    const key = (a) => {
      let k = Infinity;
      for (const id of areaNodes.get(a.code) || []) { const q = pos.get(id); if (q) k = Math.min(k, q.x * 4 + q.y); }
      return k;
    };
    return areas.map((a, i) => ({ a, i, k: key(a) })).sort((x, y) => (x.k - y.k) || (x.i - y.i)).map((x) => x.a);
  }, [areas, canvas, areaNodes]);
  // Window height per area from its layout's aspect; a one-tank area is
  // treated as three machines wide so the neighbours its pipes reach show too.
  const areaHeight = (ids) => {
    const b = layoutBounds(canvas.nodes.filter((n) => ids.has(n.id)), 40);
    const w = Math.max(b.w, 3 * NODE_W + 160);
    return Math.max(200, Math.min(440, Math.round(820 * (b.h / w))));
  };
  const selected = selectedNode && canvas ? canvas.nodes.find((n) => n.id === selectedNode) : null;
  const selectedTags = useMemo(() => tagList.filter((t) => t.nodeId === selectedNode), [tagList, selectedNode]);
  const selectedEquipment = useMemo(() => equipment.filter((e) => e.nodeId === selectedNode), [equipment, selectedNode]);

  const selectedPanel = selected ? (
  <aside className="card p-3 w-full lg:w-72 flex-shrink-0 space-y-2" aria-label="Selected equipment">
    <div className="flex items-start justify-between gap-2">
      <div className="min-w-0">
        <div className="text-sm font-semibold text-gray-900 leading-snug">{selected.data?.label || selected.id}</div>
        <div className="text-[11px] text-gray-500">{familyOf(selected.data?.opType)} · {selected.data?.area || ''}</div>
      </div>
      <button onClick={() => setSelectedNode(null)} className="p-1 text-gray-400 hover:text-gray-600" aria-label="Close equipment"><X className="w-4 h-4" /></button>
    </div>
    {selected.data?.source && <div className="text-[11px] text-gray-500">{selected.data.source}</div>}
    <ul className="text-xs divide-y divide-gray-100" aria-label="Points">
      {selectedTags.map((t) => (
        <li key={t.id} className="py-1 flex items-center justify-between gap-2">
          <span className="font-mono text-gray-800 truncate">{t.tag}</span>
          <span className={`tabular-nums ${t.quality === 'good' ? 'text-gray-900' : 'text-amber-700'}`}>
            {t.value == null ? '—' : t.signalType === 'DI' || t.signalType === 'DO' ? (t.value >= 0.5 ? 'ON' : 'OFF') : Number(t.value).toLocaleString('en-IN', { maximumFractionDigits: 1 })}
            {t.signalType === 'AI' && t.engUnit ? ` ${t.engUnit}` : ''}
          </span>
        </li>
      ))}
      {!selectedTags.length && <li className="py-1 text-gray-400">No PLC points bound on this equipment.</li>}
    </ul>
    {selectedEquipment.filter((e) => e.command).map((e) => (
      <div key={e.key} className="flex items-center justify-between gap-2 pt-1">
        <span className="font-mono text-xs text-gray-700">{e.key}</span>
        {canControl ? (
          <button onClick={() => { setWriteError(null); setControl({ equipment: e, action: e.opType === 'valve' ? (e.opened === true ? 'close' : 'open') : (e.running === true ? 'stop' : 'start') }); }}
            className={`text-xs px-2 py-1 rounded border font-semibold ${e.running === true || e.opened === true ? 'text-red-700 border-red-300 hover:bg-red-50' : 'text-emerald-700 border-emerald-300 hover:bg-emerald-50'}`}
            aria-label={`${e.opType === 'valve' ? (e.opened === true ? 'close' : 'open') : (e.running === true ? 'stop' : 'start')} ${e.key}`}>
            {e.opType === 'valve' ? (e.opened === true ? 'Close' : 'Open') : (e.running === true ? 'Stop' : 'Start')}
          </button>
        ) : <span className="text-[10px] text-gray-400">operators control</span>}
      </div>
    ))}
  </aside>
  ) : null;

  return (
    <AppLayout immersive>
      {/* Gradients for the area cards; the schematic carries its own copy. */}
      <svg width="0" height="0" aria-hidden="true" focusable="false" style={{ position: 'absolute' }}><MimicDefs /></svg>
      <div className="p-3 md:p-5 space-y-4 max-w-[1800px] mx-auto">
        {/* Header */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <h2 className="text-xl font-bold text-gray-900 flex items-center gap-2">
              <Monitor className="w-5 h-5 text-brand-600" aria-hidden="true" /> Live plant
            </h2>
            <span className={`inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full border ${connected ? 'text-emerald-700 bg-emerald-50 border-emerald-200' : 'text-gray-500 bg-gray-50 border-gray-200'}`} data-testid="ws-status">
              <Radio className="w-3 h-3" /> {connected ? 'live' : 'polling'}
            </span>
            {lastUpdate && <span className="text-[11px] text-gray-400">updated {relTime(lastUpdate)}</span>}
          </div>
          <div className="flex items-center gap-2 flex-wrap text-[11px]">
            <Link to="/alarms" className={`inline-flex items-center gap-1 px-2 py-1 rounded-lg border ${counts.critical ? 'text-red-700 bg-red-50 border-red-200' : 'text-gray-600 bg-gray-50 border-gray-200'}`}>
              <BellRing className="w-3 h-3" /> {counts.critical} critical · {counts.warning} warning · {counts.unack} unacknowledged
            </Link>
            {tasks && (
              <Link to="/tasks" className={`inline-flex items-center gap-1 px-2 py-1 rounded-lg border ${tasks.overdue ? 'text-red-700 bg-red-50 border-red-200' : 'text-gray-600 bg-gray-50 border-gray-200'}`}>
                <ClipboardList className="w-3 h-3" /> {tasks.open} open tasks · {tasks.awaitingApproval} awaiting approval{tasks.overdue ? ` · ${tasks.overdue} overdue` : ''}
              </Link>
            )}
            <button onClick={() => load()} disabled={loading} className="btn-secondary text-xs py-1 disabled:opacity-50" aria-label="Refresh">
              <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            </button>
          </div>
        </div>

        {error && <div role="alert" className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-xl px-4 py-2.5">{error}</div>}

        {/* Comms bar */}
        {comms && (
          <div className="flex flex-wrap items-center gap-2" aria-label="PLC connections">
            {comms.connections.map((c) => <ConnChip key={c.id} c={c} />)}
            {!comms.connections.length && <span className="text-xs text-gray-400">No PLC connections — add one under Settings → PLC.</span>}
            <span className="text-[11px] text-gray-400 ml-auto">{comms.bindings.good}/{comms.bindings.total} points good</span>
          </div>
        )}

        {/* Alarm strip */}
        {alarms.length > 0 && (
          <section className="card p-2 divide-y divide-gray-100" aria-label="Active alarms">
            {alarms.slice(0, 8).map((a) => (
              <div key={a.id} className="flex items-center gap-3 px-2 py-1.5 text-sm" data-alarm={a.id}>
                <SeverityPill severity={a.severity} />
                <span className="flex-1 min-w-0 truncate text-gray-800" title={a.message}>{a.message}</span>
                <span className="text-[11px] text-gray-400 whitespace-nowrap" title={absTime(a.triggeredAt)}>{relTime(a.triggeredAt)}</span>
                {a.acknowledged
                  ? <span className="inline-flex items-center gap-1 text-[11px] text-emerald-700"><Check className="w-3 h-3" /> ack</span>
                  : canAck && (
                    <button onClick={() => ack(a)} disabled={acking.has(a.id)} className="btn-secondary text-[11px] py-0.5 px-2 disabled:opacity-50" aria-label={`Acknowledge ${a.ruleName || a.message}`}>
                      {acking.has(a.id) ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />} Ack
                    </button>
                  )}
              </div>
            ))}
            {alarms.length > 8 && <div className="px-2 py-1 text-[11px] text-gray-400"><Link to="/alarms" className="text-brand-700 hover:underline">{alarms.length - 8} more…</Link></div>}
          </section>
        )}

        {/* View switch */}
        {snap && plant && (
          <div className="flex items-center gap-2" role="tablist" aria-label="Plant view">
            <button role="tab" aria-selected={effectiveView === 'schematic'} onClick={() => chooseView('schematic')} className={`px-3 py-1.5 text-xs font-medium rounded-lg border ${effectiveView === 'schematic' ? 'bg-brand-600 text-white border-brand-600' : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'}`}>Schematic</button>
            <button role="tab" aria-selected={effectiveView === 'areas'} onClick={() => chooseView('areas')} className={`px-3 py-1.5 text-xs font-medium rounded-lg border ${effectiveView === 'areas' ? 'bg-brand-600 text-white border-brand-600' : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'}`}>Areas</button>
            <span className="text-[11px] text-gray-400 ml-1">{plant.name} · {plant.bound} bound points</span>
          </div>
        )}

        {/* Schematic */}
        {effectiveView === 'schematic' && snap && plant && (
          <div className="flex flex-col lg:flex-row gap-3 items-stretch lg:items-start">
            <div className="flex-1 min-w-0 w-full">
              {canvas ? (
                <MimicView nodes={canvas.nodes} edges={canvas.edges} states={nodeStates} selected={selectedNode} onSelect={setSelectedNode} height={640} />
              ) : (
                <div className="card p-8 text-center text-sm text-gray-400"><Loader2 className="w-5 h-5 animate-spin inline-block mr-2" />Drawing the plant…</div>
              )}
            </div>
            {selectedPanel}
          </div>
        )}

        {/* Areas */}
        {loading && !snap ? (
          <div className="card p-8 text-center text-sm text-gray-400"><Loader2 className="w-5 h-5 animate-spin inline-block mr-2" />Loading the plant…</div>
        ) : effectiveView === 'schematic' && plant ? null : !areas.length ? (
          <EmptyState icon={Monitor} title="Nothing is bound to a PLC yet"
            description="Bind registry tags to a PLC connection on a flowsheet and this screen fills itself: gauges for analogue points, cards for drives and valves, alarms as they happen." />
        ) : (
          <div className="flex flex-col lg:flex-row gap-3 items-stretch lg:items-start">
            <div className={`flex-1 min-w-0 w-full grid gap-3 md:grid-cols-2 ${canvas ? '' : '2xl:grid-cols-3'}`} role="list" aria-label="Process areas">
              {areaList.map((a) => {
                const ids = canvas ? areaNodes.get(a.code) : null;
                const asFlow = !!(ids && ids.size);
                const drives = a.equipment.filter((e) => e.opType !== 'valve');
                const valves = a.equipment.filter((e) => e.opType === 'valve');
                return (
                  <section key={a.code} className={`card p-3 ${a.alarms ? 'border-red-200' : ''}`} aria-label={a.name} data-area={a.code} data-view={asFlow ? 'flow' : 'cards'}>
                    <div className="flex items-center justify-between gap-2 mb-2">
                      <div className="min-w-0">
                        <div className="text-sm font-semibold text-gray-900 truncate">{a.name}</div>
                        <div className="text-[10px] text-gray-400 font-mono">
                          {a.code} · {a.good}/{a.points} points good
                          {drives.length > 0 && ` · ${drives.filter((e) => e.running === true).length}/${drives.length} running`}
                          {valves.length > 0 && ` · ${valves.filter((e) => e.opened === true).length}/${valves.length} open`}
                        </div>
                      </div>
                      {a.alarms > 0 && (
                        <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-red-700 bg-red-50 border border-red-200 rounded-full px-2 py-0.5">
                          <AlertTriangle className="w-3 h-3" /> {a.alarms} alarm{a.alarms === 1 ? '' : 's'}
                        </span>
                      )}
                    </div>
                    {asFlow ? (
                      <MimicView nodes={canvas.nodes} edges={canvas.edges} states={nodeStates} focus={ids} selected={selectedNode} onSelect={setSelectedNode} height={areaHeight(ids)} compact />
                    ) : (
                      <>
                        {a.analog.length > 0 && (
                          <div className="flex flex-wrap gap-2 mb-2" aria-label={`${a.name} readings`}>
                            {a.analog.map((t) => <InstrumentCard key={t.id} tag={t} />)}
                          </div>
                        )}
                        {a.equipment.length > 0 && (
                          <div className="flex flex-wrap gap-2" aria-label={`${a.name} equipment`}>
                            {a.equipment.map((e) => <EquipmentCard key={e.key} equipment={e} canControl={canControl} onControl={(eq, action) => { setWriteError(null); setControl({ equipment: eq, action }); }} />)}
                          </div>
                        )}
                        {!a.analog.length && !a.equipment.length && <div className="text-[11px] text-gray-400">Only digital points here.</div>}
                      </>
                    )}
                  </section>
                );
              })}
            </div>
            {selectedPanel}
          </div>
        )}

        {/* Pinned trends */}
        {pins.length > 0 && (
          <section className="card p-3 space-y-2" aria-label="Pinned trends">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-gray-900 flex items-center gap-1"><Pin className="w-3.5 h-3.5 text-gray-400" /> Pinned trends · last 6 h</h3>
              <Link to={`/trends?ids=${pins.map((p) => p.tagId).join(',')}`} className="text-xs text-brand-700 hover:underline">Open in Trends</Link>
            </div>
            <div className="grid gap-2 md:grid-cols-2 2xl:grid-cols-3">
              {pins.map((p) => {
                const s = pinned.find((x) => x.tagId === p.tagId);
                return <Sparkline key={p.tagId} tag={p.tag} name={p.name} unit={p.unit} points={s?.points || []} />;
              })}
            </div>
          </section>
        )}
      </div>

      {control && (
        <ControlDialog equipment={control.equipment} action={control.action} busy={writing} error={writeError}
          onClose={() => setControl(null)} onConfirm={confirmControl} />
      )}

      {toast && (
        <div role="status" aria-live="polite"
          className={`fixed bottom-20 md:bottom-6 right-4 z-50 px-4 py-3 rounded-xl shadow-xl text-white text-sm font-medium ${toast.ok ? 'bg-emerald-700' : 'bg-red-700'}`}>
          {toast.ok ? '✓' : '⚠'} {toast.msg}
        </div>
      )}
    </AppLayout>
  );
}
