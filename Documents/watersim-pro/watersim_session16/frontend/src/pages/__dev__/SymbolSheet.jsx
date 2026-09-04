/**
 * SymbolSheet — the equipment-glyph contact sheet (spec §8, lanes C/D/E)
 * ─────────────────────────────────────────────────────────────────────────────
 * "Add `frontend/src/pages/__dev__/SymbolSheet.jsx` — a contact sheet rendering
 *  all 26 at 1× and 0.5×, in every state (rest / live / OFF / watch / alarm),
 *  so 26 glyphs are not drawn by 26 different judgement calls."
 *
 * DEV HARNESS ONLY. Deliberately NOT routed in `App.jsx`: mount it by hand
 * (or point a throwaway route at it) while drawing symbols. It is shared by
 * lanes C, D and E.
 *
 * It renders WHATEVER IS IN THE REGISTRY plus the placeholder, so it works
 * today with lane C's ten and grows on its own as lanes D and E land — the
 * `import.meta.glob` below eagerly loads every `symbols/*.jsx`, and each symbol
 * module registers itself on import. Nothing here needs editing per symbol.
 *
 * The five state columns are driven by FAKE `NodeSnapshot`s shaped exactly like
 * the ones `liveStore.getNodeSnapshot()` hands a real node — same keys, same
 * `{}`-for-no-metrics, same `refs` — so a symbol that looks right here looks
 * right on the canvas.
 */

import { useState } from 'react';
import SymbolDefs, {
  SYMBOLS, getSymbol, getTag, PlaceholderSymbol,
} from '../../components/canvas/symbols';
import '../../styles/canvas-tokens.css';
import '../../styles/canvas-motion.css';

/* Every symbol module registers itself as a side effect of being imported.
   Eager-glob so lanes D and E appear the moment their files exist, and so this
   harness never needs a per-symbol edit. Absent lanes are simply absent. */
const LOADED = Object.keys(
  import.meta.glob('../../components/canvas/symbols/*.jsx', { eager: true })
);

const PLACEHOLDER_KEY = '__placeholder__';

// ═══════════════════════════════════════════════════════════════════════════
// Fixtures — shaped like a real NodeSnapshot
// ═══════════════════════════════════════════════════════════════════════════

const REFS = Object.freeze({
  Qref: 12000, O2ref: 800, screenRef: 120, doseRef: 400,
  gasRef: 4200, sludgeRef: 500, powerRef: 20,
});

const DOSE = { chemical_type: 'alum', dose_mg_L: 30, dose_kg_d: 300, sludge_kg_d: 78, pH_in: 7.2, pH_out: 7.2 };

/** `rest` and `live` share these; only the `live` flag differs. */
const BASE = {
  inlet: { Q_in: 10000 },
  outlet: { Q_out: 9800, compliant: true, permit_violations: [] },
  pump: {
    status: 'ON', speed_pct: 85, Q_in_m3_d: 10000, Q_delivered_m3_d: 8500,
    blocked_Q_m3_d: 0, power_kW: 14.2, energy_kWh_d: 340.8,
  },
  valve: { status: 'OPEN', opening_pct: 100, Q_in_m3_d: 8500, Q_out_m3_d: 8500, blocked_Q_m3_d: 0 },
  blower: {},
  screening: {
    screenType: 'fine', TSS_removal_pct: '15.0', screenings_kg_d: 82.5,
    BOD_removed_kg_d: 20, screenings_Q_m3_d: 0.41, headloss_m: 0.15,
  },
  chemical_dosing: DOSE,
  coagulant_dosing: { ...DOSE, chemical_type: 'ferric_chloride', dose_kg_d: 220 },
  polymer_dosing: { ...DOSE, chemical_type: 'polymer', dose_mg_L: 4, dose_kg_d: 40 },
  ph_adjustment: { ...DOSE, chemical_type: 'naoh', dose_mg_L: 60, dose_kg_d: 380, pH_in: 6.4, pH_out: 7.4 },
};

const OFF = {
  pump: { status: 'OFF', speed_pct: 85, Q_in_m3_d: 10000, Q_delivered_m3_d: 0, blocked_Q_m3_d: 10000, power_kW: 0 },
  valve: { status: 'CLOSED', opening_pct: 0, Q_in_m3_d: 8500, Q_out_m3_d: 0, blocked_Q_m3_d: 8500 },
  blower: {},
  chemical_dosing: { ...DOSE, dose_mg_L: 0, dose_kg_d: 0 },
  coagulant_dosing: { ...DOSE, dose_mg_L: 0, dose_kg_d: 0 },
  polymer_dosing: { ...DOSE, dose_mg_L: 0, dose_kg_d: 0 },
  ph_adjustment: { ...DOSE, dose_mg_L: 0, dose_kg_d: 0 },
  screening: { ...BASE.screening, screenings_kg_d: 0 },
};

const WATCH = {
  pump: { ...BASE.pump, blocked_Q_m3_d: 1500 },
  valve: { ...BASE.valve, status: 'THROTTLED', opening_pct: 35, Q_out_m3_d: 2975, blocked_Q_m3_d: 5525 },
  screening: { ...BASE.screening, headloss_m: 0.55 },
  ph_adjustment: { ...BASE.ph_adjustment, pH_in: 6.2, pH_out: 8.4 },
};

const VIOLATIONS = [
  { param: 'TN', value: 14.2, limit: 10, unit: 'mg/L' },
  { param: 'TSS', value: 41.0, limit: 30, unit: 'mg/L' },
  { param: 'TP', value: 2.4, limit: 1, unit: 'mg/L' },
  { param: 'BOD', value: 35.1, limit: 30, unit: 'mg/L' },
];

const ALARM = {
  outlet: { Q_out: 9800, compliant: false, permit_violations: VIOLATIONS },
};

const DATA = {
  pump: { label: 'Transfer Pump', params: { running: 1, speed_pct: 85 } },
  valve: { label: 'Throttle Valve', params: { open: 1, opening_pct: 100 } },
  screening: { label: 'Bar Screen', params: { screenType: 'fine', headloss_m: 0.15 } },
};

/** Blower duty is DERIVED — there is no blower model. Unlinked in OFF/alarm. */
const DERIVED = {
  rest: { blower: { O2_served: 640, servedCount: 2 } },
  live: { blower: { O2_served: 640, servedCount: 2 } },
  watch: { blower: { O2_served: 180, servedCount: 1 } },
  off: { blower: { O2_served: 0, servedCount: 0 } },
  alarm: { blower: { O2_served: 0, servedCount: 0 } },
};

const STATES = [
  { key: 'rest', label: 'rest', live: false, note: 'results, no motion' },
  { key: 'live', label: 'live', live: true, note: 'loops running' },
  { key: 'off', label: 'OFF', live: true, note: 'stopped / closed / unlinked' },
  { key: 'watch', label: 'watch', live: true, note: 'amber, never blinks' },
  { key: 'alarm', label: 'alarm', live: true, note: 'violations, else model error' },
];

function metricsFor(opType, stateKey) {
  if (stateKey === 'off') return OFF[opType] ?? BASE[opType] ?? {};
  if (stateKey === 'watch') return WATCH[opType] ?? BASE[opType] ?? {};
  if (stateKey === 'alarm') return ALARM[opType] ?? { error: 'Model raised an error' };
  return BASE[opType] ?? {};
}

function snapshotFor(opType, st) {
  const metrics = metricsFor(opType, st.key);
  return {
    id: `dev-${opType}`,
    live: st.live,
    seq: 7,
    changedSeq: 7,
    hasResults: true,
    type: opType,
    opType,
    metrics,
    biogas: null,
    outputs: {},
    derived: DERIVED[st.key]?.[opType] ?? {},
    refs: REFS,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Presentation
// ═══════════════════════════════════════════════════════════════════════════

const cxs = (...p) => p.filter(Boolean).join(' ');

const S = {
  page: { padding: 20, background: '#F7F8FA', minHeight: '100vh', fontFamily: 'Inter, system-ui, sans-serif' },
  h1: { fontSize: 16, fontWeight: 700, margin: '0 0 4px', color: '#0B1220' },
  sub: { fontSize: 12, color: '#64748B', margin: '0 0 16px' },
  bar: { display: 'flex', gap: 16, alignItems: 'center', marginBottom: 16, fontSize: 12, color: '#1E293B' },
  table: { borderCollapse: 'separate', borderSpacing: 0, fontSize: 11 },
  th: {
    textAlign: 'left', padding: '6px 10px', fontSize: 10, fontWeight: 700,
    letterSpacing: '0.06em', textTransform: 'uppercase', color: '#94A3B8',
    borderBottom: '1px solid #E2E8F0', whiteSpace: 'nowrap',
  },
  rowHead: {
    padding: '8px 10px', verticalAlign: 'middle', borderBottom: '1px solid #E2E8F0',
    whiteSpace: 'nowrap',
  },
  cell: { padding: 6, borderBottom: '1px solid #E2E8F0', verticalAlign: 'middle' },
  frame: {
    background: '#FFFFFF', border: '1px solid #E2E8F0', borderRadius: 2,
    display: 'block',
  },
  tag: {
    fontFamily: 'ui-monospace, Menlo, Consolas, monospace', fontSize: 9.5, fontWeight: 700,
    letterSpacing: '0.06em', color: '#94A3B8',
  },
  name: { fontSize: 11, fontWeight: 600, color: '#0B1220' },
  missing: { fontSize: 10, color: '#B45309' },
};

function SymbolCell({ opType, Comp, st, lodFar }) {
  const snap = snapshotFor(opType, st);
  const data = DATA[opType];
  return (
    <td style={S.cell}>
      <div className={cxs('ws-sheet', st.live && 'ws-live', lodFar && 'ws-lod-far')} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        {[1, 0.5].map((scale) => (
          <svg
            key={scale}
            className="ws-frame"
            viewBox="0 0 144 60"
            width={144 * scale}
            height={60 * scale}
            style={S.frame}
            role="img"
            aria-label={`${opType} — ${st.label} — ${scale}x`}
          >
            <Comp
              nodeId={`dev-${opType}-${st.key}`}
              opType={opType}
              data={data}
              state={st.key}
              snap={snap}
            />
          </svg>
        ))}
      </div>
    </td>
  );
}

export default function SymbolSheet() {
  const [lodFar, setLodFar] = useState(false);

  // Registry order is insertion order; sort so the sheet is stable to read.
  const types = Object.keys(SYMBOLS).sort();
  const rows = [...types, PLACEHOLDER_KEY];

  return (
    <div style={S.page}>
      {/* One shared sprite for the whole page, exactly as the canvas does it. */}
      <div className="ws-sheet"><SymbolDefs /></div>

      <h1 style={S.h1}>Symbol contact sheet</h1>
      <p style={S.sub}>
        {`${types.length} registered symbol${types.length === 1 ? '' : 's'} from ${LOADED.length} module${LOADED.length === 1 ? '' : 's'}`}
        {' · each cell is 1× (144×60) then 0.5× · dev harness, not routed'}
      </p>

      <div style={S.bar}>
        <label style={{ display: 'flex', gap: 6, alignItems: 'center', cursor: 'pointer' }}>
          <input type="checkbox" checked={lodFar} onChange={(e) => setLodFar(e.target.checked)} />
          {'.ws-lod-far (zoom < 0.40 — motion off, symbols collapse by CSS alone)'}
        </label>
        <span style={{ color: '#64748B' }}>
          {'Reduced motion is honoured by the OS setting — turn it on and every loop must stop with every value still legible.'}
        </span>
      </div>

      <table style={S.table}>
        <thead>
          <tr>
            <th style={S.th}>op type</th>
            {STATES.map((st) => (
              <th key={st.key} style={S.th}>
                {st.label}
                <div style={{ fontWeight: 400, textTransform: 'none', letterSpacing: 0, color: '#94A3B8' }}>
                  {st.note}
                </div>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((opType) => {
            const isPlaceholder = opType === PLACEHOLDER_KEY;
            const Comp = isPlaceholder ? PlaceholderSymbol : getSymbol(opType);
            return (
              <tr key={opType}>
                <td style={S.rowHead}>
                  <div style={S.tag}>{isPlaceholder ? '—' : getTag(opType)}</div>
                  <div style={S.name}>{isPlaceholder ? 'placeholder' : opType}</div>
                  {isPlaceholder && <div style={S.missing}>unregistered / future lane</div>}
                </td>
                {STATES.map((st) => (
                  <SymbolCell key={st.key} opType={isPlaceholder ? 'unknown' : opType} Comp={Comp} st={st} lodFar={lodFar} />
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
