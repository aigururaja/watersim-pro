/**
 * LiveSimPanel — Full-screen dashboard overlay for real-time simulation.
 *
 * Renders as a large overlay on top of the canvas with:
 * - Transport controls (start/pause/resume/stop) + speed slider
 * - Tag picker to add/remove trend variables (influent & effluent)
 * - Live Recharts trend chart that grows as steps stream in
 * - Peak summary table
 * - Current values table
 *
 * The panel sends current canvas data (nodes + edges) with the
 * sim:live:start message so the server uses the latest unsaved state.
 */

import React, { useState, useMemo } from 'react';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from 'recharts';
import useLiveSimStore, { STREAM_PARAMS } from '../../store/liveSimStore';

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Map log-scale slider (0–1) <-> speed (1–1000). */
const sliderToSpeed = (v) => Math.round(Math.pow(10, v * 3));
const speedToSlider = (s) => Math.log10(Math.max(1, s)) / 3;

/** Get colour for a watched param (influent = base, effluent = darker). */
function paramColor(key, source) {
  const base = STREAM_PARAMS.find(p => p.key === key)?.color || '#6B7280';
  if (source === 'effluent') {
    return base.replace(/[\da-f]{2}/gi, h =>
      Math.max(0, Math.round(parseInt(h, 16) * 0.75)).toString(16).padStart(2, '0')
    );
  }
  return base;
}

// ── Transport Controls ──────────────────────────────────────────────────────

const FLAT_PROFILE = Array.from({ length: 24 }, (_, h) => ({
  hour: h, Q_scale: 1, BOD_scale: 1, TN_scale: 1, TP_scale: 1, TSS_scale: 1,
}));

function TransportControls({ sendEvent, buildNodeParams, canvasData, wsConnected }) {
  const status      = useLiveSimStore(s => s.status);
  const currentStep = useLiveSimStore(s => s.currentStep);
  const totalSteps  = useLiveSimStore(s => s.totalSteps);
  const speed       = useLiveSimStore(s => s.speed);
  const reset       = useLiveSimStore(s => s.reset);

  const [sliderVal, setSliderVal] = useState(speedToSlider(speed));
  const [constantInlet, setConstantInlet] = useState(false);

  const pct = totalSteps ? Math.round((currentStep / totalSteps) * 100) : 0;
  const isIdle = status === 'idle' || status === 'completed' || status === 'cancelled';

  const handleStart = () => {
    reset();
    const spd = sliderToSpeed(sliderVal);
    const tsc = { hoursToSimulate: 24 };
    if (constantInlet) tsc.profile = FLAT_PROFILE;
    sendEvent('sim:live:start', {
      nodeParams: buildNodeParams ? buildNodeParams() : {},
      timeSeriesConfig: tsc,
      speed: spd,
      canvasData: canvasData || { nodes: [], edges: [] },
    });
  };

  const canStart = wsConnected && isIdle;

  const handleSpeedChange = (val) => {
    setSliderVal(val);
    const spd = sliderToSpeed(val);
    if (status === 'running' || status === 'paused') {
      sendEvent('sim:live:speed', { speed: spd });
    }
  };

  const displaySpeed = sliderToSpeed(sliderVal);
  const secPerStep = (3600 / displaySpeed).toFixed(1);

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

      {/* Progress */}
      <div style={{ flex: 1, minWidth: 200 }}>
        <div style={{ fontSize: 11, color: '#6B7280', marginBottom: 3 }}>
          Step {currentStep} / {totalSteps || '\u2014'} ({pct}%)
        </div>
        <div style={S.progressOuter}>
          <div style={{ ...S.progressInner, width: `${pct}%` }} />
        </div>
      </div>

      {/* Speed slider */}
      <div style={{ minWidth: 220 }}>
        <label style={{ fontSize: 11, color: '#6B7280' }}>
          Speed: <strong>{displaySpeed}x</strong> ({secPerStep}s / step)
        </label>
        <input
          type="range" min={0} max={1} step={0.01}
          value={sliderVal}
          onChange={e => handleSpeedChange(parseFloat(e.target.value))}
          style={{ width: '100%', marginTop: 2 }}
        />
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: '#9CA3AF' }}>
          <span>1x</span><span>10x</span><span>100x</span><span>1000x</span>
        </div>
      </div>

      {/* Constant inlet toggle */}
      <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#374151', cursor: 'pointer' }}>
        <input type="checkbox" checked={constantInlet} onChange={e => setConstantInlet(e.target.checked)} disabled={!isIdle} />
        Constant Inlet (no diurnal variation)
      </label>
    </div>
  );
}

// ── Variable Picker (always visible) ────────────────────────────────────────

function VariablePicker() {
  const watchedParams     = useLiveSimStore(s => s.watchedParams);
  const addWatchedParam   = useLiveSimStore(s => s.addWatchedParam);
  const removeWatchedParam = useLiveSimStore(s => s.removeWatchedParam);
  const [open, setOpen]   = useState(false);

  return (
    <div>
      {/* Active chips */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 6, alignItems: 'center' }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: '#6B7280', marginRight: 4 }}>Tags:</span>
        {watchedParams.map(wp => (
          <span key={`${wp.source}-${wp.key}`} style={{
            ...S.chip,
            borderColor: paramColor(wp.key, wp.source),
            color: paramColor(wp.key, wp.source),
          }}>
            {wp.label}
            <button style={S.chipX} onClick={() => removeWatchedParam(wp.key, wp.source)}>&times;</button>
          </span>
        ))}
        <button style={S.addBtn} onClick={() => setOpen(v => !v)}>
          {open ? '- Close' : '+ Add Tag'}
        </button>
      </div>

      {/* Dropdown picker */}
      {open && (
        <div style={S.pickerGrid}>
          <div>
            <div style={S.pickerHeader}>Influent</div>
            {STREAM_PARAMS.map(p => {
              const checked = !!watchedParams.find(w => w.key === p.key && w.source === 'influent');
              return (
                <label key={`inf-${p.key}`} style={S.pickerLabel}>
                  <input type="checkbox" checked={checked}
                    onChange={e => e.target.checked
                      ? addWatchedParam(p.key, 'influent')
                      : removeWatchedParam(p.key, 'influent')
                    }
                  />
                  <span style={{ color: p.color }}>{p.label}</span>
                </label>
              );
            })}
          </div>
          <div>
            <div style={S.pickerHeader}>Effluent</div>
            {STREAM_PARAMS.map(p => {
              const checked = !!watchedParams.find(w => w.key === p.key && w.source === 'effluent');
              return (
                <label key={`eff-${p.key}`} style={S.pickerLabel}>
                  <input type="checkbox" checked={checked}
                    onChange={e => e.target.checked
                      ? addWatchedParam(p.key, 'effluent')
                      : removeWatchedParam(p.key, 'effluent')
                    }
                  />
                  <span style={{ color: paramColor(p.key, 'effluent') }}>{p.label}</span>
                </label>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Live Trend Chart ────────────────────────────────────────────────────────

function LiveTrendChart() {
  const steps         = useLiveSimStore(s => s.steps);
  const watchedParams = useLiveSimStore(s => s.watchedParams);

  const chartData = useMemo(() => steps.map(step => {
    const point = { hour: `${step.hour}h` };
    for (const wp of watchedParams) {
      const src = wp.source === 'influent' ? step.summary?.influent : step.summary?.effluent;
      point[wp.label] = src?.[wp.key] ?? null;
    }
    return point;
  }), [steps, watchedParams]);

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
        Click <strong>Start Live</strong> to begin the simulation. Data will appear here as each hour is computed.
      </div>
    );
  }

  return (
    <ResponsiveContainer width="100%" height="100%">
      <LineChart data={chartData} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#E5E7EB" />
        <XAxis dataKey="hour" tick={{ fontSize: 11 }} interval={Math.max(0, Math.floor(chartData.length / 12) - 1)} />
        <YAxis tick={{ fontSize: 11 }} />
        <Tooltip contentStyle={{ fontSize: 12 }} />
        <Legend iconSize={12} wrapperStyle={{ fontSize: 11 }} />
        {watchedParams.map(wp => (
          <Line
            key={wp.label}
            type="monotone"
            dataKey={wp.label}
            stroke={paramColor(wp.key, wp.source)}
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
      const src = wp.source === 'influent' ? latest.summary?.influent : latest.summary?.effluent;
      const current = src?.[wp.key] ?? null;

      let peak = -Infinity;
      for (const step of steps) {
        const s2 = wp.source === 'influent' ? step.summary?.influent : step.summary?.effluent;
        const val = s2?.[wp.key];
        if (val != null && val > peak) peak = val;
      }

      const paramDef = STREAM_PARAMS.find(p => p.key === wp.key);
      return {
        label: wp.label,
        current,
        peak: peak === -Infinity ? null : peak,
        unit: paramDef?.unit || '',
        color: paramColor(wp.key, wp.source),
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
    completed: 'Completed', cancelled: 'Cancelled',
  }[status] || status;

  const statusColor = {
    idle: '#6B7280', running: '#059669', paused: '#D97706',
    completed: '#2563EB', cancelled: '#DC2626',
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
          <VariablePicker />
        </div>

        {/* Main content: chart + values table */}
        <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
          {/* Chart area (takes most space) */}
          <div style={{ flex: 1, padding: '12px 20px', display: 'flex', flexDirection: 'column', minWidth: 0 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: '#9CA3AF', textTransform: 'uppercase', marginBottom: 8 }}>
              Live Trend
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
  progressOuter: {
    width: '100%', height: 8, background: '#F3F4F6', borderRadius: 4, overflow: 'hidden',
  },
  progressInner: {
    height: '100%', background: '#059669', borderRadius: 4, transition: 'width 0.3s ease',
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
  pickerGrid: {
    display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12,
    background: '#F9FAFB', borderRadius: 8, padding: 12, marginTop: 6,
  },
  pickerHeader: {
    fontSize: 11, fontWeight: 700, color: '#6B7280', textTransform: 'uppercase', marginBottom: 6,
  },
  pickerLabel: {
    display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, cursor: 'pointer', marginBottom: 3,
  },
  th: { padding: '6px 8px', textAlign: 'left', fontSize: 11, color: '#6B7280', fontWeight: 700, textTransform: 'uppercase' },
  td: { padding: '6px 8px', fontSize: 12 },
};
