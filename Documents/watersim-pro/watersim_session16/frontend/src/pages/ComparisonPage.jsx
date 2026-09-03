/**
 * WaterSim Pro — ComparisonPage
 * Side-by-side comparison of 2–6 completed simulation runs.
 * Highlights best/worst values. Exports to Excel.
 *
 * Route: /reports/compare?runs=uuid1,uuid2,...
 */
import { useState, useEffect, useCallback } from 'react';
import { useSearchParams, Link, useNavigate } from 'react-router-dom';
import {
  ArrowLeft, TableIcon, CheckCircle2, XCircle, AlertTriangle,
  Loader2, ChevronDown, ChevronUp, TrendingDown, TrendingUp,
  Crown, Minus, ExternalLink,
} from 'lucide-react';
import api from '../services/api';
import { downloadFile } from '../utils/download';

// ── Constants ─────────────────────────────────────────────────────────────────

const QUALITY_PARAMS = [
  { key: 'BOD',  label: 'BOD₅',                  unit: 'mg/L',  dec: 1,  lowerBetter: true  },
  { key: 'COD',  label: 'COD',                    unit: 'mg/L',  dec: 1,  lowerBetter: true  },
  { key: 'TSS',  label: 'TSS',                    unit: 'mg/L',  dec: 1,  lowerBetter: true  },
  { key: 'TN',   label: 'Total Nitrogen',         unit: 'mg/L',  dec: 2,  lowerBetter: true  },
  { key: 'NH4',  label: 'Ammonia (NH₄-N)',        unit: 'mg/L',  dec: 2,  lowerBetter: true  },
  { key: 'NO3',  label: 'Nitrate (NO₃-N)',        unit: 'mg/L',  dec: 2,  lowerBetter: true  },
  { key: 'TP',   label: 'Total Phosphorus',       unit: 'mg/L',  dec: 2,  lowerBetter: true  },
  { key: 'DO',   label: 'Dissolved Oxygen',       unit: 'mg/L',  dec: 2,  lowerBetter: false },
  { key: 'pH',   label: 'pH',                     unit: 'S.U.', dec: 2,  lowerBetter: null  },
  { key: 'temp', label: 'Temperature',            unit: '°C',    dec: 1,  lowerBetter: null  },
  { key: 'Q',    label: 'Effluent Flow',          unit: 'm³/d',  dec: 0,  lowerBetter: null  },
];

const REMOVAL_PARAMS = [
  { key: 'BOD', label: 'BOD₅ removal',       higherBetter: true },
  { key: 'COD', label: 'COD removal',        higherBetter: true },
  { key: 'TSS', label: 'TSS removal',        higherBetter: true },
  { key: 'TN',  label: 'Total N removal',    higherBetter: true },
  { key: 'NH4', label: 'Ammonia removal',    higherBetter: true },
  { key: 'TP',  label: 'Total P removal',    higherBetter: true },
];

const COST_ROWS = [
  { label: 'Total OPEX (USD/yr)',      get: c => c?.total_USD_yr,                              lowerBetter: true,  dec: 0 },
  { label: 'Unit cost (USD/m³)',       get: c => c?.cost_per_m3_treated_USD,                   lowerBetter: true,  dec: 3 },
  { label: 'Energy (USD/yr)',          get: c => c?.energy?.cost_USD_yr,                       lowerBetter: true,  dec: 0 },
  { label: 'Chemicals (USD/yr)',       get: c => c?.chemicals?.total_USD_yr,                   lowerBetter: true,  dec: 0 },
  { label: 'Sludge disposal (USD/yr)', get: c => c?.sludge?.cost_USD_yr,                       lowerBetter: true,  dec: 0 },
  { label: 'Labour (USD/yr)',          get: c => c?.labour?.cost_USD_yr,                       lowerBetter: true,  dec: 0 },
  { label: 'Maintenance (USD/yr)',     get: c => c?.maintenance?.cost_USD_yr,                  lowerBetter: true,  dec: 0 },
  { label: 'Energy (kWh/yr)',          get: c => c?.energy?.total_kWh_yr,                      lowerBetter: true,  dec: 0 },
  { label: 'Dry sludge (t/yr)',        get: c => c?.sludge?.dry_tonnes_yr,                     lowerBetter: true,  dec: 0 },
  { label: 'Staff (FTE)',              get: c => c?.labour?.staff_count,                       lowerBetter: null,  dec: 1 },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtNum(v, dec = 1) {
  if (v == null || !isFinite(v)) return '—';
  return Number(v).toLocaleString(undefined, { minimumFractionDigits: dec, maximumFractionDigits: dec });
}

function calcRemoval(inf, eff) {
  try {
    const i = parseFloat(inf), e = parseFloat(eff);
    if (!isFinite(i) || !isFinite(e) || i === 0) return null;
    return (i - e) / i * 100;
  } catch { return null; }
}

function bestIndices(values, lowerBetter) {
  if (lowerBetter === null) return new Set();
  const valid = values.map((v, i) => ({ v: parseFloat(v), i })).filter(x => isFinite(x.v));
  if (valid.length < 2) return new Set();
  const best = lowerBetter
    ? Math.min(...valid.map(x => x.v))
    : Math.max(...valid.map(x => x.v));
  return new Set(valid.filter(x => x.v === best).map(x => x.i));
}

function ComplianceIcon({ summary }) {
  const c = summary?.compliant;
  if (c === true)  return <CheckCircle2 className="w-5 h-5 text-emerald-600" />;
  if (c === false) return <XCircle className="w-5 h-5 text-red-600" />;
  return <AlertTriangle className="w-5 h-5 text-gray-400" />;
}

// ── Section wrapper ───────────────────────────────────────────────────────────

function Section({ title, color = 'blue', children, defaultOpen = true }) {
  const [open, setOpen] = useState(defaultOpen);
  const colors = {
    blue:   'bg-blue-800 text-white',
    green:  'bg-emerald-700 text-white',
    violet: 'bg-violet-700 text-white',
    cyan:   'bg-cyan-700 text-white',
  };
  return (
    <div className="card overflow-hidden mb-4">
      <button
        className={`w-full flex items-center justify-between px-5 py-3 text-left ${colors[color]}`}
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
      >
        <span className="font-semibold text-sm tracking-wide">{title}</span>
        {open ? <ChevronUp className="w-4 h-4 opacity-70" /> : <ChevronDown className="w-4 h-4 opacity-70" />}
      </button>
      {open && <div className="overflow-x-auto">{children}</div>}
    </div>
  );
}

// ── ComparisonTable ───────────────────────────────────────────────────────────

function ComparisonTable({ runs, rows, title, color, getCellValue, lowerBetterFn, decFn = () => 1, unitFn = () => '' }) {
  return (
    <Section title={title} color={color}>
      <table className="w-full text-sm min-w-max" aria-label={title}>
        <thead className="bg-gray-50 border-b border-gray-200">
          <tr>
            <th className="px-4 py-2.5 text-left text-xs font-semibold text-gray-600 uppercase tracking-wider sticky left-0 bg-gray-50 min-w-48">
              Parameter
            </th>
            {runs.map((run, i) => (
              <th key={run.id} className="px-4 py-2.5 text-center text-xs font-semibold text-gray-600 uppercase tracking-wider min-w-36">
                <div className="font-bold text-gray-900 normal-case text-sm truncate max-w-36" title={run.label || run.flowsheet_name}>
                  {run.label || run.flowsheet_name}
                </div>
                <div className="font-normal text-gray-400 text-[11px] truncate">{run.project_name}</div>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, ri) => {
            const values = runs.map(run => getCellValue(run, row));
            const numVals = values.map(v => (v != null && isFinite(parseFloat(v))) ? parseFloat(v) : null);
            const bests   = bestIndices(numVals.filter(v => v != null), lowerBetterFn(row));
            const altBests = lowerBetterFn(row) === null ? new Set() : bests;

            // Re-map to original indices
            const validIdxs = numVals.map((v, i) => v != null ? i : null).filter(i => i !== null);
            const bestOriginal = new Set();
            if (altBests.size > 0) {
              let target = lowerBetterFn(row) ? Infinity : -Infinity;
              validIdxs.forEach(i => {
                const v = numVals[i];
                if (lowerBetterFn(row) && v < target) target = v;
                if (!lowerBetterFn(row) && v > target) target = v;
              });
              validIdxs.forEach(i => {
                if (numVals[i] === target) bestOriginal.add(i);
              });
            }

            return (
              <tr key={ri} className={ri % 2 === 0 ? 'bg-white' : 'bg-gray-50/60'}>
                <td className="px-4 py-2.5 text-sm font-medium text-gray-700 sticky left-0 bg-inherit border-r border-gray-100">
                  <div>{row.label || row.key}</div>
                  {(row.unit || unitFn(row)) && (
                    <div className="text-xs text-gray-400">{row.unit || unitFn(row)}</div>
                  )}
                </td>
                {values.map((val, ci) => {
                  const isBest = bestOriginal.has(ci);
                  const cellVal = val != null ? fmtNum(val, decFn(row)) : '—';
                  return (
                    <td key={ci}
                      className={`px-4 py-2.5 text-sm text-center font-mono transition-colors
                        ${isBest ? 'bg-emerald-50 text-emerald-800 font-bold' : 'text-gray-700'}`}
                    >
                      {isBest && <Crown className="w-3 h-3 inline mr-1 text-emerald-600 -mt-0.5" aria-hidden="true" />}
                      {cellVal}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </Section>
  );
}

// ── ComparisonPage ────────────────────────────────────────────────────────────

export default function ComparisonPage() {
  const [searchParams] = useSearchParams();
  const navigate       = useNavigate();
  const runIds = (searchParams.get('runs') || '').split(',').filter(Boolean);

  const [runs, setRuns]         = useState([]);
  const [labels, setLabels]     = useState([]);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState(null);
  const [exporting, setExporting] = useState(false);

  // Load full report data for each run
  const load = useCallback(async () => {
    if (!runIds.length) { setError('No runs specified'); setLoading(false); return; }
    setLoading(true);
    try {
      // Resolve each selected run's projectId/flowsheetId from the org history.
      // The history is cursor-paginated, so follow nextCursor until every
      // selected run is found — a single limit-100 fetch missed older runs.
      // (There is no JSON endpoint keyed by runId alone; the per-run report
      // endpoint needs project + flowsheet ids.)
      const wanted = new Set(runIds);
      const map = {};
      let cursor = null;
      for (let page = 0; page < 20 && wanted.size > 0; page++) {
        const params = new URLSearchParams({ limit: '100' });
        if (cursor) params.set('cursor', cursor);
        const { data } = await api.get(`/reports?${params.toString()}`);
        for (const r of data.runs || []) {
          if (wanted.has(r.id)) { map[r.id] = r; wanted.delete(r.id); }
        }
        cursor = data.nextCursor;
        if (!cursor) break;
      }

      // For full results (cost + quality) we need the full report JSON per run
      const fullRuns = await Promise.all(
        runIds.map(id => {
          const meta = map[id];
          if (!meta) return null;
          return api.get(`/projects/${meta.projectId}/flowsheets/${meta.flowsheetId}/simulate/${id}/report`)
            .then(r => ({ ...r.data, _meta: meta }))
            .catch(() => null);
        })
      );

      const valid = fullRuns.filter(Boolean);
      if (valid.length < 2) { setError('Could not load at least 2 runs. They may have been deleted.'); return; }
      setRuns(valid);
      setLabels(valid.map(r => r.flowsheet_name || 'Run'));
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to load runs');
    } finally { setLoading(false); }
  }, [runIds.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { load(); }, [load]);

  const handleExcel = async () => {
    setExporting(true);
    try {
      await downloadFile('/reports/compare/excel', 'watersim_comparison.xlsx', {
        method: 'POST',
        data: { runIds, labels },
      });
    } catch { /* silent */ }
    finally { setExporting(false); }
  };

  // ── Loading / error ────────────────────────────────────────────────────────

  if (loading) return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center">
      <div className="flex flex-col items-center gap-3">
        <Loader2 className="w-8 h-8 animate-spin text-brand-600" />
        <p className="text-sm text-gray-500">Loading scenarios for comparison…</p>
      </div>
    </div>
  );

  if (error) return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center">
      <div className="text-center max-w-sm">
        <AlertTriangle className="w-12 h-12 text-amber-400 mx-auto mb-3" />
        <p className="font-semibold text-gray-800 mb-1">Could not load comparison</p>
        <p className="text-sm text-gray-500 mb-4">{error}</p>
        <button onClick={() => navigate('/reports')} className="text-sm text-brand-600 hover:underline flex items-center gap-1 mx-auto">
          <ArrowLeft className="w-4 h-4" />Back to reports
        </button>
      </div>
    </div>
  );

  const n = runs.length;

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header bar */}
      <header className="bg-blue-900 text-white px-4 md:px-6 py-3 flex items-center justify-between sticky top-0 z-10 shadow-lg">
        <div className="flex items-center gap-3 min-w-0">
          <button onClick={() => navigate('/reports')}
            className="p-1.5 hover:bg-blue-800 rounded-lg transition-colors flex-shrink-0"
            aria-label="Back to reports">
            <ArrowLeft className="w-4 h-4" />
          </button>
          <div>
            <p className="text-[10px] text-blue-300 uppercase tracking-widest">Scenario Comparison</p>
            <h1 className="font-bold text-sm">{n} scenarios</h1>
          </div>
        </div>
        <button
          onClick={handleExcel}
          disabled={exporting}
          className="flex items-center gap-2 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-60 px-3 py-2 rounded-lg text-sm font-semibold transition-colors"
        >
          {exporting ? <Loader2 className="w-4 h-4 animate-spin" /> : <TableIcon className="w-4 h-4" />}
          <span className="hidden sm:inline">{exporting ? 'Exporting…' : 'Export Excel'}</span>
        </button>
      </header>

      <main className="max-w-6xl mx-auto px-3 md:px-4 py-4 md:py-6">

        {/* Scenario header cards */}
        <div className={`grid gap-3 mb-6`} style={{ gridTemplateColumns: `repeat(${n}, minmax(0, 1fr))` }}>
          {runs.map((run, i) => {
            const summary   = run.results?.summary || {};
            const compliant = summary.compliant;
            return (
              <div key={run.run_id}
                className={`card p-4 border-t-4 ${
                  compliant === true  ? 'border-emerald-500' :
                  compliant === false ? 'border-red-500'     : 'border-gray-300'}`}>
                <div className="flex items-start justify-between gap-2 mb-2">
                  <div className="min-w-0">
                    <p className="font-bold text-sm text-gray-900 truncate">{labels[i] || run.flowsheet_name}</p>
                    <p className="text-xs text-gray-500 truncate">{run.project_name}</p>
                  </div>
                  <ComplianceIcon summary={summary} />
                </div>
                <div className="flex flex-wrap gap-1.5 mb-3">
                  <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border
                    ${run.mode === 'dynamic' ? 'text-purple-700 bg-purple-50 border-purple-200' : 'text-blue-700 bg-blue-50 border-blue-200'}`}>
                    {run.mode === 'dynamic' ? 'Dynamic' : 'Steady'}
                  </span>
                  {compliant === true  && <span className="text-xs text-emerald-700 font-medium">✓ All permits</span>}
                  {compliant === false && <span className="text-xs text-red-700 font-medium">✗ {summary.permit_violations?.length} violation{summary.permit_violations?.length !== 1 ? 's' : ''}</span>}
                </div>

                {/* Editable label */}
                <div className="mb-2">
                  <label className="text-[10px] text-gray-400 uppercase tracking-wider font-semibold block mb-1">Scenario label</label>
                  <input
                    className="input text-xs py-1"
                    value={labels[i]}
                    onChange={e => setLabels(ls => ls.map((l, j) => j === i ? e.target.value : l))}
                    aria-label={`Label for scenario ${i + 1}`}
                    placeholder="Scenario name"
                    maxLength={50}
                  />
                </div>

                <Link
                  to={`/projects/${run._meta?.projectId || run.project_id}/flowsheets/${run._meta?.flowsheetId || run.flowsheet_id}/simulate/${run.run_id}/report`}
                  className="text-xs text-brand-600 hover:underline flex items-center gap-1"
                >
                  <ExternalLink className="w-3 h-3" />Full report
                </Link>
              </div>
            );
          })}
        </div>

        {/* Effluent quality */}
        <Section title="Effluent Quality" color="blue">
          <table className="w-full text-sm min-w-max">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="px-4 py-2.5 text-left text-xs font-semibold text-gray-600 uppercase tracking-wider min-w-44">Parameter</th>
                {runs.map((run, i) => (
                  <th key={run.run_id} className="px-4 py-2.5 text-center min-w-36">
                    <div className="text-sm font-bold text-gray-900 truncate">{labels[i]}</div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {QUALITY_PARAMS.map((p, ri) => {
                const values = runs.map(run => run.results?.summary?.effluent?.[p.key]);
                const numVals = values.map(v => v != null ? parseFloat(v) : null);
                const validVals = numVals.filter(v => v != null && isFinite(v));
                let bestVal = null;
                if (p.lowerBetter === true  && validVals.length > 1) bestVal = Math.min(...validVals);
                if (p.lowerBetter === false && validVals.length > 1) bestVal = Math.max(...validVals);
                const limits = runs.map(run => run.results?.permitLimitsUsed?.[p.key]);

                return (
                  <tr key={p.key} className={ri % 2 === 0 ? 'bg-white' : 'bg-gray-50/60'}>
                    <td className="px-4 py-2.5 font-medium text-gray-700 border-r border-gray-100">
                      <div className="text-sm">{p.label}</div>
                      <div className="text-xs text-gray-400">{p.unit}</div>
                    </td>
                    {values.map((val, ci) => {
                      const num = parseFloat(val);
                      const isBest = bestVal !== null && isFinite(num) && num === bestVal;
                      // Permit check
                      const limit = limits[ci];
                      const overLimit = limit != null && val != null &&
                        !['Q', 'pH', 'temp', 'DO'].includes(p.key) &&
                        parseFloat(val) > parseFloat(limit);
                      return (
                        <td key={ci}
                          className={`px-4 py-2.5 text-center font-mono text-sm
                            ${isBest ? 'bg-emerald-50 text-emerald-800 font-bold' :
                              overLimit ? 'bg-red-50 text-red-700' : 'text-gray-700'}`}
                        >
                          {isBest && <Crown className="w-3 h-3 inline mr-0.5 text-emerald-600 -mt-0.5" />}
                          {val != null ? fmtNum(val, p.dec) : '—'}
                          {overLimit && <span className="ml-1 text-[10px] text-red-500 font-semibold">↑</span>}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="px-4 py-2 text-xs text-gray-400 bg-gray-50 border-t border-gray-100">
            <Crown className="w-3 h-3 inline text-emerald-600 mr-1" />best value  ·  ↑ exceeds permit limit
          </p>
        </Section>

        {/* Removal efficiencies */}
        <Section title="Removal Efficiencies" color="green">
          <table className="w-full text-sm min-w-max">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="px-4 py-2.5 text-left text-xs font-semibold text-gray-600 uppercase tracking-wider min-w-44">Parameter</th>
                {runs.map((run, i) => (
                  <th key={run.run_id} className="px-4 py-2.5 text-center min-w-36">
                    <div className="text-sm font-bold text-gray-900 truncate">{labels[i]}</div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {REMOVAL_PARAMS.map((p, ri) => {
                const values = runs.map(run => calcRemoval(
                  run.results?.summary?.influent?.[p.key],
                  run.results?.summary?.effluent?.[p.key]
                ));
                const validVals = values.filter(v => v != null && isFinite(v));
                const bestVal   = validVals.length > 1 ? Math.max(...validVals) : null;

                return (
                  <tr key={p.key} className={ri % 2 === 0 ? 'bg-white' : 'bg-gray-50/60'}>
                    <td className="px-4 py-2.5 font-medium text-gray-700 border-r border-gray-100">
                      <div className="text-sm">{p.label}</div>
                      <div className="text-xs text-gray-400">%</div>
                    </td>
                    {values.map((val, ci) => {
                      const isBest = bestVal !== null && val !== null && val === bestVal;
                      return (
                        <td key={ci}
                          className={`px-4 py-2.5 text-center font-mono text-sm
                            ${isBest ? 'bg-emerald-50 text-emerald-800 font-bold' : 'text-gray-700'}`}
                        >
                          {isBest && <TrendingUp className="w-3 h-3 inline mr-0.5 text-emerald-600 -mt-0.5" />}
                          {val != null ? `${fmtNum(val, 1)}%` : '—'}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Section>

        {/* Cost comparison */}
        {runs.some(r => r.results?.costBreakdown) && (
          <Section title="Operating Cost Comparison" color="violet">
            <table className="w-full text-sm min-w-max">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr>
                  <th className="px-4 py-2.5 text-left text-xs font-semibold text-gray-600 uppercase tracking-wider min-w-48">Cost item</th>
                  {runs.map((run, i) => (
                    <th key={run.run_id} className="px-4 py-2.5 text-center min-w-36">
                      <div className="text-sm font-bold text-gray-900 truncate">{labels[i]}</div>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {COST_ROWS.map((row, ri) => {
                  const values = runs.map(run => row.get(run.results?.costBreakdown));
                  const numVals = values.map(v => (v != null && isFinite(parseFloat(v))) ? parseFloat(v) : null);
                  const validVals = numVals.filter(v => v != null);
                  let bestVal = null;
                  if (row.lowerBetter === true  && validVals.length > 1) bestVal = Math.min(...validVals);
                  if (row.lowerBetter === false && validVals.length > 1) bestVal = Math.max(...validVals);

                  return (
                    <tr key={ri} className={ri % 2 === 0 ? 'bg-white' : 'bg-gray-50/60'}>
                      <td className="px-4 py-2.5 font-medium text-gray-700 border-r border-gray-100 text-sm">
                        {row.label}
                      </td>
                      {values.map((val, ci) => {
                        const num = numVals[ci];
                        const isBest = bestVal !== null && num !== null && num === bestVal;
                        return (
                          <td key={ci}
                            className={`px-4 py-2.5 text-center font-mono text-sm
                              ${isBest ? 'bg-emerald-50 text-emerald-800 font-bold' : 'text-gray-700'}`}
                          >
                            {isBest && <TrendingDown className="w-3 h-3 inline mr-0.5 text-emerald-600 -mt-0.5" />}
                            {val != null ? fmtNum(val, row.dec) : '—'}
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <p className="px-4 py-2 text-xs text-gray-400 bg-gray-50 border-t border-gray-100">
              <TrendingDown className="w-3 h-3 inline text-emerald-600 mr-1" />lowest cost scenario highlighted in green
            </p>
          </Section>
        )}

        {/* Permit compliance per run */}
        <Section title="Permit Compliance Detail" color="cyan" defaultOpen={false}>
          <div className={`grid gap-4 p-4`} style={{ gridTemplateColumns: `repeat(${Math.min(n, 2)}, minmax(0, 1fr))` }}>
            {runs.map((run, i) => {
              const summary     = run.results?.summary || {};
              const violations  = summary.permit_violations || [];
              const limits      = run.results?.permitLimitsUsed || {};
              return (
                <div key={run.run_id} className={`rounded-xl border p-4 ${summary.compliant === true ? 'border-emerald-200 bg-emerald-50' : summary.compliant === false ? 'border-red-200 bg-red-50' : 'border-gray-200'}`}>
                  <div className="flex items-center gap-2 mb-2">
                    <ComplianceIcon summary={summary} />
                    <p className="font-semibold text-sm text-gray-900">{labels[i]}</p>
                  </div>
                  {violations.length === 0
                    ? <p className="text-xs text-emerald-700">All permit limits met</p>
                    : violations.map((v, j) => (
                        <p key={j} className="text-xs text-red-700 mb-0.5">• {v}</p>
                      ))
                  }
                  {Object.keys(limits).length > 0 && (
                    <p className="text-xs text-gray-400 mt-2">
                      Template: {Object.keys(limits).filter(k => limits[k] != null).length} parameters regulated
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        </Section>

      </main>
    </div>
  );
}
