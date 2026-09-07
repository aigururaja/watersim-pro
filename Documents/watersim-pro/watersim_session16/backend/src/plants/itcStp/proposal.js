/**
 * ITC STP — the commercial proposal, transcribed.
 *
 * Slides 16–20 of "Project Proposal v2": the input-monitoring device cost, the
 * output-control device options, the three system architectures, and the
 * overall option table. All figures are Indian rupees, exactly as quoted.
 *
 * NOTHING here is derived. `costing.js` recomputes every total from these
 * line items and reports where the recomputed figure differs from the quoted
 * one, so a reviewer sees the arithmetic rather than trusting it.
 */
'use strict';

/** Device quantities the commercial tables are priced against (slide 16). */
const PRICED_QUANTITIES = Object.freeze({
  valves: 58,
  pumps: 26,
  tank_level: 12,
  flow_ph: 7, // 6 flow meters + 1 pH analyser
});

/** Slide 16, upper table — input monitoring devices. */
const MONITORING_COST = Object.freeze({
  title: 'Input monitoring device cost',
  slide: 16,
  lines: Object.freeze([
    { family: 'valves', label: 'Valves', qty: 58, detail: 'Feedback sensor',
      monitoring: 'Open / Close status', device: 300000, cabling: 180000, install: 140000, cableRun: '750 m' },
    { family: 'pumps', label: 'Pumps', qty: 26, detail: 'Pumps with DOL, STD & VFD',
      monitoring: 'On / Off status, Trip status', device: 50000, cabling: 70000, install: 80000, cableRun: '300 m' },
    { family: 'tank_level', label: 'Tank level', qty: 12, detail: 'Tank level sensor + level switch',
      monitoring: 'Level value 8, level status 4', device: 200000, cabling: 80000, install: 90000, cableRun: '300 m' },
    { family: 'flow_ph', label: 'Pipe flow + pH', qty: 7, detail: 'Water flow meter, pH meter',
      monitoring: 'Flow meter 6, pH sensor 1', device: 340000, cabling: 45000, install: 50000, cableRun: '200 m' },
  ]),
  quotedTotals: Object.freeze({ device: 890000, cabling: 375000, install: 360000, total: 1625000 }),
});

/** Slide 16, lower table — output control devices. Three mutually exclusive valve options. */
const VALVE_CONTROL_OPTIONS = Object.freeze([
  {
    id: 'new_electrical',
    option: 1,
    label: 'New valve with electrical actuator',
    detail: 'Actuator is attached mechanically in the valve handle',
    merits: 'Maintenance will be easy for the next 10 years',
    demerits: 'Cost and time factor',
    device: 2030000, cabling: 165880, install: 350000,
    extras: [],
    quotedTotal: 2545880,
  },
  {
    id: 'retrofit_electrical',
    option: 2,
    label: 'Electrical actuator added to the existing valve',
    detail: 'Actuator is attached mechanically in the valve handle',
    merits: 'Easy and cost efficient',
    demerits: 'On / Off control only',
    device: 580000, cabling: 165880, install: 430000,
    extras: [],
    quotedTotal: 1175880,
  },
  {
    id: 'new_pneumatic',
    option: 3,
    label: 'New valve with pneumatic actuator',
    detail: 'Needs a pneumatic air line',
    merits: 'Cost lower than electrical',
    demerits: 'Pneumatic air line needed',
    device: 870000, cabling: 165880, install: 380000,
    extras: [
      { label: 'Pneumatic system — air compressor & pipe line', device: 150000, cabling: 360000, install: 260000 },
    ],
    quotedTotal: 2185880,
  },
]);

/** Slide 16 — pump control hardware, common to every option. */
const PUMP_CONTROL = Object.freeze({
  label: 'Contactors & relays',
  qty: 26,
  monitoring: 'On / Off status, Trip status',
  control: 'On / Off control',
  device: 80000, cabling: 70000, install: 100000,
  quotedTotal: 250000,
});

/** Slides 17–19 — the three proposed system architectures. */
const ARCHITECTURES = Object.freeze([
  {
    id: 'arch1',
    no: 1,
    name: 'Siemens SCADA & Controller',
    slide: 17,
    family: 'siemens',
    scope: 'monitoring_and_control',
    nodes: ['Node 1 — MCC panel', 'Node 2 — Reactor', 'Node 3 — Motor side', 'Node 4 — VFD panel'],
    capacity: { DI: 240, DO: 160, AI: 24, AO: 0 },
    items: [
      { key: 'scada', label: 'Siemens SCADA', detail: 'Graphics plant monitoring, history, alarms, trend, report & controlling (600 tags, 20 screens)', cost: 360000, optional: false },
      { key: 'controller', label: 'Siemens controller', detail: '4 nodes (DI 240, DO 160, AI 24) + 4 control panels', cost: 820000, optional: false },
      { key: 'icmes', label: 'ICMES software', detail: 'Remote monitoring, web + WhatsApp integration (16 standard screens, operator & supervisor alerts)', cost: 450000, optional: true },
      { key: 'amc', label: 'Annual maintenance contract', detail: 'SCADA, PLC & ICMES · 12 scheduled + 12 emergency visits per year', cost: 240000, optional: true },
    ],
  },
  {
    id: 'arch2',
    no: 2,
    name: 'IOT Nodes & ICMES software',
    slide: 18,
    family: 'icmes',
    scope: 'monitoring_and_control',
    nodes: ['IOT node 1 — MCC panel', 'IOT node 2 — Reactor', 'IOT node 3 — Motor side', 'IOT node 4 — VFD panel'],
    capacity: { DI: 240, DO: 160, AI: 24, AO: 0 },
    items: [
      { key: 'iot_node', label: 'IOT node', detail: '4 nodes (DI 240, DO 160, AI 24) + 4 control panels', cost: 400000, optional: false },
      { key: 'icmes', label: 'ICMES software', detail: 'Remote monitoring, web + WhatsApp integration (16 standard screens, operator & supervisor alerts)', cost: 450000, optional: false },
      { key: 'amc', label: 'Annual maintenance contract', detail: 'SCADA, PLC & ICMES · 12 scheduled + 12 emergency visits per year', cost: 240000, optional: true },
    ],
  },
  {
    id: 'arch3',
    no: 3,
    name: 'Monitoring-only system',
    slide: 19,
    family: 'both',
    scope: 'monitoring_only',
    nodes: ['IOT I/O 1 — MCC panel', 'IOT node 2 — Reactor', 'IOT node 3 — Motor side', 'IOT node 4 — VFD panel'],
    capacity: { DI: 230, DO: 0, AI: 24, AO: 0 },
    items: [
      { key: 'scada', label: 'Siemens SCADA (1 system)', detail: 'Graphics plant monitoring, history, alarms, trend, report & controlling (600 tags, 20 screens)', cost: 420000, optional: false, variant: 'siemens' },
      { key: 'controller', label: 'Siemens controller', detail: '4 nodes (DI 230, AI 24) + 4 control panels', cost: 480000, optional: false, variant: 'siemens' },
      { key: 'iot_node', label: 'IOT node', detail: '4 nodes (DI 230, AI 24) + 4 control panels', cost: 300000, optional: false, variant: 'icmes' },
      { key: 'icmes', label: 'ICMES software (multiple systems)', detail: 'Remote monitoring, web + WhatsApp integration (16 standard screens, operator & supervisor alerts)', cost: 450000, optional: false, variant: 'icmes' },
      { key: 'amc', label: 'Annual maintenance contract', detail: 'SCADA, PLC & ICMES · 12 scheduled + 12 emergency visits per year', cost: 240000, optional: true },
    ],
  },
]);

/** Slide 20 — the overall option table, exactly as quoted. */
const OVERALL_OPTIONS = Object.freeze([
  {
    id: 'option1',
    no: 1,
    label: 'Option 1 — Siemens SCADA & Controller',
    detail: 'ICMES additional if required — ₹4,20,000 (software remote monitor / SCADA view and WhatsApp interface)',
    icmesAddOn: 420000,
    quoted: { new_electrical: 5600880, retrofit_electrical: 4230880, monitoring_only: 2555000 },
  },
  {
    id: 'option2',
    no: 2,
    label: 'Option 2 — IOT nodes & ICMES software',
    detail: 'Inbuilt software remote monitor (SCADA view) and WhatsApp interface',
    icmesAddOn: 0,
    quoted: { new_electrical: 5270880, retrofit_electrical: 3900880, monitoring_only: 2725000 },
  },
]);

/** Slide 20 — line items priced once, independent of the chosen option. */
const ADD_ONS = Object.freeze([
  { id: 'display', label: 'Display station', detail: '43-inch display with stand, i7 12th-gen PC, 1 kVA UPS and anti-virus', cost: 150000 },
  { id: 'energy', label: 'Energy & air-quality monitoring', detail: 'Pump process and electrical parameters with alerting', cost: 650000 },
  { id: 'amc', label: 'Annual maintenance contract', detail: 'SCADA, PLC & ICMES · 12 scheduled + 12 emergency visits per year', cost: 240000, recurring: 'yearly' },
]);

/** Slide 20 note — what the ICMES product includes. */
const ICMES_FEATURES = Object.freeze([
  'Web-based software — a normal browser is enough, nothing to install',
  'Opens on multiple systems with access restricted by operator and supervisor role',
  'Dashboard with flexible options, designed to the client brief',
  'All alerts can be sent as WhatsApp messages',
  'Yearly renewal ₹60,000 (included in the AMC)',
]);

/** Commercial parties, from slide 1. */
const PARTIES = Object.freeze({
  client: 'ITC',
  contractor: 'Safekrite',
  subContractor: 'Infercon Automation',
  objective: 'Complete monitoring and control of the sewage treatment plant',
});

/** Design influent, from the schematic and slide 4. */
const INFLUENT = Object.freeze([
  { stream: 'Kitchen influent', kld: 100, pretreatment: 'Oil & grease trap (OGT)' },
  { stream: 'Sewage influent', kld: 475, pretreatment: 'Bar chamber' },
  { stream: 'Laundry influent', kld: 100, pretreatment: 'Collection tank (CT)' },
]);

const DESIGN_FLOW_KLD = INFLUENT.reduce((sum, s) => sum + s.kld, 0); // 675 KLD

module.exports = {
  PARTIES,
  INFLUENT,
  DESIGN_FLOW_KLD,
  PRICED_QUANTITIES,
  MONITORING_COST,
  VALVE_CONTROL_OPTIONS,
  PUMP_CONTROL,
  ARCHITECTURES,
  OVERALL_OPTIONS,
  ADD_ONS,
  ICMES_FEATURES,
};
