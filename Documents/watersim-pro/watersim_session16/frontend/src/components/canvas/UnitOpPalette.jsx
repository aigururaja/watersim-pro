import { useState } from 'react';

const PALETTE = [
  {
    category: 'Flow Boundaries',
    items: [
      { type: 'inlet',  label: 'Inlet (Source)' },
      { type: 'outlet', label: 'Outlet (Discharge)' },
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
      { type: 'chlorination',     label: 'Chlorination / Disinfection' },
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
      { type: 'pump',    label: 'Pump' },
      { type: 'blower',  label: 'Blower' },
      { type: 'tank',    label: 'Storage Tank' },
    ]
  },
  {
    category: 'OPC Integration',
    items: [
      { type: 'opc_read',  label: 'OPC Read' },
      { type: 'opc_write', label: 'OPC Write' },
    ]
  },
];

function PaletteItem({ type, label }) {
  const onDragStart = (e) => {
    e.dataTransfer.setData('application/unitop-type', type);
    e.dataTransfer.setData('application/unitop-label', label);
    e.dataTransfer.effectAllowed = 'move';
  };

  return (
    <div
      draggable
      onDragStart={onDragStart}
      style={styles.item}
      title={`Drag to add: ${label}`}
    >
      <span style={styles.itemText}>{label}</span>
      <span style={styles.dragHint}>⠿</span>
    </div>
  );
}

export default function UnitOpPalette() {
  // On mobile, palette collapses to a toggle button
  const [open, setOpen] = useState(false);

  return (
    <>
      {/* Mobile toggle button (shown when panel is closed) */}
      {!open && (
        <button
          className="md:hidden absolute left-2 top-2 z-20 bg-white border border-gray-200 shadow rounded-lg px-2.5 py-1.5 text-xs font-bold text-brand-700 flex items-center gap-1.5"
          onClick={() => setOpen(true)}
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
        `}
      >
        <div style={styles.header} className="flex items-center justify-between">
          <span>Unit Operations</span>
          <button
            className="md:hidden text-brand-200 hover:text-white p-1 rounded"
            onClick={() => setOpen(false)}
          >✕</button>
        </div>
        <div style={styles.scrollArea}>
          {PALETTE.map(group => (
            <div key={group.category} style={styles.group}>
              <div style={styles.groupTitle}>{group.category}</div>
              {group.items.map(item => (
                <PaletteItem key={item.type} {...item} />
              ))}
            </div>
          ))}
        </div>
        <div style={styles.hint}>Drag items onto the canvas</div>
      </aside>
    </>
  );
}

const styles = {
  panel:     { width: 200, background: '#fff', borderRight: '1px solid #E5E7EB', flexDirection: 'column', flexShrink: 0 },
  header:    { padding: '12px 14px', fontWeight: 700, fontSize: 13, color: '#1F4E79', borderBottom: '1px solid #E5E7EB', textTransform: 'uppercase', letterSpacing: '0.05em' },
  scrollArea:{ flex: 1, overflowY: 'auto', padding: '8px 0' },
  group:     { marginBottom: 8 },
  groupTitle:{ padding: '6px 14px', fontSize: 11, fontWeight: 700, color: '#9CA3AF', textTransform: 'uppercase', letterSpacing: '0.08em' },
  item:      { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 14px', cursor: 'grab', fontSize: 13, color: '#374151', userSelect: 'none' },
  itemText:  { flex: 1 },
  dragHint:  { color: '#CBD5E1', fontSize: 14 },
  hint:      { padding: '10px 14px', fontSize: 11, color: '#9CA3AF', borderTop: '1px solid #E5E7EB', fontStyle: 'italic' },
};
