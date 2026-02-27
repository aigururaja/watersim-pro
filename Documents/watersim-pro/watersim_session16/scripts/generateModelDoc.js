/**
 * Generate WaterSim Pro — Models & Equations Reference Document (.docx)
 *
 * Run: node scripts/generateModelDoc.js
 * Output: WaterSim_Pro_Models_and_Equations.docx
 */

'use strict';

const {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  HeadingLevel, AlignmentType, BorderStyle, WidthType, ShadingType,
  TableOfContents, PageBreak, Tab,
} = require('docx');
const fs = require('fs');
const path = require('path');

// ── Helpers ──────────────────────────────────────────────────────────────────

function heading(text, level = HeadingLevel.HEADING_1) {
  return new Paragraph({ text, heading: level, spacing: { before: 300, after: 120 } });
}

function h1(text) { return heading(text, HeadingLevel.HEADING_1); }
function h2(text) { return heading(text, HeadingLevel.HEADING_2); }
function h3(text) { return heading(text, HeadingLevel.HEADING_3); }

function para(text, opts = {}) {
  return new Paragraph({
    spacing: { after: 80 },
    ...opts,
    children: [new TextRun({ text, size: 22, font: 'Calibri', ...opts })],
  });
}

function bold(text) {
  return new TextRun({ text, bold: true, size: 22, font: 'Calibri' });
}

function italic(text) {
  return new TextRun({ text, italics: true, size: 22, font: 'Calibri' });
}

function normal(text) {
  return new TextRun({ text, size: 22, font: 'Calibri' });
}

function eqn(text) {
  return new Paragraph({
    spacing: { before: 60, after: 60 },
    indent: { left: 720 },
    children: [new TextRun({ text, font: 'Consolas', size: 21, color: '1F4E79' })],
  });
}

function bullet(text) {
  return new Paragraph({
    spacing: { after: 40 },
    bullet: { level: 0 },
    children: [new TextRun({ text, size: 22, font: 'Calibri' })],
  });
}

function paramTable(rows) {
  // rows: [[name, value, unit], ...]
  const headerCells = ['Parameter', 'Default Value', 'Unit'].map(t =>
    new TableCell({
      children: [new Paragraph({ children: [bold(t)], alignment: AlignmentType.CENTER })],
      shading: { type: ShadingType.SOLID, color: '1F4E79' },
      width: { size: 33, type: WidthType.PERCENTAGE },
    })
  );
  // Override header text color to white
  const headerRow = new TableRow({
    children: ['Parameter', 'Default Value', 'Unit'].map(t =>
      new TableCell({
        children: [new Paragraph({ children: [new TextRun({ text: t, bold: true, size: 20, font: 'Calibri', color: 'FFFFFF' })], alignment: AlignmentType.CENTER })],
        shading: { type: ShadingType.SOLID, color: '1F4E79' },
      })
    ),
  });

  const dataRows = rows.map((r, i) => new TableRow({
    children: r.map((cell, ci) => new TableCell({
      children: [new Paragraph({ children: [new TextRun({ text: String(cell), size: 20, font: 'Calibri' })], alignment: ci === 1 ? AlignmentType.CENTER : AlignmentType.LEFT })],
      shading: i % 2 === 0 ? { type: ShadingType.SOLID, color: 'F0F4FA' } : undefined,
    })),
  }));

  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [headerRow, ...dataRows],
  });
}

function spacer() {
  return new Paragraph({ spacing: { after: 120 }, children: [] });
}

// ── Document Content ─────────────────────────────────────────────────────────

const children = [];

// ── Title Page ───────────────────────────────────────────────────────────────
children.push(
  new Paragraph({ spacing: { before: 3000 }, children: [] }),
  new Paragraph({
    alignment: AlignmentType.CENTER,
    children: [new TextRun({ text: 'WaterSim Pro', size: 72, bold: true, font: 'Calibri', color: '1F4E79' })],
  }),
  new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { after: 200 },
    children: [new TextRun({ text: 'Models & Equations Reference', size: 40, font: 'Calibri', color: '4A90D9' })],
  }),
  new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { after: 400 },
    children: [new TextRun({ text: 'Comprehensive Technical Documentation', size: 26, font: 'Calibri', color: '6B7280' })],
  }),
  new Paragraph({
    alignment: AlignmentType.CENTER,
    children: [new TextRun({ text: `Version 16  |  ${new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long' })}`, size: 24, font: 'Calibri', color: '9CA3AF' })],
  }),
  new Paragraph({ children: [new TextRun({ break: 1 })] }),
);

// ── Chapter 1: Introduction ──────────────────────────────────────────────────
children.push(
  h1('1. Introduction'),
  para('WaterSim Pro is a process simulation platform for wastewater and water treatment plant design. It models each unit operation using established engineering equations — Monod kinetics for biological treatment, surface overflow rate correlations for clarifiers, Kozeny-Carman for filtration, and empirical models for chemical dosing, disinfection, and membrane separation.'),
  spacer(),
  para('This document provides a complete reference for every model and equation implemented in the simulation engine. Each chapter covers one unit operation with its governing equations, default parameters, assumptions, and output calculations.'),
  spacer(),

  h2('1.1 Stream Properties'),
  para('Every connection between unit operations carries a Stream object with the following water quality parameters:'),
  paramTable([
    ['Q', '—', 'm\u00B3/d (volumetric flow rate)'],
    ['TSS', '—', 'mg/L (total suspended solids)'],
    ['BOD', '—', 'mg/L (5-day biochemical oxygen demand)'],
    ['COD', '—', 'mg/L (chemical oxygen demand)'],
    ['TN', '—', 'mg/L (total nitrogen)'],
    ['NH\u2084', '—', 'mg/L (ammonia-nitrogen)'],
    ['NO\u2083', '—', 'mg/L (nitrate-nitrogen)'],
    ['NO\u2082', '—', 'mg/L (nitrite-nitrogen)'],
    ['TP', '—', 'mg/L (total phosphorus)'],
    ['DO', '—', 'mg/L (dissolved oxygen)'],
    ['pH', '—', 'dimensionless'],
    ['temp', '—', '\u00B0C (temperature)'],
  ]),
  spacer(),

  h2('1.2 Stream Mixing'),
  para('When multiple streams merge at a node, concentrations are calculated as flow-weighted averages:'),
  eqn('C_mix = \u03A3(C_i \u00D7 Q_i) / \u03A3(Q_i)'),
  para('This applies to all concentration parameters. Flow is simply summed: Q_mix = \u03A3(Q_i).'),
  spacer(),

  h2('1.3 Solver Architecture'),
  para('The solver performs a topological sort of the flowsheet graph, then propagates streams from inlet to outlet. For flowsheets with recycle loops (e.g., RAS from secondary clarifier to aeration basin), a fixed-point iteration is used:'),
  bullet('Maximum iterations: 50'),
  bullet('Convergence tolerance: \u03B5 = 0.0001 (relative change in Q, TSS, BOD, TN, NH\u2084, NO\u2083, TP)'),
  bullet('Converged when all tracked parameters change by less than \u03B5 between iterations'),
  spacer(),
);

// ── Chapter 2: Inlet ─────────────────────────────────────────────────────────
children.push(
  h1('2. Inlet (Source)'),
  para('The Inlet is a source node that defines the raw wastewater characteristics entering the treatment plant. It performs no transformation — the effluent equals the influent.'),
  spacer(),
  h2('2.1 Default Influent Parameters'),
  para('These represent typical medium-strength municipal wastewater:'),
  paramTable([
    ['Q', '10,000', 'm\u00B3/d'],
    ['TSS', '250', 'mg/L'],
    ['BOD', '200', 'mg/L'],
    ['COD', '400', 'mg/L'],
    ['TN', '45', 'mg/L'],
    ['NH\u2084', '35', 'mg/L'],
    ['TP', '8', 'mg/L'],
    ['DO', '0', 'mg/L'],
    ['pH', '7.2', '—'],
    ['temp', '20', '\u00B0C'],
  ]),
  spacer(),
);

// ── Chapter 3: Screening ─────────────────────────────────────────────────────
children.push(
  h1('3. Screening'),
  para('Screens remove large debris, rags, and coarse solids from the influent. The model applies empirical removal fractions based on screen type.'),
  spacer(),
  h2('3.1 Removal Efficiencies by Screen Type'),
  paramTable([
    ['Coarse', 'TSS: 5%, BOD: 3%, COD: 3%', '—'],
    ['Fine', 'TSS: 15%, BOD: 10%, COD: 8%', '—'],
    ['Micro', 'TSS: 30%, BOD: 20%, COD: 15%', '—'],
  ]),
  spacer(),
  h2('3.2 Screenings Production'),
  eqn('Screenings (kg/d) = Q (m\u00B3/d) \u00D7 TSS_in (mg/L) \u00D7 \u03B7_TSS / 1000'),
  spacer(),
  h2('3.3 Effluent Calculation'),
  eqn('TSS_eff = TSS_in \u00D7 (1 - \u03B7_TSS)'),
  eqn('BOD_eff = BOD_in \u00D7 (1 - \u03B7_BOD)'),
  eqn('COD_eff = COD_in \u00D7 (1 - \u03B7_COD)'),
  para('All other parameters (TN, NH\u2084, NO\u2083, TP, DO, pH, temp) pass through unchanged. Q is unchanged.'),
  spacer(),
);

// ── Chapter 4: Grit Removal ──────────────────────────────────────────────────
children.push(
  h1('4. Grit Removal'),
  para('Grit chambers remove heavy inorganic particles (sand, gravel, cinders) that could damage downstream equipment. The model is based on chamber type and hydraulic retention time.'),
  spacer(),
  h2('4.1 Removal Efficiencies by Chamber Type'),
  paramTable([
    ['Horizontal', 'TSS: 10%, BOD: 2%, COD: 2%', '—'],
    ['Aerated', 'TSS: 15%, BOD: 3%, COD: 3%', '—'],
    ['Vortex', 'TSS: 12%, BOD: 2%, COD: 2%', '—'],
  ]),
  spacer(),
  h2('4.2 Chamber Sizing'),
  eqn('Q_m3_min = Q (m\u00B3/d) / 1440'),
  eqn('Volume (m\u00B3) = Q_m3_min \u00D7 HRT_min'),
  spacer(),
  h2('4.3 Grit Production'),
  eqn('Grit (kg/d) = Q (m\u00B3/d) \u00D7 TSS_in (mg/L) \u00D7 \u03B7_TSS / 1000'),
  spacer(),
);

// ── Chapter 5: Primary Clarifier ─────────────────────────────────────────────
children.push(
  h1('5. Primary Clarifier'),
  para('Primary clarifiers remove settleable solids by gravity sedimentation. The model uses Surface Overflow Rate (SOR) to predict TSS removal, with BOD and COD removal derived proportionally.'),
  spacer(),
  h2('5.1 Default Parameters'),
  paramTable([
    ['SOR', '40', 'm\u00B3/m\u00B2/d'],
    ['Depth', '3.5', 'm'],
    ['Sludge TSS', '25,000', 'mg/L (2.5% DS)'],
  ]),
  spacer(),
  h2('5.2 Sizing Equations'),
  eqn('Area (m\u00B2) = Q / SOR'),
  eqn('Volume (m\u00B3) = Area \u00D7 depth'),
  eqn('HRT (h) = (Volume / Q) \u00D7 24'),
  spacer(),
  h2('5.3 TSS Removal (empirical hyperbolic)'),
  para('The TSS removal efficiency is a function of SOR, following a hyperbolic relationship:'),
  eqn('\u03B7_TSS = min(0.70, max(0.30, 65 / (40 + SOR) + 0.25))'),
  para('This yields ~55% removal at SOR = 40 m\u00B3/m\u00B2/d, decreasing as overflow rate increases.'),
  spacer(),
  h2('5.4 BOD and COD Removal'),
  eqn('\u03B7_BOD = \u03B7_TSS \u00D7 0.55'),
  eqn('\u03B7_COD = \u03B7_BOD \u00D7 0.90'),
  spacer(),
  h2('5.5 Mass Balance and Sludge Flow'),
  eqn('TSS_removed (kg/d) = Q \u00D7 TSS_in \u00D7 \u03B7_TSS / 1000'),
  eqn('Sludge_Q (m\u00B3/d) = TSS_removed (kg/d) / (sludge_TSS / 1000)'),
  eqn('Effluent_Q = Q_in - Sludge_Q'),
  spacer(),
  h2('5.6 Effluent Quality'),
  eqn('TSS_eff = TSS_in \u00D7 (1 - \u03B7_TSS) \u00D7 Q_in / Q_eff'),
  eqn('BOD_eff = BOD_in \u00D7 (1 - \u03B7_BOD)'),
  eqn('COD_eff = COD_in \u00D7 (1 - \u03B7_COD)'),
  eqn('TN_eff = TN_in \u00D7 0.98  (minor removal)'),
  eqn('TP_eff = TP_in \u00D7 0.95  (minor removal)'),
  spacer(),
);

// ── Chapter 6: Activated Sludge (Aeration Basin) ────────────────────────────
children.push(
  h1('6. Activated Sludge (Aeration Basin)'),
  para('The aeration basin is the core biological treatment unit. It models carbonaceous BOD removal, nitrification, denitrification, and optional Enhanced Biological Phosphorus Removal (EBPR) using Monod kinetics.'),
  spacer(),
  h2('6.1 Default Kinetic Parameters'),
  paramTable([
    ['SRT', '10', 'days (solids retention time)'],
    ['DO setpoint', '2.0', 'mg/L'],
    ['MLSS', '3,000', 'mg/L'],
    ['Y (yield)', '0.60', 'g VSS/g BOD'],
    ['k_d (decay)', '0.06', '1/d'],
    ['\u03BC_max,BOD', '6.0', '1/d (at 20\u00B0C)'],
    ['K_s,BOD', '60', 'mg/L'],
    ['\u03BC_max,NH4', '0.75', '1/d (nitrifiers)'],
    ['K_s,NH4', '0.74', 'mg/L'],
    ['K_s,DO', '0.2', 'mg/L'],
    ['\u03B8 (temp coeff)', '1.07', '—'],
    ['\u03BC_max,denit', '0.40', '1/d'],
    ['K_s,NO3', '0.10', 'mg/L'],
    ['BOD:N ratio', '3.5', 'mg BOD/mg N for denitrification'],
  ]),
  spacer(),
  h2('6.2 Temperature Correction'),
  para('All maximum growth rates are corrected for temperature using the Arrhenius-type equation:'),
  eqn('\u03BC(T) = \u03BC(20\u00B0C) \u00D7 \u03B8^(T - 20)'),
  para('Where \u03B8 = 1.07 (default). At 15\u00B0C the rate drops to ~71% of the 20\u00B0C value; at 25\u00B0C it rises to ~140%.'),
  spacer(),
  h2('6.3 BOD Removal (Monod Kinetics)'),
  para('The effluent BOD is determined by the minimum substrate concentration that sustains biomass at the given SRT:'),
  eqn('BOD_eff = K_s,BOD \u00D7 (1 + k_d \u00D7 SRT) / (SRT \u00D7 (Y \u00D7 \u03BC_max,BOD - k_d) - 1)'),
  para('This is the classic Lawrence-McCarty equation. Lower SRT gives higher effluent BOD; longer SRT gives better removal but more oxygen demand.'),
  spacer(),
  h2('6.4 Nitrification (Ammonia Oxidation)'),
  para('Nitrification occurs when the SRT exceeds the minimum SRT for nitrifier growth:'),
  eqn('SRT_min,nit = 1 / \u03BC_max,NH4'),
  para('If SRT > 1.5 \u00D7 SRT_min,nit (full nitrification):'),
  eqn('NH4_eff = K_s,NH4 \u00D7 (1 + k_d \u00D7 SRT) / (SRT \u00D7 (\u03BC_max,NH4 - k_d) - 1)'),
  para('Otherwise, partial nitrification efficiency is:'),
  eqn('efficiency = SRT / (1.5 \u00D7 SRT_min,nit)'),
  eqn('NH4_eff = NH4_in \u00D7 (1 - efficiency \u00D7 0.90)'),
  spacer(),
  eqn('NH4_nitrified = NH4_in - NH4_eff'),
  eqn('NO3_produced = NO3_in + NH4_nitrified'),
  spacer(),
  h2('6.5 Denitrification (Anoxic Zone)'),
  para('Denitrification reduces nitrate to nitrogen gas using BOD as the carbon source:'),
  eqn('max_NO3_removable = BOD_in / BOD_NO3_ratio'),
  eqn('kinetic_floor = max(0, K_s,NO3 \u00D7 (1 + k_d\u00D7SRT) / (SRT\u00D7(\u03BC_denit - k_d) - 1))'),
  eqn('NO3_eff = max(kinetic_floor, NO3_produced - max_NO3_removable)'),
  para('The BOD consumed by denitrification:'),
  eqn('BOD_consumed_denit = (NO3_produced - NO3_eff) \u00D7 BOD_NO3_ratio'),
  spacer(),
  h2('6.6 Oxygen Demand'),
  para('The total oxygen demand integrates carbonaceous oxidation, endogenous respiration, and nitrification:'),
  eqn('O2 (kg/d) = Q/1000 \u00D7 (1.5 \u00D7 BOD_removed - 1.42 \u00D7 biomass_prod + 4.33 \u00D7 NH4_nitrified)'),
  para('Where:'),
  bullet('1.5 = oxygen factor for BOD oxidation'),
  bullet('1.42 = oxygen equivalent of cell mass (COD of VSS)'),
  bullet('4.33 = oxygen for nitrification (NH\u2084-N \u2192 NO\u2083-N)'),
  spacer(),
  h2('6.7 Biomass Production'),
  eqn('P_x (kg/d) = Q \u00D7 BOD_removed \u00D7 Y / ((1 + k_d \u00D7 SRT) \u00D7 1000)'),
  spacer(),
  h2('6.8 Volume Sizing'),
  eqn('MLVSS = MLSS \u00D7 0.80'),
  eqn('Volume (m\u00B3) = max(50, P_x (kg/d) \u00D7 1000 \u00D7 SRT / MLVSS)'),
  eqn('HRT (h) = (Volume / Q) \u00D7 24'),
  spacer(),
  h2('6.9 WAS Flow'),
  eqn('WAS_Q (m\u00B3/d) = P_x (kg/d) \u00D7 1000 / MLSS'),
  spacer(),
  h2('6.10 EBPR — Enhanced Biological Phosphorus Removal'),
  para('Three EBPR configurations are supported:'),
  spacer(),
  h3('6.10.1 Simple EBPR'),
  eqn('VFA_available = COD_in \u00D7 VFA_COD_fraction'),
  eqn('P_released = VFA_available \u00D7 0.5'),
  eqn('P_uptake = P_released \u00D7 ebpr_uptake_rate \u00D7 Y_PAO \u00D7 PAO_fraction'),
  spacer(),
  h3('6.10.2 UCT Configuration (University of Cape Town)'),
  para('Process train: RAS \u2192 Anoxic \u2192 Anaerobic \u2192 Aerobic'),
  para('Key principle: No nitrate recycle to the anaerobic zone. Mixed Liquor Recycle (MLR) removes NO\u2083 in the anoxic zone before flow enters the anaerobic zone.'),
  eqn('Q_MLR (m\u00B3/d) = Q_in \u00D7 MLR_ratio'),
  eqn('NO3_suppress = max(0.2, 1 - (NO3_to_anaerobic - 1) / 20)  if NO3 > 1'),
  spacer(),
  h3('6.10.3 JHB Configuration (Johannesburg)'),
  para('Process train: Influent \u2192 Pre-anoxic (with RAS) \u2192 Anaerobic \u2192 Main Anoxic \u2192 Aerobic'),
  para('The pre-anoxic zone denitrifies the RAS stream before it enters the anaerobic zone:'),
  eqn('preanox_BOD = BOD_in \u00D7 jhb_preanoxic_fraction \u00D7 5'),
  spacer(),
);

// ── Chapter 7: Secondary Clarifier ───────────────────────────────────────────
children.push(
  h1('7. Secondary Clarifier'),
  para('The secondary clarifier separates activated sludge biomass from the treated effluent using gravity settling. It produces a clarified effluent and a concentrated Return Activated Sludge (RAS) stream.'),
  spacer(),
  h2('7.1 Default Parameters'),
  paramTable([
    ['SOR', '16', 'm\u00B3/m\u00B2/d'],
    ['Depth', '4.0', 'm'],
    ['RAS ratio', '0.5', '—'],
    ['RAS TSS', '8,000', 'mg/L'],
    ['Effluent TSS', '12', 'mg/L'],
  ]),
  spacer(),
  h2('7.2 Sizing'),
  eqn('Area (m\u00B2) = Q_in / SOR'),
  eqn('Volume (m\u00B3) = Area \u00D7 depth'),
  eqn('HRT (h) = (Volume / Q_in) \u00D7 24'),
  spacer(),
  h2('7.3 Solids Balance'),
  eqn('RAS_Q (m\u00B3/d) = Q_in \u00D7 RAS_ratio'),
  eqn('Effluent_Q = Q_in - RAS_Q'),
  eqn('Solids_in (kg/d) = Q_in \u00D7 MLSS / 1000'),
  eqn('Solids_eff (kg/d) = Effluent_Q \u00D7 TSS_eff / 1000'),
  eqn('Solids_RAS (kg/d) = Solids_in - Solids_eff'),
  eqn('RAS_TSS (mg/L) = Solids_RAS \u00D7 1000 / RAS_Q'),
  spacer(),
  h2('7.4 Solids Loading Rate'),
  eqn('SLR (kg TSS/m\u00B2/d) = Solids_in / Area'),
  para('Warning issued if SLR exceeds 6.0 kg/m\u00B2/d (risk of solids blanket overflow).'),
  spacer(),
);

// ── Chapter 8: Anaerobic Digester ────────────────────────────────────────────
children.push(
  h1('8. Anaerobic Digester (ADM1-lite)'),
  para('The anaerobic digester model is a steady-state simplification of the IWA Anaerobic Digestion Model No. 1 (ADM1). It models the four-stage biochemical pathway: hydrolysis, acidogenesis, acetogenesis, and methanogenesis.'),
  spacer(),
  h2('8.1 Default Parameters'),
  paramTable([
    ['HRT', '20', 'days'],
    ['Temperature', '35', '\u00B0C (mesophilic)'],
    ['COD removal target', '55', '%'],
    ['k_hyd', '0.3', '1/d (hydrolysis rate at 35\u00B0C)'],
    ['pH setpoint', '7.2', '—'],
    ['VS:COD ratio', '1.42', 'g COD/g VS'],
    ['Biogas CH\u2084 fraction', '0.65', '—'],
    ['Dewatering', 'false', '—'],
    ['Cake DS', '22', '%'],
  ]),
  spacer(),
  h2('8.2 Temperature Correction'),
  eqn('Mesophilic (25\u201345\u00B0C): k_corr = 1.08^(T - 35)'),
  eqn('Thermophilic (45\u201360\u00B0C): k_corr = 1.7 \u00D7 1.06^(T - 55)'),
  eqn('Below 15\u00B0C: k_corr = 0.15 (severe inhibition)'),
  spacer(),
  h2('8.3 COD Destruction'),
  eqn('k_eff = k_hyd \u00D7 k_corr(T)'),
  eqn('kinetic_fraction = 1 - exp(-k_eff \u00D7 HRT)'),
  eqn('COD_destruction = min(kinetic_fraction, target_removal)'),
  spacer(),
  h2('8.4 Biogas Production'),
  para('80% of influent COD is assumed particulate/colloidal:'),
  eqn('COD_hydrolysed = COD_in \u00D7 0.80 \u00D7 COD_destruction'),
  eqn('VFA_formed = COD_hydrolysed \u00D7 0.85'),
  eqn('COD_to_CH4 = VFA_formed \u00D7 0.70'),
  spacer(),
  para('Methane yield (stoichiometric):'),
  eqn('CH4 (m\u00B3/d) = COD_to_CH4 (kg/d) \u00D7 0.35  [0.35 m\u00B3 CH4 STP per kg COD]'),
  eqn('Biogas (m\u00B3/d) = CH4 / CH4_fraction'),
  spacer(),
  h2('8.5 Energy Recovery'),
  eqn('Energy (kWh/d) = CH4 (m\u00B3/d) \u00D7 10 \u00D7 0.35'),
  para('Where 10 kWh/m\u00B3 is the higher heating value of methane and 0.35 is the CHP generator efficiency.'),
  spacer(),
  h2('8.6 Digestate Quality'),
  eqn('VS_destruction = COD_destruction \u00D7 0.90'),
  eqn('VSS_out = VSS_in \u00D7 (1 - VS_destruction)'),
  eqn('TSS_out = VSS_out + ISS_in  [ISS = inert fraction = 25% of feed TSS]'),
  spacer(),
  para('Nitrogen release (ammonification):'),
  eqn('org_N_in = (TN_in - NH4_in) \u00D7 0.9'),
  eqn('NH4_released = org_N_in \u00D7 COD_destruction \u00D7 0.70'),
  eqn('NH4_out = NH4_in + NH4_released'),
  spacer(),
  h2('8.7 Stability Criteria'),
  bullet('VFA/Alkalinity ratio < 0.3 for stable operation'),
  bullet('pH \u2265 6.8 to avoid methanogenic inhibition'),
  bullet('HRT \u2265 15 days recommended; < 10 days risks washout'),
  bullet('Temperature 30\u201340\u00B0C (mesophilic) or 50\u201360\u00B0C (thermophilic)'),
  spacer(),
);

// ── Chapter 9: UV Disinfection ───────────────────────────────────────────────
children.push(
  h1('9. UV Disinfection'),
  para('UV disinfection inactivates pathogens using ultraviolet radiation at 254 nm. The model uses the UV fluence (dose) approach based on organism-specific inactivation constants.'),
  spacer(),
  h2('9.1 Default Parameters'),
  paramTable([
    ['Target log reduction', '4', 'log\u2081\u2080'],
    ['UVT', '65', '% (UV transmittance at 254 nm)'],
    ['Lamp power', '0.4', 'kW per lamp'],
    ['Lamp capacity', '50', 'm\u00B3/h per lamp bank'],
    ['k_inact (E. coli)', '19', 'mJ/cm\u00B2'],
  ]),
  spacer(),
  h2('9.2 Inactivation Constants (k_inact)'),
  paramTable([
    ['E. coli', '19', 'mJ/cm\u00B2'],
    ['Total coliforms', '21', 'mJ/cm\u00B2'],
    ['Cryptosporidium', '10', 'mJ/cm\u00B2 (UV-sensitive)'],
    ['Giardia', '82', 'mJ/cm\u00B2'],
    ['Adenovirus', '186', 'mJ/cm\u00B2 (UV-resistant)'],
  ]),
  spacer(),
  h2('9.3 UV Fluence (Dose) Calculation'),
  eqn('Required fluence = target_log_reduction \u00D7 k_inact'),
  eqn('UVT correction = \u221A(UVT / 65)   [normalized to 65% reference]'),
  eqn('Fluence_delivered = Required_fluence \u00D7 UVT_correction'),
  spacer(),
  h2('9.4 Lamp Sizing'),
  eqn('Lamp count = \u2308 Q (m\u00B3/h) / lamp_capacity \u2309'),
  eqn('Energy (kWh/d) = lamp_count \u00D7 lamp_power \u00D7 24'),
  spacer(),
  h2('9.5 Log Reduction Achieved'),
  eqn('Log reduction = Fluence_delivered / k_inact'),
  para('Compliance check: target achieved if log deficit < 0.05.'),
  spacer(),
);

// ── Chapter 10: Granular Filter ──────────────────────────────────────────────
children.push(
  h1('10. Granular Media Filter'),
  para('The granular filter model uses Kozeny-Carman head loss equations and empirical breakthrough curves to predict filtration performance for dual-media or sand filters.'),
  spacer(),
  h2('10.1 Default Parameters'),
  paramTable([
    ['Filter type', 'dual_media', '—'],
    ['HLR', '8', 'm/h (hydraulic loading rate)'],
    ['TSS removal', '90', '%'],
    ['Backwash interval', '24', 'hours'],
    ['Head loss limit', '2.5', 'm'],
    ['Sand depth', '0.30', 'm'],
    ['Sand d\u2085\u2080', '0.5', 'mm'],
    ['Anthracite depth', '0.45', 'm (dual-media only)'],
    ['Anthracite d\u2085\u2080', '1.4', 'mm'],
  ]),
  spacer(),
  h2('10.2 Kinematic Viscosity'),
  eqn('\u03BD(T) = 10\u207B\u2076 / (1 + 0.0337\u00D7T + 0.000221\u00D7T\u00B2)  [m\u00B2/s]'),
  spacer(),
  h2('10.3 Kozeny-Carman Clean-Bed Head Loss'),
  para('For each media layer (anthracite, sand):'),
  eqn('f_K = 180 \u00D7 (1-\u03B5)\u00B2 / \u03B5\u00B3   [Kozeny constant]'),
  eqn('h_L = (f_K \u00D7 \u03BD \u00D7 v \u00D7 L) / (g \u00D7 d_e\u00B2)'),
  para('Where \u03B5 = porosity, v = filtration velocity (m/s), L = bed depth (m), g = 9.81 m/s\u00B2, d_e = effective grain diameter (m).'),
  eqn('h_clean = h_anthracite + h_sand'),
  spacer(),
  h2('10.4 Clogging Model'),
  eqn('TSS_load (kg/m\u00B2) = (TSS_in/1000) \u00D7 Q_m3_h \u00D7 t_backwash / Area'),
  eqn('h_clogged = h_clean + 0.4 \u00D7 TSS_load  [0.4 m per kg/m\u00B2]'),
  para('Backwash triggered when h_clogged > h_limit (default 2.5 m).'),
  spacer(),
  h2('10.5 TSS Breakthrough'),
  eqn('TSS_capacity = 0.8 \u00D7 (1.4 for dual-media, 1.0 for sand)'),
  eqn('Breakthrough = min(1, TSS_load / TSS_capacity)'),
  eqn('Effective removal = target \u00D7 (1 - 0.15 \u00D7 Breakthrough)'),
  spacer(),
  h2('10.6 Filtrate Quality'),
  eqn('TSS_filtrate = TSS_in \u00D7 (1 - effective_removal)'),
  eqn('BOD_filtrate = BOD_in \u00D7 (1 - effective_removal \u00D7 0.45)'),
  eqn('COD_filtrate = COD_in \u00D7 (1 - effective_removal \u00D7 0.30)'),
  eqn('Q_backwash = Q_in \u00D7 0.05  [5% consumption]'),
  spacer(),
);

// ── Chapter 11: RO Membrane ─────────────────────────────────────────────────
children.push(
  h1('11. Reverse Osmosis Membrane'),
  para('The RO model simulates pressure-driven membrane separation, splitting the feed into high-quality permeate and a concentrated reject stream.'),
  spacer(),
  h2('11.1 Default Parameters'),
  paramTable([
    ['Recovery', '75', '%'],
    ['Salt rejection', '0.97', '—'],
    ['TN rejection', '0.85', '—'],
    ['TP rejection', '0.98', '—'],
    ['BOD rejection', '0.99', '—'],
    ['TSS rejection', '1.00', '—'],
    ['Operating pressure', '15', 'bar'],
  ]),
  spacer(),
  h2('11.2 Flow Split'),
  eqn('Permeate_Q = Q_in \u00D7 Recovery'),
  eqn('Concentrate_Q = Q_in \u00D7 (1 - Recovery)'),
  eqn('Concentration_Factor = 1 / (1 - Recovery)'),
  spacer(),
  h2('11.3 Permeate Quality'),
  eqn('TSS_perm = 0  [complete removal]'),
  eqn('BOD_perm = BOD_in \u00D7 (1 - BOD_rejection)'),
  eqn('TN_perm = TN_in \u00D7 (1 - TN_rejection)'),
  eqn('TP_perm = TP_in \u00D7 (1 - TP_rejection)'),
  spacer(),
  h2('11.4 Concentrate Quality'),
  eqn('C_concentrate = C_in \u00D7 CF \u00D7 rejection'),
  para('Each parameter is concentrated by the concentration factor and rejection coefficient.'),
  spacer(),
  h2('11.5 Energy Consumption'),
  eqn('Energy (kWh/d) = Permeate_Q \u00D7 (pressure / 15) \u00D7 0.5'),
  para('Where 0.5 kWh/m\u00B3 is the reference specific energy at 15 bar.'),
  spacer(),
);

// ── Chapter 12: Chemical Dosing ──────────────────────────────────────────────
children.push(
  h1('12. Chemical Dosing'),
  para('The chemical dosing model handles coagulation (phosphorus removal), pH adjustment, and disinfection based on chemical type and dose.'),
  spacer(),
  h2('12.1 Chemical Coefficients'),
  paramTable([
    ['Alum — TP removal', '0.23', 'mg TP per mg alum'],
    ['Alum — TSS increase', '0.26', 'mg TSS per mg alum (Al(OH)\u2083 floc)'],
    ['FeCl\u2083 — TP removal', '0.17', 'mg TP per mg FeCl\u2083'],
    ['FeCl\u2083 — TSS increase', '0.40', 'mg TSS per mg FeCl\u2083 (Fe(OH)\u2083 floc)'],
    ['NaOH — pH change', '+0.01', 'pH per mg/L NaOH'],
    ['H\u2082SO\u2084 — pH change', '-0.008', 'pH per mg/L H\u2082SO\u2084'],
    ['NaOCl — BOD removal', '8%', 'fraction'],
    ['NaOCl — TSS removal', '2%', 'fraction'],
  ]),
  spacer(),
  h2('12.2 Coagulant Dose Calculation'),
  eqn('Dose (kg/d) = Q (m\u00B3/d) \u00D7 dose (mg/L) / 1000'),
  eqn('TP_removed = min(TP_in, dose \u00D7 TP_removal_coeff)'),
  eqn('TP_eff = max(0, TP_in - TP_removed)'),
  eqn('TSS_eff = TSS_in + dose \u00D7 TSS_increase_coeff'),
  spacer(),
  h2('12.3 pH Adjustment'),
  eqn('If target_pH set: pH_eff = target_pH'),
  eqn('Otherwise: pH_eff = clamp(pH_in + dose \u00D7 pH_change_coeff, 0, 14)'),
  spacer(),
);

// ── Chapter 13: Cost Estimation ──────────────────────────────────────────────
children.push(
  h1('13. Cost Estimation Model'),
  para('The cost estimator calculates annual operating costs across five categories based on simulation results and configurable unit cost parameters.'),
  spacer(),
  h2('13.1 Default Unit Costs'),
  paramTable([
    ['Electricity', '0.12', '$/kWh'],
    ['Aeration energy', '1.0', 'kWh/kg O\u2082 transferred'],
    ['Pumping', '0.04', 'kWh/m\u00B3'],
    ['Coagulant (alum)', '0.30', '$/kg'],
    ['Polymer', '3.50', '$/kg'],
    ['Disinfectant (NaOCl)', '0.25', '$/kg'],
    ['Biosolids disposal', '80', '$/tonne (dry)'],
    ['Operator salary', '60,000', '$/year'],
    ['Maintenance', '2%', 'of CapEx/year'],
    ['CapEx factor', '1,200', '$/m\u00B3\u00B7d capacity'],
  ]),
  spacer(),
  h2('13.2 Energy Cost'),
  eqn('Aeration (kWh/d) = \u03A3(O2_demand) \u00D7 aeration_kWh_per_kgO2'),
  eqn('Pumping (kWh/d) = Q \u00D7 pumping_kWh_per_m3'),
  eqn('Energy cost ($/yr) = (Aeration + Pumping) \u00D7 365 \u00D7 electricity_rate'),
  spacer(),
  h2('13.3 Chemical Costs'),
  eqn('Coagulant ($/yr) = Q \u00D7 dose/1000 \u00D7 365 \u00D7 unit_cost'),
  eqn('Polymer ($/yr) = WAS_Q \u00D7 dose/1000 \u00D7 365 \u00D7 unit_cost'),
  eqn('Disinfectant ($/yr) = Q \u00D7 dose/1000 \u00D7 365 \u00D7 unit_cost'),
  spacer(),
  h2('13.4 Sludge Disposal'),
  eqn('Dry solids (t/yr) = \u03A3(biomass_kg_d) / 1000 \u00D7 365'),
  eqn('Disposal cost ($/yr) = dry_tonnes/yr \u00D7 biosolids_rate'),
  spacer(),
  h2('13.5 Labour'),
  eqn('Staff count = max(2, round(Q_MLD / 5))'),
  eqn('Labour cost ($/yr) = Staff \u00D7 salary'),
  spacer(),
  h2('13.6 Maintenance'),
  eqn('CapEx estimate ($) = Q (m\u00B3/d) \u00D7 1,200 $/m\u00B3\u00B7d'),
  eqn('Maintenance ($/yr) = CapEx \u00D7 2%'),
  spacer(),
  h2('13.7 Total Annual Cost'),
  eqn('Total ($/yr) = Energy + Chemicals + Sludge + Labour + Maintenance'),
  eqn('Unit cost ($/m\u00B3) = Total / (Q \u00D7 365)'),
  spacer(),
);

// ── Chapter 14: Dynamic Simulation ───────────────────────────────────────────
children.push(
  h1('14. Dynamic Simulation (Diurnal Profile)'),
  para('The dynamic solver wraps the steady-state engine in a time-step loop. At each hourly step, inlet parameters are scaled by diurnal multipliers to simulate 24-hour flow variation.'),
  spacer(),
  h2('14.1 Scaling Equation'),
  eqn('Parameter(h) = Base_value \u00D7 Scale_factor(h)'),
  para('Applied to: Q, BOD, TN, TP, TSS, and NH\u2084 (NH\u2084 scales with TN).'),
  para('Not scaled: COD, pH, temperature, DO.'),
  spacer(),
  h2('14.2 Default Diurnal Profile'),
  para('The default profile represents a typical municipal wastewater pattern:'),
  paramTable([
    ['00:00\u201305:00', '0.50\u20130.60', 'Night low (minimum at 3 AM)'],
    ['06:00\u201308:00', '0.80\u20131.30', 'Morning rise'],
    ['09:00\u201312:00', '1.40\u20131.50', 'Morning peak (max at 11 AM)'],
    ['13:00\u201316:00', '1.20\u20131.35', 'Afternoon moderate'],
    ['17:00\u201319:00', '1.25\u20131.30', 'Evening peak'],
    ['20:00\u201323:00', '0.68\u20131.10', 'Night decline'],
  ]),
  spacer(),
  h2('14.3 Constant Inlet Mode'),
  para('When the "Constant Inlet" option is enabled, all scale factors are set to 1.0, and inlet parameters remain at their base values throughout the simulation.'),
  spacer(),
);

// ── Chapter 15: Outlet ───────────────────────────────────────────────────────
children.push(
  h1('15. Outlet (Discharge Compliance)'),
  para('The outlet node performs no treatment. It checks effluent quality against discharge permit limits and flags violations.'),
  spacer(),
  h2('15.1 Default Permit Limits'),
  paramTable([
    ['BOD', '30', 'mg/L'],
    ['TSS', '30', 'mg/L'],
    ['TN', '10', 'mg/L'],
    ['TP', '1', 'mg/L'],
    ['NH\u2084', '5', 'mg/L'],
    ['pH range', '6.0\u20139.0', '—'],
  ]),
  spacer(),
);

// ── Build document ───────────────────────────────────────────────────────────

const doc = new Document({
  styles: {
    default: {
      heading1: {
        run: { size: 32, bold: true, font: 'Calibri', color: '1F4E79' },
        paragraph: { spacing: { before: 400, after: 120 } },
      },
      heading2: {
        run: { size: 26, bold: true, font: 'Calibri', color: '2E75B6' },
        paragraph: { spacing: { before: 240, after: 80 } },
      },
      heading3: {
        run: { size: 24, bold: true, font: 'Calibri', color: '4A90D9' },
        paragraph: { spacing: { before: 200, after: 60 } },
      },
    },
  },
  sections: [{ children }],
});

const outPath = path.resolve(__dirname, '..', 'WaterSim_Pro_Models_and_Equations.docx');

Packer.toBuffer(doc).then(buffer => {
  fs.writeFileSync(outPath, buffer);
  console.log(`Document generated: ${outPath}`);
  console.log(`Size: ${(buffer.length / 1024).toFixed(0)} KB`);
});
