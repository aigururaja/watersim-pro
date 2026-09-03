import React, { useMemo } from 'react';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  BarChart, Bar, Cell, ReferenceLine,
} from 'recharts';

/**
 * LiveChartsDock — collapsible chart strip under the flowsheet canvas.
 *
 * Every simulation run (live preview or manual) appends one point to
 * `history`; the dock shows how effluent quality and cost respond as the
 * user tweaks the flowsheet, plus current effluent vs permit limits.
 *
 * Charts are fixed-size (no ResponsiveContainer) inside a horizontal
 * scroller: cheaper (no resize observers) and stable in tests.
 */

const METRICS = [
  { key: 'BOD', color: '#2563EB' },
  { key: 'TSS', color: '#0D9488' },
  { key: 'TN',  color: '#D97706' },
  { key: 'NH4', color: '#7C3AED' },
  { key: 'TP',  color: '#DC2626' },
];

// permitLimitsUsed shapes vary; resolve a numeric limit for a param or null.
function resolveLimit(limits, param) {
  if (!limits) return null;
  const src = limits.limits && typeof limits.limits === 'object' ? limits.limits : limits;
  const raw = src[param] ?? src[param?.toLowerCase?.()] ?? null;
  if (raw == null) return null;
  if (typeof raw === 'number') return raw;
  if (typeof raw === 'object') return raw.max ?? raw.limit ?? raw.value ?? null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

const fmtNum = (v, dp = 1) =>
  v == null ? '—' : Number(v).toLocaleString('en-US', { maximumFractionDigits: dp });

function Delta({ cur, prev, downIsGood = true, dp = 1, prefix = '' }) {
  if (cur == null || prev == null || cur === prev) return null;
  const up = cur > prev;
  const good = downIsGood ? !up : up;
  return (
    <span style={{ marginLeft: 6, fontSize: 11, fontWeight: 700, color: good ? '#16A34A' : '#DC2626' }}>
      {up ? '▲' : '▼'}{prefix}{fmtNum(Math.abs(cur - prev), dp)}
    </span>
  );
}

const S = {
  dock: {
    borderTop: '2px solid #E5E7EB', background: '#fff', flexShrink: 0,
  },
  header: {
    display: 'flex', alignItems: 'center', gap: 10, padding: '6px 14px',
    fontSize: 12, fontWeight: 700, color: '#1F4E79', borderBottom: '1px solid #F3F4F6',
  },
  chip: (ok) => ({
    fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 10,
    background: ok == null ? '#F3F4F6' : ok ? '#D1FAE5' : '#FEE2E2',
    color:      ok == null ? '#6B7280' : ok ? '#065F46' : '#991B1B',
  }),
  smallBtn: {
    fontSize: 11, fontWeight: 600, padding: '2px 10px', borderRadius: 6,
    background: '#F3F4F6', color: '#374151', border: '1px solid #D1D5DB', cursor: 'pointer',
  },
  body: { display: 'flex', gap: 18, padding: '8px 14px 10px', overflowX: 'auto', alignItems: 'stretch' },
  section: { flexShrink: 0 },
  secTitle: { fontSize: 11, fontWeight: 700, color: '#6B7280', marginBottom: 2 },
  costCol: {
    flexShrink: 0, minWidth: 180, display: 'flex', flexDirection: 'column',
    justifyContent: 'center', gap: 8, paddingLeft: 6, borderLeft: '1px solid #F3F4F6',
  },
  costLabel: { fontSize: 10, fontWeight: 600, color: '#9CA3AF', textTransform: 'uppercase', letterSpacing: '0.04em' },
  costVal: { fontSize: 16, fontWeight: 700, color: '#111827', fontVariantNumeric: 'tabular-nums' },
};

const LiveChartsDock = React.memo(function LiveChartsDock({
  history, permitLimits, collapsed, onToggle, onClear,
}) {
  const last = history[history.length - 1] || null;
  const prev = history[history.length - 2] || null;

  const permitData = useMemo(() => {
    if (!last) return [];
    return METRICS.map(({ key }) => {
      const limit = resolveLimit(permitLimits, key);
      const value = last[key];
      return {
        param: key, value: value ?? 0, limit,
        ok: limit == null || value == null ? null : value <= limit,
      };
    }).filter(d => d.value != null);
  }, [last, permitLimits]);

  if (!history.length) return null;

  return (
    <div style={S.dock} data-testid="live-charts-dock">
      <div style={S.header}>
        <span>📈 Live Charts</span>
        <span style={{ color: '#9CA3AF', fontWeight: 500 }}>
          run #{last.idx} · {last.time}
        </span>
        <span style={S.chip(last.compliant)}>
          {last.compliant == null ? 'no permit check' : last.compliant ? 'compliant' : 'violations'}
        </span>
        {!last.converged && (
          <span style={{ ...S.chip(false), background: '#FEF3C7', color: '#92400E' }}>not converged</span>
        )}
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
          <button style={S.smallBtn} onClick={onClear} title="Clear the run history behind these charts">Clear</button>
          <button style={S.smallBtn} onClick={onToggle} aria-expanded={!collapsed}>
            {collapsed ? '▴ Show' : '▾ Hide'}
          </button>
        </span>
      </div>

      {!collapsed && (
        <div style={S.body}>
          {/* ── Effluent quality trend across runs ─────────────────────── */}
          <div style={S.section}>
            <div style={S.secTitle}>Effluent quality per run (mg/L)</div>
            <LineChart width={430} height={168} data={history} margin={{ top: 6, right: 12, left: -14, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#F3F4F6" />
              <XAxis dataKey="idx" tick={{ fontSize: 10 }} tickFormatter={v => `#${v}`} />
              <YAxis tick={{ fontSize: 10 }} />
              <Tooltip
                labelFormatter={v => `Run #${v}`}
                formatter={(v, name) => [fmtNum(v, 2) + ' mg/L', name]}
                contentStyle={{ fontSize: 11 }}
              />
              <Legend wrapperStyle={{ fontSize: 10 }} />
              {METRICS.map(m => (
                <Line
                  key={m.key} type="monotone" dataKey={m.key} stroke={m.color}
                  strokeWidth={1.8} dot={{ r: 2 }} activeDot={{ r: 4 }} isAnimationActive={false}
                />
              ))}
            </LineChart>
          </div>

          {/* ── Current effluent vs permit limits ──────────────────────── */}
          <div style={S.section}>
            <div style={S.secTitle}>Latest run vs permit limits (mg/L)</div>
            <BarChart width={300} height={168} data={permitData} margin={{ top: 6, right: 8, left: -14, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#F3F4F6" />
              <XAxis dataKey="param" tick={{ fontSize: 10 }} />
              <YAxis tick={{ fontSize: 10 }} />
              <Tooltip
                formatter={(v, name, entry) => {
                  const lim = entry?.payload?.limit;
                  return [`${fmtNum(v, 2)} mg/L${lim != null ? ` (limit ${fmtNum(lim, 1)})` : ''}`, 'effluent'];
                }}
                contentStyle={{ fontSize: 11 }}
              />
              <Bar dataKey="value" isAnimationActive={false} radius={[3, 3, 0, 0]}>
                {permitData.map(d => (
                  <Cell
                    key={d.param}
                    fill={d.ok == null ? '#93C5FD' : d.ok ? '#34D399' : '#F87171'}
                  />
                ))}
              </Bar>
              {permitData.filter(d => d.limit != null).map(d => (
                <ReferenceLine
                  key={`lim-${d.param}`} y={d.limit} stroke="#9CA3AF" strokeDasharray="4 3"
                  ifOverflow="extendDomain"
                />
              ))}
            </BarChart>
          </div>

          {/* ── Cost + flow strip with deltas vs previous run ──────────── */}
          <div style={S.costCol}>
            <div>
              <div style={S.costLabel}>Annual cost</div>
              <div style={S.costVal}>
                ${fmtNum(last.costYr, 0)}<span style={{ fontSize: 11, color: '#9CA3AF' }}>/yr</span>
                <Delta cur={last.costYr} prev={prev?.costYr} downIsGood dp={0} prefix="$" />
              </div>
            </div>
            <div>
              <div style={S.costLabel}>Cost of water (LCOW)</div>
              <div style={S.costVal}>
                ${fmtNum(last.lcow, 3)}<span style={{ fontSize: 11, color: '#9CA3AF' }}>/m³</span>
                <Delta cur={last.lcow} prev={prev?.lcow} downIsGood dp={3} prefix="$" />
              </div>
            </div>
            <div>
              <div style={S.costLabel}>Effluent flow</div>
              <div style={S.costVal}>
                {fmtNum(last.Qeff, 0)}<span style={{ fontSize: 11, color: '#9CA3AF' }}> m³/d</span>
                <Delta cur={last.Qeff} prev={prev?.Qeff} downIsGood={false} dp={0} />
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
});

export default LiveChartsDock;
