/**
 * customUnitStore — palette customization.
 *
 *   units:     user-defined units  [{ id, label, category, baseType, params }]
 *   overrides: edits to built-ins   { [builtinType]: { label?, category?, hidden? } }
 *
 * Cached per-browser in localStorage and (when a project is open) synced to
 * that project's settings.paletteCustom so it follows the user across devices.
 */
import { create } from 'zustand';

const KEY = 'watersim_palette_custom';

function load() {
  try {
    const j = JSON.parse(localStorage.getItem(KEY));
    return { units: j?.units || [], overrides: j?.overrides || {} };
  } catch { return { units: [], overrides: {} }; }
}
function persist(s) {
  try { localStorage.setItem(KEY, JSON.stringify({ units: s.units, overrides: s.overrides })); }
  catch { /* quota / private mode */ }
}

let seq = Date.now();
const nextId = () => `cu_${seq++}`;
const init = load();

const useCustomUnitStore = create((set) => ({
  units: init.units,
  overrides: init.overrides,

  addUnit: (u) => set((s) => {
    const units = [...s.units, { id: nextId(), category: 'Custom Units', params: {}, ...u }];
    persist({ ...s, units }); return { units };
  }),
  updateUnit: (id, patch) => set((s) => {
    const units = s.units.map((u) => (u.id === id ? { ...u, ...patch } : u));
    persist({ ...s, units }); return { units };
  }),
  removeUnit: (id) => set((s) => {
    const units = s.units.filter((u) => u.id !== id);
    persist({ ...s, units }); return { units };
  }),

  setOverride: (type, patch) => set((s) => {
    const overrides = { ...s.overrides, [type]: { ...(s.overrides[type] || {}), ...patch } };
    persist({ ...s, overrides }); return { overrides };
  }),
  resetOverride: (type) => set((s) => {
    const overrides = { ...s.overrides }; delete overrides[type];
    persist({ ...s, overrides }); return { overrides };
  }),

  /** Replace state from a project's saved blob (no re-save loop needed). */
  hydrate: (data) => set(() => {
    const next = { units: data?.units || [], overrides: data?.overrides || {} };
    persist(next); return next;
  }),
}));

export default useCustomUnitStore;
