/**
 * LiveSimPanel — Full-screen dashboard overlay for real-time simulation.
 *
 * The live simulation runs continuously at a configurable solver interval
 * (default 1s) using the latest node params including OPC-polled values.
 * The solver interval is independent of OPC polling speed. Runs until
 * the user clicks Stop.
 *
 * Renders as a large overlay on top of the canvas with:
 * - Transport controls (start/pause/resume/stop)
 * - Tag picker to add/remove trend variables from ANY process node
 * - Live Recharts trend chart that grows as steps stream in
 * - Current values + peak summary table
 */

import React, { useState, useMemo, useRef, useCallback, useEffect } from 'react';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from 'recharts';
import useLiveSimStore, { STREAM_PARAMS } from '../../store/liveSimStore';
import api from '../../utils/api';

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Map opType → primary output key in unitResults.outputs */
const PRIMARY_OUTPUT_KEY = {
  inlet: 'effluent', outlet: 'effluent',
  screening: 'effluent', grit_removal: 'effluent',
  primary_clarifier: 'effluent',
  activated_sludge: 'effluent', secondary_clarifier: 'effluent',
  membrane_bioreactor: 'effluent', uct_reactor: 'effluent', jhb_reactor: 'effluent',
  chemical_dosing: 'effluent', coagulant_dosing: 'effluent',
  polymer_dosing: 'effluent', ph_adjustment: 'effluent',
  coagulation: 'effluent', chlorination: 'effluent',
  uv_disinfection: 'effluent',
  uf_membrane: 'effluent', gac_adsorption: 'effluent',
  pump: 'effluent', blower: 'effluent', tank: 'effluent',
  opc_read: 'effluent', opc_write: 'effluent',
  sand_filter: 'filtrate', granular_filter: 'filtrate',
  ro_membrane: 'permeate',
  thickener: 'thickened', sludge_thickener: 'thickened',
  anaerobic_digester: 'digestate',
};

/** Node types to exclude from the variable picker.
 *  inlet/outlet are covered by the Influent/Effluent Summary sections. */
const EXCLUDED_TYPES = new Set(['opc_read', 'opc_write', 'inlet', 'outlet']);

/** Resolve a watched param value from a step. */
function resolveValue(step, wp) {
  if (wp.nodeId === '__summary__') {
    const src = wp.outputKey === 'influent'
      ? step.summary?.influent
      : step.summary?.effluent;
    return src?.[wp.key] ?? null;
  }
  if (wp.outputKey === 'metric') {
    return step.unitResults?.[wp.nodeId]?.metrics?.[wp.key] ?? null;
  }
  return step.unitResults?.[wp.nodeId]?.outputs?.[wp.outputKey]?.[wp.key] ?? null;
}

/** Format elapsed seconds as mm:ss or hh:mm:ss */
function fmtElapsed(sec) {
  if (sec < 3600) {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
  }
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

// ── Transport Controls ──────────────────────────────────────────────────────

const FLAT_PROFILE = Array.from({ length: 24 }, (_, h) => ({
  hour: h, Q_scale: 1, BOD_scale: 1, TN_scale: 1, TP_scale: 1, TSS_scale: 1,
}));

/** Speed multiplier options. */
const SPEED_OPTIONS = [
  { value: 1,    label: '1x' },
  { value: 5,    label: '5x' },
  { value: 10,   label: '10x' },
  { value: 100,  label: '100x' },
  { value: 1000, label: '1000x' },
];

function TransportControls({ sendEvent, buildNodeParams, canvasData, wsConnected }) {
  const status      = useLiveSimStore(s => s.status);
  const currentStep = useLiveSimStore(s => s.currentStep);
  const steps       = useLiveSimStore(s => s.steps);
  const reset       = useLiveSimStore(s => s.reset);
  const speed       = useLiveSimStore(s => s.speed);
  const setSpeed    = useLiveSimStore(s => s.setSpeed);

  // Default ON: run at the fixed inlet values. Values then change only from the
  // simulation/calculations (and live edits), not an automatic diurnal drift.
  const [constantInlet, setConstantInlet] = useState(true);

  const isIdle = status === 'idle' || status === 'cancelled';

  const handleStart = () => {
    reset();
    const tsc = {};
    if (constantInlet) tsc.profile = FLAT_PROFILE;
    sendEvent('sim:live:start', {
      nodeParams: buildNodeParams ? buildNodeParams() : {},
      timeSeriesConfig: tsc,
      canvasData: canvasData || { nodes: [], edges: [] },
      speed,
    });
  };

  const handleSpeedChange = (e) => {
    const newSpeed = Number(e.target.value);
    setSpeed(newSpeed);
    // If simulation is already running, send the change to the backend
    if (status === 'running' || status === 'paused') {
      sendEvent('sim:live:speed', { speed: newSpeed });
    }
  };

  const canStart = wsConnected && isIdle;

  // Elapsed time from the latest step
  const lastStep = steps.length > 0 ? steps[steps.length - 1] : null;
  const elapsed = lastStep?.elapsedSec ?? 0;

  // Display label for current speed
  const speedLabel = SPEED_OPTIONS.find(o => o.value === speed)?.label || `${speed}x`;

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
      {/* Buttons */}
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        {isIdle && (
          <button
            style={{ ...S.btn, background: canStart ? '#059669' : '#9CA3AF', color: '#fff' }}
            onClick={handleStart}
            disabled={!canStart}
          >
            {wsConnected ? 'Start Live' : 'Connecting...'}
          </button>
        )}
        {status === 'running' && (
          <button style={{ ...S.btn, background: '#D97706', color: '#fff' }}
            onClick={() => sendEvent('sim:live:pause', {})}>
            Pause
          </button>
        )}
        {status === 'paused' && (
          <button style={{ ...S.btn, background: '#059669', color: '#fff' }}
            onClick={() => sendEvent('sim:live:resume', {})}>
            Resume
          </button>
        )}
        {(status === 'running' || status === 'paused') && (
          <button style={{ ...S.btn, background: '#DC2626', color: '#fff' }}
            onClick={() => sendEvent('sim:live:cancel', {})}>
            Stop
          </button>
        )}
      </div>

      {/* Speed selector */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ fontSize: 11, fontWeight: 600, color: '#6B7280' }}>Speed:</span>
        <select
          value={speed}
          onChange={handleSpeedChange}
          style={{
            fontSize: 12, padding: '4px 8px', borderRadius: 4,
            border: '1px solid #D1D5DB', background: '#fff', cursor: 'pointer',
          }}
        >
          {SPEED_OPTIONS.map(o => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      </div>

      {/* Step counter + elapsed time */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
        <span style={{ fontSize: 12, color: '#374151' }}>
          <strong>{currentStep}</strong>
          <span style={{ color: '#9CA3AF' }}> steps</span>
        </span>
        {elapsed > 0 && (
          <span style={{ fontSize: 12, color: '#374151' }}>
            <strong>{fmtElapsed(elapsed)}</strong>
            <span style={{ color: '#9CA3AF' }}> elapsed</span>
          </span>
        )}
        {status === 'running' && (
          <span style={{ fontSize: 10, color: '#059669', fontWeight: 600 }}>
            {speedLabel} &middot; {speed} steps/tick
          </span>
        )}
      </div>

      {/* Constant inlet toggle */}
      <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#374151', cursor: 'pointer', marginLeft: 'auto' }}>
        <input type="checkbox" checked={constantInlet} onChange={e => setConstantInlet(e.target.checked)} disabled={!isIdle} />
        Fixed inlet values (uncheck for diurnal variation)
      </label>
    </div>
  );
}

// ── Variable Picker (all-node accordion) ─────────────────────────────────────

function VariablePicker({ canvasData }) {
  const watchedParams      = useLiveSimStore(s => s.watchedParams);
  const addWatchedParam    = useLiveSimStore(s => s.addWatchedParam);
  const removeWatchedParam = useLiveSimStore(s => s.removeWatchedParam);

  const [open, setOpen]       = useState(false);
  const [expanded, setExpanded] = useState(null);

  // Build the list of picker sections from canvas nodes
  const sections = useMemo(() => {
    const result = [];

    // Summary: Influent
    result.push({
      id: '__influent__', nodeId: '__summary__', outputKey: 'influent',
      label: 'Influent (Summary)',
    });

    // Process nodes from canvas
    const nodes = canvasData?.nodes || [];
    for (const node of nodes) {
      const opType = node.data?.opType || node.type;
      if (EXCLUDED_TYPES.has(opType)) continue;
      const outputKey = PRIMARY_OUTPUT_KEY[opType] || 'effluent';
      result.push({
        id: node.id, nodeId: node.id, outputKey,
        label: node.data?.label || opType,
      });
    }

    // Summary: Effluent
    result.push({
      id: '__effluent__', nodeId: '__summary__', outputKey: 'effluent',
      label: 'Effluent (Summary)',
    });

    return result;
  }, [canvasData]);

  const toggleExpand = (id) => setExpanded(prev => prev === id ? null : id);

  return (
    <div>
      {/* Active chips */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 6, alignItems: 'center' }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: '#6B7280', marginRight: 4 }}>Tags:</span>
        {watchedParams.length === 0 && (
          <span style={{ fontSize: 11, color: '#9CA3AF', fontStyle: 'italic' }}>None selected</span>
        )}
        {watchedParams.map(wp => (
          <span key={`${wp.nodeId}-${wp.outputKey}-${wp.key}`} style={{
            ...S.chip,
            borderColor: wp.color,
            color: wp.color,
          }}>
            {wp.label}
            <button style={S.chipX} onClick={() => removeWatchedParam(wp.key, wp.nodeId, wp.outputKey)}>&times;</button>
          </span>
        ))}
        <button style={S.addBtn} onClick={() => setOpen(v => !v)}>
          {open ? '- Close' : '+ Add Tag'}
        </button>
      </div>

      {/* Accordion picker */}
      {open && (
        <div style={S.pickerContainer}>
          {sections.map(sec => {
            const isExpanded = expanded === sec.id;
            return (
              <div key={sec.id} style={{ borderBottom: '1px solid #E5E7EB' }}>
                {/* Section header */}
                <button
                  onClick={() => toggleExpand(sec.id)}
                  style={S.accordionHeader}
                >
                  <span style={{ fontSize: 11, color: '#6B7280', marginRight: 6 }}>
                    {isExpanded ? '\u25BE' : '\u25B8'}
                  </span>
                  <span style={{ fontSize: 12, fontWeight: 600, color: '#374151' }}>
                    {sec.label}
                  </span>
                  {/* Count of watched params from this section */}
                  {(() => {
                    const cnt = watchedParams.filter(
                      w => w.nodeId === sec.nodeId && w.outputKey === sec.outputKey
                    ).length;
                    return cnt > 0 ? (
                      <span style={{
                        fontSize: 10, fontWeight: 700, color: '#059669',
                        background: '#D1FAE5', borderRadius: 8, padding: '1px 6px', marginLeft: 6,
                      }}>
                        {cnt}
                      </span>
                    ) : null;
                  })()}
                </button>

                {/* Expanded param grid */}
                {isExpanded && (
                  <div style={S.paramGrid}>
                    {STREAM_PARAMS.map(p => {
                      const checked = !!watchedParams.find(
                        w => w.key === p.key && w.nodeId === sec.nodeId && w.outputKey === sec.outputKey
                      );
                      return (
                        <label key={p.key} style={S.pickerLabel}>
                          <input type="checkbox" checked={checked}
                            onChange={e => e.target.checked
                              ? addWatchedParam(p.key, sec.nodeId, sec.outputKey, sec.label)
                              : removeWatchedParam(p.key, sec.nodeId, sec.outputKey)
                            }
                          />
                          <span style={{ fontSize: 12 }}>{p.key}</span>
                          <span style={{ fontSize: 10, color: '#9CA3AF' }}>{p.unit}</span>
                        </label>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Live Trend Chart ────────────────────────────────────────────────────────

function XAxisSelector() {
  const xAxisMode    = useLiveSimStore(s => s.xAxisMode);
  const setXAxisMode = useLiveSimStore(s => s.setXAxisMode);
  return (
    <select
      value={xAxisMode}
      onChange={e => setXAxisMode(e.target.value)}
      style={{
        fontSize: 10, padding: '2px 4px', border: '1px solid #D1D5DB',
        borderRadius: 3, color: '#6B7280', background: '#fff', cursor: 'pointer',
      }}
      title="X-axis display mode"
    >
      <option value="elapsed">X: Elapsed Time</option>
      <option value="step">X: Step #</option>
      <option value="hour">X: Sim Hour</option>
    </select>
  );
}

function CsvExportButton() {
  const steps         = useLiveSimStore(s => s.steps);
  const watchedParams = useLiveSimStore(s => s.watchedParams);

  const handleExport = () => {
    if (steps.length === 0 || watchedParams.length === 0) return;

    const headers = ['Step', 'Elapsed (s)', 'Sim Hour',
      ...watchedParams.map(wp => wp.label)];

    const rows = steps.map(step => {
      const values = [
        step.tick,
        step.elapsedSec ?? 0,
        step.stepEntry?.hour ?? (step.tick % 24),
        ...watchedParams.map(wp => {
          const v = resolveValue(step, wp);
          return v != null ? v : '';
        }),
      ];
      return values.map(v => typeof v === 'string' && v.includes(',') ? `"${v}"` : v).join(',');
    });

    const csv = [headers.join(','), ...rows].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `livesim_trend_${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const disabled = steps.length === 0 || watchedParams.length === 0;
  return (
    <button
      onClick={handleExport}
      disabled={disabled}
      style={{
        fontSize: 10, padding: '2px 8px', border: '1px solid #D1D5DB',
        borderRadius: 3, background: disabled ? '#F3F4F6' : '#fff',
        color: disabled ? '#9CA3AF' : '#374151', cursor: disabled ? 'default' : 'pointer',
        fontWeight: 500,
      }}
      title={disabled ? 'No data to export' : 'Export trend data to CSV'}
    >
      Export CSV
    </button>
  );
}

function LiveTrendChart() {
  const steps         = useLiveSimStore(s => s.steps);
  const watchedParams = useLiveSimStore(s => s.watchedParams);
  const xAxisMode     = useLiveSimStore(s => s.xAxisMode);

  const chartData = useMemo(() => steps.map(step => {
    let xVal;
    if (xAxisMode === 'step')       xVal = step.tick;
    else if (xAxisMode === 'hour')  xVal = step.stepEntry?.hour ?? (step.tick % 24);
    else                            xVal = fmtElapsed(step.elapsedSec ?? 0);

    const point = { xAxis: xVal };
    for (const wp of watchedParams) {
      point[wp.label] = resolveValue(step, wp);
    }
    return point;
  }), [steps, watchedParams, xAxisMode]);

  if (watchedParams.length === 0) {
    return (
      <div style={S.placeholder}>
        Click <strong>+ Add Tag</strong> above to choose which process variables to plot.
      </div>
    );
  }

  if (chartData.length === 0) {
    return (
      <div style={S.placeholder}>
        Click <strong>Start Live</strong> to begin. Data points appear at the configured solver interval using the latest values.
      </div>
    );
  }

  const xLabel = xAxisMode === 'step' ? 'Step' : xAxisMode === 'hour' ? 'Hour' : undefined;

  return (
    <ResponsiveContainer width="100%" height="100%">
      <LineChart data={chartData} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#E5E7EB" />
        <XAxis
          dataKey="xAxis"
          tick={{ fontSize: 11 }}
          interval={Math.max(0, Math.floor(chartData.length / 12) - 1)}
          label={xLabel ? { value: xLabel, position: 'insideBottomRight', fontSize: 10, fill: '#9CA3AF' } : undefined}
        />
        <YAxis tick={{ fontSize: 11 }} />
        <Tooltip contentStyle={{ fontSize: 12 }} />
        <Legend iconSize={12} wrapperStyle={{ fontSize: 11 }} />
        {watchedParams.map(wp => (
          <Line
            key={wp.label}
            type="monotone"
            dataKey={wp.label}
            stroke={wp.color}
            dot={false}
            strokeWidth={2}
            isAnimationActive={false}
          />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
}

// ── Current Values + Peak Summary Table ─────────────────────────────────────

function ValuesTable() {
  const steps         = useLiveSimStore(s => s.steps);
  const watchedParams = useLiveSimStore(s => s.watchedParams);

  const data = useMemo(() => {
    if (!steps.length) return [];
    const latest = steps[steps.length - 1];
    return watchedParams.map(wp => {
      const current = resolveValue(latest, wp);

      let peak = -Infinity;
      for (const step of steps) {
        const val = resolveValue(step, wp);
        if (val != null && val > peak) peak = val;
      }

      const paramDef = STREAM_PARAMS.find(p => p.key === wp.key);
      return {
        label: wp.label,
        current,
        peak: peak === -Infinity ? null : peak,
        unit: paramDef?.unit || '',
        color: wp.color,
      };
    });
  }, [steps, watchedParams]);

  if (!data.length || !steps.length) return null;

  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
      <thead>
        <tr style={{ borderBottom: '2px solid #E5E7EB' }}>
          <th style={S.th}>Tag</th>
          <th style={{ ...S.th, textAlign: 'right' }}>Current</th>
          <th style={{ ...S.th, textAlign: 'right' }}>Peak</th>
          <th style={{ ...S.th, textAlign: 'right' }}>Unit</th>
        </tr>
      </thead>
      <tbody>
        {data.map(d => (
          <tr key={d.label} style={{ borderBottom: '1px solid #F3F4F6' }}>
            <td style={{ ...S.td, color: d.color, fontWeight: 600 }}>{d.label}</td>
            <td style={{ ...S.td, textAlign: 'right', fontWeight: 700 }}>
              {d.current != null ? d.current.toFixed(2) : '\u2014'}
            </td>
            <td style={{ ...S.td, textAlign: 'right', color: '#6B7280' }}>
              {d.peak != null ? d.peak.toFixed(2) : '\u2014'}
            </td>
            <td style={{ ...S.td, textAlign: 'right', color: '#9CA3AF' }}>{d.unit}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ── Always-visible KPI strip ────────────────────────────────────────────────

function KpiStrip({ canvasData }) {
  const steps  = useLiveSimStore(s => s.steps);
  const latest = steps.length ? steps[steps.length - 1] : null;
  const inf = latest?.summary?.influent || {};
  const eff = latest?.summary?.effluent || {};
  const fmt = v => (v == null ? '—' : (+v).toFixed(0));

  // Held inlet setpoints (the fixed values the sim runs at)
  const inlets = (canvasData?.nodes || []).filter(n => n.data?.opType === 'inlet');
  const sp = inlets[0]?.data?.params || {};
  const spQ = inlets.reduce((s, n) => s + (Number(n.data?.params?.Q) || 0), 0) || sp.Q;

  const cell = (label, val, unit, color) => (
    <div key={label} style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 88 }}>
      <span style={{ fontSize: 10, color: '#9CA3AF', textTransform: 'uppercase', letterSpacing: '.05em' }}>{label}</span>
      <span style={{ fontSize: 17, fontWeight: 700, color, fontVariantNumeric: 'tabular-nums' }}>
        {fmt(val)}<span style={{ fontSize: 10, color: '#9CA3AF', fontWeight: 500 }}> {unit}</span>
      </span>
    </div>
  );
  const chip = (label, val) => (
    <span key={label} style={{ fontFamily: 'ui-monospace,Consolas,monospace', fontSize: 11, fontWeight: 700, color: '#92400E' }}>
      {label} <span style={{ fontWeight: 800 }}>{val == null || val === '' ? '—' : val}</span>
    </span>
  );

  return (
    <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'stretch', padding: '10px 20px', background: '#F9FAFB', borderBottom: '1px solid #E5E7EB' }}>
      {inlets.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: '6px 12px', background: '#FFFBEB', border: '1px solid #FDE68A', borderRadius: 8 }}>
          <span style={{ fontSize: 10, fontWeight: 700, color: '#B45309', textTransform: 'uppercase', letterSpacing: '.05em', display: 'flex', alignItems: 'center', gap: 5 }}>
            🔒 Fixed inlet setpoints
          </span>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            {chip('Q', fmt(spQ) + ' m³/d')}
            {chip('BOD', fmt(sp.BOD))}
            {chip('TSS', fmt(sp.TSS))}
            {chip('TN', fmt(sp.TN))}
            {chip('TP', sp.TP == null ? '—' : sp.TP)}
            {chip('pH', sp.pH == null ? '—' : sp.pH)}
          </div>
        </div>
      )}
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'center' }}>
        {cell('Influent Q', inf.Q, 'm³/d', '#1F4E79')}
        {cell('Influent TSS', inf.TSS, 'mg/L', '#1F4E79')}
        {cell('Influent BOD', inf.BOD, 'mg/L', '#1F4E79')}
        <div style={{ width: 1, background: '#E5E7EB', alignSelf: 'stretch' }} />
        {cell('Effluent Q', eff.Q, 'm³/d', '#059669')}
        {cell('Effluent TSS', eff.TSS, 'mg/L', '#059669')}
        {cell('Effluent BOD', eff.BOD, 'mg/L', '#059669')}
        {cell('Effluent TN', eff.TN, 'mg/L', '#059669')}
        {cell('Effluent TP', eff.TP, 'mg/L', '#059669')}
      </div>
    </div>
  );
}

// ── Simple one-click tag chips (replaces the nested picker) ──────────────────

const QUICK_TAGS = [
  ['Q', 'influent', 'Influent'], ['TSS', 'influent', 'Influent'], ['BOD', 'influent', 'Influent'],
  ['Q', 'effluent', 'Effluent'], ['TSS', 'effluent', 'Effluent'], ['BOD', 'effluent', 'Effluent'],
  ['TN', 'effluent', 'Effluent'], ['TP', 'effluent', 'Effluent'],
];
function QuickTags() {
  const watched = useLiveSimStore(s => s.watchedParams);
  const add     = useLiveSimStore(s => s.addWatchedParam);
  const remove  = useLiveSimStore(s => s.removeWatchedParam);
  const on = (k, out) => watched.some(w => w.key === k && w.nodeId === '__summary__' && w.outputKey === out);
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
      <span style={{ fontSize: 12, fontWeight: 600, color: '#6B7280', marginRight: 4 }}>Plot lines:</span>
      {QUICK_TAGS.map(([k, out, lbl]) => {
        const active = on(k, out);
        return (
          <button key={out + k}
            onClick={() => active ? remove(k, '__summary__', out) : add(k, '__summary__', out, lbl)}
            style={{
              padding: '5px 11px', borderRadius: 999, cursor: 'pointer', fontSize: 12, fontWeight: 600,
              border: '1px solid ' + (active ? '#0891B2' : '#D1D5DB'),
              background: active ? '#0891B2' : '#fff', color: active ? '#fff' : '#374151',
            }}>{lbl} {k}</button>
        );
      })}
    </div>
  );
}

// ── Trend picker: node tabs + dynamic per-node parameter chips ───────────────

function NodeTrendPicker({ canvasData }) {
  const steps   = useLiveSimStore(s => s.steps);
  const watched = useLiveSimStore(s => s.watchedParams);
  const add     = useLiveSimStore(s => s.addWatchedParam);
  const remove  = useLiveSimStore(s => s.removeWatchedParam);
  const latest  = steps.length ? steps[steps.length - 1] : null;

  const nodes = (canvasData?.nodes || []).filter(n => !['opc_read', 'opc_write'].includes(n.data?.opType));
  const [tab, setTab] = useState('__summary__');

  const isOn = (key, nodeId, outKey) => watched.some(w => w.key === key && w.nodeId === nodeId && w.outputKey === outKey);
  const toggle = (key, nodeId, outKey, label) =>
    isOn(key, nodeId, outKey) ? remove(key, nodeId, outKey) : add(key, nodeId, outKey, label);

  const chip = (key, nodeId, outKey, label) => {
    const on = isOn(key, nodeId, outKey);
    return (
      <button key={outKey + ':' + key} onClick={() => toggle(key, nodeId, outKey, label)}
        style={{ padding: '4px 10px', borderRadius: 999, cursor: 'pointer', fontSize: 11.5, fontWeight: 600,
          border: '1px solid ' + (on ? '#0891B2' : '#D1D5DB'), background: on ? '#0891B2' : '#fff', color: on ? '#fff' : '#374151' }}>
        {key}
      </button>
    );
  };

  const grpLabel = { fontSize: 10, fontWeight: 700, color: '#9CA3AF', textTransform: 'uppercase', letterSpacing: '.05em', margin: '6px 0 4px' };
  const chipRow  = { display: 'flex', flexWrap: 'wrap', gap: 5 };

  let content;
  if (tab === '__summary__') {
    content = (
      <>
        <div style={grpLabel}>Influent</div>
        <div style={chipRow}>{STREAM_PARAMS.map(p => chip(p.key, '__summary__', 'influent', 'Influent'))}</div>
        <div style={grpLabel}>Effluent (final)</div>
        <div style={chipRow}>{STREAM_PARAMS.map(p => chip(p.key, '__summary__', 'effluent', 'Effluent'))}</div>
      </>
    );
  } else {
    const node = nodes.find(n => n.id === tab);
    const outKey = PRIMARY_OUTPUT_KEY[node?.data?.opType] || 'effluent';
    const label = node?.data?.label || tab;
    const metrics = latest?.unitResults?.[tab]?.metrics || {};
    const metricKeys = Object.keys(metrics).filter(k => typeof metrics[k] === 'number');
    content = (
      <>
        <div style={grpLabel}>Output stream ({outKey})</div>
        <div style={chipRow}>{STREAM_PARAMS.map(p => chip(p.key, tab, outKey, label))}</div>
        {metricKeys.length > 0 && (
          <>
            <div style={grpLabel}>Calculated metrics</div>
            <div style={chipRow}>{metricKeys.map(k => chip(k, tab, 'metric', label))}</div>
          </>
        )}
      </>
    );
  }

  const tabBtn = (id, lbl) => (
    <button key={id} onClick={() => setTab(id)} style={{
      padding: '5px 11px', borderRadius: 7, cursor: 'pointer', fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap',
      border: '1px solid ' + (tab === id ? '#0891B2' : '#E5E7EB'), background: tab === id ? '#ECFEFF' : '#fff', color: tab === id ? '#0369A1' : '#4B5563' }}>
      {lbl}
    </button>
  );

  return (
    <div>
      <div style={{ display: 'flex', gap: 5, overflowX: 'auto', paddingBottom: 6 }}>
        {tabBtn('__summary__', 'Summary')}
        {nodes.map(n => tabBtn(n.id, n.data?.label || n.id))}
      </div>
      {content}
      {watched.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 10, alignItems: 'center', borderTop: '1px dashed #E5E7EB', paddingTop: 8 }}>
          <span style={{ fontSize: 11, color: '#6B7280', fontWeight: 700 }}>Plotting {watched.length}:</span>
          {watched.map(w => (
            <span key={w.nodeId + w.outputKey + w.key}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, padding: '2px 5px 2px 8px', borderRadius: 999, background: '#F3F4F6', color: '#374151' }}>
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: w.color }} />
              {w.label}
              <button onClick={() => remove(w.key, w.nodeId, w.outputKey)} style={{ border: 'none', background: 'none', cursor: 'pointer', color: '#9CA3AF', fontSize: 12 }}>✕</button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Live inputs bar — start/stop the device gateway for this flowsheet ───────

function LiveInputsBar({ flowsheetId, canvasData }) {
  const [on, setOn] = useState(false);
  const [values, setValues] = useState([]);
  const timerRef = useRef(null);

  const bindings = useMemo(() => {
    const out = [];
    for (const n of (canvasData?.nodes || [])) {
      const lb = n.data?.liveBindings || {};
      for (const [paramKey, b] of Object.entries(lb)) {
        if (b?.enabled && b.protocol) {
          out.push({ nodeId: n.id, paramKey, protocol: b.protocol, mode: b.mode || 'read', config: b.config || {}, scale: b.scale, poll_ms: b.poll_ms });
        }
      }
    }
    return out;
  }, [canvasData]);

  const labelOf = useMemo(
    () => Object.fromEntries((canvasData?.nodes || []).map(n => [n.id, n.data?.label || n.id])),
    [canvasData]
  );

  const poll = async () => {
    try { const { data } = await api.get('/live/gateway/status', { params: { flowsheetId } }); setValues(data.values || []); }
    catch { /* ignore */ }
  };
  const start = async () => {
    if (!bindings.length) return;
    try {
      await api.post('/live/gateway/start', { flowsheetId, bindings });
      setOn(true); poll();
      timerRef.current = setInterval(poll, 3000);
    } catch { /* ignore */ }
  };
  const stop = async () => {
    clearInterval(timerRef.current); timerRef.current = null;
    setOn(false); setValues([]);
    try { await api.post('/live/gateway/stop', { flowsheetId }); } catch { /* ignore */ }
  };
  useEffect(() => () => {
    clearInterval(timerRef.current);
    if (on) api.post('/live/gateway/stop', { flowsheetId }).catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', padding: '8px 20px', borderBottom: '1px solid #E5E7EB', background: '#F0F9FF' }}>
      <button onClick={on ? stop : start} disabled={!bindings.length}
        style={{ padding: '6px 14px', borderRadius: 8, border: 'none', fontWeight: 700, fontSize: 12.5, color: '#fff',
          cursor: bindings.length ? 'pointer' : 'not-allowed', background: on ? '#DC2626' : (bindings.length ? '#059669' : '#9CA3AF') }}>
        {on ? '■ Stop live inputs' : '▶ Start live inputs'}
      </button>
      {on && <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#059669', boxShadow: '0 0 0 3px rgba(5,150,105,.25)' }} />}
      <span style={{ fontSize: 12, color: '#4B5563' }}>
        {bindings.length
          ? `${bindings.filter(b => b.mode !== 'write').length} read · ${bindings.filter(b => b.mode === 'write').length} write`
          : 'No live bindings yet — set them in a node’s Live Configuration tab'}
      </span>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginLeft: 'auto' }}>
        {values.map(v => {
          const write = v.mode === 'write';
          const c = !v.ok ? { borderColor: '#FCA5A5', background: '#FEF2F2', color: '#991B1B' }
            : write ? { borderColor: '#FDBA74', background: '#FFF7ED', color: '#9A3412' }
                    : { borderColor: '#A7F3D0', background: '#ECFDF5', color: '#065F46' };
          const shown = v.ok ? Number(write ? v.value : v.value).toFixed(2) : '✕';
          return (
            <span key={(v.mode || 'r') + v.nodeId + v.paramKey} title={`${labelOf[v.nodeId]} · ${v.protocol} · ${write ? 'write' : 'read'}`}
              style={{ fontFamily: 'ui-monospace, Consolas, monospace', fontSize: 11, padding: '3px 8px', borderRadius: 6, border: '1px solid', ...c }}>
              {write ? '↑' : '↓'} {labelOf[v.nodeId]}·{v.paramKey} = {shown}
            </span>
          );
        })}
      </div>
    </div>
  );
}

// ── Live animated flowsheet diagram ─────────────────────────────────────────

const DC = {
  panel: '#ffffff', panel2: '#F3F4F6', line: '#E5E7EB', ink: '#111827', ink2: '#4B5563', ink3: '#9CA3AF',
  steel: '#94A3B8', run: '#059669', idle: '#9CA3AF', water: '#2F86BD', water2: '#4AA8DD',
  solid: '#8A5A34', solid2: '#A87142', recycle: '#7C3AED', accent: '#0891B2', accent2: '#22B8CF',
  mediaA: '#D8C48A', mediaB: '#7C8794',
};
const SOLIDS_ST  = new Set(['sludge', 'solids', 'underflow', 'primary_sludge', 'thickened', 'concentrate', 'backwash', 'screenings']);
const RECYCLE_ST = new Set(['ras', 'was', 'recycle', 'internal_recycle']);
const diagEdgeClass = e => {
  const st = e.data && e.data.streamType;
  if ((e.data && e.data.isSolids) || SOLIDS_ST.has(st)) return 'solid';
  if ((e.data && e.data.isRecycle) || RECYCLE_ST.has(st)) return 'recycle';
  return 'water';
};
function diagIconCat(op) {
  op = op || '';
  if (op.includes('inlet')) return 'inlet';
  if (op.includes('outlet')) return 'outlet';
  if (op.includes('pump')) return 'pump';
  if (op.includes('blower')) return 'blower';
  if (op.includes('thicken') || op.includes('clarifier')) return 'clarifier';
  if (op.includes('aeration') || op.includes('activated') || op.includes('reactor') || op.includes('bioreactor') || op.includes('digest')) return 'basin';
  if (op.includes('filter') || op.includes('sand') || op.includes('gac') || op.includes('membrane') || op === 'ro' || op.includes('ro_') || op.includes('uf')) return 'vessel';
  if (op.includes('dos') || op.includes('coagul') || op.includes('polymer') || op === 'ph_adjustment' || op.includes('chlor')) return 'dosing';
  if (op.includes('uv')) return 'uv';
  if (op.includes('valve')) return 'valve';
  if (op.includes('screen') || op.includes('grit')) return 'screen';
  if (op.includes('tank')) return 'tank';
  return 'unit';
}
const pickLiquid = out => (out && (out.effluent || out.filtrate || out.permeate || out.thickened || out.digestate)) || null;
const pickSolids = out => (out && (out.primarySludge || out.thickened || out.WAS || out.concentrate || out.backwash || out.screenings)) || null;
const dfmt = n => (n == null ? '–' : Math.abs(n) >= 1000 ? Math.round(n).toLocaleString() : (+n).toFixed(Math.abs(n) < 10 ? 1 : 0));

function drawDiagram(svg, canvasData, latest, onNodeClick) {
  if (!svg) return;
  while (svg.firstChild) svg.removeChild(svg.firstChild);
  const nodes = (canvasData && canvasData.nodes) || [], edges = (canvasData && canvasData.edges) || [];
  const NS = 'http://www.w3.org/2000/svg';
  const el = (t, a) => { const e = document.createElementNS(NS, t); for (const k in a) e.setAttribute(k, a[k]); return e; };
  if (!nodes.length) {
    svg.setAttribute('viewBox', '0 0 420 100');
    const tx = el('text', { x: 210, y: 54, 'text-anchor': 'middle', fill: DC.ink3, 'font-size': 13, 'font-family': 'system-ui' });
    tx.textContent = 'No units on this flowsheet yet.'; svg.appendChild(tx); return;
  }
  const NW = 156, NH = 88;
  const byId = Object.fromEntries(nodes.map(n => [n.id, n]));
  const ur = (latest && latest.unitResults) || {};
  const sr = (latest && latest.streamResults) || {};   // true per-edge stream table
  let minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9;
  for (const n of nodes) { const p = n.position || { x: 0, y: 0 }; minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); maxX = Math.max(maxX, p.x + NW); maxY = Math.max(maxY, p.y + NH); }
  svg.setAttribute('viewBox', `${minX - 24} ${minY - 24} ${(maxX - minX) + 180} ${(maxY - minY) + 50}`);
  const elbow = (sx, sy, tx, ty) => { const mx = (sx + tx) / 2; return `M ${sx} ${sy} L ${mx} ${sy} L ${mx} ${ty} L ${tx} ${ty}`; };
  const spinG = (cx, cy, fast) => { const s = el('g', { class: 'ispin' + (fast ? ' fast' : '') }); s.setAttribute('style', `transform-box:view-box;transform-origin:${cx}px ${cy}px`); return s; };

  function drawIcon(g, cat, cx, cy, running) {
    const stk = running ? DC.run : DC.steel, mv = running ? DC.run : DC.idle;
    const add = (t, a) => g.appendChild(el(t, a));
    if (cat === 'pump') {
      add('circle', { cx, cy, r: 16, fill: DC.panel, stroke: stk, 'stroke-width': 2.5 });
      const s = spinG(cx, cy, true);
      s.appendChild(el('path', { d: `M${cx} ${cy} L${cx + 10} ${cy - 4} L${cx + 10} ${cy + 4} Z`, fill: mv }));
      s.appendChild(el('path', { d: `M${cx} ${cy} L${cx - 10} ${cy + 4} L${cx - 10} ${cy - 4} Z`, fill: mv }));
      s.appendChild(el('path', { d: `M${cx} ${cy} L${cx - 4} ${cy - 10} L${cx + 4} ${cy - 10} Z`, fill: mv, opacity: .85 }));
      g.appendChild(s); add('circle', { cx, cy, r: 3, fill: DC.panel, stroke: stk, 'stroke-width': 1 });
    } else if (cat === 'blower') {
      add('circle', { cx, cy, r: 16, fill: DC.panel, stroke: stk, 'stroke-width': 2.5 });
      const s = spinG(cx, cy, true);
      for (let i = 0; i < 3; i++) { const a = i * 2 * Math.PI / 3; s.appendChild(el('path', { d: `M${cx} ${cy} L${cx + 11 * Math.cos(a)} ${cy + 11 * Math.sin(a)} L${cx + 6 * Math.cos(a + 0.9)} ${cy + 6 * Math.sin(a + 0.9)} Z`, fill: mv })); }
      g.appendChild(s); add('circle', { cx, cy, r: 3, fill: mv });
    } else if (cat === 'clarifier') {
      add('circle', { cx, cy, r: 18, fill: DC.panel2, stroke: stk, 'stroke-width': 2.5 });
      add('circle', { cx, cy, r: 11, fill: 'none', stroke: DC.line, 'stroke-width': 1 });
      const s = spinG(cx, cy, false);
      s.appendChild(el('rect', { x: cx - 16, y: cy - 1.6, width: 32, height: 3.2, rx: 1.5, fill: mv }));
      s.appendChild(el('path', { d: `M${cx - 16} ${cy} l4 -4 l0 8 Z`, fill: mv }));
      s.appendChild(el('path', { d: `M${cx + 16} ${cy} l-4 -4 l0 8 Z`, fill: mv }));
      g.appendChild(s);
      add('rect', { x: cx - 13, y: cy - 25, width: 26, height: 7, rx: 2, fill: DC.ink2 });
      add('circle', { cx, cy, r: 3.4, fill: DC.steel });
    } else if (cat === 'vessel') {
      add('ellipse', { cx, cy: cy - 16, rx: 16, ry: 5, fill: DC.panel, stroke: stk, 'stroke-width': 2 });
      add('rect', { x: cx - 16, y: cy - 16, width: 32, height: 32, fill: DC.panel2, stroke: stk, 'stroke-width': 2 });
      add('rect', { x: cx - 15, y: cy - 14, width: 30, height: 13, fill: DC.mediaA, opacity: .9 });
      add('rect', { x: cx - 15, y: cy - 1, width: 30, height: 15, fill: DC.mediaB, opacity: .85 });
      add('line', { x1: cx - 15, y1: cy - 1, x2: cx + 15, y2: cy - 1, stroke: DC.ink2, 'stroke-width': 1, 'stroke-dasharray': '3 3' });
      add('ellipse', { cx, cy: cy + 16, rx: 16, ry: 5, fill: DC.panel2, stroke: stk, 'stroke-width': 2 });
    } else if (cat === 'basin') {
      add('rect', { x: cx - 22, y: cy - 15, width: 44, height: 32, rx: 3, fill: DC.water, 'fill-opacity': .4, stroke: stk, 'stroke-width': 2 });
      add('line', { x1: cx - 18, y1: cy + 14, x2: cx + 18, y2: cy + 14, stroke: stk, 'stroke-width': 1.5, 'stroke-dasharray': '2 3' });
      for (let i = 0; i < 4; i++) { const bx = cx - 14 + i * 9; g.appendChild(el('circle', { cx: bx, cy: cy + 12, r: 2.4, class: 'bubble', style: `animation-delay:${i * 0.25}s` })); }
    } else if (cat === 'tank') {
      add('rect', { x: cx - 16, y: cy - 16, width: 32, height: 32, rx: 4, fill: DC.panel2, stroke: stk, 'stroke-width': 2 });
      add('rect', { x: cx - 14, y: cy - 2, width: 28, height: 16, rx: 2, fill: DC.water, 'fill-opacity': .5 });
    } else if (cat === 'dosing') {
      add('rect', { x: cx - 9, y: cy - 8, width: 18, height: 22, rx: 2, fill: DC.panel2, stroke: stk, 'stroke-width': 2 });
      add('path', { d: `M${cx} ${cy - 17} l4 6 a4 4 0 1 1 -8 0 Z`, fill: DC.accent });
      g.appendChild(el('circle', { cx, cy: cy + 16, r: 2.2, class: 'idrop' }));
    } else if (cat === 'uv') {
      add('rect', { x: cx - 18, y: cy - 7, width: 36, height: 14, rx: 3, fill: DC.panel2, stroke: stk, 'stroke-width': 2 });
      add('rect', { x: cx - 14, y: cy - 3, width: 28, height: 6, rx: 3, fill: running ? DC.accent2 : DC.idle });
    } else if (cat === 'valve') {
      add('path', { d: `M${cx - 14} ${cy - 10} L${cx} ${cy} L${cx - 14} ${cy + 10} Z`, fill: DC.panel2, stroke: stk, 'stroke-width': 2 });
      add('path', { d: `M${cx + 14} ${cy - 10} L${cx} ${cy} L${cx + 14} ${cy + 10} Z`, fill: DC.panel2, stroke: stk, 'stroke-width': 2 });
    } else if (cat === 'screen') {
      add('rect', { x: cx - 16, y: cy - 15, width: 32, height: 30, rx: 3, fill: DC.panel2, stroke: stk, 'stroke-width': 2 });
      for (let i = 0; i < 4; i++) add('line', { x1: cx - 10 + i * 7, y1: cy - 12, x2: cx - 10 + i * 7, y2: cy + 12, stroke: stk, 'stroke-width': 1.5 });
    } else if (cat === 'inlet') {
      add('path', { d: `M${cx - 16} ${cy - 12} h32 v10 l-12 12 h-8 l-12 -12 Z`, fill: DC.panel2, stroke: stk, 'stroke-width': 2 });
      g.appendChild(el('circle', { cx, cy: cy + 16, r: 3, class: 'idrop' }));
    } else if (cat === 'outlet') {
      add('rect', { x: cx - 16, y: cy - 14, width: 32, height: 22, rx: 3, fill: DC.panel2, stroke: stk, 'stroke-width': 2 });
      add('path', { d: `M${cx} ${cy + 6} l7 -8 h-14 Z`, fill: running ? DC.accent : DC.idle });
    } else {
      add('rect', { x: cx - 16, y: cy - 14, width: 32, height: 28, rx: 5, fill: DC.panel2, stroke: stk, 'stroke-width': 2 });
    }
  }

  const playing = !!latest;
  for (const e of edges) {
    const s = byId[e.source], t = byId[e.target]; if (!s || !t) continue;
    const sp = s.position || { x: 0, y: 0 }, tp = t.position || { x: 0, y: 0 };
    const sx = sp.x + NW, sy = sp.y + NH / 2, tx = tp.x, ty = tp.y + NH / 2;
    const d = elbow(sx, sy, tx, ty), cls = diagEdgeClass(e);
    const col = cls === 'solid' ? DC.solid2 : cls === 'recycle' ? DC.recycle : DC.water2;
    const casing = cls === 'solid' ? DC.solid : cls === 'recycle' ? DC.recycle : DC.steel;
    svg.appendChild(el('path', { d, fill: 'none', stroke: casing, 'stroke-width': 6, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', opacity: .85 }));
    // Prefer the true per-edge stream value; fall back to the source unit's output
    const out = ur[e.source] && ur[e.source].outputs;
    const stream = sr[e.id] || (cls === 'solid' ? pickSolids(out) : pickLiquid(out));
    const q = stream ? stream.Q : null;
    const on = playing ? (q && q > 0.001) : false;
    svg.appendChild(el('path', { d, fill: 'none', stroke: col, 'stroke-width': 4, 'stroke-linecap': 'round', class: 'efl' + (on ? ' on' : '') }));
    if (stream) {
      const mx = (sx + tx) / 2, my = (sy + ty) / 2;
      const t1 = el('text', { x: mx, y: my - 4, 'text-anchor': 'middle', 'font-family': 'ui-monospace,Consolas,monospace', 'font-size': 9, fill: DC.ink2 });
      t1.textContent = dfmt(stream.Q) + ' m³/d';
      const t2 = el('text', { x: mx, y: my + 8, 'text-anchor': 'middle', 'font-family': 'ui-monospace,Consolas,monospace', 'font-size': 9, fill: DC.ink3 });
      t2.textContent = 'TSS ' + dfmt(stream.TSS);
      svg.appendChild(t1); svg.appendChild(t2);
    }
  }
  for (const n of nodes) {
    const p = n.position || { x: 0, y: 0 }, x = p.x, y = p.y;
    const op = (n.data && n.data.opType) || '', label = (n.data && n.data.label) || op || n.id;
    const out = ur[n.id] && ur[n.id].outputs;
    const liq = pickLiquid(out);
    const running = liq ? (liq.Q > 0.001) : false;
    const g = el('g', { class: running ? 'running' : '' });
    g.style.cursor = 'pointer';
    g.addEventListener('click', () => { if (onNodeClick) onNodeClick(n.id); });
    let stripe = DC.water;
    if (op.includes('outlet')) stripe = DC.accent; else if (op.includes('inlet')) stripe = DC.accent2;
    else if (op.includes('thicken') || op.includes('clarifier')) stripe = DC.solid2;
    else if (op.includes('pump') || op.includes('blower')) stripe = DC.steel;
    g.appendChild(el('rect', { x, y, width: NW, height: NH, rx: 11, fill: DC.panel2, stroke: DC.steel, 'stroke-width': 1.5 }));
    g.appendChild(el('rect', { x, y, width: NW, height: 4, rx: 2, fill: stripe }));
    drawIcon(g, diagIconCat(op), x + NW / 2, y + 30, running);
    const lt = el('text', { x: x + NW / 2, y: y + 60, 'text-anchor': 'middle', 'font-family': 'system-ui', 'font-weight': 700, 'font-size': 12, fill: DC.ink });
    lt.textContent = label.length > 22 ? label.slice(0, 21) + '…' : label; g.appendChild(lt);
    const tt = el('text', { x: x + NW / 2, y: y + 72, 'text-anchor': 'middle', 'font-family': 'ui-monospace,Consolas,monospace', 'font-size': 9, fill: DC.ink3 });
    tt.textContent = op; g.appendChild(tt);
    const met = (ur[n.id] && ur[n.id].metrics) || {};
    if (met.tank_level_m != null) {
      const arrow = met.level_trend === 'rising' ? '▲' : met.level_trend === 'falling' ? '▼' : '■';
      const col = met.level_trend === 'rising' ? '#DC2626' : met.level_trend === 'falling' ? '#059669' : DC.accent;
      const vt = el('text', { x: x + NW / 2, y: y + 83, 'text-anchor': 'middle', 'font-family': 'ui-monospace,Consolas,monospace', 'font-size': 9.5, 'font-weight': 700, fill: col });
      vt.textContent = 'Lvl ' + met.tank_level_m + ' m ' + arrow; g.appendChild(vt);
    } else if (liq) {
      const vt = el('text', { x: x + NW / 2, y: y + 83, 'text-anchor': 'middle', 'font-family': 'ui-monospace,Consolas,monospace', 'font-size': 9.5, 'font-weight': 600, fill: DC.accent });
      vt.textContent = 'Q ' + dfmt(liq.Q) + ' · TSS ' + dfmt(liq.TSS); g.appendChild(vt);
    }
    svg.appendChild(g);
  }
}

const DIAGRAM_CSS = `
.lsimdiag .efl{fill:none;stroke-linecap:round;stroke-dasharray:2 12;opacity:0}
.lsimdiag .efl.on{opacity:.95;animation:lmarch .8s linear infinite}
.lsimdiag .ispin{transform-box:view-box}
.lsimdiag .running .ispin{animation:lspin 1.05s linear infinite}
.lsimdiag .running .ispin.fast{animation-duration:.55s}
.lsimdiag .bubble{opacity:0;fill:#22B8CF}
.lsimdiag .running .bubble{animation:lrise 1.5s ease-in infinite}
.lsimdiag .idrop{opacity:0;fill:#4AA8DD}
.lsimdiag .running .idrop{animation:ldrip 1.3s ease-in infinite}
@keyframes lmarch{to{stroke-dashoffset:-28}}
@keyframes lspin{to{transform:rotate(360deg)}}
@keyframes lrise{0%{opacity:0;transform:translateY(0)}25%{opacity:.9}100%{opacity:0;transform:translateY(-22px)}}
@keyframes ldrip{0%{opacity:0;transform:translateY(-4px)}30%{opacity:1}100%{opacity:0;transform:translateY(12px)}}
@media (prefers-reduced-motion:reduce){.lsimdiag .efl.on,.lsimdiag .running .ispin,.lsimdiag .running .bubble,.lsimdiag .running .idrop{animation:none}}
`;

function LiveDiagram({ canvasData, sendEvent, paramDefs }) {
  const steps  = useLiveSimStore(s => s.steps);
  const ref    = useRef(null);
  const latest = steps.length ? steps[steps.length - 1] : null;
  const [sel, setSel]   = useState(null);   // selected nodeId
  const [edits, setEdits] = useState({});   // { nodeId: { key: value } } local overlay

  useEffect(() => { drawDiagram(ref.current, canvasData, latest, setSel); }, [canvasData, latest]);

  const node = (canvasData?.nodes || []).find(n => n.id === sel);
  const defs = node ? (paramDefs?.[node.data?.opType] || []) : [];
  const valOf = (key) => {
    const e = edits[sel]?.[key];
    if (e !== undefined) return e;
    return node?.data?.params?.[key] ?? '';
  };
  const setVal = (key, raw, type) => {
    const val = type === 'number' ? (raw === '' ? '' : Number(raw)) : raw;
    setEdits(p => ({ ...p, [sel]: { ...(p[sel] || {}), [key]: val } }));
    if (sendEvent && val !== '') sendEvent('params:update', { nodeId: sel, params: { [key]: val } });
  };

  return (
    <div style={{ flex: 1, display: 'flex', minWidth: 0 }}>
      <div className="lsimdiag" style={{ flex: 1, minWidth: 0, overflow: 'auto', padding: '10px 16px' }}>
        <style>{DIAGRAM_CSS}</style>
        <svg ref={ref} viewBox="0 0 1200 460" style={{ width: '100%', height: '100%', minWidth: 820, display: 'block' }} />
      </div>
      {node && (
        <div style={{ width: 250, borderLeft: '1px solid #E5E7EB', padding: '12px 14px', overflowY: 'auto', background: '#FBFDFF' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 2 }}>
            <span style={{ fontWeight: 700, fontSize: 13, color: '#1F4E79' }}>{node.data?.label}</span>
            <button onClick={() => setSel(null)} style={{ border: 'none', background: 'none', cursor: 'pointer', color: '#9CA3AF', fontSize: 15 }}>✕</button>
          </div>
          <div style={{ fontSize: 11, color: '#9CA3AF', marginBottom: 10 }}>Live edit — changes recompute the flow</div>
          {(() => {
            const m = latest?.unitResults?.[sel]?.metrics;
            if (!m || m.tank_level_m == null) return null;
            const arrow = m.level_trend === 'rising' ? '▲ rising' : m.level_trend === 'falling' ? '▼ falling' : '■ steady';
            const col = m.level_trend === 'rising' ? '#DC2626' : m.level_trend === 'falling' ? '#059669' : '#0891B2';
            const row = (k, v) => (
              <div key={k} style={{ display: 'flex', justifyContent: 'space-between', fontFamily: 'ui-monospace,Consolas,monospace', fontSize: 12 }}>
                <span style={{ color: '#6B7280' }}>{k}</span><span style={{ fontWeight: 700 }}>{v}</span>
              </div>
            );
            return (
              <div style={{ background: '#F0F9FF', border: '1px solid #BAE6FD', borderRadius: 8, padding: '8px 10px', marginBottom: 12, display: 'flex', flexDirection: 'column', gap: 3 }}>
                <div style={{ fontSize: 10, fontWeight: 700, color: '#0369A1', textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: 2 }}>Tank balance (live)</div>
                {row('Inflow', (m.Q_in_m3d ?? '—') + ' m³/d')}
                {row('Outflow', (m.Q_out_m3d ?? '—') + ' m³/d')}
                {row('Level', m.tank_level_m + ' m (' + m.tank_level_pct + '%)')}
                <div style={{ textAlign: 'right', fontWeight: 800, color: col, fontSize: 12 }}>{arrow}</div>
              </div>
            );
          })()}
          {defs.length === 0 && <div style={{ fontSize: 12, color: '#9CA3AF' }}>No editable inputs.</div>}
          {defs.map(def => (
            <label key={def.key} style={{ display: 'flex', flexDirection: 'column', gap: 3, marginBottom: 9 }}>
              <span style={{ fontSize: 10.5, color: '#6B7280', fontWeight: 600 }}>{def.label}</span>
              {def.type === 'select' ? (
                <select value={valOf(def.key)} onChange={e => setVal(def.key, e.target.value, 'select')}
                  style={{ padding: '6px 8px', border: '1px solid #D1D5DB', borderRadius: 7, fontSize: 12.5 }}>
                  <option value="">—</option>
                  {def.options.map(o => <option key={o} value={o}>{o}</option>)}
                </select>
              ) : (
                <input type="number" value={valOf(def.key)} step={def.step} min={def.min} max={def.max}
                  onChange={e => setVal(def.key, e.target.value, 'number')}
                  style={{ padding: '6px 8px', border: '1px solid #D1D5DB', borderRadius: 7, fontSize: 12.5 }} />
              )}
              {def.hint && <span style={{ fontSize: 10, color: '#9CA3AF' }}>{def.hint}</span>}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Main Dashboard Overlay ──────────────────────────────────────────────────

export default function LiveSimPanel({ sendEvent, buildNodeParams, canvasData, flowsheetId, paramDefs, wsConnected, onClose, compareContent }) {
  const status    = useLiveSimStore(s => s.status);
  const startedBy = useLiveSimStore(s => s.startedBy);
  const error     = useLiveSimStore(s => s.error);
  const [tab, setTab] = useState('diagram');

  const statusLabel = {
    idle: 'Ready', running: 'Running', paused: 'Paused',
    cancelled: 'Stopped',
  }[status] || status;

  const statusColor = {
    idle: '#6B7280', running: '#059669', paused: '#D97706',
    cancelled: '#DC2626',
  }[status] || '#6B7280';

  return (
    <div style={S.overlay}>
      <div style={S.dashboard}>
        {/* Header bar */}
        <div style={S.header}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <span style={{ fontWeight: 700, fontSize: 16, color: '#1F4E79' }}>
              Live Simulation Dashboard
            </span>
            <span style={{
              fontSize: 11, fontWeight: 700, padding: '3px 10px', borderRadius: 4,
              background: statusColor + '18', color: statusColor,
            }}>
              {statusLabel}
            </span>
            {/* WebSocket connection indicator */}
            <span style={{
              fontSize: 10, fontWeight: 600, padding: '2px 8px', borderRadius: 4,
              background: wsConnected ? '#D1FAE5' : '#FEE2E2',
              color: wsConnected ? '#065F46' : '#991B1B',
            }}>
              {wsConnected ? 'WS Connected' : 'WS Disconnected'}
            </span>
            {startedBy && status === 'running' && (
              <span style={{ fontSize: 12, color: '#6B7280' }}>Started by {startedBy}</span>
            )}
          </div>
          <button style={S.closeBtn} onClick={onClose}>&times;</button>
        </div>

        {/* Error banner */}
        {error && (
          <div style={{ padding: '8px 16px', background: '#FEF2F2', color: '#991B1B', fontSize: 13 }}>
            Error: {error}
          </div>
        )}

        {/* Controls row */}
        <div style={{ padding: '12px 20px', borderBottom: '1px solid #E5E7EB' }}>
          <TransportControls sendEvent={sendEvent} buildNodeParams={buildNodeParams} canvasData={canvasData} wsConnected={wsConnected} />
        </div>

        {/* Live device inputs — start/stop the gateway; values override the sim */}
        <LiveInputsBar flowsheetId={flowsheetId} canvasData={canvasData} />

        {/* KPI strip — pinned fixed setpoints + live influent/effluent */}
        <KpiStrip canvasData={canvasData} />

        {/* Tabs */}
        <div style={{ display: 'flex', gap: 4, padding: '0 20px', borderBottom: '1px solid #E5E7EB' }}>
          {[['diagram', 'Live Diagram'], ['trends', 'Trend'], ...(compareContent ? [['compare', 'Compare']] : [])].map(([k, lbl]) => (
            <button key={k} onClick={() => setTab(k)} style={{
              padding: '10px 16px', border: 'none', background: 'none', cursor: 'pointer',
              fontSize: 13, fontWeight: 600, color: tab === k ? '#0891B2' : '#6B7280',
              borderBottom: tab === k ? '2px solid #0891B2' : '2px solid transparent',
            }}>{lbl}</button>
          ))}
        </div>

        {/* Body */}
        {tab === 'compare' ? (
          <div style={{ flex: 1, overflow: 'auto', padding: '12px 20px' }}>
            {compareContent}
          </div>
        ) : tab === 'diagram' ? (
          <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
            <LiveDiagram canvasData={canvasData} sendEvent={sendEvent} paramDefs={paramDefs} />
          </div>
        ) : (
          <>
            <div style={{ padding: '10px 20px', borderBottom: '1px solid #E5E7EB' }}>
              <NodeTrendPicker canvasData={canvasData} />
            </div>
            <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
              <div style={{ flex: 1, padding: '12px 20px', display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                  <span style={{ fontSize: 11, fontWeight: 700, color: '#9CA3AF', textTransform: 'uppercase' }}>Live Trend</span>
                  <XAxisSelector />
                  <CsvExportButton />
                </div>
                <div style={{ flex: 1, minHeight: 200 }}><LiveTrendChart /></div>
              </div>
              <div style={{ width: 320, borderLeft: '1px solid #E5E7EB', padding: '12px 16px', overflowY: 'auto' }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: '#9CA3AF', textTransform: 'uppercase', marginBottom: 8 }}>Current Values</div>
                <ValuesTable />
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ── Quick Trend Window (draggable, resizable, minimizable) ───────────────────

const TREND_DEFAULT_W = 780;
const TREND_DEFAULT_H = 460;
const TREND_MIN_W = 420;
const TREND_MIN_H = 260;
const TREND_TASKBAR_H = 36;

export function TrendOverlay({ onClose }) {
  const status        = useLiveSimStore(s => s.status);
  const watchedParams = useLiveSimStore(s => s.watchedParams);

  const statusLabel = {
    idle: 'Idle', running: 'Running', paused: 'Paused', cancelled: 'Stopped',
  }[status] || status;
  const statusColor = {
    idle: '#6B7280', running: '#059669', paused: '#D97706', cancelled: '#DC2626',
  }[status] || '#6B7280';

  // ── Window state ────────────────────────────────────────────────────────────
  const [minimized, setMinimized] = useState(false);
  const [pos, setPos]   = useState(() => ({
    x: Math.max(40, Math.round((window.innerWidth - TREND_DEFAULT_W) / 2)),
    y: Math.max(40, Math.round((window.innerHeight - TREND_DEFAULT_H) / 2 - 40)),
  }));
  const [size, setSize] = useState({ w: TREND_DEFAULT_W, h: TREND_DEFAULT_H });

  // ── Drag handling ───────────────────────────────────────────────────────────
  const dragRef = useRef(null);

  const onDragStart = useCallback((e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    dragRef.current = { startX: e.clientX, startY: e.clientY, origX: pos.x, origY: pos.y };
    const onMove = (ev) => {
      const d = dragRef.current;
      if (!d) return;
      const nx = d.origX + (ev.clientX - d.startX);
      const ny = d.origY + (ev.clientY - d.startY);
      setPos({
        x: Math.max(0, Math.min(window.innerWidth - 120, nx)),
        y: Math.max(0, Math.min(window.innerHeight - 40, ny)),
      });
    };
    const onUp = () => {
      dragRef.current = null;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [pos]);

  // ── Resize handling ─────────────────────────────────────────────────────────
  const resizeRef = useRef(null);

  const onResizeStart = useCallback((e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    resizeRef.current = { startX: e.clientX, startY: e.clientY, origW: size.w, origH: size.h };
    const onMove = (ev) => {
      const r = resizeRef.current;
      if (!r) return;
      setSize({
        w: Math.max(TREND_MIN_W, r.origW + (ev.clientX - r.startX)),
        h: Math.max(TREND_MIN_H, r.origH + (ev.clientY - r.startY)),
      });
    };
    const onUp = () => {
      resizeRef.current = null;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [size]);

  // ── Minimized pill (taskbar) ────────────────────────────────────────────────
  if (minimized) {
    return (
      <div style={{
        position: 'fixed', bottom: 8, left: pos.x, zIndex: 1100,
        background: '#1F4E79', color: '#fff', borderRadius: 8,
        padding: '6px 14px', display: 'flex', alignItems: 'center', gap: 8,
        boxShadow: '0 2px 12px rgba(0,0,0,0.25)', cursor: 'pointer',
        fontSize: 12, fontWeight: 600, userSelect: 'none',
      }}
        onClick={() => setMinimized(false)}
      >
        <span style={{
          width: 8, height: 8, borderRadius: '50%',
          background: statusColor, flexShrink: 0,
        }} />
        Live Trend
        {watchedParams.length > 0 && (
          <span style={{ opacity: 0.7, fontWeight: 400 }}>
            ({watchedParams.length} tag{watchedParams.length !== 1 ? 's' : ''})
          </span>
        )}
        <button
          onClick={(e) => { e.stopPropagation(); onClose(); }}
          style={{
            background: 'none', border: 'none', color: '#fff', cursor: 'pointer',
            fontSize: 16, padding: 0, marginLeft: 4, opacity: 0.7, lineHeight: 1,
          }}
        >&times;</button>
      </div>
    );
  }

  // ── Full floating window ────────────────────────────────────────────────────
  return (
    <div style={{
      position: 'fixed', left: pos.x, top: pos.y,
      width: size.w, height: size.h,
      zIndex: 1100,
      background: '#fff', borderRadius: 10,
      boxShadow: '0 8px 32px rgba(0,0,0,0.28)',
      display: 'flex', flexDirection: 'column', overflow: 'hidden',
      border: '1px solid #D1D5DB',
    }}>
      {/* Title bar (draggable) */}
      <div
        onMouseDown={onDragStart}
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '8px 14px', background: '#F9FAFB', borderBottom: '1px solid #E5E7EB',
          cursor: 'move', userSelect: 'none', borderRadius: '10px 10px 0 0', flexShrink: 0,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontWeight: 700, fontSize: 13, color: '#1F4E79' }}>Live Trend</span>
          <span style={{
            fontSize: 9, fontWeight: 700, padding: '1px 6px', borderRadius: 3,
            background: statusColor + '18', color: statusColor,
          }}>
            {statusLabel}
          </span>
          {watchedParams.length > 0 && (
            <span style={{ fontSize: 10, color: '#9CA3AF' }}>
              {watchedParams.length} tag{watchedParams.length !== 1 ? 's' : ''}
            </span>
          )}
          <XAxisSelector />
          <CsvExportButton />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
          {/* Minimize */}
          <button
            onClick={(e) => { e.stopPropagation(); setMinimized(true); }}
            title="Minimize"
            style={T.winBtn}
          >
            &#x2500;
          </button>
          {/* Close */}
          <button
            onClick={(e) => { e.stopPropagation(); onClose(); }}
            title="Close"
            style={{ ...T.winBtn, color: '#DC2626' }}
          >
            &times;
          </button>
        </div>
      </div>

      {/* Content: chart + values table */}
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden', minHeight: 0 }}>
        <div style={{ flex: 1, padding: '8px 14px', display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          <div style={{ flex: 1, minHeight: 100 }}>
            {watchedParams.length === 0 ? (
              <div style={S.placeholder}>
                No tags configured. Open <strong>Live Sim</strong> to add trend tags.
              </div>
            ) : (
              <LiveTrendChart />
            )}
          </div>
        </div>
        {size.w >= 600 && (
          <div style={{ width: 240, borderLeft: '1px solid #E5E7EB', padding: '8px 12px', overflowY: 'auto' }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: '#9CA3AF', textTransform: 'uppercase', marginBottom: 6 }}>
              Values
            </div>
            <ValuesTable />
          </div>
        )}
      </div>

      {/* Resize handle */}
      <div
        onMouseDown={onResizeStart}
        style={{
          position: 'absolute', right: 0, bottom: 0, width: 18, height: 18,
          cursor: 'nwse-resize', display: 'flex', alignItems: 'center',
          justifyContent: 'center', color: '#9CA3AF', fontSize: 10, userSelect: 'none',
        }}
      >
        &#x25E2;
      </div>
    </div>
  );
}

/** Trend window button styles. */
const T = {
  winBtn: {
    background: 'none', border: 'none', cursor: 'pointer',
    width: 28, height: 24, borderRadius: 4,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    fontSize: 16, color: '#6B7280', lineHeight: 1,
  },
};

// ── Styles ──────────────────────────────────────────────────────────────────

const S = {
  overlay: {
    position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
    background: 'rgba(0,0,0,0.5)', zIndex: 1000,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    padding: 12,
  },
  dashboard: {
    background: '#fff', borderRadius: 10, boxShadow: '0 25px 50px rgba(0,0,0,0.25)',
    width: '100%', maxWidth: 1500, height: '94vh', maxHeight: '94vh',
    display: 'flex', flexDirection: 'column', overflow: 'hidden',
  },
  header: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    padding: '14px 20px', borderBottom: '1px solid #E5E7EB', background: '#F9FAFB',
    borderRadius: '12px 12px 0 0',
  },
  closeBtn: {
    background: 'none', border: 'none', cursor: 'pointer',
    color: '#6B7280', fontSize: 22, minWidth: 36, minHeight: 36,
    borderRadius: 6, display: 'flex', alignItems: 'center', justifyContent: 'center',
  },
  btn: {
    border: 'none', borderRadius: 6, padding: '8px 18px', fontWeight: 600,
    cursor: 'pointer', fontSize: 13, minHeight: 38,
  },
  placeholder: {
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    height: '100%', fontSize: 14, color: '#9CA3AF', fontStyle: 'italic',
    textAlign: 'center', padding: 32,
  },
  chip: {
    display: 'inline-flex', alignItems: 'center', gap: 3,
    fontSize: 11, fontWeight: 600, padding: '3px 8px', borderRadius: 12,
    border: '1.5px solid', background: '#fff',
  },
  chipX: {
    background: 'none', border: 'none', cursor: 'pointer',
    fontSize: 14, lineHeight: 1, padding: 0, marginLeft: 2, color: 'inherit', opacity: 0.6,
  },
  addBtn: {
    fontSize: 11, fontWeight: 600, color: '#059669', background: 'none',
    border: '1.5px dashed #A7F3D0', borderRadius: 12, padding: '3px 10px', cursor: 'pointer',
  },
  pickerContainer: {
    background: '#F9FAFB', borderRadius: 8, marginTop: 6,
    border: '1px solid #E5E7EB', maxHeight: 260, overflowY: 'auto',
  },
  accordionHeader: {
    width: '100%', display: 'flex', alignItems: 'center',
    padding: '8px 12px', background: 'none', border: 'none',
    cursor: 'pointer', textAlign: 'left',
  },
  paramGrid: {
    display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 2,
    padding: '4px 12px 10px 28px',
  },
  pickerLabel: {
    display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, cursor: 'pointer',
  },
  th: { padding: '6px 8px', textAlign: 'left', fontSize: 11, color: '#6B7280', fontWeight: 700, textTransform: 'uppercase' },
  td: { padding: '6px 8px', fontSize: 12 },
};
