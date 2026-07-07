import { useState } from 'react';
import UnitOpIcon from './UnitOpIcon';
import useCustomUnitStore from '../../store/customUnitStore';

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
    category: 'Valves & Actuators',
    items: [
      { type: 'on_off_valve',  label: 'On/Off Valve' },
      { type: 'control_valve', label: 'Control Valve' },
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

// Built-in unit types a custom unit can be based on (so it still simulates).
const BASE_TYPES = (() => {
  const seen = new Set(); const out = [];
  for (const g of PALETTE) for (const it of g.items) {
    if (it.type === 'opc_read' || it.type === 'opc_write') continue;
    if (seen.has(it.type)) continue;
    seen.add(it.type);
    out.push({ type: it.type, label: it.label });
  }
  return out;
})();

// A user-defined palette item: draggable, with edit / delete controls.
function CustomPaletteItem({ unit, onEdit, onDelete }) {
  const onDragStart = (e) => {
    e.dataTransfer.setData('application/unitop-type', unit.baseType);
    e.dataTransfer.setData('application/unitop-label', unit.label);
    e.dataTransfer.effectAllowed = 'move';
  };
  return (
    <div draggable onDragStart={onDragStart} style={styles.item} title={`Drag to add: ${unit.label}`}>
      <span style={styles.itemIcon}><UnitOpIcon opType={unit.baseType} size={22} /></span>
      <span style={styles.itemText}>{unit.label}</span>
      <button style={styles.iconBtn} title="Edit" onClick={(e) => { e.stopPropagation(); onEdit(unit); }}>✎</button>
      <button style={{ ...styles.iconBtn, color: '#DC2626' }} title="Delete" onClick={(e) => { e.stopPropagation(); onDelete(unit.id); }}>🗑</button>
    </div>
  );
}

// Add / edit form for a custom unit.
function CustomUnitModal({ initial, onSave, onCancel }) {
  const [label, setLabel]       = useState(initial?.label || '');
  const [baseType, setBaseType] = useState(initial?.baseType || BASE_TYPES[0]?.type || 'tank');
  const [category, setCategory] = useState(initial?.category || 'Custom Units');
  const valid = label.trim().length > 0 && baseType;

  const save = (e) => {
    e.preventDefault();
    if (!valid) return;
    onSave({ label: label.trim(), baseType, category: category.trim() || 'Custom Units' });
  };

  return (
    <div style={styles.modalOverlay} onClick={onCancel}>
      <form style={styles.modal} onClick={(e) => e.stopPropagation()} onSubmit={save}>
        <div style={styles.modalTitle}>{initial ? 'Edit unit operation' : 'Add unit operation'}</div>

        <label style={styles.fieldLabel} htmlFor="cu-label">Name</label>
        <input id="cu-label" style={styles.input} value={label} autoFocus
          placeholder="e.g. High-rate Clarifier" onChange={(e) => setLabel(e.target.value)} />

        <label style={styles.fieldLabel} htmlFor="cu-base">Based on (simulation model)</label>
        <div style={styles.baseRow}>
          <UnitOpIcon opType={baseType} size={24} />
          <select id="cu-base" style={{ ...styles.input, margin: 0 }} value={baseType} onChange={(e) => setBaseType(e.target.value)}>
            {BASE_TYPES.map(b => <option key={b.type} value={b.type}>{b.label}</option>)}
          </select>
        </div>
        <p style={styles.hintText}>It behaves like this model in the solver — you can tune parameters on the node after adding it.</p>

        <label style={styles.fieldLabel} htmlFor="cu-cat">Category</label>
        <input id="cu-cat" style={styles.input} value={category}
          placeholder="Custom Units" onChange={(e) => setCategory(e.target.value)} />

        <div style={styles.modalBtns}>
          <button type="button" style={styles.btnGhost} onClick={onCancel}>Cancel</button>
          <button type="submit" style={{ ...styles.btnPrimary, opacity: valid ? 1 : 0.5 }} disabled={!valid}>
            {initial ? 'Save changes' : 'Add unit'}
          </button>
        </div>
      </form>
    </div>
  );
}

function PaletteItem({ type, label, disabled }) {
  const onDragStart = (e) => {
    if (disabled) { e.preventDefault(); return; }
    e.dataTransfer.setData('application/unitop-type', type);
    e.dataTransfer.setData('application/unitop-label', label);
    e.dataTransfer.effectAllowed = 'move';
  };

  return (
    <div
      draggable={!disabled}
      onDragStart={onDragStart}
      style={{ ...styles.item, ...(disabled ? { opacity: 0.4, cursor: 'default' } : {}) }}
      title={disabled ? `${label} already on canvas (only one allowed)` : `Drag to add: ${label}`}
    >
      <span style={styles.itemIcon}><UnitOpIcon opType={type} size={22} /></span>
      <span style={styles.itemText}>{label}</span>
      {disabled
        ? <span style={{ color: '#9CA3AF', fontSize: 10 }}>{'\u2713'}</span>
        : <span style={styles.dragHint}>⠿</span>
      }
    </div>
  );
}

// OPC nodes are singletons — only one of each allowed on the canvas
const SINGLETON_TYPES = new Set(['opc_read', 'opc_write']);

// Group custom units by their category label.
function groupCustom(units) {
  const map = new Map();
  for (const u of units) {
    const cat = u.category || 'Custom Units';
    if (!map.has(cat)) map.set(cat, []);
    map.get(cat).push(u);
  }
  return [...map.entries()];
}

export default function UnitOpPalette({ nodes = [] }) {
  const existingTypes = new Set(nodes.map(n => n.data?.opType).filter(Boolean));
  // On mobile, palette collapses to a toggle button
  const [open, setOpen] = useState(false);

  // Custom (user-defined) units
  const customUnits = useCustomUnitStore(s => s.units);
  const addUnit     = useCustomUnitStore(s => s.addUnit);
  const updateUnit  = useCustomUnitStore(s => s.updateUnit);
  const removeUnit  = useCustomUnitStore(s => s.removeUnit);
  const [modal, setModal] = useState(null); // null | 'new' | unit object

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
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <button style={styles.addBtn} title="Add a custom unit operation" onClick={() => setModal('new')}>+ Add</button>
            <button
              className="md:hidden text-brand-200 hover:text-white p-1 rounded"
              onClick={() => setOpen(false)}
            >✕</button>
          </div>
        </div>
        <div style={styles.scrollArea}>
          {PALETTE.map(group => (
            <div key={group.category} style={styles.group}>
              <div style={styles.groupTitle}>{group.category}</div>
              {group.items.map(item => (
                <PaletteItem key={item.type} {...item} disabled={SINGLETON_TYPES.has(item.type) && existingTypes.has(item.type)} />
              ))}
            </div>
          ))}

          {/* User-defined units */}
          {groupCustom(customUnits).map(([cat, items]) => (
            <div key={`custom-${cat}`} style={styles.group}>
              <div style={styles.groupTitle}>{cat}</div>
              {items.map(u => (
                <CustomPaletteItem key={u.id} unit={u} onEdit={setModal} onDelete={removeUnit} />
              ))}
            </div>
          ))}

          <button style={styles.addRow} onClick={() => setModal('new')}>+ Add unit operation</button>
        </div>
        <div style={styles.hint}>Drag items onto the canvas</div>
      </aside>

      {modal && (
        <CustomUnitModal
          initial={modal === 'new' ? null : modal}
          onCancel={() => setModal(null)}
          onSave={(data) => {
            if (modal === 'new') addUnit(data);
            else updateUnit(modal.id, data);
            setModal(null);
          }}
        />
      )}
    </>
  );
}

const styles = {
  panel:     { width: 200, background: '#fff', borderRight: '1px solid #E5E7EB', flexDirection: 'column', flexShrink: 0 },
  header:    { padding: '12px 14px', fontWeight: 700, fontSize: 13, color: '#1F4E79', borderBottom: '1px solid #E5E7EB', textTransform: 'uppercase', letterSpacing: '0.05em' },
  scrollArea:{ flex: 1, overflowY: 'auto', padding: '8px 0' },
  group:     { marginBottom: 8 },
  groupTitle:{ padding: '6px 14px', fontSize: 11, fontWeight: 700, color: '#9CA3AF', textTransform: 'uppercase', letterSpacing: '0.08em' },
  item:      { display: 'flex', alignItems: 'center', gap: 10, padding: '7px 14px', cursor: 'grab', fontSize: 13, color: '#374151', userSelect: 'none', borderRadius: 8 },
  itemIcon:  { display: 'flex', alignItems: 'center', justifyContent: 'center', width: 26, height: 26, flexShrink: 0 },
  itemText:  { flex: 1 },
  dragHint:  { color: '#CBD5E1', fontSize: 14 },
  hint:      { padding: '10px 14px', fontSize: 11, color: '#9CA3AF', borderTop: '1px solid #E5E7EB', fontStyle: 'italic' },
  addBtn:    { fontSize: 11, fontWeight: 700, color: '#0891B2', background: '#ECFEFF', border: '1px solid #A5F3FC', borderRadius: 6, padding: '3px 8px', cursor: 'pointer' },
  iconBtn:   { border: 'none', background: 'none', cursor: 'pointer', fontSize: 12, color: '#9CA3AF', padding: '2px 3px', lineHeight: 1 },
  addRow:    { display: 'block', width: 'calc(100% - 20px)', margin: '4px 10px 8px', padding: '8px', fontSize: 12.5, fontWeight: 600, color: '#0891B2', background: '#fff', border: '1px dashed #A5F3FC', borderRadius: 8, cursor: 'pointer' },
  // modal
  modalOverlay: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)', zIndex: 60, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 },
  modal:     { background: '#fff', borderRadius: 14, boxShadow: '0 20px 50px rgba(0,0,0,0.25)', width: 'min(380px, 94vw)', padding: 20, display: 'flex', flexDirection: 'column' },
  modalTitle:{ fontSize: 16, fontWeight: 700, color: '#1F4E79', marginBottom: 12 },
  fieldLabel:{ fontSize: 12, fontWeight: 600, color: '#374151', margin: '8px 0 4px' },
  input:     { width: '100%', padding: '8px 10px', border: '1px solid #D1D5DB', borderRadius: 8, fontSize: 13, color: '#111', margin: '0 0 4px', boxSizing: 'border-box' },
  baseRow:   { display: 'flex', alignItems: 'center', gap: 8 },
  hintText:  { fontSize: 11, color: '#9CA3AF', margin: '4px 0 4px' },
  modalBtns: { display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 },
  btnGhost:  { padding: '8px 14px', background: '#F3F4F6', color: '#374151', border: 'none', borderRadius: 8, fontWeight: 600, fontSize: 13, cursor: 'pointer' },
  btnPrimary:{ padding: '8px 16px', background: '#0891B2', color: '#fff', border: 'none', borderRadius: 8, fontWeight: 600, fontSize: 13, cursor: 'pointer' },
};
