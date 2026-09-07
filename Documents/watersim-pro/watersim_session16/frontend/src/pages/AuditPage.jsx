/**
 * WaterSim Pro — AuditPage
 * The organisation's audit trail: who did what, to which record, when — and
 * which automated source (poller, evaluator) did it when nobody was logged in.
 *
 * Route: /audit  (admin only — capability `audit.read`; the API refuses the
 * rest with 403, this page tells the others why before it asks).
 *
 * Structurally AlarmsPage's sibling: AppLayout, FilterBar, VirtualTable with a
 * `columns` useMemo, EmptyState, toast, and `downloadFile` for the CSV. Paging
 * is keyset (`nextCursor`) rather than offset, so a trail that grows while
 * someone is reading it never repeats or skips a row.
 */
import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  ScrollText, Download, RefreshCw, Loader2, ChevronDown, ArrowRight, X,
  User, Bot, ShieldAlert, Search,
} from 'lucide-react';
import AppLayout from '../components/layout/AppLayout';
import { useAuth } from '../context/AuthContext';
import EmptyState from '../components/EmptyState';
import VirtualTable from '../components/VirtualTable';
import api from '../services/api';
import { downloadFile } from '../utils/download';
import { relTime, absTime } from '../components/alarms/alarmState';

const PAGE_SIZE = 50;

// ── Small presentational pieces ───────────────────────────────────────────────

/** `member.update` → a coloured verb pill: creates green, deletes red, the rest neutral. */
function ActionPill({ action }) {
  const verb = String(action || '').split('.').pop();
  const tone = /^(create|register|seed|instantiate|login)$/.test(verb)
    ? 'text-emerald-700 bg-emerald-50 border-emerald-200'
    : /^(delete|revoke|deactivate|logout)$/.test(verb)
      ? 'text-red-700 bg-red-50 border-red-200'
      : /^(ack|acknowledge|approve)$/.test(verb)
        ? 'text-purple-700 bg-purple-50 border-purple-200'
        : 'text-gray-700 bg-gray-50 border-gray-200';
  return (
    <span data-action={action} className={`inline-flex px-2 py-0.5 rounded-full text-xs font-mono font-medium border ${tone}`}>
      {action}
    </span>
  );
}

/** A person, or the automated source that acted on nobody's behalf. */
function Actor({ actor }) {
  const system = !actor?.id;
  return (
    <div className="min-w-0 flex items-center gap-2">
      <span className={`w-6 h-6 rounded-full flex items-center justify-center flex-shrink-0 ${
        system ? 'bg-slate-100 text-slate-500' : 'bg-brand-100 text-brand-700'}`}
      >
        {system ? <Bot className="w-3.5 h-3.5" aria-hidden="true" /> : <User className="w-3.5 h-3.5" aria-hidden="true" />}
      </span>
      <div className="min-w-0">
        <div className="text-sm text-gray-800 truncate" title={actor?.email || actor?.name}>{actor?.name || '—'}</div>
        <div className="text-[11px] text-gray-400 capitalize">{actor?.role || ''}</div>
      </div>
    </div>
  );
}

function When({ ts }) {
  if (!ts) return <span className="text-gray-400">—</span>;
  return (
    <span className="text-xs text-gray-500" title={absTime(ts)}>
      <span className="block">{relTime(ts)}</span>
      <span className="block text-[10px] text-gray-400">{absTime(ts)}</span>
    </span>
  );
}

/** The details JSON, one line, truncated; the full text sits in the title. */
function Details({ details }) {
  const entries = Object.entries(details || {}).filter(([k]) => k !== 'source' && k !== 'requestId');
  if (!entries.length) return <span className="text-gray-300">—</span>;
  const text = entries.map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`).join('  ');
  return (
    <span className="block text-xs font-mono text-gray-600 truncate" title={JSON.stringify(details, null, 2)}>
      {text}
    </span>
  );
}

// ── FilterBar ─────────────────────────────────────────────────────────────────

function FilterBar({ filters, setFilters, actions }) {
  const set = (patch) => setFilters(f => ({ ...f, ...patch }));
  const dirty = !!(filters.action || filters.source || filters.from || filters.to || filters.q);

  return (
    <div className="flex flex-wrap gap-2 items-center">
      <div className="relative">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400 pointer-events-none" aria-hidden="true" />
        <input
          type="search"
          className="input py-1.5 pl-8 text-sm min-w-52"
          placeholder="Search action, record, actor…"
          value={filters.q || ''}
          onChange={e => set({ q: e.target.value || undefined })}
          aria-label="Search the audit trail"
        />
      </div>

      <div className="relative">
        <select
          className="input py-1.5 pr-8 text-sm appearance-none min-w-44"
          value={filters.action || ''}
          onChange={e => set({ action: e.target.value || undefined })}
          aria-label="Filter by action"
        >
          <option value="">All actions</option>
          {actions.map(a => (
            <option key={a.action} value={a.action}>{a.action} ({a.count})</option>
          ))}
        </select>
        <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400 pointer-events-none" />
      </div>

      <div className="relative">
        <select
          className="input py-1.5 pr-8 text-sm appearance-none"
          value={filters.source || ''}
          onChange={e => set({ source: e.target.value || undefined })}
          aria-label="Filter by source"
        >
          <option value="">People and system</option>
          <option value="poller">System · PLC poller</option>
          <option value="evaluator">System · alarm evaluator</option>
          <option value="scheduler">System · scheduler</option>
        </select>
        <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400 pointer-events-none" />
      </div>

      <input
        type="date"
        className="input py-1.5 text-sm w-auto"
        value={filters.from || ''}
        onChange={e => set({ from: e.target.value || undefined })}
        aria-label="From date"
      />
      <span className="text-gray-400 text-sm">to</span>
      <input
        type="date"
        className="input py-1.5 text-sm w-auto"
        value={filters.to || ''}
        onChange={e => set({ to: e.target.value || undefined })}
        aria-label="To date"
      />

      {dirty && (
        <button
          onClick={() => setFilters({})}
          className="inline-flex items-center gap-1 text-xs text-gray-500 hover:text-gray-700 px-2 py-1"
        >
          <X className="w-3.5 h-3.5" /> Clear
        </button>
      )}
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function AuditPage() {
  const { can } = useAuth();
  const allowed = can('audit.read');

  const [entries, setEntries] = useState([]);
  const [total, setTotal] = useState(0);
  const [nextCursor, setNextCursor] = useState(null);
  const [actions, setActions] = useState([]);
  const [filters, setFilters] = useState({});
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(null);
  const [exporting, setExporting] = useState(false);
  const [toast, setToast] = useState(null);

  const showToast = useCallback((msg, ok = true) => {
    setToast({ msg, ok });
    setTimeout(() => setToast(null), 3500);
  }, []);

  /** Query string from the filters — the same one the CSV export carries. */
  const queryParams = useMemo(() => {
    const p = new URLSearchParams();
    if (filters.q)      p.set('q', filters.q);
    if (filters.action) p.set('action', filters.action);
    if (filters.source) p.set('source', filters.source);
    if (filters.from)   p.set('from', `${filters.from}T00:00:00.000Z`);
    if (filters.to)     p.set('to',   `${filters.to}T23:59:59.999Z`);
    return p;
  }, [filters]);

  const reqRef = useRef(0);

  const fetchPage = useCallback(async (cursor) => {
    const p = new URLSearchParams(queryParams);
    p.set('limit', String(PAGE_SIZE));
    if (cursor) p.set('cursor', cursor);
    const { data } = await api.get(`/audit?${p.toString()}`);
    return {
      total: data?.total ?? 0,
      entries: Array.isArray(data?.entries) ? data.entries : [],
      nextCursor: data?.nextCursor || null,
    };
  }, [queryParams]);

  const load = useCallback(async () => {
    if (!allowed) { setLoading(false); return; }
    const seq = ++reqRef.current;
    setLoading(true);
    setError(null);
    try {
      const page = await fetchPage(null);
      if (seq !== reqRef.current) return;
      setEntries(page.entries);
      setTotal(page.total);
      setNextCursor(page.nextCursor);
    } catch (err) {
      if (seq !== reqRef.current) return;
      setError(err.response?.data?.error || err.message || 'Could not load the audit trail');
    } finally {
      if (seq === reqRef.current) setLoading(false);
    }
  }, [allowed, fetchPage]);

  useEffect(() => { load(); }, [load]);

  // The action picker: distinct action names with counts, loaded once.
  useEffect(() => {
    if (!allowed) return;
    let cancelled = false;
    api.get('/audit/actions')
      .then(({ data }) => { if (!cancelled) setActions(Array.isArray(data?.actions) ? data.actions : []); })
      .catch(() => { /* the picker is a convenience; the search box still works */ });
    return () => { cancelled = true; };
  }, [allowed]);

  const loadMore = async () => {
    if (loadingMore || !nextCursor) return;
    setLoadingMore(true);
    try {
      const page = await fetchPage(nextCursor);
      setEntries(prev => {
        const seen = new Set(prev.map(e => e.id));
        return [...prev, ...page.entries.filter(e => !seen.has(e.id))];
      });
      setTotal(page.total);
      setNextCursor(page.nextCursor);
    } catch (err) {
      showToast(err.response?.data?.error || 'Could not load more entries', false);
    } finally {
      setLoadingMore(false);
    }
  };

  const exportCsv = async () => {
    setExporting(true);
    try {
      const qs = queryParams.toString();
      const stamp = new Date().toISOString().slice(0, 10);
      await downloadFile(`/audit/export.csv${qs ? `?${qs}` : ''}`, `watersim_audit_${stamp}.csv`);
      showToast('Audit trail exported');
    } catch (err) {
      showToast(err.response?.data?.error || 'CSV export failed', false);
    } finally {
      setExporting(false);
    }
  };

  const columns = useMemo(() => [
    { key: 'when',   header: 'When',   flex: '0 0 150px', width: 150, render: (e) => <When ts={e.createdAt} /> },
    { key: 'actor',  header: 'Who',    flex: 1.4, minWidth: 150, render: (e) => <Actor actor={e.actor} /> },
    { key: 'action', header: 'Action', flex: '0 0 190px', width: 190, render: (e) => <ActionPill action={e.action} /> },
    {
      key: 'resource', header: 'Record', flex: 1.2, minWidth: 140,
      render: (e) => (
        <div className="min-w-0">
          <div className="text-sm text-gray-800 truncate">{e.resourceType || '—'}</div>
          {e.resourceId && (
            <div className="text-[10px] font-mono text-gray-400 truncate" title={e.resourceId}>{e.resourceId}</div>
          )}
        </div>
      ),
    },
    { key: 'details', header: 'Details', flex: 2, minWidth: 200, render: (e) => <Details details={e.details} /> },
    { key: 'ip', header: 'IP', flex: '0 0 110px', width: 110, render: (e) => <span className="text-xs font-mono text-gray-500">{e.ip || '—'}</span> },
  ], []);

  const hasFilters = Object.keys(filters).some(k => filters[k]);

  if (!allowed) {
    return (
      <AppLayout>
        <div className="p-4 md:p-6 max-w-3xl mx-auto">
          <EmptyState
            icon={ShieldAlert}
            title="Audit trail is admin-only"
            description="Every change in WaterSim Pro is recorded, but reading the trail is reserved for administrators. Ask an admin if you need an export."
            action={{ label: 'Back to dashboard', href: '/dashboard' }}
          />
        </div>
      </AppLayout>
    );
  }

  return (
    <AppLayout>
      <div className="p-4 md:p-6 space-y-4 max-w-7xl mx-auto">
        {/* Header */}
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-xl font-bold text-gray-900 flex items-center gap-2">
              <ScrollText className="w-5 h-5 text-brand-600" aria-hidden="true" />
              Audit trail
            </h2>
            <p className="text-sm text-gray-500 mt-0.5">
              Every user action and automated event in your organisation, newest first.
              {total > 0 && <> {total.toLocaleString()} entr{total === 1 ? 'y' : 'ies'} match.</>}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={exportCsv}
              disabled={exporting || loading}
              className="btn-secondary text-sm disabled:opacity-50"
              aria-label="Export audit trail as CSV"
            >
              {exporting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
              Export CSV
            </button>
            <button
              onClick={load}
              disabled={loading}
              className="btn-secondary text-sm disabled:opacity-50"
              aria-label="Refresh"
            >
              <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            </button>
          </div>
        </div>

        {error && (
          <div role="alert" className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-xl px-4 py-2.5">
            {error}
          </div>
        )}

        <FilterBar filters={filters} setFilters={setFilters} actions={actions} />

        <div className="card overflow-hidden">
          <VirtualTable
            rows={entries}
            columns={columns}
            rowHeight={56}
            containerHeight={600}
            getRowKey={(e) => e.id}
            loading={loading}
            emptyState={
              <EmptyState
                icon={ScrollText}
                title="No audit entries"
                description={hasFilters
                  ? 'Nothing matches these filters. Try clearing them.'
                  : 'Nothing has been recorded yet. Sign-ins, edits, acknowledgements and automated actions will appear here as they happen.'}
                action={hasFilters ? { label: 'Clear filters', onClick: () => setFilters({}) } : undefined}
              />
            }
          />
        </div>

        <div className="flex flex-col items-center gap-2 pb-4">
          {nextCursor ? (
            <button onClick={loadMore} disabled={loadingMore} className="btn-secondary text-sm disabled:opacity-50">
              {loadingMore
                ? <><Loader2 className="w-3.5 h-3.5 animate-spin" />Loading…</>
                : <><ArrowRight className="w-3.5 h-3.5" />Load more ({entries.length} of {total})</>}
            </button>
          ) : entries.length > 0 && (
            <p className="text-xs text-gray-400 py-2">
              All {total.toLocaleString()} entr{total === 1 ? 'y' : 'ies'} loaded
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
