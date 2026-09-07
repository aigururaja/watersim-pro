/**
 * WaterSim Pro — TwinPage
 * The digital twin: the model that runs beside the plant, on the server, and
 * says where they disagree.
 *
 * Route: /twin (list) · /twin/:flowsheetId (one twin)
 *
 *   Configuration   enabled, cadence, drift threshold; solve now.
 *   Residuals       per instrument: measured, modelled, residual, z — and the
 *                   last hours of them as a sparkline.
 *   What-if         a scenario seeded from the twin's live state; deltas
 *                   against the live baseline; never persisted as a run.
 *   Commissioning   PLC connections' live / shadow mode, and the narrative's
 *                   control sequences played against a shadow plant.
 *
 * Live updates (twin:state, twin:script, twin:mode) arrive on the org room.
 */
import { useState, useEffect, useCallback, useMemo } from 'react';
import { Link, useParams, useNavigate } from 'react-router-dom';
import {
  Boxes, RefreshCw, Loader2, Play, Square, ShieldAlert, ShieldCheck, Activity, FlaskConical, ListChecks, AlertTriangle, Check,
} from 'lucide-react';
import AppLayout from '../components/layout/AppLayout';
import EmptyState from '../components/EmptyState';
import Sparkline from '../components/live/Sparkline';
import api from '../services/api';
import { useAuth } from '../context/AuthContext';
import { useOrgLive } from '../hooks/useOrgLive';
import { relTime } from '../components/alarms/alarmState';

const fmt = (v, dp = 2) => (v == null || !Number.isFinite(Number(v)) ? '—' : Number(v).toLocaleString('en-IN', { maximumFractionDigits: dp }));
const zTone = (z, limit) => (z == null ? 'text-gray-400' : Math.abs(z) > limit ? 'text-red-700 font-semibold' : Math.abs(z) > limit * 0.66 ? 'text-amber-700' : 'text-emerald-700');

function TwinList({ twins, selected, onSelect }) {
  return (
    <aside className="card p-2 w-full lg:w-72 flex-shrink-0 space-y-1" aria-label="Twins">
      {twins.map((t) => (
        <button key={t.flowsheetId} onClick={() => onSelect(t.flowsheetId)}
          className={`w-full text-left px-3 py-2 rounded-lg text-sm ${selected === t.flowsheetId ? 'bg-brand-50 border border-brand-200' : 'hover:bg-gray-50 border border-transparent'}`}
          aria-label={t.flowsheetName} data-twin={t.flowsheetId}>
          <div className="flex items-center justify-between gap-2">
            <span className="font-medium text-gray-900 truncate">{t.flowsheetName}</span>
            <span className={`w-2 h-2 rounded-full flex-shrink-0 ${t.config.enabled ? (t.state?.error ? 'bg-red-500' : 'bg-emerald-500') : 'bg-gray-300'}`} title={t.config.enabled ? 'running' : 'off'} />
          </div>
          <div className="text-[11px] text-gray-500 truncate">{t.projectName}</div>
          <div className="text-[10px] text-gray-400 mt-0.5">
            {t.boundPoints} bound · {t.state?.solvedAt ? `solved ${relTime(t.state.solvedAt)}` : 'never solved'}{t.driftAlarms ? ` · ${t.driftAlarms} drift` : ''}
          </div>
        </button>
      ))}
      {!twins.length && (
        <div className="text-xs text-gray-400 p-3">
          No twins yet. <Link to="/projects" className="text-brand-700 hover:underline">Import the plant you monitor</Link> or create a model under Projects.
        </div>
      )}
    </aside>
  );
}

export default function TwinPage() {
  const { flowsheetId } = useParams();
  const navigate = useNavigate();
  const { can } = useAuth();
  const canConfigure = typeof can === 'function' && can('twin.configure');
  const canCommission = typeof can === 'function' && can('twin.commission');
  const canLeaveShadow = typeof can === 'function' && can('task.approve');
  const canScenario = typeof can === 'function' && can('scenario.run');

  const [twins, setTwins] = useState([]);
  const [connections, setConnections] = useState([]);
  const [detail, setDetail] = useState(null);
  const [residualSeries, setResidualSeries] = useState([]);
  const [scripts, setScripts] = useState([]);
  const [runs, setRuns] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(null);
  const [toast, setToast] = useState(null);
  const [cfg, setCfg] = useState({ enabled: false, cadenceS: 60, driftZ: 3 });
  const [whatIf, setWhatIf] = useState({ node: '', param: '', value: '', name: 'What if' });
  const [whatIfResult, setWhatIfResult] = useState(null);

  const showToast = useCallback((msg, ok = true) => { setToast({ msg, ok }); setTimeout(() => setToast(null), 4000); }, []);

  const loadList = useCallback(async () => {
    try {
      const { data } = await api.get('/twin');
      setTwins(data.twins || []);
      setConnections(data.connections || []);
      setError(null);
      if (!flowsheetId && data.twins?.length) navigate(`/twin/${data.twins[0].flowsheetId}`, { replace: true });
    } catch (err) {
      setError(err.response?.data?.error || 'Could not load the twins');
    } finally {
      setLoading(false);
    }
  }, [flowsheetId, navigate]);

  const loadDetail = useCallback(async () => {
    if (!flowsheetId) return;
    try {
      const [{ data }, res, sc, ru] = await Promise.all([
        api.get(`/twin/${flowsheetId}`),
        api.get(`/twin/${flowsheetId}/residuals?range=6h`).catch(() => ({ data: { series: [] } })),
        api.get('/twin/scripts').catch(() => ({ data: { scripts: [] } })),
        api.get(`/twin/${flowsheetId}/scripts/runs`).catch(() => ({ data: { runs: [] } })),
      ]);
      setDetail(data);
      setCfg({ enabled: data.config.enabled, cadenceS: data.config.cadenceS, driftZ: data.config.driftZ });
      setResidualSeries(res.data.series || []);
      setScripts(sc.data.scripts || []);
      setRuns(ru.data.runs || []);
    } catch (err) {
      setError(err.response?.data?.error || 'Could not load the twin');
    }
  }, [flowsheetId]);

  useEffect(() => { loadList(); }, [loadList]);
  useEffect(() => { loadDetail(); }, [loadDetail]);

  useOrgLive({
    onMessage: (msg) => {
      if (msg.type === 'twin:state' && msg.payload?.flowsheetId === flowsheetId) {
        setDetail((d) => (d ? { ...d, state: { ...(d.state || {}), ...msg.payload } } : d));
        setTwins((ts) => ts.map((t) => (t.flowsheetId === msg.payload.flowsheetId ? { ...t, state: { ...(t.state || {}), ...msg.payload } } : t)));
      } else if (msg.type === 'twin:script' && msg.payload?.flowsheetId === flowsheetId) {
        setRuns((rs) => { const rest = rs.filter((r) => r.runId !== msg.payload.runId); return [msg.payload, ...rest].slice(0, 20); });
      } else if (msg.type === 'twin:mode') {
        setConnections((cs) => cs.map((c) => (c.id === msg.payload.connectionId ? { ...c, mode: msg.payload.mode } : c)));
        showToast(`${msg.payload.name}: ${msg.payload.mode} mode`, msg.payload.mode === 'live');
      }
    },
  });

  const saveConfig = async () => {
    setBusy('config');
    try {
      const { data } = await api.put(`/twin/${flowsheetId}`, cfg);
      setDetail((d) => ({ ...d, config: data }));
      showToast(data.enabled ? `Twin running every ${data.cadenceS} s` : 'Twin paused');
      loadList();
    } catch (err) { showToast(err.response?.data?.error || 'Could not save', false); }
    finally { setBusy(null); }
  };

  const solveNow = async () => {
    setBusy('solve');
    try {
      const { data } = await api.post(`/twin/${flowsheetId}/solve`);
      setDetail((d) => ({ ...d, state: data }));
      showToast(data.error ? `Solve failed: ${data.error}` : `Solved in ${data.durationMs} ms · ${data.residuals.length} residuals`, !data.error);
      loadDetail();
    } catch (err) { showToast(err.response?.data?.error || 'Solve failed', false); }
    finally { setBusy(null); }
  };

  const runWhatIf = async () => {
    if (!whatIf.node || !whatIf.param || whatIf.value === '') { showToast('Pick a parameter and a value', false); return; }
    setBusy('whatif');
    try {
      const { data } = await api.post(`/twin/${flowsheetId}/scenarios`, { scenarios: [{ name: whatIf.name || 'What if', nodeParams: { [whatIf.node]: { [whatIf.param]: Number(whatIf.value) } } }] });
      setWhatIfResult(data);
    } catch (err) { showToast(err.response?.data?.error || err.response?.data?.details?.[0]?.msg || 'Scenario failed', false); }
    finally { setBusy(null); }
  };

  const setMode = async (c, mode) => {
    if (mode === 'live' && !window.confirm(`Leave shadow mode on "${c.name}"? Writes will reach the real PLC again.`)) return;
    setBusy(`mode:${c.id}`);
    try {
      const { data } = await api.put(`/twin/connections/${c.id}/mode`, { mode });
      setConnections((cs) => cs.map((x) => (x.id === c.id ? { ...x, mode: data.mode } : x)));
      showToast(`${c.name}: ${data.mode} mode`, data.mode === 'live');
    } catch (err) { showToast(err.response?.data?.error || 'Could not switch mode', false); }
    finally { setBusy(null); }
  };

  const runScript = async (s) => {
    setBusy(`script:${s.id}`);
    try {
      const { data } = await api.post(`/twin/${flowsheetId}/scripts/${s.id}/run`, { speedup: 360 });
      setRuns((rs) => [data, ...rs]);
      showToast(`${s.title}: running (${data.totalSteps} steps)`);
    } catch (err) { showToast(err.response?.data?.error || 'Could not start the script', false); }
    finally { setBusy(null); }
  };
  const cancelRun = async (r) => {
    try { const { data } = await api.post(`/twin/${flowsheetId}/scripts/runs/${r.runId}/cancel`); setRuns((rs) => rs.map((x) => (x.runId === r.runId ? data : x))); }
    catch (err) { showToast(err.response?.data?.error || 'Could not cancel', false); }
  };

  const state = detail?.state;
  const residuals = state?.residuals || [];
  const driftZ = detail?.config?.driftZ ?? 3;
  const anyShadow = connections.some((c) => c.mode === 'shadow');
  const paramOptions = useMemo(() => Object.entries(state?.nodeParams || {}).flatMap(([node, params]) => Object.keys(params).map((p) => ({ node, param: p, value: params[p] }))), [state]);
  const effluentKeys = useMemo(() => Object.keys(state?.summary?.effluent || {}).filter((k) => Number.isFinite(Number(state.summary.effluent[k]))).slice(0, 8), [state]);
  const activeRun = runs.find((r) => r.status === 'running');

  return (
    <AppLayout>
      <div className="p-4 md:p-6 space-y-4 max-w-[1600px] mx-auto">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-xl font-bold text-gray-900 flex items-center gap-2"><Boxes className="w-5 h-5 text-brand-600" aria-hidden="true" /> Digital twin</h2>
            <p className="text-sm text-gray-500 mt-0.5">The model runs beside the plant on the server and says where they disagree.</p>
          </div>
          <div className="flex items-center gap-2">
            {anyShadow && (
              <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-semibold text-amber-800 bg-amber-50 border border-amber-300" role="status">
                <ShieldAlert className="w-3.5 h-3.5" /> Shadow mode on — writes go to the simulator, not the plant
              </span>
            )}
            <button onClick={() => { loadList(); loadDetail(); }} className="btn-secondary text-sm" aria-label="Refresh"><RefreshCw className="w-4 h-4" /></button>
          </div>
        </div>

        {error && <div role="alert" className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-xl px-4 py-2.5">{error}</div>}

        {/* Side by side from lg only: at tablet width the fixed list left the
            detail column too narrow for its controls (what-if select). */}
        <div className="flex flex-col lg:flex-row gap-4 items-stretch lg:items-start">
          <TwinList twins={twins} selected={flowsheetId} onSelect={(id) => navigate(`/twin/${id}`)} />

          <div className="flex-1 min-w-0 space-y-4">
            {loading && !detail && <div className="card p-8 text-center text-sm text-gray-400"><Loader2 className="w-5 h-5 animate-spin inline-block mr-2" />Loading…</div>}
            {!loading && !flowsheetId && <EmptyState icon={Boxes} title="No twin selected" description="Pick a flowsheet on the left." />}
            {detail && (
              <>
                {/* Configuration + state */}
                <section className="card p-4" aria-label="Twin configuration">
                  <div className="flex flex-wrap items-end gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="text-base font-semibold text-gray-900">{detail.flowsheetName}</div>
                      <div className="text-xs text-gray-500">{detail.projectName} · <Link className="text-brand-700 hover:underline" to={`/projects/${detail.projectId}/flowsheets/${detail.flowsheetId}`}>open canvas</Link></div>
                    </div>
                    <label className="flex items-center gap-1.5 text-sm"><input type="checkbox" checked={cfg.enabled} disabled={!canConfigure} onChange={(e) => setCfg((c) => ({ ...c, enabled: e.target.checked }))} className="accent-brand-600" /> Enabled</label>
                    <label className="text-xs text-gray-600">Every
                      <input type="number" min="5" max="3600" className="input py-1 text-sm w-20 ml-1" value={cfg.cadenceS} disabled={!canConfigure} onChange={(e) => setCfg((c) => ({ ...c, cadenceS: Number(e.target.value) }))} aria-label="Cadence seconds" /> s
                    </label>
                    <label className="text-xs text-gray-600">Drift at |z| &gt;
                      <input type="number" min="0.5" max="20" step="0.5" className="input py-1 text-sm w-20 ml-1" value={cfg.driftZ} disabled={!canConfigure} onChange={(e) => setCfg((c) => ({ ...c, driftZ: Number(e.target.value) }))} aria-label="Drift z" />
                    </label>
                    {canConfigure && <button onClick={saveConfig} disabled={busy === 'config'} className="btn-secondary text-sm disabled:opacity-50">{busy === 'config' ? <Loader2 className="w-4 h-4 animate-spin" /> : null} Save</button>}
                    {canConfigure && <button onClick={solveNow} disabled={busy === 'solve'} className="btn-primary text-sm disabled:opacity-50" aria-label="Solve now">{busy === 'solve' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Activity className="w-4 h-4" />} Solve now</button>}
                  </div>
                  <div className="mt-3 text-xs text-gray-500 flex flex-wrap gap-x-4 gap-y-1">
                    <span>{state?.solvedAt ? <>Last solve <b>{relTime(state.solvedAt)}</b> in {state.durationMs} ms (#{state.seq})</> : 'Never solved'}</span>
                    {state?.error && <span className="text-red-700 inline-flex items-center gap-1"><AlertTriangle className="w-3 h-3" /> {state.error}</span>}
                    {state?.summary?.effluent && <span>Effluent: {effluentKeys.map((k) => `${k} ${fmt(state.summary.effluent[k])}`).join(' · ')}</span>}
                  </div>
                </section>

                {/* Residuals */}
                <section className="card p-4" aria-label="Residuals">
                  <h3 className="text-sm font-semibold text-gray-900 mb-2">Model vs measured</h3>
                  {!residuals.length ? (
                    <p className="text-xs text-gray-500">No instrument on this flowsheet has a live measurement bound to its <span className="font-mono">measured</span> parameter yet. Bind a flow meter, level or pH transmitter and the twin compares every solve.</p>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full text-xs">
                        <thead className="text-gray-500 uppercase tracking-wide text-[10px]">
                          <tr><th className="text-left px-2 py-1">Instrument</th><th className="text-right px-2 py-1">Measured</th><th className="text-right px-2 py-1">Modelled</th><th className="text-right px-2 py-1">Residual</th><th className="text-right px-2 py-1">z</th><th className="text-left px-2 py-1">Last 6 h (residual)</th></tr>
                        </thead>
                        <tbody>
                          {residuals.map((r) => {
                            const s = residualSeries.find((x) => x.tagId === r.tagId);
                            return (
                              <tr key={r.tagId} className="border-t border-gray-100" data-residual={r.tag}>
                                <td className="px-2 py-1.5 font-mono text-gray-900">{r.tag}</td>
                                <td className="px-2 py-1.5 text-right tabular-nums">{fmt(r.measured)} {r.unit || ''}</td>
                                <td className="px-2 py-1.5 text-right tabular-nums">{fmt(r.modelled)}</td>
                                <td className="px-2 py-1.5 text-right tabular-nums">{r.residual > 0 ? '+' : ''}{fmt(r.residual)}</td>
                                <td className={`px-2 py-1.5 text-right tabular-nums ${zTone(r.z, driftZ)}`}>{fmt(r.z, 2)}{Math.abs(r.z) > driftZ ? ' ⚠' : ''}</td>
                                <td className="px-2 py-1.5"><Sparkline tag="" name="" points={(s?.points || []).map((p) => [p[0], p[3]])} width={140} height={28} /></td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                </section>

                {/* What-if */}
                <section className="card p-4" aria-label="What-if">
                  <h3 className="text-sm font-semibold text-gray-900 mb-2 flex items-center gap-1"><FlaskConical className="w-4 h-4 text-gray-400" /> What if — from the live state</h3>
                  {!paramOptions.length ? (
                    <p className="text-xs text-gray-500">Solve the twin once with live measurements and its parameters become the baseline here.</p>
                  ) : (
                    <div className="flex flex-wrap items-end gap-2 text-xs">
                      <label>Parameter
                        <select className="input py-1 text-xs block min-w-56" value={`${whatIf.node}|${whatIf.param}`} onChange={(e) => { const [node, param] = e.target.value.split('|'); const cur = paramOptions.find((p) => p.node === node && p.param === param); setWhatIf((w) => ({ ...w, node, param, value: cur ? String(cur.value) : '' })); }} aria-label="Parameter">
                          <option value="|">Choose…</option>
                          {paramOptions.map((p) => <option key={`${p.node}|${p.param}`} value={`${p.node}|${p.param}`}>{p.node} · {p.param} (now {fmt(p.value)})</option>)}
                        </select>
                      </label>
                      <label>New value <input type="number" step="any" className="input py-1 text-xs block w-28" value={whatIf.value} onChange={(e) => setWhatIf((w) => ({ ...w, value: e.target.value }))} aria-label="New value" /></label>
                      <button onClick={runWhatIf} disabled={busy === 'whatif' || !canScenario} className="btn-primary text-xs disabled:opacity-50" aria-label="Run scenario">{busy === 'whatif' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />} Run</button>
                      {!canScenario && <span className="text-gray-400">Operators and above can run scenarios.</span>}
                    </div>
                  )}
                  {whatIfResult && (
                    <div className="mt-3 overflow-x-auto" data-testid="whatif-result">
                      <table className="text-xs w-full">
                        <thead className="text-gray-500 uppercase text-[10px]"><tr><th className="text-left px-2 py-1">Scenario</th>{effluentKeys.map((k) => <th key={k} className="text-right px-2 py-1">{k}</th>)}</tr></thead>
                        <tbody>
                          <tr className="border-t border-gray-100"><td className="px-2 py-1 font-medium">{whatIfResult.baseline.name}</td>{effluentKeys.map((k) => <td key={k} className="text-right px-2 py-1 tabular-nums">{fmt(whatIfResult.baseline.effluent?.[k])}</td>)}</tr>
                          {whatIfResult.scenarios.map((s) => (
                            <tr key={s.name} className="border-t border-gray-100">
                              <td className="px-2 py-1 font-medium">{s.name}{!s.ok && <span className="text-red-600"> · {s.error}</span>}</td>
                              {effluentKeys.map((k) => <td key={k} className="text-right px-2 py-1 tabular-nums">{fmt(s.effluent?.[k])}{s.delta?.[k] != null && s.delta[k] !== 0 && <span className={`ml-1 ${s.delta[k] > 0 ? 'text-red-600' : 'text-emerald-600'}`}>({s.delta[k] > 0 ? '+' : ''}{fmt(s.delta[k])})</span>}</td>)}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      <div className="text-[10px] text-gray-400 mt-1">Not persisted as a run.</div>
                    </div>
                  )}
                </section>

                {/* Commissioning */}
                <section className="card p-4 space-y-3" aria-label="Virtual commissioning">
                  <h3 className="text-sm font-semibold text-gray-900 flex items-center gap-1"><ListChecks className="w-4 h-4 text-gray-400" /> Virtual commissioning</h3>
                  <div className="flex flex-wrap gap-2">
                    {connections.map((c) => (
                      <div key={c.id} className={`flex items-center gap-2 px-3 py-1.5 rounded-lg border text-xs ${c.mode === 'shadow' ? 'bg-amber-50 border-amber-300 text-amber-900' : 'bg-gray-50 border-gray-200 text-gray-700'}`} data-connection={c.id}>
                        {c.mode === 'shadow' ? <ShieldAlert className="w-3.5 h-3.5" /> : <ShieldCheck className="w-3.5 h-3.5" />}
                        <span className="font-medium">{c.name}</span><span className="opacity-70">{c.protocol}</span>
                        <span className="font-mono uppercase">{c.mode}</span>
                        {c.mode === 'live' && canCommission && <button onClick={() => setMode(c, 'shadow')} disabled={!!busy} className="btn-secondary text-[11px] py-0.5 px-2" aria-label={`Enter shadow mode on ${c.name}`}>Enter shadow</button>}
                        {c.mode === 'shadow' && canLeaveShadow && <button onClick={() => setMode(c, 'live')} disabled={!!busy} className="btn-secondary text-[11px] py-0.5 px-2" aria-label={`Leave shadow mode on ${c.name}`}>Leave shadow</button>}
                        {c.mode === 'shadow' && !canLeaveShadow && <span className="text-[10px]">a manager leaves shadow</span>}
                      </div>
                    ))}
                    {!connections.length && <span className="text-xs text-gray-400">No PLC connections.</span>}
                  </div>
                  <div className="grid md:grid-cols-2 gap-2">
                    {scripts.map((s) => (
                      <div key={s.id} className="border border-gray-200 rounded-lg p-2 text-xs" data-script={s.id}>
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-medium text-gray-900">{s.numeral}. {s.title}</span>
                          <span className="text-gray-400">{s.actionableSteps} steps · {fmt(s.totalHours, 2)} h</span>
                        </div>
                        <ol className="text-[11px] text-gray-500 mt-1 space-y-0.5 max-h-24 overflow-y-auto">
                          {s.steps.filter((st) => st.acts).map((st) => <li key={st.no}>{st.no}. <b className="uppercase">{st.action}</b> {st.devices.join(', ')}{st.durationH ? ` · ${fmt(st.durationH * 60, 1)} min` : ''}</li>)}
                        </ol>
                        <div className="mt-1.5">
                          {canCommission && (
                            <button onClick={() => runScript(s)} disabled={!anyShadow || !!busy || !!activeRun} title={anyShadow ? 'Play at 360× against the shadow plant' : 'Enter shadow mode first'} className="btn-primary text-[11px] py-0.5 px-2 disabled:opacity-50" aria-label={`Run ${s.title}`}>
                              {busy === `script:${s.id}` ? <Loader2 className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3" />} Run in shadow
                            </button>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                  {runs.length > 0 && (
                    <div className="text-xs space-y-1" aria-label="Script runs">
                      {runs.slice(0, 5).map((r) => (
                        <div key={r.runId} className="flex items-center gap-2" data-run={r.runId}>
                          <span className={`inline-flex px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase border ${r.status === 'running' ? 'text-brand-700 bg-brand-50 border-brand-200' : r.status === 'completed' ? 'text-emerald-700 bg-emerald-50 border-emerald-200' : 'text-gray-600 bg-gray-50 border-gray-200'}`}>{r.status}</span>
                          <span className="font-medium">{r.sectionId}</span>
                          <span className="text-gray-500">step {r.stepNo}/{r.totalSteps}</span>
                          {r.log?.length > 0 && <span className="text-gray-400 truncate">last: {r.log[r.log.length - 1].action} {r.log[r.log.length - 1].devices.join(', ')}</span>}
                          {r.status === 'completed' && <Check className="w-3.5 h-3.5 text-emerald-600" />}
                          {r.status === 'running' && canCommission && <button onClick={() => cancelRun(r)} className="btn-secondary text-[10px] py-0.5 px-1.5" aria-label="Cancel script"><Square className="w-3 h-3" /> Cancel</button>}
                        </div>
                      ))}
                    </div>
                  )}
                </section>
              </>
            )}
          </div>
        </div>
      </div>

      {toast && (
        <div role="status" aria-live="polite" className={`fixed bottom-20 md:bottom-6 right-4 z-50 px-4 py-3 rounded-xl shadow-xl text-white text-sm font-medium ${toast.ok ? 'bg-emerald-700' : 'bg-red-700'}`}>
          {toast.ok ? '✓' : '⚠'} {toast.msg}
        </div>
      )}
    </AppLayout>
  );
}
