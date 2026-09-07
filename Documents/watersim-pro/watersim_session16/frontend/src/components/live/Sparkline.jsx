/**
 * Sparkline — a pinned trend in one line: the last window's average as a
 * polyline, the last value as a number. Points are the historian's compact
 * arrays [ts, avg, min, max, last, count].
 */
import { memo } from 'react';
import { fmtValue } from './Gauge';

function Sparkline({ tag, name, unit, points = [], width = 160, height = 36, color = '#2E75B6' }) {
  const pts = points.filter((p) => p[1] != null);
  let path = '';
  if (pts.length > 1) {
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    const x0 = Math.min(...xs); const x1 = Math.max(...xs);
    const y0 = Math.min(...ys); const y1 = Math.max(...ys);
    const sx = (x) => (x1 === x0 ? 0 : ((x - x0) / (x1 - x0)) * (width - 2) + 1);
    const sy = (y) => (y1 === y0 ? height / 2 : height - 2 - ((y - y0) / (y1 - y0)) * (height - 4));
    path = pts.map((p, i) => `${i ? 'L' : 'M'} ${sx(p[0]).toFixed(1)} ${sy(p[1]).toFixed(1)}`).join(' ');
  }
  const last = pts.length ? pts[pts.length - 1][1] : null;
  return (
    <div className="flex items-center gap-3" data-tag={tag}>
      <div className="min-w-0 w-32">
        <div className="font-mono text-[11px] text-gray-800 truncate">{tag}</div>
        <div className="text-[10px] text-gray-500 truncate" title={name}>{name}</div>
      </div>
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${tag} trend`}>
        {path ? <path d={path} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" />
          : <text x={width / 2} y={height / 2 + 3} textAnchor="middle" fontSize="9" fill="#9CA3AF">no history yet</text>}
      </svg>
      <div className="font-mono text-sm text-gray-900 tabular-nums w-16 text-right">{fmtValue(last)}<span className="text-[10px] text-gray-500 ml-0.5">{unit || ''}</span></div>
    </div>
  );
}

export default memo(Sparkline);
