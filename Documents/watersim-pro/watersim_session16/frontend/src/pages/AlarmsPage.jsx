/**
 * WaterSim Pro — AlarmsPage
 * Org-wide alarm event history: every limit breach across every flowsheet,
 * newest first, with filters, acknowledgement, CSV and PDF export.
 *
 * Route: /alarms
 *
 * Structurally ReportsPage's sibling — AppLayout, header, FilterBar,
 * VirtualTable + a `columns` useMemo, EmptyState, toast, and `downloadFile`
 * for the two exports. Pagination is limit/offset with an explicit
 * "Load more" (the API is offset-paged, not cursor-paged like reports).
 */
import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Link } from 'react-router-dom';
import {
  BellRing, Bell, Download, FileText, RefreshCw, Loader2, X, ChevronDown,
  Check, CheckCheck, Cpu, Radio, ArrowRight,
} from 'lucide-react';
import AppLayout from '../components/layout/AppLayout';
import { useAuth } from '../context/AuthContext';
import { useAnnounce } from '../components/AccessibilityProvider';
import EmptyState from '../components/EmptyState';
import VirtualTable from '../components/VirtualTable';
import api from '../services/api';
import { downloadFile } from '../utils/download';
import {
  SEVERITIES, severityMeta, normalizeEvent, relTime, absTime,
} from '../components/alarms/alarmState';

const PAGE_SIZE = 50;

// ── Pills ─────────────────────────────────────────────────────────────────────

function SeverityPill({ severity }) {
  const s = severityMeta(severity);
  const Icon = s.icon;
  return (
    <span
      data-severity={s.key}
      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium border"
      style={{ background: s.bg, color: s.color, borderColor: s.border }}
    >
      <Icon className="w-3 h-3" aria-hidden="true" />
      {s.label}
    </span>
  );
}

/** Active is the only state that gets colour — a cleared alarm is history. */
function StatePill({ state }) {
  const active = state !== 'cleared';
  return (
    <span
      data-state={active ? 'active' : 'cleared'}
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium border ${
        active
          ? 'text-red-700 bg-red-50 border-red-200'
          : 'text-gray-500 bg-gray-50 border-gray-200'
      }`}
    >
      {active ? <BellRing className="w-3 h-3" /> : <Bell className="w-3 h-3" />}
      {active ? 'Active' : 'Cleared'}
    </span>
  );
}

/** Where the breach was seen: a simulation run, or a live PLC read. */
function SourceBadge({ source }) {
  const plc = source === 'plc';
  return (
    <span
      data-source={plc ? 'plc' : 'simulation'}
      title={plc ? 'Detected on live PLC data' : 'Detected during a simulation run'}
      className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] font-medium ${
        plc ? 'text-cyan-700 bg-cyan-50' : 'text-blue-700 bg-blue-50'
      }`}
    >
      {plc ? <Radio className="w-3 h-3" /> : <Cpu className="w-3 h-3" />}
      {plc ? 'PLC' : 'Simulation'}
    </span>
  );
}

/** Relative time with the full local timestamp behind it. */
function When({ ts }) {
  if (!ts) return <span className="text-gray-400">—</span>;
  return (
    <span className="text-xs text-gray-500" title={absTime(ts)}>
      <span className="block">{relTime(ts)}</span>
      <span className="block text-[10px] text-gray-400">{absTime(ts)}</span>
    </span>
  );
}

// ── FilterBar ─────────────────────────────────────────────────────────────────

function FilterBar({ filters, setFilters, flowsheets }) {
  const set = (patch) => setFilters(f => ({ ...f, ...patch }));
  const dirty = !!(filters.flowsheetId || filters.severity || filters.state ||
    filters.acknowledged || filters.from || filters.to);

  return (
    <div className="flex flex-wrap gap-2 items-center">
      <div className="relative">
        <select
          className="input py-1.5 pr-8 text-sm appearance-none min-w-40"
          value={filters.flowsheetId || ''}
          onChange={e => set({ flowsheetId: e.target.value || undefined })}
          aria-label="Filter by flowsheet"
        >
          <option value="">All flowsheets</option>
          {flowsheets.map(f => (
            <option key={f.id} value={f.id}>{f.name}</option>
          ))}
        </select>
        <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400 pointer-events-none" />
      </div>

      <div className="relative">
        <select
          className="input py-1.5 pr-8 text-sm appearance-none"
          value={filters.severity || ''}
          onChange={e => set({ severity: e.target.value || undefined })}
          aria-label="Filter by severity"
        >
          <option value="">Any severity</option>
          {SEVERITIES.map(s => (
            <option key={s} value={s}>{severityMeta(s).label}</option>
          ))}
        </select>
        <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400 pointer-events-none" />
      </div>

      <div className="relative">
        <select
          className="input py-1.5 pr-8 text-sm appearance-none"
          value={filters.state || ''}
          onChange={e => set({ state: e.target.value || undefined })}
          aria-label="Filter by state"
        >
          <option value="">Any state</option>
          <option value="active">Active only</option>
          <option value="cleared">Cleared only</option>
        </select>
        <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400 pointer-events-none" />
      </div>

      <div className="relative">
        <select
          className="input py-1.5 pr-8 text-sm appearance-none"
          value={filters.acknowledged || ''}
          onChange={e => set({ acknowledged: e.target.value || undefined })}
          aria-label="Filter by acknowledgement"
        >
          <option value="">Acknowledged or not</option>
          <option value="false">Unacknowledged</option>
          <option value="true">Acknowledged</option>
        </select>
        <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400 pointer-events-none" />
      </div>

      <label className="flex items-center gap-1.5 text-xs text-gray-500">
        From
        <input
          type="date"
          className="input py-1.5 text-sm"
          value={filters.from || ''}
          onChange={e => set({ from: e.target.value || undefined })}
          aria-label="Triggered from date"
        />
      </label>
      <label className="flex items-center gap-1.5 text-xs text-gray-500">
        To
        <input
          type="date"
          className="input py-1.5 text-sm"
          value={filters.to || ''}
          onChange={e => set({ to: e.target.value || undefined })}
          aria-label="Triggered to date"
        />
      </label>

      {dirty && (
        <button
          onClick={() => setFilters({})}
          className="text-xs text-gray-500 hover:text-gray-700 flex items-center gap-1"
        >
          <X className="w-3 h-3" />Clear filters
        </button>
      )}
    </div>
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────

export default function AlarmsPage() {
  const { user } = useAuth();
  const announce = useAnnounce();

  // operator+ may acknowledge (the backend gate is requireRole('operator'),
  // and the hierarchy is viewer < operator < engineer < admin).
  const canAck = ['admin', 'engineer', 'operator'].includes(user?.role);

  const [events, setEvents]   = useState([]);
  const [total, setTotal]     = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError]     = useState(null);
  const [selected, setSelected] = useState(() => new Set());
  const [acking, setAcking]   = useState(() => new Set());
  const [exporting, setExporting] = useState(null); // 'csv' | 'pdf' | null
  const [toast, setToast]     = useState(null);
  const [filters, setFilters] = useState({});

  // Flowsheet filter options accumulate from whatever has been seen and are
  // never removed — otherwise filtering to one flowsheet would delete every
  // other option and strand the user there.
  const [flowsheets, setFlowsheets] = useState([]);

  const showToast = useCallback((msg, ok = true) => {
    setToast({ msg, ok });
    setTimeout(() => setToast(null), 3500);
  }, []);

  const rememberFlowsheets = useCallback((rows) => {
    setFlowsheets(prev => {
      const seen = new Map(prev.map(f => [f.id, f]));
      let added = false;
      for (const e of rows) {
        if (e.flowsheetId && !seen.has(e.flowsheetId)) {
          seen.set(e.flowsheetId, {
            id: e.flowsheetId,
            name: e.projectName ? `${e.flowsheetName} — ${e.projectName}` : e.flowsheetName,
          });
          added = true;
        }
      }
      if (!added) return prev;
      return [...seen.values()].sort((a, b) => String(a.name).localeCompare(String(b.name)));
    });
  }, []);

  /** Query string from the current filters; empty values are simply omitted. */
  const queryParams = useMemo(() => {
    const p = new URLSearchParams();
    if (filters.flowsheetId) p.set('flowsheetId', filters.flowsheetId);
    if (filters.severity)    p.set('severity', filters.severity);
    if (filters.state)       p.set('state', filters.state);
    if (filters.acknowledged) p.set('acknowledged', filters.acknowledged);
    // The API wants ISO-8601; a date input gives YYYY-MM-DD, and `to` has to
    // cover the whole day or "to today" would exclude everything since midnight.
    if (filters.from) p.set('from', `${filters.from}T00:00:00.000Z`);
    if (filters.to)   p.set('to',   `${filters.to}T23:59:59.999Z`);
    return p;
  }, [filters]);

  // A request counter so a slow first page can never overwrite a newer one.
  const reqRef = useRef(0);

  const fetchPage = useCallback(async (offset) => {
    const p = new URLSearchParams(queryParams);
    p.set('limit', String(PAGE_SIZE));
    p.set('offset', String(offset));
    const { data } = await api.get(`/alarms/events?${p.toString()}`);
    return {
      total: data?.total ?? 0,
      events: (Array.isArray(data?.events) ? data.events : []).map(normalizeEvent).filter(Boolean),
    };
  }, [queryParams]);

  const load = useCallback(async () => {
    const seq = ++reqRef.current;
    setLoading(true);
    setError(null);
    try {
      const page = await fetchPage(0);
      if (seq !== reqRef.current) return;
      setEvents(page.events);
      setTotal(page.total);
      rememberFlowsheets(page.events);
      setSelected(new Set());
    } catch (err) {
      if (seq !== reqRef.current) return;
      setError(err.response?.data?.error || err.message || 'Could not load alarm events');
    } finally {
      if (seq === reqRef.current) setLoading(false);
    }
  }, [fetchPage, rememberFlowsheets]);

  useEffect(() => { load(); }, [load]);

  const hasMore = events.length < total;

  const loadMore = async () => {
    if (loadingMore || !hasMore) return;
    setLoadingMore(true);
    try {
      const page = await fetchPage(events.length);
      setEvents(prev => {
        // Offset paging can repeat a row if one cleared between requests —
        // de-dupe by id rather than showing it twice.
        const seen = new Set(prev.map(e => e.id));
        return [...prev, ...page.events.filter(e => !seen.has(e.id))];
      });
      setTotal(page.total);
      rememberFlowsheets(page.events);
    } catch (err) {
      showToast(err.response?.data?.error || 'Could not load more events', false);
    } finally {
      setLoadingMore(false);
    }
  };

  // ── Acknowledge (optimistic, reverted on failure) ────────────────────────
  const ackOne = useCallback(async (event) => {
    if (!canAck || event.acknowledged) return true;
    const id = event.id;
    setAcking(prev => new Set(prev).add(id));
    const before = event;
    setEvents(prev => prev.map(e => (e.id === id
      ? { ...e, acknowledged: true, acknowledgedAt: new Date().toISOString(), acknowledgedByName: 'You' }
      : e)));
    try {
      const { data } = await api.post(`/alarms/events/${id}/ack`);
      // The server row is the truth (the ack is idempotent and keeps the FIRST
      // acknowledger). It comes back as `RETURNING *` from alarm_events, which
      // carries acknowledged_by as a UUID and no display name — so the name
      // already on the row is kept rather than being blanked by the response.
      const srv = normalizeEvent(data) || {};
      setEvents(prev => prev.map(e => (e.id === id ? {
        ...e, ...srv,
        acknowledgedByName: srv.acknowledgedByName ?? e.acknowledgedByName,
      } : e)));
      return true;
    } catch (err) {
      setEvents(prev => prev.map(e => (e.id === id ? before : e)));
      showToast(err.response?.data?.error || 'Acknowledge failed', false);
      return false;
    } finally {
      setAcking(prev => { const n = new Set(prev); n.delete(id); return n; });
    }
  }, [canAck, showToast]);

  const ackSelected = async () => {
    const targets = events.filter(e => selected.has(e.id) && !e.acknowledged);
    if (!targets.length) return;
    const results = await Promise.all(targets.map(ackOne));
    const ok = results.filter(Boolean).length;
    setSelected(new Set());
    showToast(`Acknowledged ${ok} of ${targets.length} alarm${targets.length === 1 ? '' : 's'}`, ok === targets.length);
    announce(`${ok} alarms acknowledged`);
  };

  const toggleSelect = (id) => {
    setSelected(s => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  // ── Exports — the same filters, through the authenticated axios client ───
  const exportAs = async (kind) => {
    setExporting(kind);
    try {
      const qs = queryParams.toString();
      const stamp = new Date().toISOString().slice(0, 10);
      if (kind === 'csv') {
        await downloadFile(`/alarms/events/export.csv${qs ? `?${qs}` : ''}`, `watersim_alarms_${stamp}.csv`);
      } else {
        await downloadFile(`/alarms/report/pdf${qs ? `?${qs}` : ''}`, `watersim_alarms_${stamp}.pdf`);
      }
      showToast(kind === 'csv' ? 'Alarm CSV exported' : 'Alarm report exported');
    } catch (err) {
      showToast(err.response?.data?.error || `${kind.toUpperCase()} export failed`, false);
    } finally {
      setExporting(null);
    }
  };

  const selectableCount = events.filter(e => !e.acknowledged).length;

  const columns = useMemo(() => [
    ...(canAck ? [{
      key: 'select', header: '', flex: '0 0 36px', width: 36,
      render: (e) => (e.acknowledged ? null : (
        <input
          type="checkbox"
          checked={selected.has(e.id)}
          onChange={() => toggleSelect(e.id)}
          onClick={ev => ev.stopPropagation()}
          className="w-4 h-4 accent-brand-600"
          aria-label={`Select alarm ${e.ruleName || e.id}`}
        />
      )),
    }] : []),
    {
      key: 'severity', header: 'Severity', flex: '0 0 110px', width: 110,
      render: (e) => <SeverityPill severity={e.severity} />,
    },
    {
      key: 'rule', header: 'Rule / Message', flex: 2.4,
      render: (e) => (
        <div className="min-w-0">
          <div className="font-medium text-gray-800 truncate">{e.ruleName || '—'}</div>
          <div className="text-xs text-gray-500 truncate" title={e.message}>{e.message}</div>
        </div>
      ),
    },
    {
      key: 'where', header: 'Flowsheet', flex: 1.4,
      render: (e) => (
        <div className="min-w-0">
          {e.projectId && e.flowsheetId ? (
            <Link
              to={`/projects/${e.projectId}/flowsheets/${e.flowsheetId}`}
              className="text-brand-700 hover:underline truncate block"
              onClick={ev => ev.stopPropagation()}
              title={`Open ${e.flowsheetName}`}
            >
              {e.flowsheetName}
            </Link>
          ) : (
            <span className="truncate block">{e.flowsheetName || '—'}</span>
          )}
          <div className="text-xs text-gray-400 truncate">{e.projectName}</div>
        </div>
      ),
    },
    {
      key: 'value', header: 'Value / Limit', flex: '0 0 116px', width: 116,
      render: (e) => {
        const lim = e.limitMin != null && e.limitMax != null
          ? `${e.limitMin}–${e.limitMax}`
          : e.limitMax != null ? `max ${e.limitMax}`
            : e.limitMin != null ? `min ${e.limitMin}` : '—';
        return (
          <div className="font-mono text-xs">
            <div className="text-gray-800">{e.value ?? '—'}</div>
            <div className="text-gray-400">{lim}</div>
          </div>
        );
      },
    },
    {
      key: 'state', header: 'State', flex: '0 0 100px', width: 100,
      render: (e) => <StatePill state={e.state} />,
    },
    {
      key: 'source', header: 'Source', flex: '0 0 104px', width: 104,
      render: (e) => <SourceBadge source={e.source} />,
    },
    {
      key: 'triggered', header: 'Triggered', flex: '0 0 130px', width: 130,
      render: (e) => <When ts={e.triggeredAt} />,
    },
    {
      key: 'ack', header: 'Acknowledged', flex: '0 0 132px', width: 132,
      render: (e) => {
        if (e.acknowledged) {
          return (
            <span className="inline-flex items-center gap-1 text-xs text-emerald-700" title={absTime(e.acknowledgedAt)}>
              <Check className="w-3.5 h-3.5" />
              {e.acknowledgedByName || 'Acknowledged'}
            </span>
          );
        }
        if (!canAck) return <span className="text-xs text-gray-400">—</span>;
        const busy = acking.has(e.id);
        return (
          <button
            onClick={(ev) => { ev.stopPropagation(); ackOne(e); }}
            disabled={busy}
            className="btn-secondary text-xs py-1 px-2 disabled:opacity-50"
            aria-label={`Acknowledge alarm ${e.ruleName || e.id}`}
          >
            {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />}
            Ack
          </button>
        );
      },
    },
  ], [canAck, selected, acking, ackOne]);

  return (
    <AppLayout>
      <div className="p-4 md:p-6 max-w-[100rem] mx-auto space-y-4">

        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Alarms</h1>
            <p className="text-sm text-gray-500 mt-0.5">
              Every limit breach across your flowsheets, newest first
            </p>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <button
              onClick={() => exportAs('csv')}
              disabled={exporting !== null}
              className="btn-secondary text-sm disabled:opacity-50"
            >
              {exporting === 'csv' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
              Export CSV
            </button>
            <button
              onClick={() => exportAs('pdf')}
              disabled={exporting !== null}
              className="btn-secondary text-sm disabled:opacity-50"
            >
              {exporting === 'pdf' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <FileText className="w-3.5 h-3.5" />}
              Alarm report (PDF)
            </button>
            <button
              onClick={load}
              aria-label="Refresh alarms"
              className="p-2 text-gray-400 hover:text-gray-600 rounded-lg hover:bg-gray-100 transition-colors"
            >
              <RefreshCw className="w-4 h-4" />
            </button>
          </div>
        </div>

        {error && (
          <div role="alert" className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-xl px-4 py-2.5">
            {error}
          </div>
        )}

        {/* Filters */}
        <FilterBar filters={filters} setFilters={setFilters} flowsheets={flowsheets} />

        {/* Bulk acknowledge */}
        {canAck && selected.size > 0 && (
          <div className="flex items-center gap-3 flex-wrap text-sm text-brand-700 bg-brand-50 border border-brand-200 rounded-xl px-4 py-2.5">
            <span className="font-medium">
              {selected.size} alarm{selected.size === 1 ? '' : 's'} selected
            </span>
            <button onClick={ackSelected} className="btn-primary text-xs py-1.5">
              <CheckCheck className="w-3.5 h-3.5" />
              Acknowledge selected
            </button>
            <button
              onClick={() => setSelected(new Set())}
              className="text-xs text-gray-500 hover:text-gray-700"
            >
              Clear selection
            </button>
            {selectableCount > selected.size && (
              <button
                onClick={() => setSelected(new Set(events.filter(e => !e.acknowledged).map(e => e.id)))}
                className="text-xs text-brand-700 hover:underline ml-auto"
              >
                Select all {selectableCount} unacknowledged
              </button>
            )}
          </div>
        )}

        {/* Table */}
        <div className="card overflow-hidden">
          <VirtualTable
            rows={events}
            columns={columns}
            rowHeight={60}
            containerHeight={600}
            getRowKey={(e) => e.id}
            loading={loading}
            emptyState={
              <EmptyState
                icon={BellRing}
                title="No alarms"
                description={
                  Object.keys(filters).length
                    ? 'No alarm events match these filters. Try clearing them.'
                    : 'Nothing has breached a limit yet. Alarm rules are created on a flowsheet — open a canvas, click the 🔔 on any parameter, or use its Alarms panel.'
                }
                action={Object.keys(filters).length
                  ? { label: 'Clear filters', onClick: () => setFilters({}) }
                  : { label: 'Go to projects', href: '/projects' }}
              />
            }
          />
        </div>

        {/* Pagination */}
        <div className="flex flex-col items-center gap-2 pb-4">
          {hasMore ? (
            <button
              onClick={loadMore}
              disabled={loadingMore}
              className="btn-secondary text-sm disabled:opacity-50"
            >
              {loadingMore
                ? <><Loader2 className="w-3.5 h-3.5 animate-spin" />Loading…</>
                : <><ArrowRight className="w-3.5 h-3.5" />Load more ({events.length} of {total})</>}
            </button>
          ) : events.length > 0 && (
            <p className="text-xs text-gray-400 py-2">
              All {total.toLocaleString()} alarm event{total !== 1 ? 's' : ''} loaded
            </p>
          )}
        </div>
      </div>

      {toast && (
        <div role="status" aria-live="polite"
          className={`fixed bottom-20 md:bottom-6 right-4 z-50 px-4 py-3 rounded-xl shadow-xl text-white text-sm font-medium
            ${toast.ok ? 'bg-emerald-700' : 'bg-red-700'}`}>
          {toast.ok ? '✓' : '⚠'} {toast.msg}
        </div>
      )}
    </AppLayout>
  );
}
