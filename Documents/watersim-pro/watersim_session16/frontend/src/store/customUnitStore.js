/**
 * customUnitStore — user-defined unit operations for the palette.
 *
 * A custom unit is a labelled preset over an existing solver model (baseType),
 * so it drags onto the canvas and simulates exactly like the built-in it is
 * based on. Persisted per-browser in localStorage.
 *
 *   { id, label, category, baseType }
 */
import { create } from 'zustand';

const KEY = 'watersim_custom_units';

function load() {
  try { return JSON.parse(localStorage.getItem(KEY)) || []; } catch { return []; }
}
function persist(units) {
  try { localStorage.setItem(KEY, JSON.stringify(units)); } catch { /* quota / private mode */ }
}

let seq = Date.now();
const nextId = () => `cu_${seq++}`;

const useCustomUnitStore = create((set) => ({
  units: load(),
  addUnit: (u) => set((s) => {
    const units = [...s.units, { id: nextId(), category: 'Custom Units', ...u }];
    persist(units);
    return { units };
  }),
  updateUnit: (id, patch) => set((s) => {
    const units = s.units.map((u) => (u.id === id ? { ...u, ...patch } : u));
    persist(units);
    return { units };
  }),
  removeUnit: (id) => set((s) => {
    const units = s.units.filter((u) => u.id !== id);
    persist(units);
    return { units };
  }),
}));

export default useCustomUnitStore;
