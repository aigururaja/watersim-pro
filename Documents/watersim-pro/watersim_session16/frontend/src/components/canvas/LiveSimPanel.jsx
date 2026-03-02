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

  const [constantInlet, setConstantInlet] = useState(false);

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
        Constant Inlet (no diurnal variation)
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

// ── Main Dashboard Overlay ──────────────────────────────────────────────────

export default function LiveSimPanel({ sendEvent, buildNodeParams, canvasData, wsConnected, onClose }) {
  const status    = useLiveSimStore(s => s.status);
  const startedBy = useLiveSimStore(s => s.startedBy);
  const error     = useLiveSimStore(s => s.error);

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

        {/* Tag picker row */}
        <div style={{ padding: '10px 20px', borderBottom: '1px solid #E5E7EB' }}>
          <VariablePicker canvasData={canvasData} />
        </div>

        {/* Main content: chart + values table */}
        <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
          {/* Chart area (takes most space) */}
          <div style={{ flex: 1, padding: '12px 20px', display: 'flex', flexDirection: 'column', minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
              <span style={{ fontSize: 11, fontWeight: 700, color: '#9CA3AF', textTransform: 'uppercase' }}>
                Live Trend
              </span>
              <XAxisSelector />
              <CsvExportButton />
            </div>
            <div style={{ flex: 1, minHeight: 200 }}>
              <LiveTrendChart />
            </div>
          </div>

          {/* Values table (right side) */}
          <div style={{ width: 320, borderLeft: '1px solid #E5E7EB', padding: '12px 16px', overflowY: 'auto' }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: '#9CA3AF', textTransform: 'uppercase', marginBottom: 8 }}>
              Current Values
            </div>
            <ValuesTable />
          </div>
        </div>
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
    padding: 24,
  },
  dashboard: {
    background: '#fff', borderRadius: 12, boxShadow: '0 25px 50px rgba(0,0,0,0.25)',
    width: '100%', maxWidth: 1100, height: '85vh', maxHeight: 720,
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
