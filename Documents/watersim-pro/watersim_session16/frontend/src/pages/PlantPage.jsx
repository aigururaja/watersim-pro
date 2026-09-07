/**
 * WaterSim Pro — PlantPage
 *
 * The ITC sewage treatment plant, as the proposal defines it and as the app
 * reads it back. Route: /plant
 *
 * Six tabs, each answering one question a person actually arrives with:
 *
 *   Overview    what is this plant, and what did the proposal promise?
 *   Flow        what does it look like, and what is in each stream?
 *   I/O         what has to be wired, and does it fit the panels quoted?
 *   Sequences   what does the control narrative say, and does it add up?
 *   Commercial  what does each option cost, and does the arithmetic hold?
 *   Review      everywhere the proposal disagrees with itself
 *
 * The Review tab is the point of the page. Everything else is reference; the
 * review is the work. It is therefore the tab a high-severity count links to,
 * and the one the header badge advertises.
 *
 * Five of the six read one cached API call each from /plant/*, which serves a
 * static transcription — no organisation scope, no database. The flow diagram is
 * fetched separately and on demand, because drawing it runs the solver.
 */
import { useState, useEffect, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Factory, Cable, ListOrdered, IndianRupee, AlertTriangle, Loader2,
  Download, ChevronRight, AlertCircle, Info, ArrowRight, RefreshCw, Network, Workflow,
} from 'lucide-react';
import AppLayout from '../components/layout/AppLayout';
import EmptyState from '../components/EmptyState';
import api from '../services/api';
import { downloadFile } from '../utils/download';

// ── Formatting ────────────────────────────────────────────────────────────────

/** Indian digit grouping, matching the backend's `formatINR`. */
function inr(amount) {
  if (amount == null || !Number.isFinite(Number(amount))) return '—';
  const n = Math.round(Number(amount));
  const sign = n < 0 ? '-' : '';
  const s = String(Math.abs(n));
  if (s.length <= 3) return `${sign}₹${s}`;
  return `${sign}₹${s.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${s.slice(-3)}`;
}

const num = (v) => (v == null || !Number.isFinite(Number(v)) ? '—' : Number(v).toLocaleString('en-IN'));

const SEVERITY = {
  high: { label: 'High', chip: 'text-red-700 bg-red-50 border-red-200', dot: '#DC2626' },
  medium: { label: 'Medium', chip: 'text-amber-700 bg-amber-50 border-amber-200', dot: '#D97706' },
  low: { label: 'Low', chip: 'text-gray-600 bg-gray-50 border-gray-200', dot: '#6B7280' },
};

const TABS = [
  { id: 'overview', label: 'Overview', icon: Factory },
  { id: 'flow', label: 'Flow diagram', icon: Network },
  { id: 'io', label: 'I/O schedule', icon: Cable },
  { id: 'sequences', label: 'Sequences', icon: ListOrdered },
  { id: 'commercial', label: 'Commercial', icon: IndianRupee },
  { id: 'review', label: 'Review', icon: AlertTriangle },
];

// ── Small shared pieces ───────────────────────────────────────────────────────

function SeverityChip({ severity }) {
  const s = SEVERITY[severity] || SEVERITY.low;
  return (
    <span
      data-severity={severity}
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium border ${s.chip}`}
    >
      <span className="w-1.5 h-1.5 rounded-full" style={{ background: s.dot }} aria-hidden="true" />
      {s.label}
    </span>
  );
}

function Stat({ label, value, sub, tone }) {
  return (
    <div className="bg-white border border-gray-200 rounded-lg p-4">
      <div className="text-xs uppercase tracking-wide text-gray-500 font-semibold">{label}</div>
      <div
        className="mt-1 text-2xl font-bold tabular-nums"
        style={{ color: tone || '#1F4E79' }}
      >{value}</div>
      {sub && <div className="mt-0.5 text-xs text-gray-500">{sub}</div>}
    </div>
  );
}

function Section({ title, hint, children, right }) {
  return (
    <section className="mb-8">
      <div className="flex items-start justify-between gap-4 mb-2">
        <div>
          <h2 className="text-sm font-bold text-gray-900 uppercase tracking-wide">{title}</h2>
          {hint && <p className="text-xs text-gray-500 mt-0.5 max-w-3xl">{hint}</p>}
        </div>
        {right}
      </div>
      {children}
    </section>
  );
}

/**
 * A count that disagrees with another count. The whole page is about these, so
 * they get one consistent treatment: the derived figure first, the stated one
 * beside it, and a visible mark when they differ.
 */
function Delta({ derived, stated }) {
  const differs = derived !== stated;
  return (
    <span className={`tabular-nums ${differs ? 'text-red-700 font-semibold' : 'text-gray-700'}`}>
      {num(derived)}
      {differs && <span className="text-gray-400 font-normal"> vs {num(stated)}</span>}
    </span>
  );
}

// ── Tab: Overview ─────────────────────────────────────────────────────────────

function OverviewTab({ plant, onGoToReview }) {
  const { identity, io, reviewSummary, reuseCriteria, processes } = plant;
  return (
    <>
      <Section
        title="The plant"
        hint={`Transcribed from ${identity.sourceDocument}. Everything on this page is read from that document or derived from it — nothing is invented.`}
      >
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Stat label="Design flow" value={`${identity.designFlowKld} KLD`} sub="100 kitchen + 475 sewage + 100 laundry" />
          <Stat label="Process areas" value={identity.processCount} sub="Slides 4–15" />
          <Stat label="Wired signals" value={num(io.totals.derived.DI + io.totals.derived.DO + io.totals.derived.AI)}
                sub={`${io.totals.derived.DI} DI · ${io.totals.derived.DO} DO · ${io.totals.derived.AI} AI`} />
          <Stat
            label="Review findings"
            value={reviewSummary.total}
            sub={`${reviewSummary.bySeverity.high} high severity`}
            tone={reviewSummary.bySeverity.high > 0 ? '#DC2626' : '#1F4E79'}
          />
        </div>

        {reviewSummary.bySeverity.high > 0 && (
          <button
            onClick={onGoToReview}
            className="mt-3 w-full flex items-center gap-2 text-left px-4 py-3 rounded-lg border border-red-200 bg-red-50 hover:bg-red-100 transition"
          >
            <AlertCircle className="w-4 h-4 text-red-600 flex-shrink-0" aria-hidden="true" />
            <span className="text-sm text-red-800">
              <strong>{reviewSummary.bySeverity.high} high-severity findings</strong> — places the proposal
              disagrees with itself on I/O counts, device quantities or price.
            </span>
            <ArrowRight className="w-4 h-4 text-red-600 ml-auto flex-shrink-0" aria-hidden="true" />
          </button>
        )}
      </Section>

      <Section
        title="Treated water criteria"
        hint="The proposal states no effluent quality requirement anywhere. These limits are a template so the plant can be graded at all — they are not a permit."
      >
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-4">
          <div className="flex items-start gap-2">
            <Info className="w-4 h-4 text-amber-600 mt-0.5 flex-shrink-0" aria-hidden="true" />
            <div className="text-sm text-amber-900">
              <p className="font-semibold">{reuseCriteria.name}</p>
              <p className="mt-1 text-amber-800">{reuseCriteria.basis}</p>
              <p className="mt-2 font-mono text-xs">
                {Object.entries(reuseCriteria.limits)
                  .filter(([, v]) => v != null)
                  .map(([k, v]) => `${k} ${v}`)
                  .join('  ·  ')}
              </p>
            </div>
          </div>
        </div>
      </Section>

      <Section title="Process areas" hint="Each row is one slide of the proposal, with the I/O that slide printed against the I/O the devices it lists actually need.">
        <div className="overflow-x-auto border border-gray-200 rounded-lg bg-white">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-gray-600">
              <tr>
                <th className="text-left px-3 py-2 font-semibold">#</th>
                <th className="text-left px-3 py-2 font-semibold">Process</th>
                <th className="text-left px-3 py-2 font-semibold">System</th>
                <th className="text-right px-3 py-2 font-semibold">Devices</th>
                <th className="text-right px-3 py-2 font-semibold">DI</th>
                <th className="text-right px-3 py-2 font-semibold">DO</th>
                <th className="text-right px-3 py-2 font-semibold">AI</th>
              </tr>
            </thead>
            <tbody>
              {processes.map((p) => (
                <tr key={p.id} className="border-t border-gray-100 hover:bg-gray-50">
                  <td className="px-3 py-2 text-gray-500 tabular-nums">{p.no}</td>
                  <td className="px-3 py-2 font-medium text-gray-900">{p.name}</td>
                  <td className="px-3 py-2 text-gray-600">{p.system}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-gray-700">{p.deviceCount}</td>
                  <td className="px-3 py-2 text-right"><Delta derived={p.totals.derived.DI} stated={p.totals.printed.DI} /></td>
                  <td className="px-3 py-2 text-right"><Delta derived={p.totals.derived.DO} stated={p.totals.printed.DO} /></td>
                  <td className="px-3 py-2 text-right"><Delta derived={p.totals.derived.AI} stated={p.totals.printed.AI} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-xs text-gray-500">
          Where two numbers appear, the first is what the listed devices need and the second is what
          the slide printed. Red means they differ.
        </p>
      </Section>
    </>
  );
}

// ── Tab: Flow diagram ─────────────────────────────────────────────────────────

/**
 * The generated PFD sheet.
 *
 * The SVG is rendered through a blob URL in an <img>, not injected as markup.
 * The sheet is generated by our own backend from our own data and every value is
 * escaped on the way out, but an <img> cannot execute script at all, so the
 * question does not arise — and a PFD needs no interactivity beyond scrolling.
 */
function FlowTab({ diagram, detail, onDetail, onDownload, downloading, loading }) {
  const [svgUrl, setSvgUrl] = useState(null);
  const [service, setService] = useState('');

  useEffect(() => {
    if (!diagram?.svg) return undefined;
    const url = URL.createObjectURL(new Blob([diagram.svg], { type: 'image/svg+xml' }));
    setSvgUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [diagram?.svg]);

  const model = diagram?.model;
  const rows = useMemo(
    () => (diagram?.streamTable || []).filter((r) => !service || r.service === service),
    [diagram?.streamTable, service]
  );
  const services = useMemo(
    () => [...new Set((diagram?.streamTable || []).map((r) => r.service))].sort(),
    [diagram?.streamTable]
  );

  return (
    <>
      <Section
        title="Process flow diagram"
        hint={
          model
            ? `${model.blocks.length} unit operations, ${model.streams.length} streams, generated from ${model.generatedFrom}. `
              + (detail === 'pfd'
                ? 'Valves and instruments are summarised on the line they sit on — they belong on the P&ID, and the I/O schedule already specifies all 339 of them.'
                : 'Full detail: every node on the flowsheet, including valve groups and transmitters.')
            : 'Generated from the flowsheet — the drawing cannot say anything the plant model does not.'
        }
        right={
          <div className="flex items-center gap-2">
            <div className="flex rounded-md border border-gray-300 overflow-hidden">
              {[['pfd', 'PFD'], ['full', 'Full']].map(([id, label]) => (
                <button
                  key={id}
                  onClick={() => onDetail(id)}
                  aria-pressed={detail === id}
                  className={`px-2.5 py-1.5 text-xs font-semibold transition ${
                    detail === id ? 'bg-brand-700 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'
                  }`}
                >{label}</button>
              ))}
            </div>
            <button
              onClick={onDownload}
              disabled={downloading}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-md border border-gray-300 bg-white hover:bg-gray-50 disabled:opacity-50"
            >
              {downloading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
              Download SVG
            </button>
          </div>
        }
      >
        <div className="border border-gray-200 rounded-lg bg-white overflow-x-auto">
          {loading && (
            <div className="flex items-center justify-center py-20 text-gray-500">
              <Loader2 className="w-5 h-5 animate-spin mr-2" aria-hidden="true" />
              <span role="status">Solving the plant and drawing the sheet…</span>
            </div>
          )}
          {!loading && svgUrl && (
            <img
              src={svgUrl}
              alt={`Process flow diagram of the ITC sewage treatment plant: ${model?.blocks.length} unit operations and ${model?.streams.length} numbered streams`}
              style={{ maxWidth: 'none', display: 'block' }}
            />
          )}
        </div>
        {model?.assumptions?.length > 0 && (
          <details className="mt-3 bg-amber-50 border border-amber-200 rounded-lg">
            <summary className="px-4 py-2.5 cursor-pointer text-sm font-semibold text-amber-900">
              {model.assumptions.length} blocks carry an assumed parameter, not a stated duty
            </summary>
            <ul className="px-4 pb-3 space-y-1.5">
              {model.assumptions.map((a) => (
                <li key={a.tag} className="text-xs text-amber-900">
                  <span className="font-mono font-semibold">{a.tag}</span> — {a.text}
                </li>
              ))}
            </ul>
          </details>
        )}
      </Section>

      <Section
        title={`Stream table — ${rows.length} of ${diagram?.streamTable?.length || 0}`}
        hint="Keyed to the circled numbers on the sheet. Flows and qualities are the steady-state solution, not nameplate figures."
      >
        <div className="flex flex-wrap gap-2 mb-3">
          <select
            value={service}
            onChange={(e) => setService(e.target.value)}
            aria-label="Filter by service"
            className="text-xs border border-gray-300 rounded-md px-2 py-1.5 bg-white"
          >
            <option value="">All services</option>
            {services.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
        <div className="overflow-x-auto border border-gray-200 rounded-lg bg-white max-h-[30rem] overflow-y-auto">
          <table className="w-full text-xs">
            <thead className="bg-gray-50 text-gray-600 sticky top-0">
              <tr>
                <th className="text-right px-3 py-2 font-semibold">#</th>
                <th className="text-left px-3 py-2 font-semibold">From</th>
                <th className="text-left px-3 py-2 font-semibold">To</th>
                <th className="text-left px-3 py-2 font-semibold">Service</th>
                <th className="text-right px-3 py-2 font-semibold">Size</th>
                <th className="text-right px-3 py-2 font-semibold">m³/d</th>
                <th className="text-right px-3 py-2 font-semibold">TSS</th>
                <th className="text-right px-3 py-2 font-semibold">BOD</th>
                <th className="text-right px-3 py-2 font-semibold">TN</th>
                <th className="text-right px-3 py-2 font-semibold">TP</th>
                <th className="text-right px-3 py-2 font-semibold">pH</th>
                <th className="text-left px-3 py-2 font-semibold">In line</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.no} className="border-t border-gray-100 hover:bg-gray-50">
                  <td className="px-3 py-1.5 text-right font-mono font-semibold text-gray-900">{r.no}</td>
                  <td className="px-3 py-1.5 font-mono text-gray-700">{r.from}</td>
                  <td className="px-3 py-1.5 font-mono text-gray-700">{r.to}</td>
                  <td className="px-3 py-1.5 text-gray-600">{r.service}</td>
                  <td className="px-3 py-1.5 text-right text-gray-500">{r.size}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums font-semibold">{r.Q_m3_d ?? '—'}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums text-gray-600">{r.TSS ?? '—'}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums text-gray-600">{r.BOD ?? '—'}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums text-gray-600">{r.TN ?? '—'}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums text-gray-600">{r.TP ?? '—'}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums text-gray-600">{r.pH ?? '—'}</td>
                  <td className="px-3 py-1.5 text-gray-500">{r.inlineEquipment}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>
    </>
  );
}

// ── Tab: I/O schedule ─────────────────────────────────────────────────────────

function IoTab({ io, onExport, exporting }) {
  const [type, setType] = useState('');
  const [area, setArea] = useState('');

  const areas = useMemo(
    () => [...new Set(io.rows.map((r) => r.area))].sort(),
    [io.rows]
  );
  const rows = useMemo(
    () => io.rows.filter((r) => (!type || r.type === type) && (!area || r.area === area)),
    [io.rows, type, area]
  );

  return (
    <>
      <Section
        title="Panel capacity"
        hint="The quoted architecture is four nodes at DI 240 / DO 160 / AI 24. These are the same points counted four different ways — by the devices listed, by each process slide, by the summary list, and by what the panels hold."
      >
        <div className="overflow-x-auto border border-gray-200 rounded-lg bg-white">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-gray-600">
              <tr>
                <th className="text-left px-3 py-2 font-semibold">Signal</th>
                <th className="text-right px-3 py-2 font-semibold">Devices need</th>
                <th className="text-right px-3 py-2 font-semibold">Slides 4–14</th>
                <th className="text-right px-3 py-2 font-semibold">Slide 15</th>
                <th className="text-right px-3 py-2 font-semibold">Panel capacity</th>
                <th className="text-right px-3 py-2 font-semibold">Spare</th>
              </tr>
            </thead>
            <tbody>
              {io.capacityHeadroom.map((r) => (
                <tr key={r.type} className="border-t border-gray-100">
                  <td className="px-3 py-2 font-mono font-semibold text-gray-900">{r.type}</td>
                  <td className="px-3 py-2 text-right tabular-nums font-semibold">{num(r.derived)}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-gray-600">{num(r.printed)}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-gray-600">{num(r.summary)}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-gray-600">{num(r.capacity)}</td>
                  <td className={`px-3 py-2 text-right tabular-nums font-semibold ${r.spareAgainstDerived < 0 ? 'text-red-700' : 'text-green-700'}`}>
                    {r.spareAgainstDerived >= 0 ? `+${r.spareAgainstDerived}` : r.spareAgainstDerived}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      <Section title="Load per PLC node" hint="How the signals divide across the four panels the architecture names.">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
          {io.nodeLoading.map((n) => (
            <div key={n.node} className="bg-white border border-gray-200 rounded-lg p-4">
              <div className="text-xs font-semibold text-brand-700">{n.node}</div>
              <div className="mt-2 flex gap-3 text-sm tabular-nums">
                <span><span className="text-gray-500">DI</span> <strong>{n.DI}</strong></span>
                <span><span className="text-gray-500">DO</span> <strong>{n.DO}</strong></span>
                <span><span className="text-gray-500">AI</span> <strong>{n.AI}</strong></span>
              </div>
              <div className="mt-2 text-xs text-gray-500">{n.areas.join(' · ')}</div>
            </div>
          ))}
        </div>
      </Section>

      <Section
        title={`Tag list — ${rows.length} of ${io.total} signals`}
        hint="One row per wired point. This is the list a panel builder works from."
        right={
          <button
            onClick={onExport}
            disabled={exporting}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-md border border-gray-300 bg-white hover:bg-gray-50 disabled:opacity-50"
          >
            {exporting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
            Export CSV
          </button>
        }
      >
        <div className="flex flex-wrap gap-2 mb-3">
          <select
            value={type} onChange={(e) => setType(e.target.value)}
            aria-label="Filter by signal type"
            className="text-xs border border-gray-300 rounded-md px-2 py-1.5 bg-white"
          >
            <option value="">All signal types</option>
            {['DI', 'DO', 'AI'].map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
          <select
            value={area} onChange={(e) => setArea(e.target.value)}
            aria-label="Filter by area"
            className="text-xs border border-gray-300 rounded-md px-2 py-1.5 bg-white"
          >
            <option value="">All areas</option>
            {areas.map((a) => <option key={a} value={a}>{a}</option>)}
          </select>
        </div>

        <div className="overflow-x-auto border border-gray-200 rounded-lg bg-white max-h-[32rem] overflow-y-auto">
          <table className="w-full text-xs">
            <thead className="bg-gray-50 text-gray-600 sticky top-0">
              <tr>
                <th className="text-left px-3 py-2 font-semibold">Tag</th>
                <th className="text-left px-3 py-2 font-semibold">Type</th>
                <th className="text-left px-3 py-2 font-semibold">Signal</th>
                <th className="text-left px-3 py-2 font-semibold">Device</th>
                <th className="text-left px-3 py-2 font-semibold">Area</th>
                <th className="text-left px-3 py-2 font-semibold">Node</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.tag} className="border-t border-gray-100 hover:bg-gray-50">
                  <td className="px-3 py-1.5 font-mono text-gray-900">{r.tag}</td>
                  <td className="px-3 py-1.5 font-mono text-gray-500">{r.type}</td>
                  <td className="px-3 py-1.5 text-gray-700">{r.signal}</td>
                  <td className="px-3 py-1.5 text-gray-600">{r.device}</td>
                  <td className="px-3 py-1.5 font-mono text-gray-500">{r.area}</td>
                  <td className="px-3 py-1.5 text-gray-500">{r.node.replace(/^Node \d+ — /, '')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>
    </>
  );
}

// ── Tab: Sequences ────────────────────────────────────────────────────────────

function SequencesTab({ narrative }) {
  const { sections, cycleAnalysis } = narrative;
  const sbr = cycleAnalysis.sbr;
  const uf = cycleAnalysis.uf;

  return (
    <>
      <Section
        title="SBR cycle"
        hint="The proposal states the phase durations and the pump duty but never multiplies them out. This is what they deliver."
      >
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-3">
          <Stat label="Cycle time" value={`${sbr.cycleHours} h`} sub={`${sbr.cyclesPerDay} cycles/day per reactor`} />
          <Stat label="Volume per fill" value={`${sbr.volumePerFill_m3} m³`} sub={`${sbr.feedPump_m3_h} m³/hr × ${sbr.fillHours} h`} />
          <Stat label="Plant capacity" value={`${sbr.throughput_m3_d} m³/d`} sub={`${sbr.reactors} reactors`}
                tone={sbr.meetsDesignFlow ? '#15803D' : '#DC2626'} />
          <Stat label="Design flow" value={`${cycleAnalysis.designFlow_m3_d} m³/d`}
                sub={sbr.meetsDesignFlow ? 'Within capacity' : `Short by ${sbr.shortfall_m3_d} m³/d`}
                tone={sbr.meetsDesignFlow ? '#15803D' : '#DC2626'} />
        </div>

        {/* The cycle, in proportion — the same encoding the canvas symbol uses. */}
        <div className="bg-white border border-gray-200 rounded-lg p-4">
          <div className="flex h-8 rounded overflow-hidden border border-gray-200">
            {sbr.phases.map((p) => (
              <div
                key={p.key}
                className="flex items-center justify-center text-[10px] font-semibold text-white"
                style={{
                  width: `${p.sharePct}%`,
                  background: { fill: '#2E75B6', aerate: '#0891B2', settle: '#94A3B8', decant: '#0D9488' }[p.key],
                }}
                title={`${p.label} — ${p.hours} h (${p.source})`}
              >
                {p.sharePct > 12 ? `${p.label} ${p.hours}h` : ''}
              </div>
            ))}
          </div>
          {!sbr.meetsDesignFlow && (
            <p className="mt-3 text-sm text-red-800 bg-red-50 border border-red-200 rounded p-3">
              To pass {cycleAnalysis.designFlow_m3_d} m³/d the fill must extend to{' '}
              <strong>{sbr.requiredFillHours} h</strong>, or the feed pump rise to{' '}
              <strong>{sbr.requiredFeedPump_m3_h} m³/hr</strong>. Otherwise the equalisation tank
              accumulates {sbr.shortfall_m3_d} m³ every day.
            </p>
          )}
        </div>
      </Section>

      <Section title="Ultrafiltration cycle" hint="20 minutes of production then a 1-minute flush backwash, per narrative step VII.5.">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Stat label="Cycle" value={`${uf.cycleMinutes} min`} sub={`${uf.cyclesPerDay} cycles/day`} />
          <Stat label="Produced" value={`${uf.produced_m3_d} m³/d`} />
          <Stat label="Backwash" value={`${uf.backwash_m3_d} m³/d`} sub={`returns to ${uf.backwashReturnsTo}`} />
          <Stat label="Recovery" value={`${uf.recoveryPct} %`} sub={`${uf.netToFwt_m3_d} m³/d net`} />
        </div>
      </Section>

      <Section title="Control narrative" hint="The proposal's own wording, with the devices each step drives and the timings it states.">
        <div className="space-y-3">
          {sections.map((s) => (
            <details key={s.id} className="bg-white border border-gray-200 rounded-lg">
              <summary className="px-4 py-3 cursor-pointer flex items-center gap-2 text-sm font-semibold text-gray-900 hover:bg-gray-50">
                <ChevronRight className="w-4 h-4 text-gray-400 flex-shrink-0" aria-hidden="true" />
                <span className="font-mono text-brand-700">{s.numeral}</span>
                {s.title}
                <span className="ml-auto text-xs font-normal text-gray-500">
                  {s.steps.length} steps · slide {s.slide}
                  {s.totalHours > 0 && ` · ${s.totalHours} h`}
                </span>
              </summary>
              <ol className="border-t border-gray-100">
                {s.steps.map((step) => (
                  <li key={step.no} className="px-4 py-2.5 border-b border-gray-50 last:border-0 flex gap-3">
                    <span className="text-xs font-mono text-gray-400 pt-0.5 w-6 flex-shrink-0">{step.no}</span>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm text-gray-800">{step.text}</p>
                      <div className="mt-1 flex flex-wrap gap-1.5 items-center">
                        {step.action && (
                          <span className="text-[10px] uppercase font-bold tracking-wide px-1.5 py-0.5 rounded bg-brand-50 text-brand-700 border border-brand-100">
                            {step.action}
                          </span>
                        )}
                        {step.durationH > 0 && (
                          <span className="text-[10px] font-mono text-gray-500">
                            {step.durationH >= 1 ? `${step.durationH} h` : `${Math.round(step.durationH * 3600)} s`}
                          </span>
                        )}
                        {(step.devices || []).map((d) => (
                          <span key={d} className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-gray-100 text-gray-600">{d}</span>
                        ))}
                        {step.interlock && (
                          <span className="text-[10px] text-gray-500 italic">releases on: {step.interlock}</span>
                        )}
                      </div>
                      {step.review && (
                        <p className="mt-1.5 text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded px-2 py-1.5">
                          {step.review}
                        </p>
                      )}
                      {step.note && <p className="mt-1 text-xs text-gray-500">{step.note}</p>}
                    </div>
                  </li>
                ))}
              </ol>
            </details>
          ))}
        </div>
      </Section>
    </>
  );
}

// ── Tab: Commercial ───────────────────────────────────────────────────────────

function CommercialTab({ costing }) {
  const quoted = costing.scenarios.filter((s) => s.quotedInProposal);
  const unquoted = costing.scenarios.filter((s) => !s.quotedInProposal);

  return (
    <>
      <Section
        title="Every option, priced from its line items"
        hint="Each total below is rebuilt from the monitoring, valve-control, pump-control and automation lines. Where it differs from the figure the proposal quotes, both are shown."
      >
        <div className="overflow-x-auto border border-gray-200 rounded-lg bg-white">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-gray-600">
              <tr>
                <th className="text-left px-3 py-2 font-semibold">Architecture</th>
                <th className="text-left px-3 py-2 font-semibold">Valve strategy</th>
                <th className="text-right px-3 py-2 font-semibold">From line items</th>
                <th className="text-right px-3 py-2 font-semibold">Quoted</th>
                <th className="text-right px-3 py-2 font-semibold">Difference</th>
              </tr>
            </thead>
            <tbody>
              {quoted.map((r) => (
                <tr key={`${r.optionId}-${r.valveOptionId}`} className="border-t border-gray-100 hover:bg-gray-50">
                  <td className="px-3 py-2 text-gray-900">{r.optionLabel}</td>
                  <td className="px-3 py-2 text-gray-600">{r.valveOptionLabel}</td>
                  <td className="px-3 py-2 text-right tabular-nums font-semibold">{inr(r.computedTotal)}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-gray-600">{inr(r.quotedTotal)}</td>
                  <td className={`px-3 py-2 text-right tabular-nums font-semibold ${r.variance ? 'text-red-700' : 'text-green-700'}`}>
                    {r.variance ? inr(r.variance) : 'reconciles'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      {unquoted.length > 0 && (
        <Section
          title="Priced but never offered"
          hint="The pneumatic actuator option is costed in full on slide 16 and then absent from the decision table on slide 20. These are what it would come to."
        >
          <div className="overflow-x-auto border border-amber-200 rounded-lg bg-amber-50">
            <table className="w-full text-sm">
              <tbody>
                {unquoted.map((r) => (
                  <tr key={`${r.optionId}-${r.valveOptionId}`} className="border-b border-amber-100 last:border-0">
                    <td className="px-3 py-2 text-amber-900">{r.optionLabel}</td>
                    <td className="px-3 py-2 text-amber-800">{r.valveOptionLabel}</td>
                    <td className="px-3 py-2 text-right tabular-nums font-semibold text-amber-900">{inr(r.computedTotal)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
      )}

      <Section title="Device quantities" hint="What the process slides list, against what the commercial tables are priced for.">
        <div className="overflow-x-auto border border-gray-200 rounded-lg bg-white">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-gray-600">
              <tr>
                <th className="text-left px-3 py-2 font-semibold">Family</th>
                <th className="text-right px-3 py-2 font-semibold">On the equipment list</th>
                <th className="text-right px-3 py-2 font-semibold">Priced</th>
                <th className="text-right px-3 py-2 font-semibold">Difference</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(costing.pricedQuantities).map(([family, priced]) => {
                const derived = costing.derivedQuantities[family] ?? 0;
                const diff = derived - priced;
                return (
                  <tr key={family} className="border-t border-gray-100">
                    <td className="px-3 py-2 capitalize text-gray-900">{family.replace(/_/g, ' ')}</td>
                    <td className="px-3 py-2 text-right tabular-nums font-semibold">{num(derived)}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-gray-600">{num(priced)}</td>
                    <td className={`px-3 py-2 text-right tabular-nums font-semibold ${diff ? 'text-red-700' : 'text-green-700'}`}>
                      {diff === 0 ? 'matches' : diff > 0 ? `+${diff} unpriced` : `${-diff} over-priced`}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Section>

      <Section title="Priced once, whichever option is chosen">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {costing.addOns.map((a) => (
            <div key={a.id} className="bg-white border border-gray-200 rounded-lg p-4">
              <div className="text-sm font-semibold text-gray-900">{a.label}</div>
              <div className="mt-1 text-xl font-bold text-brand-700 tabular-nums">{a.formatted}</div>
              <p className="mt-1 text-xs text-gray-500">{a.detail}</p>
            </div>
          ))}
        </div>
      </Section>
    </>
  );
}

// ── Tab: Review ───────────────────────────────────────────────────────────────

function ReviewTab({ review }) {
  const [severity, setSeverity] = useState('');
  const findings = review.findings.filter((f) => !severity || f.severity === severity);

  return (
    <>
      <Section
        title={`${review.summary.total} findings`}
        hint="Every place the proposal disagrees with itself, or assumes an instrument it never schedules. Each names the slide it came from, so it can be taken back to the author as a question rather than a complaint."
      >
        <div className="flex gap-2 mb-4">
          {['', 'high', 'medium'].map((s) => (
            <button
              key={s || 'all'}
              onClick={() => setSeverity(s)}
              className={`px-3 py-1.5 text-xs font-semibold rounded-md border transition ${
                severity === s ? 'bg-brand-700 text-white border-brand-700' : 'bg-white text-gray-600 border-gray-300 hover:bg-gray-50'
              }`}
            >
              {s ? `${SEVERITY[s].label} (${review.summary.bySeverity[s] || 0})` : `All (${review.summary.total})`}
            </button>
          ))}
        </div>

        <div className="space-y-3">
          {findings.map((f) => (
            <article key={f.id} className="bg-white border border-gray-200 rounded-lg p-4">
              <div className="flex items-start gap-3">
                <SeverityChip severity={f.severity} />
                <span className="text-xs font-mono px-1.5 py-0.5 rounded bg-gray-100 text-gray-600">{f.area}</span>
                <span className="ml-auto text-xs text-gray-400">{f.source}</span>
              </div>
              <h3 className="mt-2 text-sm font-semibold text-gray-900">{f.title}</h3>
              <dl className="mt-2 grid grid-cols-1 md:grid-cols-2 gap-2 text-xs">
                <div className="bg-gray-50 rounded p-2">
                  <dt className="font-semibold text-gray-500 uppercase tracking-wide">This app derives</dt>
                  <dd className="mt-0.5 text-gray-800">{String(f.derived)}</dd>
                </div>
                <div className="bg-gray-50 rounded p-2">
                  <dt className="font-semibold text-gray-500 uppercase tracking-wide">The proposal states</dt>
                  <dd className="mt-0.5 text-gray-800">{String(f.stated)}</dd>
                </div>
              </dl>
              <p className="mt-2 text-sm text-gray-700">{f.impact}</p>
            </article>
          ))}
        </div>
      </Section>
    </>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function PlantPage() {
  const [tab, setTab] = useState('overview');
  const [plant, setPlant] = useState(null);
  const [io, setIo] = useState(null);
  const [narrative, setNarrative] = useState(null);
  const [costing, setCosting] = useState(null);
  const [review, setReview] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [exporting, setExporting] = useState(false);
  // The diagram is fetched separately: it runs the solver, and the detail toggle
  // refetches it without disturbing the other four tabs.
  const [diagram, setDiagram] = useState(null);
  const [detail, setDetail] = useState('pfd');
  const [diagramLoading, setDiagramLoading] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [instantiating, setInstantiating] = useState(false);
  const navigate = useNavigate();

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // One round trip per tab's data, in parallel — the whole definition is
      // about 50 KB and static, so there is nothing to gain by lazy-loading it.
      const [p, i, n, c, r] = await Promise.all([
        api.get('/plant'),
        api.get('/plant/io-schedule'),
        api.get('/plant/narrative'),
        api.get('/plant/costing'),
        api.get('/plant/review'),
      ]);
      setPlant(p.data);
      setIo(i.data);
      setNarrative(n.data);
      setCosting(c.data);
      setReview(r.data);
    } catch (err) {
      setError(err?.response?.data?.error || err.message || 'Could not load the plant definition');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const loadDiagram = useCallback(async (which) => {
    setDiagramLoading(true);
    try {
      const [json, svg] = await Promise.all([
        api.get(`/plant/flow-diagram?detail=${which}`),
        api.get(`/plant/flow-diagram.svg?detail=${which}`, { responseType: 'text' }),
      ]);
      setDiagram({ ...json.data, svg: svg.data });
    } catch (err) {
      setError(err?.response?.data?.error || err.message || 'Could not draw the flow diagram');
    } finally {
      setDiagramLoading(false);
    }
  }, []);

  // Drawn on first visit to the tab, and again whenever the detail level changes.
  useEffect(() => {
    if (tab === 'flow') loadDiagram(detail);
  }, [tab, detail, loadDiagram]);

  const downloadSvg = useCallback(async () => {
    setDownloading(true);
    try {
      await downloadFile(
        `/plant/flow-diagram.svg?detail=${detail}&download=1`,
        'itc-stp-process-flow-diagram.svg'
      );
    } catch (err) {
      setError(err?.response?.data?.error || 'Could not download the diagram');
    } finally {
      setDownloading(false);
    }
  }, [detail]);

  const exportCsv = useCallback(async () => {
    setExporting(true);
    try {
      // downloadFile goes through the axios client so the Bearer token applies;
      // a bare <a href> would 401.
      await downloadFile('/plant/io-schedule.csv', 'itc-stp-io-schedule.csv');
    } catch (err) {
      setError(err?.response?.data?.error || 'CSV export failed');
    } finally {
      setExporting(false);
    }
  }, []);

  /**
   * Put the plant on a canvas in the user's OWN organisation.
   *
   * Until this existed the only route onto a canvas was `npm run db:seed`, which
   * builds its own organisation and is a developer command. This creates an
   * ordinary project and flowsheet from the same definition every tab above
   * reads, then goes straight there — from that point it is editable, simulable,
   * and a target for alarm rules and PLC bindings like any other sheet.
   */
  const openOnCanvas = useCallback(async () => {
    setInstantiating(true);
    try {
      const { data } = await api.post('/plant/instantiate');
      navigate(data.canvasUrl);
    } catch (err) {
      setError(
        err?.response?.status === 403
          ? 'Creating a flowsheet needs the engineer role.'
          : err?.response?.data?.error || 'Could not create the flowsheet'
      );
      setInstantiating(false);
    }
  }, [navigate]);

  const highCount = plant?.reviewSummary?.bySeverity?.high || 0;

  return (
    <AppLayout>
      <div className="p-4 md:p-6 max-w-7xl mx-auto">
        <header className="mb-5">
          <div className="flex items-start justify-between gap-4 flex-wrap">
            <div>
              <h1 className="text-xl font-bold text-gray-900 flex items-center gap-2">
                <Factory className="w-5 h-5 text-brand-700" aria-hidden="true" />
                {plant?.identity?.name || 'Plant definition'}
              </h1>
              <p className="text-sm text-gray-500 mt-0.5">
                {plant
                  ? `${plant.identity.client} · ${plant.identity.contractor} · ${plant.identity.subContractor}`
                  : 'Loading the plant definition…'}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={load}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-md border border-gray-300 bg-white hover:bg-gray-50"
              >
                <RefreshCw className="w-3.5 h-3.5" aria-hidden="true" />
                Reload
              </button>
              <button
                onClick={openOnCanvas}
                disabled={instantiating}
                title="Creates the plant as a project and flowsheet in your organisation, then opens it"
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-md bg-brand-700 text-white hover:bg-brand-800 disabled:opacity-60"
              >
                {instantiating
                  ? <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
                  : <Workflow className="w-3.5 h-3.5" aria-hidden="true" />}
                {instantiating ? 'Building the sheet…' : 'Open on the canvas'}
                {!instantiating && <ArrowRight className="w-3.5 h-3.5" aria-hidden="true" />}
              </button>
            </div>
          </div>

          <nav className="mt-4 flex gap-1 border-b border-gray-200 overflow-x-auto" aria-label="Plant sections">
            {TABS.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                onClick={() => setTab(id)}
                aria-current={tab === id ? 'page' : undefined}
                className={`inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium border-b-2 -mb-px whitespace-nowrap transition ${
                  tab === id
                    ? 'border-brand-700 text-brand-700'
                    : 'border-transparent text-gray-500 hover:text-gray-800'
                }`}
              >
                <Icon className="w-4 h-4" aria-hidden="true" />
                {label}
                {id === 'review' && highCount > 0 && (
                  <span className="ml-0.5 px-1.5 py-0.5 rounded-full text-[10px] font-bold bg-red-100 text-red-700">
                    {highCount}
                  </span>
                )}
              </button>
            ))}
          </nav>
        </header>

        {loading && (
          <div className="flex items-center justify-center py-20 text-gray-500">
            <Loader2 className="w-6 h-6 animate-spin mr-2" aria-hidden="true" />
            <span role="status">Loading the plant definition…</span>
          </div>
        )}

        {!loading && error && (
          <EmptyState
            icon={AlertCircle}
            title="Could not load the plant definition"
            description={error}
            action={{ label: 'Try again', onClick: load }}
          />
        )}

        {!loading && !error && plant && (
          <>
            {tab === 'overview' && <OverviewTab plant={plant} onGoToReview={() => setTab('review')} />}
            {tab === 'flow' && (
              <FlowTab
                diagram={diagram}
                detail={detail}
                onDetail={setDetail}
                onDownload={downloadSvg}
                downloading={downloading}
                loading={diagramLoading && !diagram}
              />
            )}
            {tab === 'io' && io && <IoTab io={io} onExport={exportCsv} exporting={exporting} />}
            {tab === 'sequences' && narrative && <SequencesTab narrative={narrative} />}
            {tab === 'commercial' && costing && <CommercialTab costing={costing} />}
            {tab === 'review' && review && <ReviewTab review={review} />}
          </>
        )}
      </div>
    </AppLayout>
  );
}
