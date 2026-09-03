/**
 * WaterSim Pro — ReportPage
 * Full-page simulation report viewer with permit compliance, cost breakdown,
 * effluent quality table, unit operation metrics, and PDF export.
 *
 * Route: /projects/:projectId/flowsheets/:flowsheetId/simulate/:runId/report
 */

import { useParams, useNavigate, Link } from 'react-router-dom';
import { useReport } from '../hooks/useReport';
import { downloadFile } from '../utils/download';
import { useState } from 'react';
import {
  ArrowLeft, Download, CheckCircle2, XCircle, AlertTriangle,
  Activity, DollarSign, Beaker, Gauge, FileText, Layers,
  ChevronDown, ChevronUp, Loader2, AlertCircle
} from 'lucide-react';

// ── Helpers ──────────────────────────────────────────────────────────────────

function fmt(v, dec = 2, unit = '') {
  if (v == null || v === '') return '—';
  const n = Number(v);
  if (!isFinite(n)) return '—';
  const s = n.toLocaleString(undefined, { minimumFractionDigits: dec, maximumFractionDigits: dec });
  return unit ? `${s} ${unit}` : s;
}

function calcRemoval(inf, eff) {
  const i = Number(inf), e = Number(eff);
  if (!i || !isFinite(i) || !isFinite(e)) return null;
  return ((i - e) / i) * 100;
}

function ComplianceBadge({ value, limit }) {
  if (value == null || limit == null) return <span className="text-gray-400 text-xs">—</span>;
  const pass = Number(value) <= Number(limit);
  if (pass) return (
    <span className="inline-flex items-center gap-1 text-emerald-600 font-semibold text-xs bg-emerald-50 px-2 py-0.5 rounded-full">
      <CheckCircle2 size={11} /> PASS
    </span>
  );
  const pct = ((Number(value) - Number(limit)) / Number(limit) * 100).toFixed(0);
  return (
    <span className="inline-flex items-center gap-1 text-red-600 font-semibold text-xs bg-red-50 px-2 py-0.5 rounded-full">
      <XCircle size={11} /> +{pct}%
    </span>
  );
}

// ── Section wrapper ────────────────────────────────────────────────────────

function Section({ icon: Icon, title, accent = 'blue', children, collapsible = false }) {
  const [open, setOpen] = useState(true);
  const accents = {
    blue:  'border-blue-500 bg-blue-50 text-blue-700',
    cyan:  'border-cyan-500 bg-cyan-50 text-cyan-700',
    green: 'border-green-500 bg-green-50 text-green-700',
    amber: 'border-amber-500 bg-amber-50 text-amber-700',
    violet:'border-violet-500 bg-violet-50 text-violet-700',
  };
  const ac = accents[accent] || accents.blue;
  return (
    <section className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden mb-6 print:shadow-none print:border-gray-300">
      <div
        className={`flex items-center justify-between px-5 py-3 border-l-4 ${ac} cursor-pointer select-none`}
        onClick={() => collapsible && setOpen(o => !o)}
      >
        <div className="flex items-center gap-2">
          {Icon && <Icon size={16} />}
          <h2 className="font-semibold text-sm tracking-wide">{title}</h2>
        </div>
        {collapsible && (open ? <ChevronUp size={14} /> : <ChevronDown size={14} />)}
      </div>
      {open && <div className="px-5 py-4">{children}</div>}
    </section>
  );
}

// ── KPI card ──────────────────────────────────────────────────────────────

function KPI({ label, value, sub, color = 'blue' }) {
  const colors = {
    blue:  'bg-blue-50  text-blue-700',
    green: 'bg-emerald-50 text-emerald-700',
    amber: 'bg-amber-50  text-amber-700',
    red:   'bg-red-50    text-red-700',
    cyan:  'bg-cyan-50   text-cyan-700',
  };
  return (
    <div className={`rounded-lg p-3 ${colors[color] || colors.blue} flex flex-col gap-0.5`}>
      <span className="text-[10px] font-semibold uppercase tracking-widest opacity-70">{label}</span>
      <span className="text-xl font-bold leading-tight">{value}</span>
      {sub && <span className="text-[10px] opacity-60">{sub}</span>}
    </div>
  );
}

// ── Effluent quality table row ────────────────────────────────────────────

function QualityRow({ param, unit, inf, eff, limit, dec = 1 }) {
  const removal = calcRemoval(inf, eff);
  const showCompliance = limit != null && !['Q','pH','temp','DO'].includes(param);
  return (
    <tr className="border-b border-gray-100 hover:bg-gray-50 transition-colors">
      <td className="py-2 px-3 text-sm font-medium text-gray-800">{param}</td>
      <td className="py-2 px-3 text-xs text-gray-500 text-center">{unit}</td>
      <td className="py-2 px-3 text-sm text-right font-mono text-blue-700">{fmt(inf, dec)}</td>
      <td className="py-2 px-3 text-sm text-right font-mono text-emerald-700">{fmt(eff, dec)}</td>
      <td className="py-2 px-3 text-sm text-right font-mono text-gray-500">
        {removal != null ? `${removal.toFixed(1)}%` : '—'}
      </td>
      <td className="py-2 px-3 text-sm text-right font-mono text-gray-600">{limit != null ? fmt(limit, dec) : '—'}</td>
      <td className="py-2 px-3 text-center">
        {showCompliance ? <ComplianceBadge value={eff} limit={limit} /> : <span className="text-gray-300 text-xs">—</span>}
      </td>
    </tr>
  );
}

// ── Cost bar ──────────────────────────────────────────────────────────────

function CostBar({ label, value, total, color }) {
  const pct = total > 0 ? (value / total * 100) : 0;
  return (
    <div className="mb-3">
      <div className="flex justify-between text-xs mb-1">
        <span className="font-medium text-gray-700">{label}</span>
        <span className="text-gray-500">{fmt(value, 0, 'USD/yr')} <span className="text-gray-400">({pct.toFixed(0)}%)</span></span>
      </div>
      <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
        <div className={`h-2 rounded-full transition-all duration-700 ${color}`} style={{ width: `${Math.max(pct, 1)}%` }} />
      </div>
    </div>
  );
}

// ── Main ReportPage ────────────────────────────────────────────────────────

export default function ReportPage() {
  const { projectId, flowsheetId, runId } = useParams();
  const navigate = useNavigate();
  const { data, loading, error, downloadPdf } = useReport(projectId, flowsheetId, runId);
  const [pdfLoading, setPdfLoading] = useState(false);
  const [pdfError, setPdfError]     = useState(null);
  const [xlsxLoading, setXlsxLoading] = useState(false);

  const handlePdf = async () => {
    setPdfLoading(true);
    setPdfError(null);
    try {
      await downloadPdf();
    } catch (e) {
      setPdfError(e.message);
    } finally {
      setPdfLoading(false);
    }
  };

  const handleExcel = async () => {
    setXlsxLoading(true);
    try {
      await downloadFile(`/reports/${runId}/excel`, 'watersim_report.xlsx');
    } catch (e) {
      console.error('Excel download error', e);
    } finally {
      setXlsxLoading(false);
    }
  };

  // ── Loading ──────────────────────────────────────────────────────────────
  if (loading) return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <div className="flex flex-col items-center gap-3">
        <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
        <p className="text-sm text-gray-500">Loading simulation report…</p>
      </div>
    </div>
  );

  if (error) return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <div className="text-center max-w-sm">
        <AlertCircle className="w-12 h-12 text-red-400 mx-auto mb-3" />
        <p className="font-semibold text-gray-800 mb-1">Report not found</p>
        <p className="text-sm text-gray-500 mb-4">{error}</p>
        <button onClick={() => navigate(-1)} className="text-sm text-blue-600 hover:underline">
          ← Go back
        </button>
      </div>
    </div>
  );

  if (!data) return null;

  const { results = {}, warnings = [], config = {} } = data;
  const summary   = results.summary || {};
  const inf       = summary.influent || {};
  const eff       = summary.effluent || {};
  const limits    = results.permitLimitsUsed || {};
  const cost      = results.costBreakdown;
  const units_res = results.unitResults || {};
  const streams   = results.streamResults || {};
  const isDynamic = data.mode === 'dynamic';

  const compliant  = summary.compliant;
  const violations = summary.permit_violations || [];

  const QUALITY_PARAMS = [
    { key: 'Q',    label: 'Flow',              unit: 'm³/d',  dec: 0 },
    { key: 'BOD',  label: 'BOD',               unit: 'mg/L',  dec: 1 },
    { key: 'COD',  label: 'COD',               unit: 'mg/L',  dec: 1 },
    { key: 'TSS',  label: 'Total Suspended Solids', unit: 'mg/L', dec: 1 },
    { key: 'TN',   label: 'Total Nitrogen',    unit: 'mg/L',  dec: 2 },
    { key: 'NH4',  label: 'Ammonia (NH4-N)',   unit: 'mg/L',  dec: 2 },
    { key: 'NO3',  label: 'Nitrate (NO3-N)',   unit: 'mg/L',  dec: 2 },
    { key: 'TP',   label: 'Total Phosphorus',  unit: 'mg/L',  dec: 2 },
    { key: 'DO',   label: 'Dissolved Oxygen',  unit: 'mg/L',  dec: 2 },
    { key: 'pH',   label: 'pH',                unit: '—',     dec: 2 },
    { key: 'temp', label: 'Temperature',       unit: '°C',    dec: 1 },
  ];

  return (
    <div className="min-h-screen bg-gray-50">
      {/* ── Topbar ────────────────────────────────────────────────────────── */}
      <header className="bg-blue-900 text-white px-4 md:px-6 py-3 flex items-center justify-between print:hidden sticky top-0 z-10 shadow-lg gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <button
            onClick={() => navigate(`/projects/${projectId}/flowsheets/${flowsheetId}`)}
            className="p-1.5 hover:bg-blue-800 rounded-lg transition-colors flex-shrink-0"
          >
            <ArrowLeft size={18} />
          </button>
          <div className="min-w-0">
            <p className="text-[10px] text-blue-300 uppercase tracking-widest">Simulation Report</p>
            <h1 className="font-bold text-sm leading-tight truncate">{data.flowsheet_name}</h1>
          </div>
        </div>

        <div className="flex items-center gap-2 flex-shrink-0">
          {pdfError && (
            <span className="text-red-300 text-xs hidden sm:flex items-center gap-1">
              <AlertTriangle size={12} /> {pdfError}
            </span>
          )}
          <button
            onClick={handleExcel}
            disabled={xlsxLoading}
            className="flex items-center gap-1.5 bg-emerald-600 text-white hover:bg-emerald-500 px-3 py-2 rounded-lg text-xs md:text-sm font-semibold transition-colors disabled:opacity-60"
          >
            {xlsxLoading ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
            <span className="hidden sm:inline">{xlsxLoading ? 'Exporting…' : 'Export Excel'}</span>
            <span className="sm:hidden">XLS</span>
          </button>
          <button
            onClick={handlePdf}
            disabled={pdfLoading}
            className="flex items-center gap-1.5 bg-white text-blue-900 hover:bg-blue-50 px-3 py-2 rounded-lg text-xs md:text-sm font-semibold transition-colors disabled:opacity-60"
          >
            {pdfLoading ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
            <span className="hidden sm:inline">{pdfLoading ? 'Generating PDF…' : 'Export PDF'}</span>
            <span className="sm:hidden">PDF</span>
          </button>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-3 md:px-4 py-4 md:py-6">

        {/* ── Cover info ──────────────────────────────────────────────────── */}
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-5 mb-6">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <h2 className="text-xl font-bold text-gray-900">{data.project_name}</h2>
              <p className="text-gray-500 text-sm">{data.flowsheet_name}</p>
              <div className="mt-2 flex flex-wrap gap-3 text-xs text-gray-400">
                <span>Run: <span className="font-mono text-gray-600">{data.run_id?.slice(0, 8)}</span></span>
                <span>Mode: <span className="text-gray-600">{data.mode?.replace('_', ' ')}</span></span>
                <span>By: <span className="text-gray-600">{data.created_by}</span></span>
                <span>Completed: <span className="text-gray-600">{data.completed_at?.slice(0, 19)} UTC</span></span>
              </div>
            </div>

            {/* Compliance banner */}
            <div className={`flex items-center gap-2 px-4 py-2.5 rounded-xl font-semibold text-sm
              ${compliant === true  ? 'bg-emerald-50 text-emerald-700 border border-emerald-200' :
                compliant === false ? 'bg-red-50 text-red-700 border border-red-200' :
                                      'bg-gray-50 text-gray-600 border border-gray-200'}`}>
              {compliant === true  ? <CheckCircle2 size={18} /> :
               compliant === false ? <XCircle size={18} /> :
                                     <AlertTriangle size={18} />}
              {compliant === true  ? 'All Permit Limits Met' :
               compliant === false ? `${violations.length} Violation${violations.length !== 1 ? 's' : ''}` :
               'Compliance Unknown'}
            </div>
          </div>

          {violations.length > 0 && (
            <div className="mt-4 p-3 bg-red-50 border border-red-100 rounded-lg">
              <p className="text-xs font-semibold text-red-700 mb-1.5 flex items-center gap-1">
                <AlertTriangle size={12} /> Permit Violations
              </p>
              {violations.map((v, i) => (
                <p key={i} className="text-xs text-red-600 mb-0.5">• {v}</p>
              ))}
            </div>
          )}
          {warnings.length > 0 && (
            <div className="mt-3 p-3 bg-amber-50 border border-amber-100 rounded-lg">
              <p className="text-xs font-semibold text-amber-700 mb-1.5 flex items-center gap-1">
                <AlertTriangle size={12} /> Simulation Warnings
              </p>
              {warnings.slice(0, 5).map((w, i) => (
                <p key={i} className="text-xs text-amber-700 mb-0.5">• {w}</p>
              ))}
            </div>
          )}
        </div>

        {/* ── KPI strip ────────────────────────────────────────────────────── */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2 md:gap-3 mb-4 md:mb-6">
          <KPI label="Influent flow"  value={fmt(inf.Q, 0)} sub="m³/d"   color="blue" />
          <KPI label="Effluent flow"  value={fmt(eff.Q, 0)} sub="m³/d"   color="cyan" />
          <KPI label="BOD removal"
               value={calcRemoval(inf.BOD, eff.BOD) != null ? `${calcRemoval(inf.BOD, eff.BOD).toFixed(1)}%` : '—'}
               color={calcRemoval(inf.BOD, eff.BOD) >= 90 ? 'green' : 'amber'} />
          <KPI label="TN removal"
               value={calcRemoval(inf.TN, eff.TN) != null ? `${calcRemoval(inf.TN, eff.TN).toFixed(1)}%` : '—'}
               color={calcRemoval(inf.TN, eff.TN) >= 70 ? 'green' : 'amber'} />
          {cost ? (
            <KPI label="Unit cost"
                 value={fmt(cost.cost_per_m3_treated_USD, 3)}
                 sub="USD / m³"
                 color="violet" />
          ) : (
            <KPI label="Nodes solved" value={summary.solvedNodes ?? '—'} color="blue" />
          )}
        </div>

        {/* ── Influent & Effluent Quality ────────────────────────────────── */}
        <Section icon={Beaker} title="Influent & Effluent Quality" accent="blue">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-blue-900 text-white">
                  {['Parameter', 'Unit', 'Influent', 'Effluent', 'Removal', 'Permit Limit', 'Status'].map(h => (
                    <th key={h} className="py-2 px-3 text-xs font-semibold uppercase tracking-wide text-left">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {QUALITY_PARAMS.map(p => (
                  <QualityRow
                    key={p.key}
                    param={p.label}
                    unit={p.unit}
                    inf={inf[p.key]}
                    eff={eff[p.key]}
                    limit={limits[p.key]}
                    dec={p.dec}
                  />
                ))}
              </tbody>
            </table>
          </div>
        </Section>

        {/* ── Cost Breakdown ────────────────────────────────────────────────── */}
        {cost && (
          <Section icon={DollarSign} title="Annual Operating Cost Estimate" accent="violet">
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <div>
                {[
                  { label: 'Energy',      value: cost.energy?.cost_USD_yr,         color: 'bg-blue-500' },
                  { label: 'Chemicals',   value: cost.chemicals?.total_USD_yr,      color: 'bg-cyan-500' },
                  { label: 'Sludge',      value: cost.sludge?.cost_USD_yr,          color: 'bg-green-500' },
                  { label: 'Labour',      value: cost.labour?.cost_USD_yr,          color: 'bg-violet-500' },
                  { label: 'Maintenance', value: cost.maintenance?.cost_USD_yr,     color: 'bg-amber-500' },
                ].map(c => (
                  <CostBar key={c.label} {...c} total={cost.total_USD_yr} />
                ))}
              </div>
              <div className="space-y-3">
                <div className="bg-blue-900 text-white rounded-lg p-4">
                  <p className="text-xs text-blue-300 mb-1">TOTAL ANNUAL OPEX</p>
                  <p className="text-2xl font-bold">{fmt(cost.total_USD_yr, 0, 'USD')}</p>
                  <p className="text-xs text-blue-300 mt-1">per year</p>
                </div>
                <div className="bg-gray-50 rounded-lg p-3 grid grid-cols-2 gap-2 text-xs">
                  <div>
                    <p className="text-gray-500">Unit cost</p>
                    <p className="font-semibold text-gray-800">{fmt(cost.cost_per_m3_treated_USD, 3)} USD/m³</p>
                  </div>
                  <div>
                    <p className="text-gray-500">Energy</p>
                    <p className="font-semibold text-gray-800">{fmt(cost.energy?.total_kWh_yr, 0)} kWh/yr</p>
                  </div>
                  <div>
                    <p className="text-gray-500">Staff</p>
                    <p className="font-semibold text-gray-800">{cost.labour?.staff_count ?? '—'} FTE</p>
                  </div>
                  <div>
                    <p className="text-gray-500">Dry sludge</p>
                    <p className="font-semibold text-gray-800">{fmt(cost.sludge?.dry_tonnes_yr, 0)} t/yr</p>
                  </div>
                </div>
              </div>
            </div>
          </Section>
        )}

        {/* ── Unit Operation Metrics ─────────────────────────────────────── */}
        {!isDynamic && Object.keys(units_res).length > 0 && (
          <Section icon={Gauge} title="Unit Operation Performance" accent="cyan" collapsible>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {Object.entries(units_res).map(([nodeId, ur]) => {
                const metrics = ur.metrics || {};
                const opType  = (ur.paletteType || ur.type || 'unknown').replace(/_/g, ' ');
                if (!Object.keys(metrics).length) return null;
                return (
                  <div key={nodeId} className="border border-gray-200 rounded-lg overflow-hidden">
                    <div className="bg-cyan-50 border-b border-cyan-100 px-3 py-2">
                      <p className="text-xs font-semibold text-cyan-800 capitalize">{opType}</p>
                      <p className="text-[10px] text-cyan-600 font-mono">{nodeId}</p>
                    </div>
                    <table className="w-full text-xs">
                      <tbody>
                        {Object.entries(metrics).map(([k, v], i) => (
                          <tr key={k} className={i % 2 === 0 ? 'bg-white' : 'bg-gray-50'}>
                            <td className="py-1.5 px-3 text-gray-600 capitalize">{k.replace(/_/g, ' ')}</td>
                            <td className="py-1.5 px-3 text-right font-mono text-gray-800">{fmt(v)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                );
              })}
            </div>
          </Section>
        )}

        {/* ── Dynamic steps summary ─────────────────────────────────────── */}
        {isDynamic && results.steps?.length > 0 && (
          <Section icon={Activity} title="Dynamic Simulation — Hourly Profile" accent="cyan" collapsible>
            <p className="text-sm text-gray-600 mb-3">
              {results.stepCount ?? results.steps.length} time steps simulated
              {results.profileUsed ? ` (profile: ${results.profileUsed})` : ''}.
            </p>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-cyan-700 text-white">
                    {['Hour', 'Inf. Q', 'Inf. BOD', 'Inf. TN', 'Eff. BOD', 'Eff. TN', 'Eff. NH4'].map(h => (
                      <th key={h} className="py-2 px-2 text-center font-semibold">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {results.steps.slice(0, 24).map((step, i) => (
                    <tr key={i} className={i % 2 === 0 ? 'bg-white' : 'bg-gray-50'}>
                      <td className="py-1.5 px-2 text-center font-mono text-gray-600">{step.hour ?? i}</td>
                      {[
                        step.summary?.influent?.Q,   step.summary?.influent?.BOD,
                        step.summary?.influent?.TN,  step.summary?.effluent?.BOD,
                        step.summary?.effluent?.TN,  step.summary?.effluent?.NH4,
                      ].map((v, j) => (
                        <td key={j} className="py-1.5 px-2 text-center font-mono text-gray-700">{fmt(v, 1)}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Section>
        )}

        {/* ── Process Streams ──────────────────────────────────────────────── */}
        {Object.keys(streams).length > 0 && (
          <Section icon={Layers} title="Process Stream Results" accent="green" collapsible>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-green-800 text-white">
                    {['Stream / Edge', 'Q (m³/d)', 'BOD (mg/L)', 'TSS (mg/L)', 'TN (mg/L)', 'NH4', 'NO3', 'TP'].map(h => (
                      <th key={h} className="py-2 px-2 text-center font-semibold whitespace-nowrap">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(streams).map(([eid, s], i) => (
                    <tr key={eid} className={i % 2 === 0 ? 'bg-white' : 'bg-gray-50'}>
                      <td className="py-1.5 px-2 font-mono text-gray-600 text-[10px]">{eid.slice(0, 28)}</td>
                      {['Q','BOD','TSS','TN','NH4','NO3','TP'].map(k => (
                        <td key={k} className="py-1.5 px-2 text-center font-mono text-gray-700">{fmt(s[k], 1)}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Section>
        )}

        {/* ── Configuration Appendix ───────────────────────────────────────── */}
        <Section icon={FileText} title="Simulation Configuration" accent="amber" collapsible>
          {config.nodeParams && Object.keys(config.nodeParams).length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-amber-700 text-white">
                    {['Node ID', 'Parameter', 'Value'].map(h => (
                      <th key={h} className="py-2 px-3 text-left font-semibold">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(config.nodeParams).flatMap(([nid, params], gi) =>
                    typeof params === 'object'
                      ? Object.entries(params).map(([pk, pv], i) => (
                          <tr key={`${nid}-${pk}`} className={(gi + i) % 2 === 0 ? 'bg-white' : 'bg-gray-50'}>
                            <td className="py-1.5 px-3 font-mono text-gray-500">{nid}</td>
                            <td className="py-1.5 px-3 text-gray-700">{pk.replace(/_/g, ' ')}</td>
                            <td className="py-1.5 px-3 font-mono text-gray-800">{String(pv)}</td>
                          </tr>
                        ))
                      : []
                  )}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="text-sm text-gray-500">Default parameters used for all nodes.</p>
          )}
          <p className="text-[10px] text-gray-400 mt-4 border-t border-gray-100 pt-3">
            This report is generated automatically by WaterSim Pro. Results should be reviewed by a
            qualified engineer before use in design or regulatory submissions.
          </p>
        </Section>

      </main>
    </div>
  );
}
