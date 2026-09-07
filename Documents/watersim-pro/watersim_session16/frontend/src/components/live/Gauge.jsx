/**
 * Gauge — one analogue point as a 240° arc with its value, unit and tag.
 *
 * The arc is the value's position in the transmitter's calibrated span
 * (range_min..range_max). Without a span the number stands alone and the arc
 * is drawn full and faint: a gauge with no scale would be a lie. Quality is
 * the ring colour: good is the brand blue, stale amber, bad red, unknown grey.
 */
import { memo } from 'react';

const QUALITY = {
  good: '#2E75B6', stale: '#D97706', bad: '#DC2626', unknown: '#9CA3AF',
};

const R = 34;
const CX = 44;
const CY = 44;
const SWEEP = 240; // degrees
const START = 150; // degrees, measured clockwise from 3 o'clock

const polar = (deg) => {
  const rad = (deg * Math.PI) / 180;
  return [CX + R * Math.cos(rad), CY + R * Math.sin(rad)];
};

function arcPath(fromDeg, toDeg) {
  const [x1, y1] = polar(fromDeg);
  const [x2, y2] = polar(toDeg);
  const large = toDeg - fromDeg > 180 ? 1 : 0;
  return `M ${x1.toFixed(2)} ${y1.toFixed(2)} A ${R} ${R} 0 ${large} 1 ${x2.toFixed(2)} ${y2.toFixed(2)}`;
}

export const fmtValue = (v, dp) => {
  if (v == null || !Number.isFinite(Number(v))) return '—';
  const n = Number(v);
  const digits = dp ?? (Math.abs(n) >= 100 ? 0 : Math.abs(n) >= 10 ? 1 : 2);
  return n.toLocaleString('en-IN', { maximumFractionDigits: digits, minimumFractionDigits: 0 });
};

function Gauge({ tag, name, value, unit, rangeMin, rangeMax, quality = 'unknown', at, compact = false }) {
  const hasSpan = rangeMin != null && rangeMax != null && rangeMax > rangeMin;
  const frac = hasSpan && value != null ? Math.min(1, Math.max(0, (value - rangeMin) / (rangeMax - rangeMin))) : null;
  const color = QUALITY[quality] || QUALITY.unknown;
  const end = frac == null ? START + SWEEP : START + SWEEP * frac;
  const size = compact ? 72 : 96;

  return (
    <div className="flex flex-col items-center" data-tag={tag} data-quality={quality} title={at ? `Last read ${new Date(at).toLocaleTimeString()}` : 'No sample yet'}>
      <svg viewBox="0 0 88 76" width={size} height={size * 76 / 88} role="img" aria-label={`${tag} ${fmtValue(value)}${unit ? ` ${unit}` : ''}`}>
        <path d={arcPath(START, START + SWEEP)} fill="none" stroke="#E5E7EB" strokeWidth="7" strokeLinecap="round" />
        {frac != null ? (
          <path d={arcPath(START, Math.max(START + 0.5, end))} fill="none" stroke={color} strokeWidth="7" strokeLinecap="round" />
        ) : (
          <path d={arcPath(START, START + SWEEP)} fill="none" stroke={color} strokeWidth="7" strokeLinecap="round" opacity="0.25" />
        )}
        <text x={CX} y={CY + 2} textAnchor="middle" fontSize={compact ? 13 : 15} fontWeight="700" fill="#111827" fontFamily="ui-monospace, monospace">
          {fmtValue(value)}
        </text>
        <text x={CX} y={CY + 14} textAnchor="middle" fontSize="8" fill="#6B7280">{unit || ''}</text>
        {hasSpan && (
          <>
            <text x="6" y="74" fontSize="6.5" fill="#9CA3AF">{fmtValue(rangeMin, 0)}</text>
            <text x="82" y="74" textAnchor="end" fontSize="6.5" fill="#9CA3AF">{fmtValue(rangeMax, 0)}</text>
          </>
        )}
      </svg>
      <div className="font-mono text-[11px] text-gray-800 -mt-1">{tag}</div>
      {!compact && <div className="text-[10px] text-gray-500 truncate max-w-[9rem] text-center" title={name}>{name}</div>}
    </div>
  );
}

export default memo(Gauge);
