/**
 * ITC Sewage Treatment Plant — the eleven process areas, device by device.
 *
 * SOURCE OF TRUTH: "Project Proposal v2" (Client ITC · Contractor Safekrite ·
 * Sub-contractor Infercon Automation), slides 4–15. Every row below is a
 * transcription of one row of a "Controls Involved" table, with the proposal's
 * OWN printed I/O counts preserved verbatim in `printed`.
 *
 * ── WHY `printed` IS KEPT ALONGSIDE THE DEVICE DEFINITION ────────────────────
 * The proposal counts I/O three times — in the per-process tables (slides 4–14),
 * again in the Pump & Valve list (slide 15), and a fourth time as panel capacity
 * in the architecture slides — and the four counts do not agree. Rather than
 * silently pick one, this module records the device (from which a count is
 * DERIVED by signal rules) and the number the proposal PRINTED for that row.
 * `ioSchedule.js` reconciles them and reports every divergence.
 *
 * Signal rules used for the derived count (SIGNAL_RULES below) are the
 * conventional ones for this instrument list, and are exactly what the
 * proposal's own Monitoring / Control columns describe:
 *
 *   on/off valve   2 DI (open + close limit switch)   1 DO (open/close command)
 *   pump           2 DI (run status + trip)           1 DO (start/stop)
 *   air blower     2 DI (on/off status + trip)        1 DO (start/stop)
 *   decanter VFD   2 DI (on/off status + trip)        2 DO (start/stop + fwd/rev)
 *   level switch   1 DI (high level)                  —
 *   level transmitter / flow meter / pH        1 AI each
 *
 * Nothing in this file is computed. Derivation lives in `ioSchedule.js`.
 */
'use strict';

/** Per-unit signal counts by device kind. See the header for provenance. */
const SIGNAL_RULES = Object.freeze({
  butterfly_valve: { DI: 2, DO: 1, AI: 0, AO: 0, monitoring: ['Open status', 'Close status'], control: 'On/Off control' },
  ball_valve:      { DI: 2, DO: 1, AI: 0, AO: 0, monitoring: ['Open status', 'Close status'], control: 'On/Off control' },
  bypass_valve:    { DI: 2, DO: 1, AI: 0, AO: 0, monitoring: ['Open status', 'Close status'], control: 'On/Off control' },
  air_valve:       { DI: 2, DO: 1, AI: 0, AO: 0, monitoring: ['Open status', 'Close status'], control: 'On/Off control' },
  pump:            { DI: 2, DO: 1, AI: 0, AO: 0, monitoring: ['Pump status', 'Trip status'],  control: 'On/Off control' },
  dosing_pump:     { DI: 2, DO: 1, AI: 0, AO: 0, monitoring: ['Pump status', 'Trip status'],  control: 'On/Off control' },
  agitator:        { DI: 2, DO: 1, AI: 0, AO: 0, monitoring: ['Run status', 'Trip status'],   control: 'On/Off control' },
  air_blower:      { DI: 2, DO: 1, AI: 0, AO: 0, monitoring: ['On/Off status', 'Trip status'], control: 'On/Off control' },
  decanter_vfd:    { DI: 2, DO: 2, AI: 0, AO: 0, monitoring: ['On/Off status', 'Trip status'], control: 'On/Off control + Fwd/Rev' },
  level_switch:    { DI: 1, DO: 0, AI: 0, AO: 0, monitoring: ['High level'],  control: 'Status only' },
  level_tx:        { DI: 0, DO: 0, AI: 1, AO: 0, monitoring: ['Level'],       control: 'Measurement' },
  flow_meter:      { DI: 0, DO: 0, AI: 1, AO: 0, monitoring: ['Flow'],        control: 'Measurement' },
  ph_analyser:     { DI: 0, DO: 0, AI: 1, AO: 0, monitoring: ['pH'],          control: 'Measurement' },
});

/** Human labels for the device kinds, for schedules and BOQs. */
const KIND_LABELS = Object.freeze({
  butterfly_valve: 'Butterfly valve (actuated)',
  ball_valve:      'Ball valve (actuated)',
  bypass_valve:    'Bypass valve (actuated)',
  air_valve:       'Air valve (actuated)',
  pump:            'Pump',
  dosing_pump:     'Dosing pump',
  agitator:        'Agitator',
  air_blower:      'Air blower',
  decanter_vfd:    'Decanter with VFD',
  level_switch:    'Level switch',
  level_tx:        'Level transmitter',
  flow_meter:      'Flow meter',
  ph_analyser:     'pH analyser',
});

/** Device-kind to the costing family used on proposal slide 16. */
const COST_FAMILY = Object.freeze({
  butterfly_valve: 'valves', ball_valve: 'valves', bypass_valve: 'valves', air_valve: 'valves',
  pump: 'pumps', dosing_pump: 'pumps', agitator: 'pumps', air_blower: 'pumps', decanter_vfd: 'pumps',
  level_switch: 'tank_level', level_tx: 'tank_level',
  flow_meter: 'flow_ph', ph_analyser: 'flow_ph',
});

/**
 * The eleven process areas.
 *
 * process.devices[]     — one entry per row of the proposal's Controls Involved
 *   table. `printed` is that row's DI/DO/AI/AO exactly as the slide shows it.
 * process.printedTotals — the column sums of that slide's table.
 * process.summaryTotals — the same area's row on the slide-15 Pump & Valve list.
 */
const PROCESSES = Object.freeze([
  {
    no: 1,
    id: 'feed_water',
    name: 'Feed Water Process',
    system: 'Effluent Lifting Pump (ELP)',
    area: 'ELP',
    slide: 4,
    inputs: ['Kitchen influent — 100 KLD', 'Sewage influent — 475 KLD', 'Laundry influent — 100 KLD'],
    outputs: ['Equalisation tank (EQT)'],
    spec: {
      pipe: 'UPVC 50 mm',
      pumps: 'Pri + Sec, 5 m³/hr @ 8 m, Johnson, qty 2 (1W + 1SB)',
      tanks: 'OGT 400×500 mm · CT 600×1000 mm · EQT 400×500 mm',
      meters: 'EQT tank level',
    },
    devices: [
      { tag: 'ELP-XV-101', qty: 2, name: 'PP & SP inlet valves', kind: 'butterfly_valve', printed: { DI: 4, DO: 2, AI: 0, AO: 0 } },
      { tag: 'ELP-P-101', qty: 2, name: 'Primary + Secondary lifting pump', kind: 'pump', printed: { DI: 4, DO: 2, AI: 0, AO: 0 } },
      { tag: 'ELP-XV-111', qty: 2, name: 'PP & SP outlet valves', kind: 'butterfly_valve', printed: { DI: 4, DO: 2, AI: 0, AO: 0 } },
      { tag: 'OGT-LSH-101', qty: 2, name: 'OGT + CT high-level switches', kind: 'level_switch', printed: { DI: 2, DO: 0, AI: 0, AO: 0 },
        note: 'Printed as one row of qty 1 covering both the oil & grease trap and the collection tank; two switches are wired.' },
      { tag: 'EQT-LT-101', qty: 1, name: 'EQT level transmitter', kind: 'level_tx', printed: { DI: 0, DO: 0, AI: 1, AO: 0 } },
    ],
    printedTotals: { DI: 14, DO: 6, AI: 1, AO: 0 },
    summaryTotals: { DI: 14, DO: 6, AI: 1, AO: 0 },
  },
  {
    no: 2,
    id: 'reactor_feed',
    name: 'Reactor Feed Pump Process',
    system: 'Reactor Feed Pump (RFP)',
    area: 'RFP',
    slide: 5,
    inputs: ['Equalisation tank (EQT)'],
    outputs: ['Reactor tank R1', 'Reactor tank R2'],
    spec: {
      pipe: 'UPVC 100 mm',
      pumps: 'Pri + Sec, 43 m³/hr @ 8 m, Johnson, qty 2 (1W + 1SB)',
      meters: 'Discharge flow meter',
    },
    devices: [
      { tag: 'RFP-XV-201', qty: 2, name: 'PP & SP inlet valves', kind: 'butterfly_valve', printed: { DI: 2, DO: 2, AI: 0, AO: 0 } },
      { tag: 'RFP-P-201', qty: 2, name: 'Primary + Secondary reactor feed pump', kind: 'pump', printed: { DI: 4, DO: 2, AI: 0, AO: 0 } },
      { tag: 'RFP-XV-211', qty: 2, name: 'PP & SP outlet valves', kind: 'butterfly_valve', printed: { DI: 2, DO: 2, AI: 0, AO: 0 } },
      { tag: 'RFP-FT-201', qty: 1, name: 'Reactor feed flow meter', kind: 'flow_meter', printed: { DI: 0, DO: 0, AI: 1, AO: 0 } },
    ],
    printedTotals: { DI: 8, DO: 6, AI: 1, AO: 0 },
    summaryTotals: { DI: 8, DO: 6, AI: 1, AO: 0 },
  },
  {
    no: 3,
    id: 'reactor',
    name: 'Reactor Process',
    system: 'Sequencing reactors R1 / R2 + Sludge Transfer Pump (STP)',
    area: 'R',
    slide: 6,
    inputs: ['Reactor Feed Pump (RFP)'],
    outputs: ['Intermediate water tank (INT-WT) via decanter', 'Sludge holding tank (SHT)'],
    spec: {
      pipe: 'UPVC 80 mm',
      pumps: 'Pri + Sec + Dosing, 10 m³/hr @ 8 m',
      blowers: '475 m³/hr @ 0.55 kg/cm², Beta, qty 3 (2W + 1SB)',
      tanks: 'Reactor tanks R1 and R2',
      meters: 'R1 + R2 tank level',
    },
    devices: [
      { tag: 'R-XV-301', qty: 2, name: 'R1 & R2 inlet valves', kind: 'butterfly_valve', printed: { DI: 4, DO: 2, AI: 0, AO: 0 } },
      { tag: 'R-P-301', qty: 3, name: 'Pri + Sec sludge transfer pump, dosing pump', kind: 'pump', printed: { DI: 6, DO: 3, AI: 0, AO: 0 } },
      { tag: 'STP-XV-301', qty: 4, name: 'STP PP & SP inlet + outlet valves', kind: 'butterfly_valve', printed: { DI: 8, DO: 4, AI: 0, AO: 0 } },
      { tag: 'SHT-XV-301', qty: 2, name: 'Sludge tank ball valves', kind: 'ball_valve', printed: { DI: 4, DO: 2, AI: 0, AO: 0 } },
      { tag: 'R-XV-311', qty: 3, name: 'Aeration air valves', kind: 'air_valve', printed: { DI: 6, DO: 4, AI: 0, AO: 0 } },
      { tag: 'R-B-301', qty: 3, name: 'Air blowers (2W + 1SB)', kind: 'air_blower', printed: { DI: 6, DO: 3, AI: 0, AO: 0 } },
      { tag: 'R-LT-301', qty: 2, name: 'R1 + R2 level transmitters', kind: 'level_tx', printed: { DI: 0, DO: 0, AI: 2, AO: 0 } },
      { tag: 'R-M-301', qty: 2, name: 'R1 + R2 decanters with VFD', kind: 'decanter_vfd', printed: { DI: 4, DO: 4, AI: 0, AO: 0 } },
    ],
    printedTotals: { DI: 38, DO: 22, AI: 2, AO: 0 },
    summaryTotals: { DI: 38, DO: 22, AI: 2, AO: 0 },
  },
  {
    no: 4,
    id: 'sludge',
    name: 'Sludge Process',
    system: 'Sludge holding tank (SHT) dewatering train',
    area: 'SHT',
    slide: 7,
    inputs: ['Sludge holding tank (SHT)'],
    outputs: ['Water drain', 'Solid discharge', 'Centrate to EQT'],
    spec: {
      pipe: 'UPVC 50 mm',
      pumps: 'Dosing 0–30 lph (Milton) · Discharge 2 m³/hr @ 35 m (Roto) · Centrifuge 1 m³/hr (Hiller)',
      tanks: 'Sludge holding tank · poly dosing tank 500 L',
      meters: 'Sludge tank level',
    },
    devices: [
      { tag: 'SHT-P-401', qty: 1, name: 'Sludge discharge pump', kind: 'pump', printed: { DI: 2, DO: 1, AI: 0, AO: 0 } },
      { tag: 'SHT-P-411', qty: 1, name: 'Poly dosing pump', kind: 'dosing_pump', printed: { DI: 2, DO: 1, AI: 0, AO: 0 } },
      { tag: 'SHT-P-421', qty: 1, name: 'Centrifuge (decanter centrifugal)', kind: 'pump', printed: { DI: 2, DO: 1, AI: 0, AO: 0 } },
      { tag: 'SHT-XV-401', qty: 1, name: 'Sludge outlet valve', kind: 'butterfly_valve', printed: { DI: 2, DO: 1, AI: 0, AO: 0 } },
      { tag: 'SHT-LT-401', qty: 1, name: 'Sludge tank level transmitter', kind: 'level_tx', printed: { DI: 0, DO: 0, AI: 1, AO: 0 } },
    ],
    printedTotals: { DI: 8, DO: 4, AI: 1, AO: 0 },
    summaryTotals: { DI: 10, DO: 4, AI: 1, AO: 0 },
  },
  {
    no: 5,
    id: 'filter_feed',
    name: 'Filter Feed Pump Process',
    system: 'Filter Feed Pump (FFP)',
    area: 'FFP',
    slide: 8,
    inputs: ['Intermediate water tank (INT-WT)'],
    outputs: ['Micron filter', 'ACF & MGF filters', 'Garden bypass'],
    spec: {
      pipe: 'UPVC 100 mm',
      pumps: 'Pri + Sec + Cl dosing, 43 m³/hr @ 8 m, Johnson, qty 2 (1W + 1SB)',
      tanks: 'INT-WT · Cl dosing tank 200 L (Milton Roy 0–12 lph)',
      meters: 'Micron filter flow · ACF & MGF flow · INT tank level',
    },
    devices: [
      { tag: 'FFP-XV-501', qty: 3, name: 'PP & SP inlet valves', kind: 'butterfly_valve', printed: { DI: 6, DO: 4, AI: 0, AO: 0 },
        note: 'Slide 8 prints the Monitoring column for this valve row as "Pump status / Trip status" — copied from the pump row.' },
      { tag: 'FFP-P-501', qty: 3, name: 'Pri + Sec filter feed pump, Cl dosing pump', kind: 'pump', printed: { DI: 6, DO: 3, AI: 0, AO: 0 } },
      { tag: 'FFP-XV-511', qty: 4, name: 'PP, SP & bypass outlet valves', kind: 'butterfly_valve', printed: { DI: 8, DO: 6, AI: 0, AO: 0 } },
      { tag: 'INT-LT-501', qty: 1, name: 'INT-WT level transmitter', kind: 'level_tx', printed: { DI: 0, DO: 0, AI: 1, AO: 0 } },
      { tag: 'FFP-FT-501', qty: 2, name: 'Micron filter + ACF/MGF flow meters', kind: 'flow_meter', printed: { DI: 0, DO: 0, AI: 2, AO: 0 } },
    ],
    printedTotals: { DI: 20, DO: 13, AI: 3, AO: 0 },
    summaryTotals: { DI: 20, DO: 13, AI: 4, AO: 0 },
  },
  {
    no: 6,
    id: 'acf_mgf',
    name: 'ACF and MGF Filter Process',
    system: 'Activated carbon filter (ACF) + Multigrade filter (MGF)',
    area: 'ACF',
    slide: 9,
    inputs: ['Filter Feed Pump (FFP)'],
    outputs: ['Softener system', 'Backwash to EQT', 'Bypass to garden'],
    spec: {
      pipe: 'CPVC 80 mm frontal piping',
      vessels: 'ACF Ø1650 mm · MGF Ø1500 mm · HOS 1500 mm · shell 6 mm · dish end 8 mm · 25 m³/hr each',
      meters: 'pH analyser',
    },
    devices: [
      { tag: 'ACF-XV-601', qty: 5, name: 'ACF frontal + backwash valves', kind: 'butterfly_valve', printed: { DI: 10, DO: 5, AI: 0, AO: 0 },
        note: 'Slide 9 prints the Monitoring column for both valve rows as "Pump status / Trip status" — copied from the pump row.' },
      { tag: 'MGF-XV-601', qty: 5, name: 'MGF frontal + backwash valves', kind: 'butterfly_valve', printed: { DI: 10, DO: 5, AI: 0, AO: 0 } },
      { tag: 'ACF-XV-611', qty: 3, name: 'Ball valve to EQT + BF valve to garden', kind: 'ball_valve', printed: { DI: 6, DO: 4, AI: 0, AO: 0 } },
      { tag: 'ACF-AT-601', qty: 1, name: 'Filtered water pH analyser', kind: 'ph_analyser', printed: { DI: 0, DO: 0, AI: 1, AO: 0 } },
    ],
    printedTotals: { DI: 26, DO: 14, AI: 1, AO: 0 },
    summaryTotals: { DI: 26, DO: 14, AI: 1, AO: 0 },
  },
  {
    no: 7,
    id: 'softener_feed',
    name: 'Softener Feed Process',
    system: 'Softener Feed Pump (SFP) + softener vessel (SOF)',
    area: 'SFP',
    slide: 10,
    inputs: ['ACF & MGF filtered water'],
    outputs: ['Soft water tank (SWT)', 'Overflow to IRR-WT', 'Regeneration to reject'],
    spec: {
      pipe: 'UPVC 100 mm · frontal piping CPVC 80 mm',
      pumps: 'Pri + Sec 43 m³/hr @ 8 m, Johnson, qty 2 (1W + 1SB) · agitator',
      vessels: 'SOF Ø1000 mm · HOS 1500 mm · shell 6 mm · dish end 8 mm · 20 m³/hr · brine tank 1000 L Sintex',
      meters: 'Softener flow',
    },
    devices: [
      { tag: 'SFP-XV-701', qty: 2, name: 'PP & SP inlet valves', kind: 'butterfly_valve', printed: { DI: 4, DO: 2, AI: 0, AO: 0 } },
      { tag: 'SFP-P-701', qty: 3, name: 'Pri + Sec softener feed pump, brine agitator', kind: 'pump', printed: { DI: 6, DO: 3, AI: 0, AO: 0 } },
      { tag: 'SFP-XV-711', qty: 3, name: 'PP, SP & outlet valves', kind: 'butterfly_valve', printed: { DI: 6, DO: 4, AI: 0, AO: 0 } },
      { tag: 'SOF-XV-701', qty: 4, name: 'Softener ball valves + bypass valve', kind: 'ball_valve', printed: { DI: 8, DO: 4, AI: 0, AO: 0 } },
      { tag: 'SOF-FT-701', qty: 1, name: 'Softener outlet flow meter', kind: 'flow_meter', printed: { DI: 0, DO: 0, AI: 1, AO: 0 } },
    ],
    printedTotals: { DI: 24, DO: 13, AI: 1, AO: 0 },
    summaryTotals: { DI: 24, DO: 13, AI: 1, AO: 0 },
  },
  {
    no: 8,
    id: 'uf_feed',
    name: 'Ultrafiltration Feed Pump Process',
    system: 'UF feed pump (UFFP) + UF backwash pump (UFBP)',
    area: 'UF',
    slide: 11,
    inputs: ['Micron filter'],
    outputs: ['Sintex tank 1000 L → FWT', 'Backwash to EQT'],
    spec: {
      pipe: 'UPVC 50 mm · CPVC 80 mm micro-filter backwash',
      pumps: 'UFFP 10 m³/hr @ 25 m Grundfos qty 2 (1W + 1SB) · UFBP 15 m³/hr @ 15 m Grundfos qty 2',
      tanks: 'Sintex tank 1000 L',
      meters: 'Sintex tank level',
    },
    devices: [
      { tag: 'UF-XV-801', qty: 4, name: 'UFFP & UFBP inlet valves', kind: 'butterfly_valve', printed: { DI: 8, DO: 4, AI: 0, AO: 0 } },
      { tag: 'UF-P-801', qty: 4, name: 'UFFP + UFBP pumps (2 duty, 2 standby)', kind: 'pump', printed: { DI: 8, DO: 4, AI: 0, AO: 0 } },
      { tag: 'UF-XV-811', qty: 4, name: 'UFFP & UFBP outlet valves', kind: 'butterfly_valve', printed: { DI: 8, DO: 4, AI: 0, AO: 0 } },
      { tag: 'UF-XV-821', qty: 4, name: 'Feed, backwash, rinse & outlet valves', kind: 'butterfly_valve', printed: { DI: 8, DO: 4, AI: 0, AO: 0 } },
      { tag: 'SNT-LT-801', qty: 1, name: 'Sintex tank level transmitter', kind: 'level_tx', printed: { DI: 0, DO: 0, AI: 1, AO: 0 } },
    ],
    printedTotals: { DI: 32, DO: 16, AI: 1, AO: 0 },
    summaryTotals: { DI: 32, DO: 16, AI: 1, AO: 0 },
  },
  {
    no: 9,
    id: 'horticulture',
    name: 'Horticulture Water T/F Pump Process',
    system: 'Horticulture water transfer pump (HWTP)',
    area: 'HWTP',
    slide: 12,
    inputs: ['Softener / filtered water — irrigation water tank (IRR-WT)'],
    outputs: ['Irrigation system'],
    spec: {
      pipe: '100 mm',
      pumps: 'Pri + Sec, Grundfos, qty 3 on the schematic',
      tanks: 'IRR-WT',
      meters: 'Irrigation water meter · IRR tank level',
    },
    devices: [
      { tag: 'HWT-XV-901', qty: 2, name: 'PP & SP inlet valves', kind: 'butterfly_valve', printed: { DI: 4, DO: 2, AI: 0, AO: 0 } },
      { tag: 'HWT-P-901', qty: 2, name: 'Pri + Sec horticulture transfer pump', kind: 'pump', printed: { DI: 4, DO: 2, AI: 0, AO: 0 },
        flagged: true,
        note: 'Highlighted on slide 12. The schematic shows a Grundfos set of 3; the I/O table prices 2.' },
      { tag: 'HWT-XV-911', qty: 2, name: 'PP & SP outlet valves', kind: 'butterfly_valve', printed: { DI: 4, DO: 2, AI: 0, AO: 0 } },
      { tag: 'IRR-LT-901', qty: 1, name: 'IRR-WT level transmitter', kind: 'level_tx', printed: { DI: 0, DO: 0, AI: 1, AO: 0 } },
      { tag: 'HWT-FT-901', qty: 1, name: 'Irrigation water meter', kind: 'flow_meter', printed: { DI: 0, DO: 0, AI: 1, AO: 0 } },
    ],
    printedTotals: { DI: 12, DO: 6, AI: 2, AO: 0 },
    summaryTotals: { DI: 12, DO: 6, AI: 2, AO: 0 },
  },
  {
    no: 10,
    id: 'flushing',
    name: 'Flushing Water T/F Pump Process',
    system: 'Flushing water transfer pump (FWTP)',
    area: 'FWTP',
    slide: 13,
    inputs: ['Sintex tank → flush water tank (FWT)'],
    outputs: ['Flushing water system'],
    spec: {
      pipe: '100 mm',
      pumps: 'Grundfos, qty 3',
      tanks: 'FWT',
      meters: 'Flush water meter · FWT level',
    },
    devices: [
      { tag: 'FWT-XV-1001', qty: 2, name: 'PP & SP inlet valves', kind: 'butterfly_valve', printed: { DI: 4, DO: 2, AI: 0, AO: 0 } },
      { tag: 'FWT-P-1001', qty: 3, name: 'Flushing water transfer pumps', kind: 'pump', printed: { DI: 6, DO: 4, AI: 0, AO: 0 },
        flagged: true,
        note: 'Highlighted on slide 13. Three pumps are shown, but the slide-15 list names only Pri + Sec.' },
      { tag: 'FWT-XV-1011', qty: 2, name: 'PP & SP outlet valves', kind: 'butterfly_valve', printed: { DI: 4, DO: 2, AI: 0, AO: 0 } },
      { tag: 'FWT-LT-1001', qty: 1, name: 'FWT level transmitter', kind: 'level_tx', printed: { DI: 0, DO: 0, AI: 1, AO: 0 } },
      { tag: 'FWT-FT-1001', qty: 1, name: 'Flush water meter', kind: 'flow_meter', printed: { DI: 0, DO: 0, AI: 1, AO: 0 } },
    ],
    printedTotals: { DI: 14, DO: 8, AI: 2, AO: 0 },
    summaryTotals: { DI: 14, DO: 8, AI: 2, AO: 0 },
  },
  {
    no: 11,
    id: 'soft_water',
    name: 'Soft Water T/F Pump Process',
    system: 'Soft water transfer pump (SWTP)',
    area: 'SWTP',
    slide: 14,
    inputs: ['Softener system — soft water tank (SWT)'],
    outputs: ['Cooling tower'],
    spec: {
      pipe: '100 mm · 80 mm CPVC dosing header',
      pumps: 'Pri + Sec + Cl dosing, Grundfos qty 3 · dosing 0–12 LPH Milton Roy',
      tanks: 'SWT · dosing tank 200 L',
      meters: 'Soft water meter · SWT level',
    },
    devices: [
      { tag: 'SWT-XV-1101', qty: 2, name: 'PP & SP inlet valves', kind: 'butterfly_valve', printed: { DI: 4, DO: 2, AI: 0, AO: 0 } },
      { tag: 'SWT-P-1101', qty: 3, name: 'Pri + Sec soft water pump, Cl dosing pump', kind: 'pump', printed: { DI: 6, DO: 4, AI: 0, AO: 0 },
        flagged: true,
        note: 'Highlighted on slide 14. Three pumps including dosing are shown; the slide-15 list names Pri + Sec + Dosing but prices two.' },
      { tag: 'SWT-XV-1111', qty: 2, name: 'PP & SP outlet valves', kind: 'butterfly_valve', printed: { DI: 4, DO: 2, AI: 0, AO: 0 } },
      { tag: 'SWT-LT-1101', qty: 1, name: 'SWT level transmitter', kind: 'level_tx', printed: { DI: 0, DO: 0, AI: 1, AO: 0 } },
      { tag: 'SWT-FT-1101', qty: 1, name: 'Soft water meter', kind: 'flow_meter', printed: { DI: 0, DO: 0, AI: 1, AO: 0 } },
    ],
    printedTotals: { DI: 14, DO: 8, AI: 2, AO: 0 },
    summaryTotals: { DI: 14, DO: 8, AI: 2, AO: 0 },
  },
]);

module.exports = { PROCESSES, SIGNAL_RULES, KIND_LABELS, COST_FAMILY };
