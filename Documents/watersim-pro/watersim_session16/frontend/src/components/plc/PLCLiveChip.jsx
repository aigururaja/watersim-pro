import { QUALITY_COLORS, relTime } from './plcState';

/**
 * PLCLiveChip — small live-value indicator shown under a bound parameter:
 * quality dot (good=green, stale=amber, bad=red, unknown=gray) + last value +
 * relative time. Shows '— no data yet' before the first read.
 */
export default function PLCLiveChip({ live }) {
  const quality = live?.quality || 'unknown';
  const hasData = live != null && live.value != null;
  const color   = QUALITY_COLORS[quality] || QUALITY_COLORS.unknown;

  const fmtVal = (v) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return String(v);
    return n.toLocaleString('en-US', { maximumFractionDigits: Math.abs(n) >= 100 ? 1 : 3 });
  };

  return (
    <span
      data-quality={quality}
      title={hasData ? `PLC value · quality: ${quality}` : 'Waiting for the first PLC read'}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 5,
        fontSize: 10.5, color: '#6B7280', whiteSpace: 'nowrap',
        background: '#F9FAFB', border: '1px solid #E5E7EB',
        borderRadius: 10, padding: '1px 8px', lineHeight: '16px',
      }}
    >
      <span aria-hidden="true" style={{
        width: 7, height: 7, borderRadius: '50%', flexShrink: 0,
        background: hasData ? color : QUALITY_COLORS.unknown,
      }} />
      {hasData ? (
        <>
          <span style={{ fontWeight: 700, color: '#374151', fontVariantNumeric: 'tabular-nums' }}>
            {fmtVal(live.value)}
          </span>
          {live.ts != null && <span>· {relTime(live.ts)}</span>}
        </>
      ) : (
        <span>— no data yet</span>
      )}
    </span>
  );
}
