/**
 * WaterSim Pro — TrendsPage
 * Any tag over any window, from the historian. Pick up to eight points from
 * the registry, choose a range and a resolution, and read them as stacked
 * charts with a shared time axis. Export the window as CSV, or as a period
 * report (PDF / Excel) through the same Python runner as the run reports.
 *
 * Route: /trends
 *
 * The chart is recharts, fixed-width inside a measured container (the same
 * approach as LiveChartsDock: no ResponsiveContainer, one ResizeObserver, a
 * fixed fallback width in jsdom). Points arrive as compact arrays
 * [ts, avg, min, max, last, count] and are expanded once per series.
 *
 * "Pin" writes the selection to localStorage (`ws.trendPins`); the Phase 3
 * operations dashboard reads the same key to show pinned trends.
 */
import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Area, ComposedChart, ReferenceLine,
} from 'recharts';
import {
  LineChart as LineChartIcon, Search, X, Download, FileText, FileSpreadsheet, Pin, PinOff,
  RefreshCw, Loader2, Radio, ChevronDown, Activity,
} from 'lucide-react';
import AppLayout from '../components/layout/AppLayout';
import EmptyState from '../components/EmptyState';
import api from '../services/api';
import { downloadFile } from '../utils/download';

export const MAX_SELECTED = 8;
export const PINS_KEY = 'ws.trendPins';

const RANGES = [
  { key: '1h', label: '1 h' }, { key: '6h', label: '6 h' }, { key: '24h', label: '24 h' },
  { key: '7d', label: '7 d' }, { key: '30d', label: '30 d' },
];
const BUCKETS = ['auto', 'raw', '1m', '5m', '15m', '1h', '6h', '1d'];
const COLORS = ['#1E40AF', '#0891B2', '#D97706', '#7C3AED', '#DC2626', '#16A34A', '#DB2777', '#4B5563'];

// ── Helpers ───────────────────────────────────────────────────────────────────

export function readPins() {
  try { const v = JSON.parse(localStorage.getItem(PINS_KEY) || '[]'); return Array.isArray(v) ? v : []; }
  catch { return []; }
}
function writePins(pins) {
  try { localStorage.setItem(PINS_KEY, JSON.stringify(pins)); } catch { /* private mode */ }
}

const fmtNum = (v, dp = 2) => (v == null || !Number.isFinite(Number(v)) ? '—'
  : Number(v).toLocaleString('en-IN', { maximumFractionDigits: Math.abs(v) >= 1000 ? 0 : dp }));

function fmtTick(ts, spanMs) {
  const d = new Date(ts);
  if (spanMs <= 36 * 3600_000) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (spanMs <= 14 * 86400_000) return d.toLocaleString([], { day: '2-digit', month: 'short', hour: '2-digit' });
  return d.toLocaleDateString([], { day: '2-digit', month: 'short' });
}
const fmtFull = (ts) => new Date(ts).toLocaleString();

/** [ts, avg, min, max, last, count] → the object recharts wants. */
const expand = (points) => points.map((p) => ({ ts: p[0], avg: p[1], min: p[2], max: p[3], last: p[4], count: p[5] }));

function QualityDot({ binding }) {
  if (!binding) return <span className="w-2 h-2 rounded-full bg-gray-300 inline-block" title="Not bound to a PLC" />;
  const tone = binding.quality === 'good' ? 'bg-emerald-500' : binding.quality === 'stale' ? 'bg-amber-500' : 'bg-red-500';
  return <span className={`w-2 h-2 rounded-full inline-block ${tone}`} title={`PLC ${binding.quality}`} />;
}

// ── Tag picker ────────────────────────────────────────────────────────────────

function TagPicker({ tags, selected, onToggle, loading }) {
  const [q, setQ] = useState('');
  const [analogOnly, setAnalogOnly] = useState(true);
  const needle = q.trim().toLowerCase();
  const shown = useMemo(() => tags
    .filter((t) => !analogOnly || t.signalType === 'AI' || t.binding)
    .filter((t) => !needle || `${t.tag} ${t.name} ${t.area}`.toLowerCase().includes(needle)), [tags, needle, analogOnly]);
  const groups = useMemo(() => {
    const m = new Map();
    for (const t of shown) { if (!m.has(t.area)) m.set(t.area, []); m.get(t.area).push(t); }
    return [...m.entries()];
  }, [shown]);

  return (
    <aside className="w-full md:w-72 flex-shrink-0 card p-3 flex flex-col gap-2 md:h-[calc(100vh-8rem)]" aria-label="Tag picker">
      <div className="relative">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400" aria-hidden="true" />
        <input type="search" className="input py-1.5 pl-8 text-sm w-full" placeholder="Find a tag…" value={q}
          onChange={(e) => setQ(e.target.value)} aria-label="Find a tag" />
      </div>
      <label className="flex items-center gap-2 text-xs text-gray-600">
        <input type="checkbox" checked={analogOnly} onChange={(e) => setAnalogOnly(e.target.checked)} className="accent-brand-600" />
        Analogue and bound points only
      </label>
      <div className="text-[11px] text-gray-400">{selected.size} of {MAX_SELECTED} selected · {shown.length} shown</div>
      <div className="flex-1 overflow-y-auto -mx-1 px-1 space-y-2">
        {loading && <div className="text-xs text-gray-400 py-4 text-center">Loading the registry…</div>}
        {!loading && !shown.length && <div className="text-xs text-gray-400 py-4 text-center">No tags match.</div>}
        {groups.map(([area, items]) => (
          <div key={area}>
            <div className="text-[10px] font-semibold uppercase tracking-wider text-gray-400 px-1 mb-0.5">{area}</div>
            {items.map((t) => {
              const on = selected.has(t.id);
              const full = !on && selected.size >= MAX_SELECTED;
              return (
                <label key={t.id} className={`flex items-center gap-2 px-1.5 py-1 rounded text-xs cursor-pointer ${on ? 'bg-brand-50' : 'hover:bg-gray-50'} ${full ? 'opacity-50' : ''}`}>
                  <input type="checkbox" checked={on} disabled={full} onChange={() => onToggle(t)} className="accent-brand-600" aria-label={t.tag} />
                  <QualityDot binding={t.binding} />
                  <span className="font-mono text-gray-800 whitespace-nowrap">{t.tag}</span>
                  <span className="text-gray-500 truncate flex-1" title={t.name}>{t.name}</span>
                  {t.binding?.value != null && <span className="text-gray-400 tabular-nums">{fmtNum(t.binding.value, 1)}</span>}
                </label>
              );
            })}
          </div>
        ))}
      </div>
    </aside>
  );
}

// ── One chart per series ──────────────────────────────────────────────────────

function SeriesChart({ series, color, width, spanMs, raw, onRemove }) {
  const data = useMemo(() => expand(series.points), [series.points]);
  const s = series.stats || {};
  const hasBand = !raw && data.some((d) => d.min != null && d.max != null);
  const chartData = useMemo(() => data.map((d) => ({ ...d, band: hasBand && d.min != null && d.max != null ? [d.min, d.max] : undefined })), [data, hasBand]);
  const hasRange = series.rangeMin != null && series.rangeMax != null && series.rangeMax > series.rangeMin;
  const w = Math.max(320, width);

  return (
    <section className="card p-3" aria-label={`${series.tag} trend`} data-tag={series.tag}>
      <div className="flex items-start justify-between gap-2 mb-1">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="w-2.5 h-2.5 rounded-sm flex-shrink-0" style={{ background: color }} aria-hidden="true" />
            <span className="font-mono text-sm font-semibold text-gray-900">{series.tag}</span>
            <span className="text-sm text-gray-500 truncate">{series.name}</span>
          </div>
          <div className="text-[11px] text-gray-500 mt-0.5 tabular-nums">
            min <b>{fmtNum(s.min)}</b> · avg <b>{fmtNum(s.avg)}</b> · max <b>{fmtNum(s.max)}</b> · last <b>{fmtNum(s.last)}</b>
            {series.unit ? ` ${series.unit}` : ''} · {s.samples ?? 0} samples
          </div>
        </div>
        <button onClick={onRemove} className="p-1 text-gray-400 hover:text-gray-600 rounded" aria-label={`Remove ${series.tag}`}>
          <X className="w-4 h-4" />
        </button>
      </div>
      {!data.length ? (
        <div className="h-32 flex items-center justify-center text-xs text-gray-400">No samples in this window.</div>
      ) : (
        <div className="overflow-x-auto">
          <ComposedChart width={w} height={180} data={chartData} syncId="trends" margin={{ top: 6, right: 12, bottom: 4, left: 0 }}>
            <CartesianGrid stroke="#F3F4F6" />
            <XAxis dataKey="ts" type="number" domain={['dataMin', 'dataMax']} tickFormatter={(v) => fmtTick(v, spanMs)} tick={{ fontSize: 10 }} minTickGap={40} />
            <YAxis tick={{ fontSize: 10 }} width={52} domain={['auto', 'auto']} unit={series.unit ? '' : undefined} />
            <Tooltip
              labelFormatter={fmtFull}
              formatter={(v, name) => [Array.isArray(v) ? `${fmtNum(v[0])} – ${fmtNum(v[1])}` : fmtNum(v), name === 'band' ? 'min–max' : name === 'avg' ? (raw ? 'value' : 'average') : name]}
              contentStyle={{ fontSize: 11 }}
            />
            {hasBand && <Area dataKey="band" stroke="none" fill={color} fillOpacity={0.15} isAnimationActive={false} />}
            {hasRange && <ReferenceLine y={series.rangeMin} stroke="#9CA3AF" strokeDasharray="4 3" />}
            {hasRange && <ReferenceLine y={series.rangeMax} stroke="#9CA3AF" strokeDasharray="4 3" />}
            <Line dataKey="avg" stroke={color} dot={false} strokeWidth={1.6} isAnimationActive={false} connectNulls={false} />
          </ComposedChart>
        </div>
      )}
    </section>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function TrendsPage() {
  const [params, setParams] = useSearchParams();
  const [tags, setTags] = useState([]);
  const [tagsLoading, setTagsLoading] = useState(true);
  const [selected, setSelected] = useState(() => new Map());
  const [range, setRange] = useState(params.get('range') || '6h');
  const [custom, setCustom] = useState({ from: params.get('from') || '', to: params.get('to') || '' });
  const [bucket, setBucket] = useState(params.get('bucket') || 'auto');
  const [live, setLive] = useState(true);
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [exporting, setExporting] = useState(null);
  const [toast, setToast] = useState(null);
  const [pins, setPins] = useState(readPins);

  const showToast = useCallback((msg, ok = true) => { setToast({ msg, ok }); setTimeout(() => setToast(null), 3500); }, []);

  // Chart width from one observer on the chart column (fixed fallback in jsdom).
  const [width, setWidth] = useState(0);
  const roRef = useRef(null);
  const colRef = useCallback((node) => {
    if (roRef.current) { roRef.current.disconnect(); roRef.current = null; }
    if (node && typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver((entries) => setWidth(Math.round(entries[0].contentRect.width)));
      ro.observe(node);
      roRef.current = ro;
    }
  }, []);
  const chartWidth = width > 0 ? width - 26 : 640;

  // ── Registry ──
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { data } = await api.get('/tags?limit=1000');
        if (cancelled) return;
        const list = Array.isArray(data?.tags) ? data.tags : [];
        setTags(list);
        // Preselect from ?ids=, else from pins.
        const wanted = (params.get('ids') || '').split(',').filter(Boolean);
        const initial = wanted.length ? wanted : readPins().map((p) => p.tagId);
        const m = new Map();
        for (const id of initial) { const t = list.find((x) => x.id === id); if (t && m.size < MAX_SELECTED) m.set(t.id, t); }
        setSelected(m);
      } catch (err) {
        if (!cancelled) setError(err.response?.data?.error || 'Could not load the tag registry');
      } finally {
        if (!cancelled) setTagsLoading(false);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggle = (t) => setSelected((prev) => {
    const m = new Map(prev);
    if (m.has(t.id)) m.delete(t.id); else if (m.size < MAX_SELECTED) m.set(t.id, t);
    return m;
  });

  // ── Window ──
  const windowQs = useMemo(() => {
    const p = new URLSearchParams();
    if (range === 'custom' && custom.from && custom.to) {
      p.set('from', new Date(custom.from).toISOString());
      p.set('to', new Date(custom.to).toISOString());
    } else {
      p.set('range', range === 'custom' ? '6h' : range);
    }
    if (bucket !== 'auto') p.set('bucket', bucket);
    return p;
  }, [range, custom, bucket]);

  const ids = useMemo(() => [...selected.keys()], [selected]);

  // Keep the URL shareable.
  useEffect(() => {
    const next = new URLSearchParams(windowQs);
    if (ids.length) next.set('ids', ids.join(','));
    setParams(next, { replace: true });
  }, [ids, windowQs, setParams]);

  const reqRef = useRef(0);
  const load = useCallback(async (silent = false) => {
    if (!ids.length) { setResult(null); return; }
    const seq = ++reqRef.current;
    if (!silent) setLoading(true);
    setError(null);
    try {
      const p = new URLSearchParams(windowQs);
      p.set('ids', ids.join(','));
      const { data } = await api.get(`/tags/history?${p.toString()}`);
      if (seq !== reqRef.current) return;
      setResult(data);
    } catch (err) {
      if (seq !== reqRef.current) return;
      setError(err.response?.data?.error || err.response?.data?.details?.[0]?.msg || err.message || 'Could not load history');
    } finally {
      if (seq === reqRef.current) setLoading(false);
    }
  }, [ids, windowQs]);

  useEffect(() => { load(); }, [load]);

  // Live refresh every 30 s while the window ends "now".
  useEffect(() => {
    if (!live || range === 'custom' || !ids.length) return undefined;
    const t = setInterval(() => load(true), 30_000);
    return () => clearInterval(t);
  }, [live, range, ids.length, load]);

  const spanMs = useMemo(() => (result ? new Date(result.to) - new Date(result.from) : 6 * 3600_000), [result]);

  // ── Exports ──
  const exportAs = async (kind) => {
    if (!ids.length) return;
    setExporting(kind);
    try {
      const stamp = new Date().toISOString().slice(0, 10);
      if (kind === 'csv') {
        const p = new URLSearchParams(windowQs); p.set('ids', ids.join(','));
        await downloadFile(`/tags/history.csv?${p.toString()}`, `watersim_trend_${stamp}.csv`);
      } else {
        const from = result?.from || new Date(Date.now() - 6 * 3600_000).toISOString();
        const to = result?.to || new Date().toISOString();
        await downloadFile('/reports/period', `watersim_history_${stamp}.${kind}`, {
          method: 'POST', data: { tagIds: ids, from, to, bucket, format: kind, title: 'Plant history report' },
        });
      }
      showToast(kind === 'csv' ? 'Trend CSV exported' : `Period report (${kind.toUpperCase()}) exported`);
    } catch (err) {
      showToast(err.response?.data?.error || `${kind.toUpperCase()} export failed`, false);
    } finally {
      setExporting(null);
    }
  };

  // ── Pins ──
  const pinnedAll = ids.length > 0 && ids.every((id) => pins.some((p) => p.tagId === id));
  const togglePins = () => {
    let next;
    if (pinnedAll) next = pins.filter((p) => !ids.includes(p.tagId));
    else {
      next = [...pins];
      for (const t of selected.values()) if (!next.some((p) => p.tagId === t.id)) next.push({ tagId: t.id, tag: t.tag, name: t.name, unit: t.engUnit });
    }
    setPins(next); writePins(next);
    showToast(pinnedAll ? 'Unpinned from the dashboard' : 'Pinned to the dashboard');
  };

  const hasData = !!result && result.series.length > 0;

  return (
    <AppLayout>
      <div className="p-4 md:p-6 space-y-4 max-w-[1600px] mx-auto">
        {/* Header */}
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-xl font-bold text-gray-900 flex items-center gap-2">
              <LineChartIcon className="w-5 h-5 text-brand-600" aria-hidden="true" />
              Trends
            </h2>
            <p className="text-sm text-gray-500 mt-0.5">
              Every sample the PLC reported, kept. Pick points, choose a window, export the period.
            </p>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <button onClick={togglePins} disabled={!ids.length} className="btn-secondary text-sm disabled:opacity-50" aria-label={pinnedAll ? 'Unpin from dashboard' : 'Pin to dashboard'}>
              {pinnedAll ? <PinOff className="w-4 h-4" /> : <Pin className="w-4 h-4" />}
              {pinnedAll ? 'Unpin' : 'Pin to dashboard'}
            </button>
            <button onClick={() => exportAs('csv')} disabled={!ids.length || !!exporting} className="btn-secondary text-sm disabled:opacity-50" aria-label="Export CSV">
              {exporting === 'csv' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />} CSV
            </button>
            <button onClick={() => exportAs('xlsx')} disabled={!ids.length || !!exporting} className="btn-secondary text-sm disabled:opacity-50" aria-label="Export Excel report">
              {exporting === 'xlsx' ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileSpreadsheet className="w-4 h-4" />} Excel
            </button>
            <button onClick={() => exportAs('pdf')} disabled={!ids.length || !!exporting} className="btn-primary text-sm disabled:opacity-50" aria-label="Export PDF report">
              {exporting === 'pdf' ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileText className="w-4 h-4" />} Period report
            </button>
          </div>
        </div>

        {/* Toolbar */}
        <div className="flex flex-wrap items-center gap-2" role="toolbar" aria-label="Trend window">
          <div className="flex rounded-lg border border-gray-200 overflow-hidden" role="group" aria-label="Range">
            {RANGES.map((r) => (
              <button key={r.key} onClick={() => setRange(r.key)} aria-pressed={range === r.key}
                className={`px-3 py-1.5 text-xs font-medium ${range === r.key ? 'bg-brand-600 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}>
                {r.label}
              </button>
            ))}
            <button onClick={() => setRange('custom')} aria-pressed={range === 'custom'}
              className={`px-3 py-1.5 text-xs font-medium ${range === 'custom' ? 'bg-brand-600 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}>
              Custom
            </button>
          </div>
          {range === 'custom' && (
            <>
              <input type="datetime-local" className="input py-1 text-xs" value={custom.from} onChange={(e) => setCustom((c) => ({ ...c, from: e.target.value }))} aria-label="From" />
              <span className="text-gray-400 text-xs">to</span>
              <input type="datetime-local" className="input py-1 text-xs" value={custom.to} onChange={(e) => setCustom((c) => ({ ...c, to: e.target.value }))} aria-label="To" />
            </>
          )}
          <div className="relative">
            <select className="input py-1.5 pr-8 text-xs appearance-none" value={bucket} onChange={(e) => setBucket(e.target.value)} aria-label="Resolution">
              {BUCKETS.map((b) => <option key={b} value={b}>{b === 'auto' ? 'Auto resolution' : b === 'raw' ? 'Raw samples' : `${b} buckets`}</option>)}
            </select>
            <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400 pointer-events-none" />
          </div>
          <label className="flex items-center gap-1.5 text-xs text-gray-600 ml-1">
            <input type="checkbox" checked={live} onChange={(e) => setLive(e.target.checked)} className="accent-brand-600" />
            <Radio className={`w-3.5 h-3.5 ${live ? 'text-emerald-600' : 'text-gray-400'}`} aria-hidden="true" /> Live (30 s)
          </label>
          <button onClick={() => load()} disabled={loading || !ids.length} className="btn-secondary text-xs py-1.5 disabled:opacity-50" aria-label="Refresh">
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          </button>
          {result && (
            <span className="text-[11px] text-gray-400 ml-auto tabular-nums">
              {result.raw ? 'raw samples' : `at ${result.bucket} resolution`} · {new Date(result.from).toLocaleString()} → {new Date(result.to).toLocaleString()}
            </span>
          )}
        </div>

        {error && <div role="alert" className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-xl px-4 py-2.5">{error}</div>}

        <div className="flex flex-col md:flex-row gap-4 items-stretch md:items-start">
          <TagPicker tags={tags} selected={selected} onToggle={toggle} loading={tagsLoading} />

          <div ref={colRef} className="flex-1 min-w-0 space-y-3 w-full">
            {!ids.length && (
              <EmptyState icon={Activity} title="Pick a tag to start"
                description="Choose up to eight points from the registry on the left. Analogue inputs that are bound to a PLC already have history; the rest fill as soon as they are bound." />
            )}
            {ids.length > 0 && loading && !hasData && (
              <div className="card p-8 text-center text-sm text-gray-400"><Loader2 className="w-5 h-5 animate-spin inline-block mr-2" />Loading history…</div>
            )}
            {hasData && result.series.map((s, i) => (
              <SeriesChart key={s.tagId} series={s} color={COLORS[i % COLORS.length]} width={chartWidth}
                spanMs={spanMs} raw={!!result.raw} onRemove={() => toggle({ id: s.tagId })} />
            ))}
          </div>
        </div>
      </div>

      {toast && (
        <div role="status" aria-live="polite"
          className={`fixed bottom-20 md:bottom-6 right-4 z-50 px-4 py-3 rounded-xl shadow-xl text-white text-sm font-medium ${toast.ok ? 'bg-emerald-700' : 'bg-red-700'}`}>
          {toast.ok ? '✓' : '⚠'} {toast.msg}
        </div>
      )}
    </AppLayout>
  );
}
