import { useEffect, useId, useState } from 'react';

/**
 * InfoTip — a small ⓘ button that toggles an INLINE detail block directly
 * beneath its row. No portal, no floating positioning: the panel is a plain
 * sibling in the flow, so it never escapes a scrolling panel or lands off-screen.
 *
 * Accessibility:
 *   - real <button> (so Enter/Space work for free), aria-expanded tracks state
 *   - aria-label names what the tip is about ("About SRT (days)")
 *   - aria-controls points at the panel while it is open
 *   - Escape closes it from anywhere; clicking the button again closes it
 *
 * Layout: the caller decides where the button sits, because the button belongs
 * inside a row while the panel belongs underneath it. Pass `children` as a
 * function and place the button wherever it belongs:
 *
 *   <InfoTip label="About SRT (days)" title="SRT (days)" detail={<p>…</p>}>
 *     {(infoButton) => (
 *       <div className="row">
 *         <label>SRT (days){infoButton}</label>
 *         <input />
 *       </div>
 *     )}
 *   </InfoTip>
 *
 * Non-function children are rendered inline with the button appended after them.
 */
export default function InfoTip({ label, title, detail, children, panelStyle }) {
  const [open, setOpen] = useState(false);
  const [hover, setHover] = useState(false);
  const panelId = useId();

  // Escape closes, wherever focus happens to be.
  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open]);

  const active = open || hover;

  const button = (
    <button
      type="button"
      className="nodrag"
      aria-expanded={open}
      aria-label={label}
      aria-controls={open ? panelId : undefined}
      title={label}
      onClick={(e) => { e.stopPropagation(); setOpen(v => !v); }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onFocus={() => setHover(true)}
      onBlur={() => setHover(false)}
      style={{
        ...S.btn,
        color: active ? '#2E75B6' : '#9CA3AF',
        background: open ? '#EFF6FF' : 'transparent',
      }}
    >
      ⓘ
    </button>
  );

  return (
    <>
      {typeof children === 'function'
        ? children(button)
        : (
          <span style={{ display: 'inline-flex', alignItems: 'center', minWidth: 0 }}>
            {children}
            {button}
          </span>
        )}
      {open && (
        <div id={panelId} role="note" style={{ ...S.panel, ...panelStyle }}>
          {title && <div style={S.title}>{title}</div>}
          {detail}
        </div>
      )}
    </>
  );
}

/**
 * InfoFacts — the standard body for a parameter tip: a short stack of
 * "Label — value" lines, skipping anything missing.
 *
 * @param {{label: string, value: any}[]} facts
 */
export function InfoFacts({ facts }) {
  const rows = (facts || []).filter(f => f && f.value);
  if (!rows.length) return null;
  return (
    <dl style={S.list}>
      {rows.map(f => (
        <div key={f.label} style={S.listRow}>
          <dt style={S.term}>{f.label}</dt>
          <dd style={S.def}>{f.value}</dd>
        </div>
      ))}
    </dl>
  );
}

const S = {
  btn: {
    border: 'none',
    cursor: 'pointer',
    borderRadius: 4,
    padding: '0 3px',
    marginLeft: 4,
    fontSize: 12,
    lineHeight: '16px',
    fontWeight: 600,
    flexShrink: 0,
    display: 'inline-flex',
    alignItems: 'center',
    transition: 'color 0.12s ease, background 0.12s ease',
  },
  panel: {
    background: '#F8FAFC',
    border: '1px solid #E5E7EB',
    borderLeft: '3px solid #2E75B6',
    borderRadius: 6,
    padding: '7px 9px',
    margin: '5px 0 2px',
    fontSize: 11.5,
    lineHeight: 1.5,
    color: '#374151',
  },
  title: {
    fontWeight: 700,
    fontSize: 11.5,
    color: '#1F4E79',
    marginBottom: 3,
  },
  list: { margin: 0 },
  listRow: { marginBottom: 3 },
  term: {
    display: 'inline',
    fontWeight: 700,
    color: '#6B7280',
    marginRight: 4,
  },
  def: { display: 'inline', margin: 0, color: '#374151' },
};
