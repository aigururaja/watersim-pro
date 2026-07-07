import { useState, useEffect, useRef } from 'react';
import UnitOpIcon, { ICON_OPTIONS } from './UnitOpIcon';
import useCustomUnitStore from '../../store/customUnitStore';
import api from '../../utils/api';

const PALETTE = [
  { category: 'Flow Boundaries', items: [
    { type: 'inlet',  label: 'Inlet (Source)' },
    { type: 'outlet', label: 'Outlet (Discharge)' },
  ]},
  { category: 'Preliminary', items: [
    { type: 'screening',    label: 'Screening' },
    { type: 'grit_removal', label: 'Grit Removal' },
  ]},
  { category: 'Primary Treatment', items: [
    { type: 'primary_clarifier', label: 'Primary Clarifier' },
  ]},
  { category: 'Secondary (Biological)', items: [
    { type: 'activated_sludge',    label: 'Activated Sludge' },
    { type: 'secondary_clarifier', label: 'Secondary Clarifier' },
    { type: 'membrane_bioreactor', label: 'Membrane Bioreactor' },
    { type: 'uct_reactor',         label: 'UCT Reactor (EBPR)' },
    { type: 'jhb_reactor',         label: 'JHB Reactor (EBPR)' },
    { type: 'anaerobic_digester',  label: 'Anaerobic Digester (ADM1-lite)' },
  ]},
  { category: 'Tertiary', items: [
    { type: 'uv_disinfection', label: 'UV Disinfection (CT model)' },
    { type: 'chlorination',    label: 'Chlorination' },
    { type: 'sand_filter',     label: 'Granular Filter (dual/sand)' },
  ]},
  { category: 'Chemical Dosing', items: [
    { type: 'chemical_dosing',  label: 'Chemical Dosing' },
    { type: 'coagulant_dosing', label: 'Coagulant (Alum/FeCl₃)' },
    { type: 'polymer_dosing',   label: 'Polymer Dosing' },
    { type: 'ph_adjustment',    label: 'pH Adjustment' },
  ]},
  { category: 'Water Purification', items: [
    { type: 'coagulation',   label: 'Coagulation/Floc' },
    { type: 'ro_membrane',   label: 'RO Membrane' },
    { type: 'uf_membrane',   label: 'UF Membrane' },
    { type: 'gac_adsorption',label: 'GAC Adsorption' },
  ]},
  { category: 'Valves & Actuators', items: [
    { type: 'on_off_valve',  label: 'On/Off Valve' },
    { type: 'control_valve', label: 'Control Valve' },
  ]},
  { category: 'Utilities', items: [
    { type: 'pump',   label: 'Pump' },
    { type: 'blower', label: 'Blower' },
    { type: 'tank',   label: 'Storage Tank' },
  ]},
  { category: 'OPC Integration', items: [
    { type: 'opc_read',  label: 'OPC Read' },
    { type: 'opc_write', label: 'OPC Write' },
  ]},
];

// OPC nodes are singletons — only one of each allowed on the canvas
const SINGLETON_TYPES = new Set(['opc_read', 'opc_write']);

// Base solver model for a chosen icon (so the unit still simulates).
const baseForIcon = (cat) => ICON_OPTIONS.find(o => o.cat === cat)?.base || 'tank';

/** Coerce a params row value into number / boolean / string. */
function coerce(v) {
  const t = String(v).trim();
  if (t === '') return '';
  if (t === 'true') return true;
  if (t === 'false') return false;
  const n = Number(t);
  return Number.isNaN(n) ? t : n;
}

/** Merge built-in items + overrides + custom units into ordered category groups. */
function buildGroups(overrides, customUnits, showHidden) {
  const order = []; const map = new Map();
  const ensure = (cat) => { if (!map.has(cat)) { map.set(cat, []); order.push(cat); } return map.get(cat); };
  for (const g of PALETTE) {
    for (const it of g.items) {
      const ov = overrides[it.type] || {};
      if (ov.hidden && !showHidden) continue;
      const cat = ov.category || g.category;
      ensure(cat).push({
        kind: 'builtin', type: it.type, label: ov.label || it.label,
        origLabel: it.label, category: cat, hidden: !!ov.hidden,
        overridden: !!(ov.label || ov.category || ov.hidden),
        singleton: SINGLETON_TYPES.has(it.type),
      });
    }
  }
  for (const u of customUnits) ensure(u.category || 'Custom Units').push({ kind: 'custom', unit: u });
  return order.map((cat) => ({ category: cat, items: map.get(cat) }));
}

// ── Palette rows ─────────────────────────────────────────────────────────────

function BuiltinItem({ item, disabled, onEdit, onToggleHide }) {
  const onDragStart = (e) => {
    if (disabled) { e.preventDefault(); return; }
    e.dataTransfer.setData('application/unitop-type', item.type);
    e.dataTransfer.setData('application/unitop-label', item.label);
    e.dataTransfer.effectAllowed = 'move';
  };
  return (
    <div draggable={!disabled} onDragStart={onDragStart}
      style={{ ...styles.item, ...(disabled ? { opacity: 0.4, cursor: 'default' } : {}), ...(item.hidden ? { opacity: 0.5 } : {}) }}
      title={disabled ? `${item.label} already on canvas (only one allowed)` : `Drag to add: ${item.label}`}>
      <span style={styles.itemIcon}><UnitOpIcon opType={item.type} size={22} /></span>
      <span style={styles.itemText}>{item.label}</span>
      <button style={styles.iconBtn} title="Edit" onClick={(e) => { e.stopPropagation(); onEdit(item); }}>✎</button>
      <button style={styles.iconBtn} title={item.hidden ? 'Show' : 'Hide'} onClick={(e) => { e.stopPropagation(); onToggleHide(item); }}>
        {item.hidden ? '🚫' : '👁'}
      </button>
    </div>
  );
}

function CustomPaletteItem({ unit, onEdit, onDelete }) {
  const onDragStart = (e) => {
    e.dataTransfer.setData('application/unitop-type', unit.baseType);
    e.dataTransfer.setData('application/unitop-label', unit.label);
    e.dataTransfer.setData('application/unitop-params', JSON.stringify(unit.params || {}));
    if (unit.icon) e.dataTransfer.setData('application/unitop-icon', unit.icon);
    if (unit.animated) e.dataTransfer.setData('application/unitop-animated', '1');
    e.dataTransfer.effectAllowed = 'move';
  };
  return (
    <div draggable onDragStart={onDragStart} style={styles.item} title={`Drag to add: ${unit.label}`}>
      <span style={styles.itemIcon}><UnitOpIcon cat={unit.icon} opType={unit.baseType} animated={unit.animated} size={22} /></span>
      <span style={styles.itemText}>{unit.label}</span>
      <button style={styles.iconBtn} title="Edit" onClick={(e) => { e.stopPropagation(); onEdit(unit); }}>✎</button>
      <button style={{ ...styles.iconBtn, color: '#DC2626' }} title="Delete" onClick={(e) => { e.stopPropagation(); onDelete(unit.id); }}>🗑</button>
    </div>
  );
}

// ── Add / edit modal ─────────────────────────────────────────────────────────

function EditModal({ spec, onSaveCustom, onSaveBuiltin, onReset, onCancel }) {
  const isBuiltin = spec.mode === 'builtin';
  const src = spec.data || {};
  const [label, setLabel]       = useState(src.label || '');
  const [icon, setIcon]         = useState(src.icon || 'clarifier');
  const [animated, setAnimated] = useState(!!src.animated);
  const [category, setCategory] = useState(src.category || 'Custom Units');
  const [hidden, setHidden]     = useState(!!src.hidden);
  const [rows, setRows]         = useState(() => Object.entries(src.params || {}).map(([k, v]) => ({ k, v: String(v) })));
  const valid = label.trim().length > 0;

  const setRow = (i, key, val) => setRows(rs => rs.map((r, idx) => idx === i ? { ...r, [key]: val } : r));
  const addRow = () => setRows(rs => [...rs, { k: '', v: '' }]);
  const delRow = (i) => setRows(rs => rs.filter((_, idx) => idx !== i));

  const submit = (e) => {
    e.preventDefault();
    if (!valid) return;
    if (isBuiltin) {
      onSaveBuiltin(spec.data.type, { label: label.trim(), category: category.trim() || undefined, hidden });
    } else {
      const params = {};
      for (const r of rows) { const k = r.k.trim(); if (k) params[k] = coerce(r.v); }
      onSaveCustom({ label: label.trim(), icon, animated, baseType: baseForIcon(icon), category: category.trim() || 'Custom Units', params });
    }
  };

  return (
    <div style={styles.modalOverlay} onClick={onCancel}>
      <form style={styles.modal} onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <div style={styles.modalTitle}>
          {isBuiltin ? 'Edit unit operation' : spec.mode === 'new' ? 'Add unit operation' : 'Edit custom unit'}
        </div>

        <label style={styles.fieldLabel} htmlFor="cu-label">Name</label>
        <input id="cu-label" style={styles.input} value={label} autoFocus
          placeholder="e.g. High-rate Clarifier" onChange={(e) => setLabel(e.target.value)} />

        {!isBuiltin && (
          <>
            <label style={styles.fieldLabel}>Icon</label>
            <div style={styles.iconGrid}>
              {ICON_OPTIONS.map(o => (
                <button type="button" key={o.cat} title={o.label} onClick={() => setIcon(o.cat)}
                  style={{ ...styles.iconChoice, ...(icon === o.cat ? styles.iconChoiceOn : {}) }}>
                  <UnitOpIcon cat={o.cat} animated={animated && icon === o.cat} size={26} />
                </button>
              ))}
            </div>
            <label style={styles.checkRow}>
              <input type="checkbox" checked={animated} onChange={(e) => setAnimated(e.target.checked)} />
              Live animated icon
              <span style={styles.previewBox}><UnitOpIcon cat={icon} animated={animated} size={26} /></span>
            </label>
          </>
        )}

        <label style={styles.fieldLabel} htmlFor="cu-cat">Category</label>
        <input id="cu-cat" style={styles.input} value={category}
          placeholder={isBuiltin ? 'Category' : 'Custom Units'} onChange={(e) => setCategory(e.target.value)} />

        {isBuiltin && (
          <label style={styles.checkRow}>
            <input type="checkbox" checked={hidden} onChange={(e) => setHidden(e.target.checked)} />
            Hide from palette
          </label>
        )}

        {!isBuiltin && (
          <>
            <label style={styles.fieldLabel}>Default parameters (optional)</label>
            {rows.map((r, i) => (
              <div key={i} style={styles.paramRow}>
                <input style={{ ...styles.input, margin: 0, flex: 1 }} placeholder="key (e.g. SRT_d)" value={r.k} onChange={(e) => setRow(i, 'k', e.target.value)} />
                <input style={{ ...styles.input, margin: 0, width: 90 }} placeholder="value" value={r.v} onChange={(e) => setRow(i, 'v', e.target.value)} />
                <button type="button" style={styles.iconBtn} title="Remove" onClick={() => delRow(i)}>✕</button>
              </div>
            ))}
            <button type="button" style={styles.addParam} onClick={addRow}>+ Add parameter</button>
            <p style={styles.hintText}>Applied when dropped. You can still tune them on the node afterwards.</p>
          </>
        )}

        <div style={styles.modalBtns}>
          {isBuiltin && spec.data.overridden && (
            <button type="button" style={styles.btnReset} onClick={() => onReset(spec.data.type)}>Reset to default</button>
          )}
          <div style={{ flex: 1 }} />
          <button type="button" style={styles.btnGhost} onClick={onCancel}>Cancel</button>
          <button type="submit" style={{ ...styles.btnPrimary, opacity: valid ? 1 : 0.5 }} disabled={!valid}>Save</button>
        </div>
      </form>
    </div>
  );
}

// ── Palette ──────────────────────────────────────────────────────────────────

export default function UnitOpPalette({ nodes = [], projectId }) {
  const existingTypes = new Set(nodes.map(n => n.data?.opType).filter(Boolean));
  const [open, setOpen] = useState(false);
  const [showHidden, setShowHidden] = useState(false);
  const [modal, setModal] = useState(null); // null | {mode:'new'} | {mode:'custom',data} | {mode:'builtin',data}

  const units       = useCustomUnitStore(s => s.units);
  const overrides   = useCustomUnitStore(s => s.overrides);
  const addUnit     = useCustomUnitStore(s => s.addUnit);
  const updateUnit  = useCustomUnitStore(s => s.updateUnit);
  const removeUnit  = useCustomUnitStore(s => s.removeUnit);
  const setOverride = useCustomUnitStore(s => s.setOverride);
  const resetOverride = useCustomUnitStore(s => s.resetOverride);
  const hydrate     = useCustomUnitStore(s => s.hydrate);

  // Load this project's saved palette customization
  const hydratedRef = useRef(false);
  useEffect(() => {
    if (!projectId) { hydratedRef.current = true; return; }
    hydratedRef.current = false;
    let cancelled = false;
    api.get(`/projects/${projectId}`).then(({ data }) => {
      if (cancelled) return;
      const pc = data?.settings?.paletteCustom;
      if (pc && ((pc.units && pc.units.length) || (pc.overrides && Object.keys(pc.overrides).length))) hydrate(pc);
    }).catch(() => {}).finally(() => { if (!cancelled) hydratedRef.current = true; });
    return () => { cancelled = true; };
  }, [projectId, hydrate]);

  // Debounced save back to the project
  useEffect(() => {
    if (!projectId || !hydratedRef.current) return;
    const t = setTimeout(() => {
      api.patch(`/projects/${projectId}`, { settings: { paletteCustom: { units, overrides } } }).catch(() => {});
    }, 800);
    return () => clearTimeout(t);
  }, [units, overrides, projectId]);

  const groups = buildGroups(overrides, units, showHidden);
  const hasHidden = Object.values(overrides).some(o => o?.hidden);

  const openEdit = (item) => {
    if (item.kind === 'custom') setModal({ mode: 'custom', data: item.unit });
    else setModal({ mode: 'builtin', data: item });
  };

  return (
    <>
      {!open && (
        <button
          className="md:hidden absolute left-2 top-2 z-20 bg-white border border-gray-200 shadow rounded-lg px-2.5 py-1.5 text-xs font-bold text-brand-700 flex items-center gap-1.5"
          onClick={() => setOpen(true)} style={{ position: 'absolute' }}
        >⊞ Palette</button>
      )}
      {open && <div className="md:hidden fixed inset-0 bg-black/30 z-30" onClick={() => setOpen(false)} />}

      <aside style={styles.panel}
        className={`transition-transform duration-300 fixed md:relative top-0 left-0 h-full z-40 md:translate-x-0 md:flex md:z-auto ${open ? 'translate-x-0 flex' : '-translate-x-full hidden md:flex'}`}>
        <div style={styles.header} className="flex items-center justify-between">
          <span>Unit Operations</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <button style={styles.addBtn} title="Add a custom unit operation" onClick={() => setModal({ mode: 'new' })}>+ Add</button>
            <button className="md:hidden text-brand-200 hover:text-white p-1 rounded" onClick={() => setOpen(false)}>✕</button>
          </div>
        </div>

        <div style={styles.scrollArea}>
          {groups.map(group => (
            <div key={group.category} style={styles.group}>
              <div style={styles.groupTitle}>{group.category}</div>
              {group.items.map(item => item.kind === 'builtin'
                ? <BuiltinItem key={item.type + group.category} item={item}
                    disabled={item.singleton && existingTypes.has(item.type)}
                    onEdit={openEdit}
                    onToggleHide={(it) => setOverride(it.type, { hidden: !it.hidden })} />
                : <CustomPaletteItem key={item.unit.id} unit={item.unit} onEdit={openEdit} onDelete={removeUnit} />
              )}
            </div>
          ))}
          <button style={styles.addRow} onClick={() => setModal({ mode: 'new' })}>+ Add unit operation</button>
        </div>

        <div style={styles.footer}>
          {hasHidden && (
            <button style={styles.showHidden} onClick={() => setShowHidden(v => !v)}>
              {showHidden ? 'Hide hidden units' : 'Show hidden units'}
            </button>
          )}
          <div style={styles.hint}>Drag items onto the canvas</div>
        </div>
      </aside>

      {modal && (
        <EditModal
          spec={modal}
          onCancel={() => setModal(null)}
          onSaveCustom={(data) => { if (modal.mode === 'new') addUnit(data); else updateUnit(modal.data.id, data); setModal(null); }}
          onSaveBuiltin={(type, patch) => { setOverride(type, patch); setModal(null); }}
          onReset={(type) => { resetOverride(type); setModal(null); }}
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
  item:      { display: 'flex', alignItems: 'center', gap: 8, padding: '7px 12px 7px 14px', cursor: 'grab', fontSize: 13, color: '#374151', userSelect: 'none', borderRadius: 8 },
  itemIcon:  { display: 'flex', alignItems: 'center', justifyContent: 'center', width: 26, height: 26, flexShrink: 0 },
  itemText:  { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  iconBtn:   { border: 'none', background: 'none', cursor: 'pointer', fontSize: 12, color: '#9CA3AF', padding: '2px 3px', lineHeight: 1, flexShrink: 0 },
  addBtn:    { fontSize: 11, fontWeight: 700, color: '#0891B2', background: '#ECFEFF', border: '1px solid #A5F3FC', borderRadius: 6, padding: '3px 8px', cursor: 'pointer' },
  addRow:    { display: 'block', width: 'calc(100% - 20px)', margin: '4px 10px 8px', padding: '8px', fontSize: 12.5, fontWeight: 600, color: '#0891B2', background: '#fff', border: '1px dashed #A5F3FC', borderRadius: 8, cursor: 'pointer' },
  footer:    { borderTop: '1px solid #E5E7EB' },
  showHidden:{ display: 'block', width: '100%', padding: '8px 14px', fontSize: 11, fontWeight: 600, color: '#6B7280', background: '#F9FAFB', border: 'none', borderBottom: '1px solid #E5E7EB', cursor: 'pointer', textAlign: 'left' },
  hint:      { padding: '10px 14px', fontSize: 11, color: '#9CA3AF', fontStyle: 'italic' },
  // modal
  modalOverlay: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)', zIndex: 60, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 },
  modal:     { background: '#fff', borderRadius: 14, boxShadow: '0 20px 50px rgba(0,0,0,0.25)', width: 'min(400px, 94vw)', maxHeight: '90vh', overflowY: 'auto', padding: 20, display: 'flex', flexDirection: 'column' },
  modalTitle:{ fontSize: 16, fontWeight: 700, color: '#1F4E79', marginBottom: 12 },
  fieldLabel:{ fontSize: 12, fontWeight: 600, color: '#374151', margin: '8px 0 4px' },
  input:     { width: '100%', padding: '8px 10px', border: '1px solid #D1D5DB', borderRadius: 8, fontSize: 13, color: '#111', margin: '0 0 4px', boxSizing: 'border-box' },
  iconGrid:  { display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 6, marginBottom: 4 },
  iconChoice:{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 6, background: '#fff', border: '1px solid #E5E7EB', borderRadius: 8, cursor: 'pointer' },
  iconChoiceOn: { border: '2px solid #0891B2', background: '#ECFEFF' },
  previewBox:{ marginLeft: 'auto', display: 'flex', alignItems: 'center', justifyContent: 'center', width: 34, height: 34, background: '#F9FAFB', border: '1px solid #E5E7EB', borderRadius: 8 },
  paramRow:  { display: 'flex', alignItems: 'center', gap: 6, marginBottom: 5 },
  addParam:  { fontSize: 12, fontWeight: 600, color: '#0891B2', background: 'none', border: 'none', cursor: 'pointer', padding: '2px 0', textAlign: 'left' },
  checkRow:  { display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: '#374151', margin: '8px 0 4px' },
  hintText:  { fontSize: 11, color: '#9CA3AF', margin: '4px 0 0' },
  modalBtns: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 16 },
  btnGhost:  { padding: '8px 14px', background: '#F3F4F6', color: '#374151', border: 'none', borderRadius: 8, fontWeight: 600, fontSize: 13, cursor: 'pointer' },
  btnPrimary:{ padding: '8px 16px', background: '#0891B2', color: '#fff', border: 'none', borderRadius: 8, fontWeight: 600, fontSize: 13, cursor: 'pointer' },
  btnReset:  { padding: '8px 12px', background: 'none', color: '#DC2626', border: '1px solid #FCA5A5', borderRadius: 8, fontWeight: 600, fontSize: 12.5, cursor: 'pointer' },
};
