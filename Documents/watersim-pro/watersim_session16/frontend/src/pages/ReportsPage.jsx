/**
 * WaterSim Pro — ReportsPage
 * Org-wide simulation report history. Lists completed runs across all
 * flowsheets, allows saving/bookmarking, filtering by project/mode/compliance,
 * links to full report, PDF and Excel export, and opens the comparison picker.
 *
 * Route: /reports
 */
import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import {
  FileText, Download, Bookmark, BookmarkCheck, SlidersHorizontal,
  CheckCircle2, XCircle, AlertTriangle,
  Loader2, RefreshCw, GitCompare, X, ChevronDown,
  ArrowRight, Clock, Layers, Search,
} from 'lucide-react';
import AppLayout from '../components/layout/AppLayout';
import { useAuth } from '../context/AuthContext';
import { useAnnounce } from '../components/AccessibilityProvider';
import EmptyState from '../components/EmptyState';
import VirtualTable from '../components/VirtualTable';
import { usePaginatedReports } from '../hooks/usePaginatedReports';
import api from '../utils/api';

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(undefined, {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

function fmtDateShort(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function fmtNum(v, dec = 1) {
  if (v == null) return '—';
  return Number(v).toLocaleString(undefined, { minimumFractionDigits: dec, maximumFractionDigits: dec });
}

function CompliancePill({ summary }) {
  const compliant = summary?.compliant;
  const violations = summary?.permit_violations?.length || 0;
  if (compliant === true)
    return <span className="inline-flex items-center gap-1 text-emerald-700 bg-emerald-50 border border-emerald-200 px-2 py-0.5 rounded-full text-xs font-medium"><CheckCircle2 className="w-3 h-3" />Pass</span>;
  if (compliant === false)
    return <span className="inline-flex items-center gap-1 text-red-700 bg-red-50 border border-red-200 px-2 py-0.5 rounded-full text-xs font-medium"><XCircle className="w-3 h-3" />{violations} fail</span>;
  return <span className="inline-flex items-center gap-1 text-gray-500 bg-gray-50 border border-gray-200 px-2 py-0.5 rounded-full text-xs"><AlertTriangle className="w-3 h-3" />Unknown</span>;
}

function ModePill({ mode }) {
  const label = mode === 'dynamic' ? 'Dynamic' : 'Steady';
  const cls = mode === 'dynamic'
    ? 'text-purple-700 bg-purple-50 border-purple-200'
    : 'text-blue-700 bg-blue-50 border-blue-200';
  return <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border ${cls}`}>{label}</span>;
}

// ── SaveModal ──────────────────────────────────────────────────────────────────

function SaveModal({ run, onClose, onSaved }) {
  const [label, setLabel] = useState(run.savedLabel || `${run.flowsheetName} — ${fmtDateShort(run.completedAt)}`);
  const [notes, setNotes] = useState(run.savedNotes || '');
  const [saving, setSaving] = useState(false);
  const [error, setError]   = useState('');
  const inputRef = useRef(null);
  useEffect(() => inputRef.current?.focus(), []);

  const handleSave = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      await api.post('/reports/saved', { runId: run.id, label: label.trim(), notes: notes.trim() });
      onSaved({ label: label.trim(), notes: notes.trim() });
    } catch (err) {
      setError(err.response?.data?.error || 'Save failed');
    } finally { setSaving(false); }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-end sm:items-center justify-center z-50 p-0 sm:p-4"
      role="dialog" aria-modal="true" aria-labelledby="save-report-title"
      onKeyDown={e => e.key === 'Escape' && onClose()}
      onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="bg-white w-full max-w-md rounded-t-2xl sm:rounded-2xl shadow-2xl" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b">
          <h2 id="save-report-title" className="font-bold text-gray-900">Save report</h2>
          <button onClick={onClose} aria-label="Close" className="p-1.5 text-gray-400 hover:text-gray-600 rounded-lg hover:bg-gray-100"><X className="w-4 h-4" /></button>
        </div>
        <form onSubmit={handleSave}>
          <div className="px-5 py-4 space-y-3">
            {error && <div role="alert" className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</div>}
            <div>
              <label className="label" htmlFor="save-label">Label</label>
              <input id="save-label" ref={inputRef} className="input" value={label}
                onChange={e => setLabel(e.target.value)} maxLength={255} required />
            </div>
            <div>
              <label className="label" htmlFor="save-notes">Notes <span className="text-gray-400 font-normal">(optional)</span></label>
              <textarea id="save-notes" className="input resize-none" rows={3} value={notes}
                onChange={e => setNotes(e.target.value)} maxLength={2000}
                placeholder="Why you saved this, key observations…" />
            </div>
          </div>
          <div className="px-5 py-4 border-t flex justify-end gap-2">
            <button type="button" onClick={onClose} className="btn-secondary text-sm">Cancel</button>
            <button type="submit" disabled={saving || !label.trim()} className="btn-primary text-sm">
              {saving ? <><Loader2 className="w-3.5 h-3.5 animate-spin" />Saving…</> : <><Bookmark className="w-3.5 h-3.5" />Save</>}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── RunRow ─────────────────────────────────────────────────────────────────────

function RunRow({ run, selected, onSelect, onSave, onUnsave, showSelect }) {
  const [downloading, setDownloading] = useState(null); // null | 'pdf' | 'excel'

  const downloadExcel = async () => {
    setDownloading('excel');
    try {
      const token = localStorage.getItem('accessToken');
      const resp  = await fetch(`/api/v1/reports/${run.id}/excel`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!resp.ok) throw new Error('Download failed');
      const blob = await resp.blob();
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      const cd   = resp.headers.get('Content-Disposition') || '';
      const m    = cd.match(/filename="([^"]+)"/);
      a.download = m ? m[1] : `watersim_report.xlsx`;
      a.href = url;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      console.error('Excel download failed', e);
    } finally { setDownloading(null); }
  };

  const inf = run.summary?.influent || {};
  const eff = run.summary?.effluent || {};
  const bodRem = inf.BOD && eff.BOD
    ? Math.round((inf.BOD - eff.BOD) / inf.BOD * 100) + '%'
    : '—';
  const unitCost = run.costSummary?.cost_per_m3_treated_USD;

  return (
    <tr className={`border-t border-gray-100 hover:bg-gray-50 transition-colors ${selected ? 'bg-brand-50' : ''}`}>
      {showSelect && (
        <td className="px-3 py-3 w-10">
          <input
            type="checkbox"
            checked={selected}
            onChange={() => onSelect(run.id)}
            aria-label={`Select ${run.flowsheetName} for comparison`}
            className="w-4 h-4 rounded border-gray-300 text-brand-600 focus:ring-brand-500"
          />
        </td>
      )}
      <td className="px-3 py-3 min-w-0">
        <p className="text-sm font-semibold text-gray-900 truncate">{run.flowsheetName}</p>
        <p className="text-xs text-gray-500 truncate">{run.projectName}</p>
        {run.saved && run.savedLabel && (
          <p className="text-xs text-brand-600 font-medium truncate mt-0.5">
            <Bookmark className="w-3 h-3 inline -mt-0.5 mr-0.5" />{run.savedLabel}
          </p>
        )}
      </td>
      <td className="px-3 py-3 hidden sm:table-cell"><ModePill mode={run.mode} /></td>
      <td className="px-3 py-3 hidden md:table-cell"><CompliancePill summary={run.summary} /></td>
      <td className="px-3 py-3 hidden lg:table-cell text-xs text-gray-600 text-right font-mono">{bodRem}</td>
      <td className="px-3 py-3 hidden xl:table-cell text-xs text-gray-600 text-right font-mono">
        {unitCost != null ? fmtNum(unitCost, 3) : '—'}
      </td>
      <td className="px-3 py-3 hidden lg:table-cell text-xs text-gray-500 whitespace-nowrap">
        {fmtDateShort(run.completedAt)}
      </td>
      <td className="px-3 py-3 text-right">
        <div className="flex items-center justify-end gap-1">
          {/* Save/unsave */}
          <button
            onClick={() => run.saved ? onUnsave(run) : onSave(run)}
            aria-label={run.saved ? `Unsave ${run.flowsheetName}` : `Save ${run.flowsheetName}`}
            title={run.saved ? 'Remove from saved' : 'Save report'}
            className={`p-1.5 rounded-lg transition-colors ${run.saved ? 'text-brand-600 hover:bg-brand-50' : 'text-gray-400 hover:text-gray-600 hover:bg-gray-100'}`}
          >
            {run.saved ? <BookmarkCheck className="w-4 h-4" /> : <Bookmark className="w-4 h-4" />}
          </button>

          {/* Excel download */}
          <button
            onClick={downloadExcel}
            disabled={!!downloading}
            aria-label={`Export ${run.flowsheetName} as Excel`}
            title="Export as Excel"
            className="p-1.5 text-gray-400 hover:text-emerald-600 hover:bg-emerald-50 rounded-lg transition-colors disabled:opacity-40"
          >
            {downloading === 'excel' ? <Loader2 className="w-4 h-4 animate-spin" /> : <TableIcon className="w-4 h-4" />}
          </button>

          {/* Open report link */}
          <Link
            to={`/projects/${run.projectId}/flowsheets/${run.flowsheetId}/simulate/${run.id}/report`}
            aria-label={`Open full report for ${run.flowsheetName}`}
            className="p-1.5 text-gray-400 hover:text-brand-600 hover:bg-brand-50 rounded-lg transition-colors"
            title="View full report"
          >
            <ArrowRight className="w-4 h-4" />
          </Link>
        </div>
      </td>
    </tr>
  );
}

// ── RunActions ───────────────────────────────────────────────────────────────
// Extracted from RunRow for use inside VirtualTable column renderers.

function RunActions({ run, onSave, onUnsave }) {
  const [downloading, setDownloading] = useState(false);

  const downloadExcel = async (e) => {
    e.stopPropagation();
    setDownloading(true);
    try {
      const token = localStorage.getItem('accessToken');
      const resp  = await fetch(`/api/v1/reports/${run.id}/excel`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!resp.ok) throw new Error('Download failed');
      const blob = await resp.blob();
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      const cd   = resp.headers.get('Content-Disposition') || '';
      const m    = cd.match(/filename="([^"]+)"/);
      a.download = m ? m[1] : 'watersim_report.xlsx';
      a.href = url;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      console.error('Excel download failed', e);
    } finally { setDownloading(false); }
  };

  return (
    <div className="flex items-center gap-1">
      <button
        onClick={(e) => { e.stopPropagation(); run.saved ? onUnsave(run) : onSave(run); }}
        aria-label={run.saved ? `Unsave ${run.flowsheetName}` : `Save ${run.flowsheetName}`}
        title={run.saved ? 'Remove from saved' : 'Save report'}
        className={`p-1.5 rounded-lg transition-colors ${run.saved ? 'text-brand-600 hover:bg-brand-50' : 'text-gray-400 hover:text-gray-600 hover:bg-gray-100'}`}
      >
        {run.saved ? <BookmarkCheck className="w-4 h-4" /> : <Bookmark className="w-4 h-4" />}
      </button>

      <button
        onClick={downloadExcel}
        disabled={downloading}
        aria-label={`Export ${run.flowsheetName} as Excel`}
        title="Export as Excel"
        className="p-1.5 text-gray-400 hover:text-emerald-600 hover:bg-emerald-50 rounded-lg transition-colors disabled:opacity-40"
      >
        {downloading
          ? <Loader2 className="w-4 h-4 animate-spin" />
          : <Download className="w-4 h-4" />}
      </button>

      <Link
        to={`/projects/${run.projectId}/flowsheets/${run.flowsheetId}/simulate/${run.id}/report`}
        aria-label={`Open full report for ${run.flowsheetName}`}
        className="p-1.5 text-gray-400 hover:text-brand-600 hover:bg-brand-50 rounded-lg transition-colors"
        title="View full report"
        onClick={(e) => e.stopPropagation()}
      >
        <ArrowRight className="w-4 h-4" />
      </Link>
    </div>
  );
}

// ── FilterBar ──────────────────────────────────────────────────────────────────

function FilterBar({ filters, setFilters, projects }) {
  return (
    <div className="flex flex-wrap gap-2 items-center">
      {/* Project */}
      <div className="relative">
        <select
          className="input py-1.5 pr-8 text-sm appearance-none min-w-32"
          value={filters.projectId || ''}
          onChange={e => setFilters(f => ({ ...f, projectId: e.target.value || undefined, page: 1 }))}
          aria-label="Filter by project"
        >
          <option value="">All projects</option>
          {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400 pointer-events-none" />
      </div>

      {/* Mode */}
      <div className="relative">
        <select
          className="input py-1.5 pr-8 text-sm appearance-none"
          value={filters.mode || ''}
          onChange={e => setFilters(f => ({ ...f, mode: e.target.value || undefined, page: 1 }))}
          aria-label="Filter by simulation mode"
        >
          <option value="">All modes</option>
          <option value="steady_state">Steady state</option>
          <option value="dynamic">Dynamic</option>
        </select>
        <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400 pointer-events-none" />
      </div>

      {/* Compliance */}
      <div className="relative">
        <select
          className="input py-1.5 pr-8 text-sm appearance-none"
          value={filters.compliance || ''}
          onChange={e => setFilters(f => ({ ...f, compliance: e.target.value || undefined, page: 1 }))}
          aria-label="Filter by compliance"
        >
          <option value="">Any compliance</option>
          <option value="pass">Pass only</option>
          <option value="fail">Fail only</option>
        </select>
        <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400 pointer-events-none" />
      </div>

      {/* Clear */}
      {(filters.projectId || filters.mode || filters.compliance) && (
        <button
          onClick={() => setFilters({ page: 1, limit: 30 })}
          className="text-xs text-gray-500 hover:text-gray-700 flex items-center gap-1"
        >
          <X className="w-3 h-3" />Clear filters
        </button>
      )}
    </div>
  );
}

// ── CompareBar ─────────────────────────────────────────────────────────────────

function CompareBar({ selected, runs, onClear, onCompare, onExcel }) {
  const [exporting, setExporting] = useState(false);
  if (!selected.length) return null;

  const handleExcel = async () => {
    setExporting(true);
    try { await onExcel(); }
    finally { setExporting(false); }
  };

  return (
    <div className="fixed bottom-20 md:bottom-6 left-0 right-0 flex justify-center z-40 px-4 pointer-events-none">
      <div className="pointer-events-auto bg-gray-900 text-white rounded-2xl shadow-2xl px-4 py-3 flex items-center gap-3 flex-wrap">
        <span className="text-sm font-medium text-gray-300">
          {selected.length} scenario{selected.length > 1 ? 's' : ''} selected
        </span>
        <div className="flex gap-2">
          <button
            onClick={handleExcel}
            disabled={exporting || selected.length < 2}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 rounded-lg text-sm font-medium transition-colors disabled:opacity-50"
          >
            {exporting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <TableIcon className="w-3.5 h-3.5" />}
            Excel
          </button>
          <button
            onClick={onCompare}
            disabled={selected.length < 2}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-brand-600 hover:bg-brand-500 rounded-lg text-sm font-medium transition-colors disabled:opacity-50"
          >
            <GitCompare className="w-3.5 h-3.5" />
            Compare
          </button>
          <button
            onClick={onClear}
            className="flex items-center gap-1 px-2 py-1.5 text-gray-400 hover:text-white rounded-lg transition-colors"
            aria-label="Clear selection"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Main ReportsPage ───────────────────────────────────────────────────────────

export default function ReportsPage() {
  const { user }    = useAuth();
  const navigate    = useNavigate();
  const announce    = useAnnounce();
  const [searchParams, setSearchParams] = useSearchParams();

  const [tab, setTab]             = useState('all'); // 'all' | 'saved'
  const [savedRuns, setSavedRuns] = useState([]);
  const [projects, setProjects]   = useState([]);
  const [saveModal, setSaveModal] = useState(null); // run | null
  const [selected, setSelected]   = useState(new Set());
  const [toast, setToast]         = useState(null);

  // Filter state (drives usePaginatedReports + URL sync)
  const [filters, setFilters] = useState({
    projectId:  searchParams.get('projectId') || null,
    mode:       searchParams.get('mode') || null,
    compliance: searchParams.get('compliance') || null,
  });

  const showToast = useCallback((msg, ok = true) => {
    setToast({ msg, ok });
    setTimeout(() => setToast(null), 3500);
  }, []);

  // ── Cursor-based infinite-scroll pagination ─────────────────────────────
  const {
    runs, total, loading, loadingMore, error: runsError,
    hasMore, loadMore, refresh, sentinelRef,
  } = usePaginatedReports({
    projectId:  filters.projectId,
    mode:       filters.mode,
    compliance: filters.compliance,
    limit: 40,
  });

  // When filters change, show a toast if there's an error
  useEffect(() => {
    if (runsError) showToast(runsError, false);
  }, [runsError, showToast]);

  // Load projects for filter dropdown
  useEffect(() => {
    api.get('/projects').then(({ data }) => {
      const list = Array.isArray(data) ? data : (data.data || data.projects || []);
      setProjects(list);
    }).catch(() => {});
  }, []);

  const loadSaved = useCallback(async () => {
    try {
      const { data } = await api.get('/reports/saved');
      setSavedRuns(Array.isArray(data) ? data : []);
    } catch {}
  }, []);

  useEffect(() => { loadSaved(); }, [loadSaved]);

  // Keep URL params in sync with filters
  useEffect(() => {
    const p = new URLSearchParams();
    if (filters.projectId)  p.set('projectId', filters.projectId);
    if (filters.mode)       p.set('mode', filters.mode);
    if (filters.compliance) p.set('compliance', filters.compliance);
    setSearchParams(p, { replace: true });
  }, [filters, setSearchParams]);

  const handleSave = (run) => setSaveModal(run);

  const handleSaved = async (run, meta) => {
    setSaveModal(null);
    showToast('Report saved');
    announce('Report saved');
    // Update in-place
    setRuns(rs => rs.map(r => r.id === run.id
      ? { ...r, saved: true, savedLabel: meta.label, savedNotes: meta.notes }
      : r
    ));
    await loadSaved();
  };

  const handleUnsave = async (run) => {
    try {
      await api.delete(`/reports/saved/${run.id}`);
      showToast('Removed from saved');
      announce('Report removed from saved');
      setRuns(rs => rs.map(r => r.id === run.id
        ? { ...r, saved: false, savedLabel: null, savedNotes: null }
        : r
      ));
      setSavedRuns(rs => rs.filter(r => r.id !== run.id));
    } catch { showToast('Remove failed', false); }
  };

  const toggleSelect = (id) => {
    setSelected(s => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else if (next.size < 6) next.add(id);
      return next;
    });
  };

  const handleCompare = () => {
    const ids = [...selected].join(',');
    navigate(`/reports/compare?runs=${ids}`);
  };

  const handleCompareExcel = async () => {
    const runIds = [...selected];
    const allRuns = [...runs, ...savedRuns];
    const labels  = runIds.map(id => allRuns.find(r => r.id === id)?.flowsheetName || '');
    try {
      const token = localStorage.getItem('accessToken');
      const resp  = await fetch('/api/v1/reports/compare/excel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ runIds, labels }),
      });
      if (!resp.ok) throw new Error('Export failed');
      const blob = await resp.blob();
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      a.href     = url;
      a.download = 'watersim_comparison.xlsx';
      a.click();
      URL.revokeObjectURL(url);
      showToast('Comparison Excel exported');
    } catch { showToast('Export failed', false); }
  };

  const displayRuns = tab === 'saved' ? savedRuns : runs;

  // VirtualTable column definitions (memoised so reference is stable)
  const columns = useMemo(() => [
    {
      key: 'select', header: '', flex: '0 0 40px', width: 40,
      render: (run) => tab === 'all' ? (
        <input
          type="checkbox"
          checked={selected.has(run.id)}
          onChange={() => toggleSelect(run.id)}
          onClick={e => e.stopPropagation()}
          className="w-4 h-4 accent-brand-600"
          aria-label={`Select ${run.flowsheetName}`}
        />
      ) : null,
    },
    {
      key: 'name', header: 'Flowsheet / Project', flex: 2,
      render: (run) => (
        <div>
          <div className="font-medium text-gray-800 truncate">{run.flowsheetName}</div>
          <div className="text-xs text-gray-400 truncate">{run.projectName}</div>
        </div>
      ),
    },
    {
      key: 'mode', header: 'Mode', flex: '0 0 90px', width: 90,
      render: (run) => <ModePill mode={run.mode} />,
    },
    {
      key: 'compliance', header: 'Compliance', flex: '0 0 110px', width: 110,
      render: (run) => <CompliancePill summary={run.summary} />,
    },
    {
      key: 'bod', header: 'BOD Rem.', flex: '0 0 88px', width: 88,
      render: (run) => {
        const v = run.summary?.bod_removal_pct;
        return v != null
          ? <span className="font-mono text-sm">{Number(v).toFixed(1)}%</span>
          : <span className="text-gray-400">—</span>;
      },
    },
    {
      key: 'cost', header: 'USD/m³', flex: '0 0 80px', width: 80,
      render: (run) => {
        const v = run.costSummary?.unit_cost_per_m3;
        return v != null
          ? <span className="font-mono text-sm">${Number(v).toFixed(3)}</span>
          : <span className="text-gray-400">—</span>;
      },
    },
    {
      key: 'completed', header: 'Completed', flex: 1,
      render: (run) => (
        <span className="text-xs text-gray-500">{fmtDate(run.completedAt)}</span>
      ),
    },
    {
      key: 'actions', header: 'Actions', flex: '0 0 140px', width: 140,
      render: (run) => (
        <RunActions
          run={run}
          onSave={handleSave}
          onUnsave={handleUnsave}
        />
      ),
    },
  ], [tab, selected]); // eslint-disable-line react-hooks/exhaustive-deps

  const TABS = [
    { key: 'all',   label: 'All reports', count: total },
    { key: 'saved', label: 'Saved',       count: savedRuns.length },
  ];

  return (
    <AppLayout>
      <div className="p-4 md:p-6 max-w-7xl mx-auto space-y-4">

        {/* Page header */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Reports</h1>
            <p className="text-sm text-gray-500 mt-0.5">Simulation report history, saved bookmarks, and exports</p>
          </div>
          <div className="flex items-center gap-2">
            {selected.size >= 2 && (
              <button
                onClick={handleCompare}
                className="btn-primary text-sm"
              >
                <GitCompare className="w-4 h-4" />
                Compare {selected.size}
              </button>
            )}
            <button
              onClick={() => { refresh(); loadSaved(); }}
              aria-label="Refresh reports"
              className="p-2 text-gray-400 hover:text-gray-600 rounded-lg hover:bg-gray-100 transition-colors"
            >
              <RefreshCw className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Compare mode tip */}
        {selected.size > 0 && selected.size < 2 && (
          <div className="text-sm text-brand-700 bg-brand-50 border border-brand-200 rounded-xl px-4 py-2.5 flex items-center gap-2">
            <GitCompare className="w-4 h-4 flex-shrink-0" />
            Select at least 2 scenarios to compare. You can select up to 6.
          </div>
        )}

        {/* Tabs */}
        <div className="flex border-b border-gray-200"
          role="tablist" aria-label="Report views"
          onKeyDown={e => {
            const keys = TABS.map(t => t.key);
            const i = keys.indexOf(tab);
            if (e.key === 'ArrowRight') setTab(keys[(i + 1) % keys.length]);
            if (e.key === 'ArrowLeft')  setTab(keys[(i - 1 + keys.length) % keys.length]);
          }}>
          {TABS.map(t => (
            <button key={t.key} role="tab" aria-selected={tab === t.key}
              onClick={() => setTab(t.key)}
              className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors
                ${tab === t.key ? 'border-brand-600 text-brand-700' : 'border-transparent text-gray-500 hover:text-gray-700'}`}>
              {t.key === 'saved' ? <Bookmark className="w-3.5 h-3.5" /> : <FileText className="w-3.5 h-3.5" />}
              {t.label}
              <span className={`px-1.5 py-0.5 rounded-full text-xs font-semibold
                ${tab === t.key ? 'bg-brand-100 text-brand-700' : 'bg-gray-100 text-gray-600'}`}>
                {t.count}
              </span>
            </button>
          ))}
        </div>

        {/* Filter bar (all tab only) */}
        {tab === 'all' && (
          <FilterBar filters={filters} setFilters={setFilters} projects={projects} />
        )}

        {/* Virtual table with infinite scroll */}
        <div className="card overflow-hidden">
          <VirtualTable
            rows={displayRuns}
            columns={columns}
            rowHeight={56}
            containerHeight={560}
            getRowKey={(run) => run.id}
            loading={loading && tab === 'all'}
            emptyState={
              <EmptyState
                icon={tab === 'saved' ? Bookmark : FileText}
                title={tab === 'saved' ? 'No saved reports' : 'No reports yet'}
                description={tab === 'saved'
                  ? 'Bookmark completed simulations to find them quickly later.'
                  : 'Completed simulation runs will appear here.'}
                action={tab === 'saved' ? { label: 'Browse all reports', onClick: () => setTab('all') } : undefined}
              />
            }
          />
        </div>

        {/* Infinite scroll sentinel + load-more indicator (All tab only) */}
        {tab === 'all' && (
          <div className="flex flex-col items-center gap-2 pb-4">
            {/* Sentinel: IntersectionObserver triggers loadMore */}
            {hasMore && <div ref={sentinelRef} className="h-1 w-full" aria-hidden />}

            {loadingMore && (
              <div className="flex items-center gap-2 text-sm text-gray-500 py-2">
                <Loader2 className="w-4 h-4 animate-spin" />
                Loading more…
              </div>
            )}

            {!hasMore && runs.length > 0 && (
              <p className="text-xs text-gray-400 py-2">
                All {total.toLocaleString()} report{total !== 1 ? 's' : ''} loaded
              </p>
            )}
          </div>
        )}
      </div>

      {/* Floating comparison bar */}
      <CompareBar
        selected={[...selected]}
        runs={runs}
        onClear={() => setSelected(new Set())}
        onCompare={handleCompare}
        onExcel={handleCompareExcel}
      />

      {/* Save modal */}
      {saveModal && (
        <SaveModal
          run={saveModal}
          onClose={() => setSaveModal(null)}
          onSaved={meta => handleSaved(saveModal, meta)}
        />
      )}

      {/* Toast */}
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
