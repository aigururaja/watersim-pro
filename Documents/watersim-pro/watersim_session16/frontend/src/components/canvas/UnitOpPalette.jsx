import { useState } from 'react';
import { getSymbol, getTag } from './symbols';

// NOTE ON THE REGISTRY: this module reads `getSymbol()` at RENDER time and
// deliberately does NOT import `symbols/register`. `UnitOpNode` owns that one
// import; CanvasPage imports UnitOpNode, so the rail is populated in the app.
// Pulling the registrations in here instead would also pull them into
// `src/test/symbolPrimitives.test.jsx` (which imports PALETTE from this file to
// assert TAG coverage) and flip its `hasSymbol('pump') === false` assertion.
// With an empty registry every chip simply falls back to the placeholder glyph
// — the rail degrades, it never breaks.

// Exported so the explanation-coverage test can assert that every unit type a
// user can drop on the canvas has an OP_INFO entry in src/content/explanations.js.
export const PALETTE = [
  {
    category: 'Flow Boundaries',
    items: [
      { type: 'inlet',  label: 'Inlet (Source)' },
      { type: 'outlet', label: 'Outlet (Discharge)' },
    ]
  },
  {
    category: 'Flow Control',
    items: [
      { type: 'pump',  label: 'Pump' },
      { type: 'valve', label: 'Valve' },
    ]
  },
  {
    category: 'Preliminary',
    items: [
      { type: 'screening',   label: 'Screening' },
      { type: 'grit_removal',label: 'Grit Removal' },
    ]
  },
  {
    category: 'Primary Treatment',
    items: [
      { type: 'primary_clarifier', label: 'Primary Clarifier' },
    ]
  },
  {
    category: 'Secondary (Biological)',
    items: [
      { type: 'activated_sludge',    label: 'Activated Sludge' },
      { type: 'secondary_clarifier', label: 'Secondary Clarifier' },
      { type: 'membrane_bioreactor', label: 'Membrane Bioreactor' },
      { type: 'uct_reactor',         label: 'UCT Reactor (EBPR)' },
      { type: 'jhb_reactor',         label: 'JHB Reactor (EBPR)' },
      { type: 'anaerobic_digester',  label: 'Anaerobic Digester (ADM1-lite)' },
    ]
  },
  {
    category: 'Tertiary',
    items: [
      { type: 'uv_disinfection', label: 'UV Disinfection (CT model)' },
      { type: 'chlorination',    label: 'Chlorination' },
      { type: 'sand_filter',     label: 'Granular Filter (dual/sand)' },
    ]
  },
  {
    category: 'Chemical Dosing',
    items: [
      { type: 'chemical_dosing',  label: 'Chemical Dosing' },
      { type: 'coagulant_dosing', label: 'Coagulant (Alum/FeCl₃)' },
      { type: 'polymer_dosing',   label: 'Polymer Dosing' },
      { type: 'ph_adjustment',    label: 'pH Adjustment' },
    ]
  },
  {
    category: 'Water Purification',
    items: [
      { type: 'coagulation',  label: 'Coagulation/Floc' },
      { type: 'ro_membrane',  label: 'RO Membrane' },
      { type: 'uf_membrane',  label: 'UF Membrane' },
      { type: 'gac_adsorption',label: 'GAC Adsorption' },
    ]
  },
  {
    category: 'Utilities',
    items: [
      { type: 'blower',  label: 'Blower' },
      { type: 'tank',    label: 'Storage Tank' },
    ]
  },
];

/**
 * The rail IS the legend (spec §3.4): each item renders its ACTUAL symbol at
 * 24x18 from the same `SYMBOLS` registry the canvas uses, with the same
 * `viewBox="0 0 144 60"` scaled down. Learn it here, read it on the sheet.
 *
 * The chip is a rest-pose render: no `nodeId`, so no live subscription, and
 * `state="rest"` with no snapshot, so every symbol draws its empty-outline
 * form. 26 of these cost 26 static SVGs and zero animations.
 */
function PaletteGlyph({ type }) {
  const Symbol = getSymbol(type);
  return (
    <span className="ws-sheet" style={styles.glyphWrap} aria-hidden="true">
      <svg viewBox="0 0 144 60" width="24" height="18" focusable="false" style={styles.glyph}>
        <Symbol opType={type} state="rest" />
      </svg>
    </span>
  );
}

function PaletteItem({ type, label, onAdd }) {
  const onDragStart = (e) => {
    e.dataTransfer.setData('application/unitop-type', type);
    e.dataTransfer.setData('application/unitop-label', label);
    e.dataTransfer.effectAllowed = 'move';
  };

  const handleAdd = () => onAdd?.(type, label);

  const onKeyDown = (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      handleAdd();
    }
  };

  return (
    <div
      draggable
      role="button"
      tabIndex={0}
      aria-label={`Add ${label} to canvas`}
      onDragStart={onDragStart}
      onClick={handleAdd}
      onKeyDown={onKeyDown}
      style={styles.item}
      title={`Click or press Enter to add · drag to place: ${label}`}
    >
      <PaletteGlyph type={type} />
      <span style={styles.itemTag}>{getTag(type)}</span>
      <span style={styles.itemText}>{label}</span>
      <span style={styles.dragHint}>⠿</span>
    </div>
  );
}

export default function UnitOpPalette({ onAddNode }) {
  // On mobile, palette collapses to a toggle button
  const [open, setOpen] = useState(false);
  // Desktop rail collapse — persisted so the choice survives visits
  const [rail, setRail] = useState(() => {
    try { return localStorage.getItem('ws.paletteRail') === '1'; } catch { /* ignore */ }
    return false;
  });
  const setRailPersist = (v) => {
    setRail(v);
    try { localStorage.setItem('ws.paletteRail', v ? '1' : '0'); } catch { /* ignore */ }
  };
  // Type-to-filter across the 26 items
  const [q, setQ] = useState('');
  const groups = PALETTE
    .map(g => ({ ...g, items: g.items.filter(i => i.label.toLowerCase().includes(q.toLowerCase())) }))
    .filter(g => g.items.length);

  return (
    <>
      {/* Mobile toggle button (shown when panel is closed) */}
      {!open && (
        <button
          className="md:hidden absolute left-2 top-2 z-20 bg-white border border-gray-200 shadow rounded-lg px-2.5 py-1.5 text-xs font-bold text-brand-700 flex items-center gap-1.5"
          onClick={() => { setOpen(true); setRailPersist(false); }}
          style={{ position: 'absolute' }}
        >
          ⊞ Palette
        </button>
      )}

      {/* Mobile overlay backdrop */}
      {open && (
        <div
          className="md:hidden fixed inset-0 bg-black/30 z-30"
          onClick={() => setOpen(false)}
        />
      )}

      {/* Palette panel */}
      <aside style={{
        ...styles.panel,
        // On mobile: slide in from left as overlay
      }}
        className={`
          transition-transform duration-300
          fixed md:relative top-0 left-0 h-full z-40
          md:translate-x-0 md:flex md:z-auto
          ${open ? 'translate-x-0 flex' : '-translate-x-full hidden md:flex'}
          ${rail ? 'md:w-10' : 'md:w-[208px]'} w-64 max-w-[85vw]
        `}
      >
        {rail ? (
          <button
            className="hidden md:flex"
            title="Show unit operations"
            onClick={() => setRailPersist(false)}
            style={{ margin: '8px auto', background: 'none', border: 'none', cursor: 'pointer', color: '#6B7280', fontSize: 13 }}
          >»</button>
        ) : (
          <>
            <div style={styles.header} className="flex items-center justify-between">
              <span>Unit Operations</span>
              <button
                className="hidden md:block"
                title="Collapse palette"
                onClick={() => setRailPersist(true)}
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#9CA3AF', fontSize: 13 }}
              >«</button>
              <button
                className="md:hidden text-brand-200 hover:text-white p-1 rounded"
                onClick={() => setOpen(false)}
              >✕</button>
            </div>
            <input
              value={q}
              onChange={e => setQ(e.target.value)}
              placeholder="Filter units…"
              aria-label="Filter unit operations"
              style={{ margin: '8px 12px 0', padding: '6px 8px', fontSize: 12, border: '1px solid #E5E7EB', borderRadius: 6, width: 'calc(100% - 24px)', boxSizing: 'border-box' }}
            />
            <div style={styles.scrollArea}>
              {groups.map(group => (
                <div key={group.category} style={styles.group}>
                  <div style={styles.groupTitle}>{group.category}</div>
                  {group.items.map(item => (
                    <PaletteItem key={item.type} {...item} onAdd={onAddNode} />
                  ))}
                </div>
              ))}
            </div>
            <div style={styles.hint}>Drag onto the canvas, or press Enter to add at centre</div>
          </>
        )}
      </aside>
    </>
  );
}

const styles = {
  panel:     { background: '#fff', borderRight: '1px solid #E5E7EB', flexDirection: 'column', flexShrink: 0 },
  header:    { padding: '10px 12px', fontWeight: 700, fontSize: 12, color: '#1F4E79', borderBottom: '1px solid #E5E7EB', textTransform: 'uppercase', letterSpacing: '0.05em' },
  scrollArea:{ flex: 1, overflowY: 'auto', padding: '8px 0' },
  group:     { marginBottom: 8 },
  groupTitle:{ padding: '6px 12px', fontSize: 10, fontWeight: 700, color: '#9CA3AF', textTransform: 'uppercase', letterSpacing: '0.08em' },
  item:      { display: 'flex', alignItems: 'center', gap: 6, padding: '5px 10px', cursor: 'grab', fontSize: 12, color: '#374151', userSelect: 'none' },
  glyphWrap: { display: 'inline-flex', flexShrink: 0, width: 24, height: 18, alignItems: 'center', justifyContent: 'center' },
  glyph:     { display: 'block', overflow: 'visible' },
  itemTag:   {
    fontFamily: "var(--ws-font-mono, ui-monospace, Menlo, Consolas, monospace)",
    fontSize: 8.5, fontWeight: 700, letterSpacing: '0.06em', color: '#94A3B8',
    width: 26, flexShrink: 0, textAlign: 'left',
  },
  itemText:  { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  dragHint:  { color: '#CBD5E1', fontSize: 14, flexShrink: 0 },
  hint:      { padding: '10px 12px', fontSize: 10, color: '#9CA3AF', borderTop: '1px solid #E5E7EB', fontStyle: 'italic' },
};
