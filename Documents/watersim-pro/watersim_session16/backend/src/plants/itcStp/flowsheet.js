/**
 * ITC STP — the plant as a flowsheet the canvas and the solver can both read.
 *
 * This is the schematic on slide 3, drawn as `canvas_data`: every vessel, pump,
 * valve group, filter and instrument in the proposal, wired in the order the
 * process pages and the control narrative describe.
 *
 * ── WHERE THE NUMBERS COME FROM ─────────────────────────────────────────────
 * Each node carries `data.source`, naming the slide its parameters were read
 * from, and `data.assumption` where the proposal does NOT state a value and one
 * had to be chosen to make the sheet solvable. That distinction is the whole
 * point: an engineer opening this sheet must be able to tell the plant's stated
 * design from a placeholder, at a glance, on the node itself.
 *
 * Stated by the proposal: pump duties and heads, vessel diameters and heights,
 * pipe sizes, the Sintex and brine tank capacities, the dosing tank volumes,
 * the three influent flows, and every cycle time in the control narrative.
 *
 * NOT stated, and therefore assumed here: the working volumes of EQT, INT-WT,
 * SHT, IRR-WT, FWT and SWT; the split of filtered water between the softener,
 * the UF line and irrigation; the influent strengths. Each is marked.
 *
 * `data.tags` links a node to the device tags in `processes.js`, so the canvas,
 * the I/O schedule and the PLC bindings all name the same equipment.
 */
'use strict';

const V = (x, y) => ({ x, y });

/** One canvas node. */
const node = (id, opType, label, position, data = {}) => ({
  id,
  type: 'unitOp',
  position,
  data: { label, opType, params: {}, ...data },
});

/** One stream. `role` marks a named model output (WAS, backwash, filtrate, …). */
const edge = (id, source, target, opts = {}) => ({
  id,
  source,
  target,
  type: 'stream',
  animated: true,
  data: {
    streamType: opts.role || 'stream',
    ...(opts.role ? { role: opts.role } : {}),
    ...(opts.recycle ? { isRecycle: true } : {}),
    ...(opts.label ? { label: opts.label } : {}),
  },
});

const NODES = [
  // ── Influent ─────────────────────────────────────────────────────────────
  node('in_kitchen', 'inlet', 'Kitchen influent', V(52, 50), {
    area: 'ELP', source: 'Slide 4 — 100 KLD kitchen influent',
    assumption: 'Strength is not stated in the proposal; typical hotel kitchen wastewater is used.',
    params: { Q: 100, BOD: 600, COD: 1200, TSS: 500, TN: 50, NH4: 25, TP: 10, pH: 6.5, temp: 28 },
  }),
  node('ogt', 'oil_grease_trap', 'OGT — Oil & grease trap', V(299, 50), {
    area: 'ELP', tags: ['OGT-LSH-101'], source: 'Slide 4 — OGT 400 × 500 mm, high-level switch',
    assumption: 'The 400 × 500 mm figure is listed under Tank Spec and reads as a chamber footprint, not a working volume; 0.5 m depth is assumed.',
    params: { volume_m3: 0.1, rated_HRT_min: 20, fog_in_mg_L: 250, fog_removal_pct: 85, TSS_removal_pct: 30, grease_capacity_m3: 0.03 },
  }),
  node('in_sewage', 'inlet', 'Sewage influent', V(52, 238), {
    area: 'ELP', source: 'Slide 4 — 475 KLD sewage influent',
    assumption: 'Strength is not stated; typical domestic sewage is used.',
    params: { Q: 475, BOD: 220, COD: 420, TSS: 260, TN: 45, NH4: 35, TP: 8, pH: 7.2, temp: 28 },
  }),
  node('in_laundry', 'inlet', 'Laundry influent', V(52, 425), {
    area: 'ELP', source: 'Slide 4 — 100 KLD laundry influent',
    assumption: 'Strength is not stated; laundry effluent is modelled as low-solids, high-pH, surfactant-loaded.',
    params: { Q: 100, BOD: 250, COD: 600, TSS: 150, TN: 15, NH4: 5, TP: 15, pH: 9.0, temp: 35 },
  }),
  node('ct', 'equalisation_tank', 'CT — Collection tank', V(299, 425), {
    area: 'ELP', tags: ['OGT-LSH-101'], source: 'Slide 4 — CT 600 × 1000 mm, high-level switch',
    assumption: 'Working volume derived from the stated footprint at 1 m depth.',
    params: { volume_m3: 5, low_level_pct: 20, high_level_pct: 90, peak_factor: 2.5, has_level_switch: 1 },
  }),
  node('elp_v_in', 'valve', 'ELP inlet valves (2)', V(546, 425), {
    area: 'ELP', tags: ['ELP-XV-101'], source: 'Slide 4 — two actuated inlet valves',
    params: { open: 1, opening_pct: 100 },
  }),
  node('elp_p', 'pump', 'ELP — Effluent lifting pump', V(780, 425), {
    area: 'ELP', tags: ['ELP-P-101'], source: 'Slide 4 — 5 m³/hr @ 8 m, Johnson, 1W + 1SB',
    params: { running: 1, speed_pct: 100, capacity_m3_d: 120, head_m: 8 },
  }),
  node('elp_v_out', 'valve', 'ELP outlet valves (2)', V(1014, 425), {
    area: 'ELP', tags: ['ELP-XV-111'], source: 'Slide 4 — two actuated outlet valves',
    params: { open: 1, opening_pct: 100 },
  }),

  // ── Equalisation ─────────────────────────────────────────────────────────
  node('eqt', 'equalisation_tank', 'EQT — Equalisation tank', V(1274, 238), {
    area: 'ELP', tags: ['EQT-LT-101'], source: 'Slide 4 — EQT level transmitter (1 AI)',
    assumption: 'Working volume is not stated. 225 m³ is 8 h at the 675 KLD design flow, the usual basis for a hotel STP balancing tank.',
    params: { volume_m3: 225, low_level_pct: 15, high_level_pct: 90, peak_factor: 2.5 },
  }),

  // ── Reactor feed ─────────────────────────────────────────────────────────
  node('rfp_v_in', 'valve', 'RFP inlet valves (2)', V(1521, 238), {
    area: 'RFP', tags: ['RFP-XV-201'], source: 'Slide 5', params: { open: 1, opening_pct: 100 },
  }),
  node('rfp_p', 'pump', 'RFP — Reactor feed pump', V(1755, 238), {
    area: 'RFP', tags: ['RFP-P-201'], source: 'Slide 5 — 43 m³/hr @ 8 m, Johnson, 1W + 1SB',
    params: { running: 1, speed_pct: 100, capacity_m3_d: 1032, head_m: 8 },
  }),
  node('rfp_v_out', 'valve', 'RFP outlet valves (2)', V(1989, 238), {
    area: 'RFP', tags: ['RFP-XV-211'], source: 'Slide 5', params: { open: 1, opening_pct: 100 },
  }),
  node('ft_201', 'instrument', 'FT-201 — Reactor feed flow', V(2223, 238), {
    area: 'RFP', tags: ['RFP-FT-201'], source: 'Slide 5 — reactor feed flow meter (1 AI)',
    assumption: 'The two reactors are fed alternately; an even 50 / 50 split is used because the proposal does not state a duty share.',
    params: { measurement: 'flow', range_min: 0, range_max: 1200, tag: 'RFP-FT-201', splitRatios: [0.5, 0.5] },
  }),

  // ── Reactors ─────────────────────────────────────────────────────────────
  node('blowers', 'blower', 'Air blowers ×3 (2W + 1SB)', V(2223, 38), {
    area: 'R', tags: ['R-B-301', 'R-XV-311'],
    source: 'Slide 6 — 475 m³/hr @ 0.55 kg/cm², Beta, qty 3',
    note: 'Carries air, not water, so it has no stream connection. It is on the sheet because it is 6 DI and 3 DO on the I/O schedule.',
    params: {},
  }),
  node('r1', 'sbr_reactor', 'R1 — Reactor 1', V(2470, 112), {
    area: 'R', tags: ['R-XV-301', 'R-LT-301', 'R-M-301'],
    source: 'Slide 22 — fill 1.5 h, aerate 2 h, settle 1 h, decant 45 min',
    assumption: 'MLSS and SRT are not stated; 3500 mg/L at 15 d SRT is standard for an SBR treating this strength.',
    params: {
      reactors: 1, fill_h: 1.5, aerate_h: 2.0, settle_h: 1.0, decant_h: 0.75,
      feed_pump_m3_h: 43, decant_TSS_mg_L: 20,
      SRT_d: 15, MLSS_mg_L: 3500, DO_set_mg_L: 2.0, denitrification: true, anoxic_fraction: 0.25, temp: 28,
    },
  }),
  node('r2', 'sbr_reactor', 'R2 — Reactor 2', V(2470, 375), {
    area: 'R', tags: ['R-XV-301', 'R-LT-301', 'R-M-301'],
    source: 'Slide 22 — same cycle as R1, run offset so one reactor fills while the other aerates',
    assumption: 'MLSS and SRT are not stated; matched to R1.',
    params: {
      reactors: 1, fill_h: 1.5, aerate_h: 2.0, settle_h: 1.0, decant_h: 0.75,
      feed_pump_m3_h: 43, decant_TSS_mg_L: 20,
      SRT_d: 15, MLSS_mg_L: 3500, DO_set_mg_L: 2.0, denitrification: true, anoxic_fraction: 0.25, temp: 28,
    },
  }),

  // ── Sludge train ─────────────────────────────────────────────────────────
  node('stp_v_in', 'valve', 'STP inlet valves (2)', V(2730, 588), {
    area: 'R', tags: ['STP-XV-301'], source: 'Slide 6', params: { open: 1, opening_pct: 100 },
  }),
  node('stp_p', 'pump', 'STP — Sludge transfer pump', V(2964, 588), {
    area: 'R', tags: ['R-P-301'], source: 'Slide 6 — 10 m³/hr @ 8 m',
    params: { running: 1, speed_pct: 100, capacity_m3_d: 240, head_m: 8 },
  }),
  node('sht', 'equalisation_tank', 'SHT — Sludge holding tank', V(3198, 588), {
    area: 'SHT', tags: ['SHT-LT-401'], source: 'Slide 7 — sludge tank level (1 AI)',
    assumption: 'Working volume is not stated; 25 m³ holds roughly two days of waste sludge at the computed WAS rate.',
    params: { volume_m3: 25, low_level_pct: 10, high_level_pct: 85, peak_factor: 1.5 },
  }),
  node('poly_dose', 'polymer_dosing', 'Poly dosing (0–30 lph)', V(3432, 588), {
    area: 'SHT', tags: ['SHT-P-411'], source: 'Slide 7 — Milton dosing pump, 500 L tank',
    params: { dose_mg_L: 4 },
  }),
  node('centrifuge', 'sludge_centrifuge', 'Decanter centrifuge (1 m³/hr)', V(3666, 588), {
    area: 'SHT', tags: ['SHT-P-421', 'SHT-XV-401'], source: 'Slide 7 — Hiller, 1 m³/hr',
    params: { type: 'DAF', target_TSS_mg_L: 180000, capture_pct: 95 },
  }),
  node('solids_out', 'outlet', 'Solid discharge', V(3913, 675), {
    area: 'SHT', source: 'Slide 7 — solid discharge to skip',
    params: { discharge_type: 'solids' },
  }),

  // ── Intermediate water tank and filter feed ──────────────────────────────
  node('int_wt', 'equalisation_tank', 'INT-WT — Intermediate water tank', V(2730, 238), {
    area: 'FFP', tags: ['INT-LT-501'], source: 'Slide 8 — INT tank level (1 AI)',
    assumption: 'Working volume is not stated; 150 m³ is about 6 h of decanted flow.',
    params: { volume_m3: 150, low_level_pct: 20, high_level_pct: 90, peak_factor: 3.0 },
  }),
  node('cl_dose', 'chlorination', 'Cl₂ dosing — 0.5 to 1 ppm', V(2977, 238), {
    area: 'FFP', tags: ['FFP-P-501'], source: 'Slide 23 — dosing ON below 0.5 ppm, OFF above',
    note: 'No residual-chlorine analyser is scheduled anywhere in the proposal, so this loop has nothing to close on as specified.',
    params: { chemical_type: 'naocl', dose_mg_L: 1.0 },
  }),
  node('ffp_v_in', 'valve', 'FFP inlet valves (3)', V(3211, 238), {
    area: 'FFP', tags: ['FFP-XV-501'], source: 'Slide 8', params: { open: 1, opening_pct: 100 },
  }),
  node('ffp_p', 'pump', 'FFP — Filter feed pump', V(3445, 238), {
    area: 'FFP', tags: ['FFP-P-501'], source: 'Slide 8 — 43 m³/hr @ 8 m, Johnson, 1W + 1SB',
    params: { running: 1, speed_pct: 100, capacity_m3_d: 1032, head_m: 8 },
  }),
  node('ffp_v_out', 'valve', 'FFP outlet valves (4, incl. bypass)', V(3679, 238), {
    area: 'FFP', tags: ['FFP-XV-511'], source: 'Slide 8 — PP, SP and bypass outlet valves',
    assumption: 'The proposal does not state how filtered water divides between the ACF/MGF line, the micron-filter line and the garden bypass. 55 / 35 / 10 is used.',
    params: { open: 1, opening_pct: 100, splitRatios: [0.55, 0.35, 0.10] },
  }),

  // ── ACF / MGF line ───────────────────────────────────────────────────────
  node('ft_acf', 'instrument', 'FT — ACF/MGF flow', V(3926, 112), {
    area: 'FFP', tags: ['FFP-FT-501'], source: 'Slide 8 — ACF & MGF flow meter (1 AI)',
    params: { measurement: 'flow', range_min: 0, range_max: 600, tag: 'FFP-FT-501' },
  }),
  node('acf', 'activated_carbon_filter', 'ACF — Activated carbon filter', V(4160, 112), {
    area: 'ACF', tags: ['ACF-XV-601'], source: 'Slide 9 — Ø1650 mm, HOS 1500 mm, 25 m³/hr',
    params: { media: 'carbon', diameter_mm: 1650, rated_flow_m3_h: 25, backwash_interval_h: 24, backwash_m3_per_wash: 6, chlorine_in_ppm: 1.0 },
  }),
  node('mgf', 'multigrade_filter', 'MGF — Multigrade filter', V(4394, 112), {
    area: 'ACF', tags: ['MGF-XV-601'], source: 'Slide 9 — Ø1500 mm, HOS 1500 mm, 25 m³/hr',
    params: { media: 'multigrade', diameter_mm: 1500, rated_flow_m3_h: 25, backwash_interval_h: 24, backwash_m3_per_wash: 5 },
  }),
  node('at_601', 'instrument', 'AT-601 — Filtered water pH', V(4628, 112), {
    area: 'ACF', tags: ['ACF-AT-601'], source: 'Slide 9 — pH analyser (1 AI)',
    assumption: 'The proposal does not state how filtered water divides between the softener and irrigation. 60 / 40 is used.',
    params: { measurement: 'pH', range_min: 0, range_max: 14, tag: 'ACF-AT-601', splitRatios: [0.6, 0.4] },
  }),

  // ── Softener and soft water ──────────────────────────────────────────────
  node('sfp_v_in', 'valve', 'SFP inlet valves (2)', V(4875, 38), {
    area: 'SFP', tags: ['SFP-XV-701'], source: 'Slide 10', params: { open: 1, opening_pct: 100 },
  }),
  node('sfp_p', 'pump', 'SFP — Softener feed pump', V(5109, 38), {
    area: 'SFP', tags: ['SFP-P-701'], source: 'Slide 10 — 43 m³/hr @ 8 m, Johnson, 1W + 1SB',
    params: { running: 1, speed_pct: 100, capacity_m3_d: 1032, head_m: 8 },
  }),
  node('sof', 'water_softener', 'SOF — Softener', V(5343, 38), {
    area: 'SFP', tags: ['SOF-XV-701', 'SOF-FT-701'], source: 'Slide 10 — Ø1000 mm, HOS 1500 mm, 20 m³/hr, brine tank 1000 L',
    assumption: 'Feed hardness and resin volume are not stated; 250 ppm as CaCO₃ and a 500 L bed are typical for this vessel size.',
    params: { resin_litres: 500, capacity_g_per_L: 50, feed_hardness_ppm: 250, product_hardness_ppm: 5, salt_g_per_L: 150, regen_water_m3: 3, rated_flow_m3_h: 20 },
  }),
  // Above the softener, not below it: the row beneath is the irrigation line,
  // and a 168 × 116 node card there overlaps FT-901. Canvas positions are laid
  // out against the card size, which `itcCanvas.test.js` asserts.
  node('reject_out', 'outlet', 'Regeneration reject', V(5343, -138), {
    area: 'SFP', source: 'Slide 10 — regeneration to reject',
    params: { discharge_type: 'reject' },
  }),
  node('swt', 'equalisation_tank', 'SWT — Soft water tank', V(5577, 38), {
    area: 'SWTP', tags: ['SWT-LT-1101'], source: 'Slide 14 — SWT level (1 AI)',
    assumption: 'Working volume is not stated; 100 m³ is used.',
    params: { volume_m3: 100, low_level_pct: 20, high_level_pct: 90, peak_factor: 2.0 },
  }),
  node('swt_cl', 'chlorination', 'SWT Cl₂ dosing (0–12 LPH)', V(5811, 38), {
    area: 'SWTP', tags: ['SWT-P-1101'], source: 'Slide 14 — Milton Roy 0–12 LPH, 200 L tank',
    params: { chemical_type: 'naocl', dose_mg_L: 0.5 },
  }),
  node('swtp', 'pump', 'SWTP — Soft water transfer pump', V(6045, 38), {
    area: 'SWTP', tags: ['SWT-P-1101', 'SWT-XV-1101', 'SWT-XV-1111'], source: 'Slide 14 — Grundfos, qty 3',
    note: 'The narrative controls this pump on header pressure, but no pressure transmitter is scheduled for this area.',
    params: { running: 1, speed_pct: 100, capacity_m3_d: 0, head_m: 25 },
  }),
  node('ft_swt', 'instrument', 'FT — Soft water meter', V(6279, 38), {
    area: 'SWTP', tags: ['SWT-FT-1101'], source: 'Slide 14 — water meter (1 AI)',
    params: { measurement: 'flow', range_min: 0, range_max: 400, tag: 'SWT-FT-1101' },
  }),
  node('cooling_tower', 'outlet', 'Cooling tower', V(6513, 38), {
    area: 'SWTP', source: 'Slide 14 — soft water to cooling tower',
    params: { discharge_type: 'water' },
  }),

  // ── Irrigation ───────────────────────────────────────────────────────────
  node('irr_wt', 'equalisation_tank', 'IRR-WT — Irrigation water tank', V(4875, 312), {
    area: 'HWTP', tags: ['IRR-LT-901'], source: 'Slide 12 — IRR tank level (1 AI)',
    assumption: 'Working volume is not stated; 100 m³ is used.',
    params: { volume_m3: 100, low_level_pct: 20, high_level_pct: 90, peak_factor: 2.0 },
  }),
  node('hwtp', 'pump', 'HWTP — Horticulture transfer pump', V(5109, 312), {
    area: 'HWTP', tags: ['HWT-P-901', 'HWT-XV-901', 'HWT-XV-911'], source: 'Slide 12 — Grundfos',
    note: 'The narrative controls this pump on header pressure, but no pressure transmitter is scheduled for this area.',
    params: { running: 1, speed_pct: 100, capacity_m3_d: 0, head_m: 25 },
  }),
  node('ft_irr', 'instrument', 'FT — Irrigation water meter', V(5343, 312), {
    area: 'HWTP', tags: ['HWT-FT-901'], source: 'Slide 12 — water meter (1 AI)',
    params: { measurement: 'flow', range_min: 0, range_max: 400, tag: 'HWT-FT-901' },
  }),
  node('irrigation', 'outlet', 'Irrigation system', V(5577, 312), {
    area: 'HWTP', source: 'Slide 12 — treated water to irrigation',
    params: { discharge_type: 'water' },
  }),

  // ── Micron filter and ultrafiltration ────────────────────────────────────
  node('ft_mf', 'instrument', 'FT — Micron filter flow', V(3926, 412), {
    area: 'FFP', tags: ['FFP-FT-501'], source: 'Slide 8 — micron filter flow meter (1 AI)',
    params: { measurement: 'flow', range_min: 0, range_max: 600, tag: 'FFP-FT-501' },
  }),
  node('mf', 'micron_filter', 'MF — Micron filter', V(4160, 412), {
    area: 'UF', source: 'Slide 8 — micron filter ahead of the UF membranes',
    assumption: 'Cartridge size is not stated; a 300 mm housing at 20 m³/hr is used.',
    params: { media: 'micron', diameter_mm: 300, rated_flow_m3_h: 20, backwash_interval_h: 168, backwash_m3_per_wash: 0.5 },
  }),
  node('uf_v_in', 'valve', 'UFFP inlet valves (4)', V(4394, 412), {
    area: 'UF', tags: ['UF-XV-801'], source: 'Slide 11', params: { open: 1, opening_pct: 100 },
  }),
  node('uffp', 'pump', 'UFFP — UF feed pump', V(4628, 412), {
    area: 'UF', tags: ['UF-P-801'], source: 'Slide 11 — 10 m³/hr @ 25 m, Grundfos, 1W + 1SB',
    params: { running: 1, speed_pct: 100, capacity_m3_d: 240, head_m: 25 },
  }),
  node('uf', 'uf_membrane', 'UF — Ultrafiltration', V(4875, 525), {
    area: 'UF', tags: ['UF-XV-821'], source: 'Slide 24 — 20 min production, 1 min flush backwash',
    params: { screenType: 'micro' },
  }),
  node('sintex', 'equalisation_tank', 'Sintex tank — 1000 L', V(5109, 525), {
    area: 'UF', tags: ['SNT-LT-801'], source: 'Slide 11 — Sintex tank 1000 L, level transmitter (1 AI)',
    assumption: 'Split between forward flow to FWT and backwash draw is set from the computed UF cycle: 1 min of UFBP at 15 m³/hr against 20 min of UFFP at 10 m³/hr.',
    params: { volume_m3: 1, low_level_pct: 25, high_level_pct: 90, peak_factor: 2.0, splitRatios: [0.925, 0.075] },
  }),
  node('ufbp', 'pump', 'UFBP — UF backwash pump', V(5109, 700), {
    area: 'UF', tags: ['UF-P-801', 'UF-XV-811'], source: 'Slide 11 — 15 m³/hr @ 15 m, Grundfos, qty 2',
    note: 'Draws filtered water from the Sintex tank and returns spent backwash to EQT, per narrative step VII.10.',
    params: { running: 1, speed_pct: 100, capacity_m3_d: 0, head_m: 15 },
  }),
  node('fwt', 'equalisation_tank', 'FWT — Flush water tank', V(5343, 525), {
    area: 'FWTP', tags: ['FWT-LT-1001'], source: 'Slide 13 — FW tank level (1 AI)',
    assumption: 'Working volume is not stated; 100 m³ is used.',
    params: { volume_m3: 100, low_level_pct: 20, high_level_pct: 90, peak_factor: 2.0 },
  }),
  node('fwtp', 'pump', 'FWTP — Flushing water transfer pump', V(5577, 525), {
    area: 'FWTP', tags: ['FWT-P-1001', 'FWT-XV-1001', 'FWT-XV-1011'], source: 'Slide 13 — Grundfos, qty 3',
    note: 'The narrative controls this pump on header pressure, but no pressure transmitter is scheduled for this area.',
    params: { running: 1, speed_pct: 100, capacity_m3_d: 0, head_m: 25 },
  }),
  node('ft_fwt', 'instrument', 'FT — Flush water meter', V(5811, 525), {
    area: 'FWTP', tags: ['FWT-FT-1001'], source: 'Slide 13 — water meter (1 AI)',
    params: { measurement: 'flow', range_min: 0, range_max: 400, tag: 'FWT-FT-1001' },
  }),
  node('flush_out', 'outlet', 'Flushing water system', V(6045, 525), {
    area: 'FWTP', source: 'Slide 13 — flush water to the building',
    params: { discharge_type: 'water' },
  }),
];

const EDGES = [
  // Influent to EQT
  edge('e_kitchen_ogt', 'in_kitchen', 'ogt'),
  edge('e_ogt_eqt', 'ogt', 'eqt', { label: '150 mm UPVC' }),
  edge('e_sewage_eqt', 'in_sewage', 'eqt', { label: '150 mm UPVC' }),
  edge('e_laundry_ct', 'in_laundry', 'ct'),
  edge('e_ct_elpv', 'ct', 'elp_v_in'),
  edge('e_elpv_elpp', 'elp_v_in', 'elp_p'),
  edge('e_elpp_elpvo', 'elp_p', 'elp_v_out'),
  edge('e_elpvo_eqt', 'elp_v_out', 'eqt', { label: '65 mm UPVC' }),

  // EQT to the reactors
  edge('e_eqt_rfpv', 'eqt', 'rfp_v_in'),
  edge('e_rfpv_rfpp', 'rfp_v_in', 'rfp_p'),
  edge('e_rfpp_rfpvo', 'rfp_p', 'rfp_v_out'),
  edge('e_rfpvo_ft', 'rfp_v_out', 'ft_201'),
  edge('e_ft_r1', 'ft_201', 'r1'),
  edge('e_ft_r2', 'ft_201', 'r2'),

  // Decant to INT-WT
  edge('e_r1_int', 'r1', 'int_wt', { label: 'Decant' }),
  edge('e_r2_int', 'r2', 'int_wt', { label: 'Decant' }),

  // Waste sludge to the sludge train
  edge('e_r1_stp', 'r1', 'stp_v_in', { role: 'was' }),
  edge('e_r2_stp', 'r2', 'stp_v_in', { role: 'was' }),
  edge('e_stpv_stpp', 'stp_v_in', 'stp_p'),
  edge('e_stpp_sht', 'stp_p', 'sht'),
  edge('e_sht_poly', 'sht', 'poly_dose'),
  edge('e_poly_cent', 'poly_dose', 'centrifuge'),
  edge('e_cent_solids', 'centrifuge', 'solids_out', { role: 'thickened' }),
  edge('e_cent_eqt', 'centrifuge', 'eqt', { role: 'filtrate', recycle: true, label: 'Centrate to EQT' }),

  // INT-WT to the filters
  edge('e_int_cl', 'int_wt', 'cl_dose'),
  edge('e_cl_ffpv', 'cl_dose', 'ffp_v_in'),
  edge('e_ffpv_ffpp', 'ffp_v_in', 'ffp_p'),
  edge('e_ffpp_ffpvo', 'ffp_p', 'ffp_v_out'),
  edge('e_ffpvo_acf', 'ffp_v_out', 'ft_acf'),
  edge('e_ffpvo_mf', 'ffp_v_out', 'ft_mf'),
  edge('e_ffpvo_garden', 'ffp_v_out', 'irr_wt', { label: 'Bypass to garden' }),

  // ACF / MGF
  edge('e_ftacf_acf', 'ft_acf', 'acf'),
  edge('e_acf_mgf', 'acf', 'mgf'),
  edge('e_mgf_ph', 'mgf', 'at_601'),
  edge('e_acf_bw', 'acf', 'eqt', { role: 'backwash', recycle: true, label: 'Backwash to EQT' }),
  edge('e_mgf_bw', 'mgf', 'eqt', { role: 'backwash', recycle: true, label: 'Backwash to EQT' }),

  // Filtered water splits to the softener and to irrigation
  edge('e_ph_sfp', 'at_601', 'sfp_v_in'),
  edge('e_ph_irr', 'at_601', 'irr_wt'),

  // Softener to soft water
  edge('e_sfpv_sfpp', 'sfp_v_in', 'sfp_p'),
  edge('e_sfpp_sof', 'sfp_p', 'sof'),
  edge('e_sof_swt', 'sof', 'swt'),
  edge('e_sof_reject', 'sof', 'reject_out', { role: 'concentrate', label: 'Regeneration reject' }),
  edge('e_swt_cl', 'swt', 'swt_cl'),
  edge('e_cl_swtp', 'swt_cl', 'swtp'),
  edge('e_swtp_ft', 'swtp', 'ft_swt'),
  edge('e_ft_cooling', 'ft_swt', 'cooling_tower'),

  // Irrigation
  edge('e_irr_hwtp', 'irr_wt', 'hwtp'),
  edge('e_hwtp_ft', 'hwtp', 'ft_irr'),
  edge('e_ft_irrigation', 'ft_irr', 'irrigation'),

  // Micron filter and UF
  edge('e_ftmf_mf', 'ft_mf', 'mf'),
  edge('e_mf_ufv', 'mf', 'uf_v_in'),
  edge('e_ufv_uffp', 'uf_v_in', 'uffp'),
  edge('e_uffp_uf', 'uffp', 'uf'),
  edge('e_uf_sintex', 'uf', 'sintex', { label: 'Permeate' }),
  edge('e_sintex_fwt', 'sintex', 'fwt'),
  edge('e_sintex_ufbp', 'sintex', 'ufbp', { label: 'Backwash draw' }),
  edge('e_ufbp_eqt', 'ufbp', 'eqt', { recycle: true, label: 'Spent backwash to EQT' }),
  edge('e_fwt_fwtp', 'fwt', 'fwtp'),
  edge('e_fwtp_ft', 'fwtp', 'ft_fwt'),
  edge('e_ft_flush', 'ft_fwt', 'flush_out'),
];

/** The complete `canvas_data` payload for the ITC STP flowsheet. */
function buildFlowsheet() {
  return {
    nodes: NODES.map((n) => ({ ...n, data: { ...n.data } })),
    edges: EDGES.map((e) => ({ ...e, data: { ...e.data } })),
    viewport: { x: 0, y: 0, zoom: 0.35 },
  };
}

/** nodeParams as the solver wants them, read straight off the nodes. */
function buildNodeParams() {
  const params = {};
  for (const n of NODES) {
    if (n.data.params && Object.keys(n.data.params).length) params[n.id] = { ...n.data.params };
  }
  return params;
}

module.exports = { buildFlowsheet, buildNodeParams, NODES, EDGES };
