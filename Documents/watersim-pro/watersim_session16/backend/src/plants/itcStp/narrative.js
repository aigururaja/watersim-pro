/**
 * ITC STP — the control narrative, made executable.
 *
 * Slides 22–24 state the sequence in prose. This module keeps that prose
 * verbatim (`text`, so nothing is lost in translation) and adds the structure a
 * controller needs beside it: which devices each step drives, how long it runs,
 * and what interlock releases it.
 *
 * `cycleAnalysis()` then does the arithmetic the prose implies but never shows —
 * how much water an SBR cycle of 1.5 h fill / 2 h aerate / 1 h settle / 45 min
 * decant can actually pass at the quoted 43 m³/hr feed pump, against the 675 KLD
 * the plant is designed for. That number decides whether the plant meets its
 * duty, and the proposal does not state it.
 *
 * DEVICE TAGS below refer to `processes.js`; every one resolves.
 */
'use strict';

const { DESIGN_FLOW_KLD } = require('./proposal');

const MIN = 1 / 60; // hours

/**
 * The ten narrative sections.
 *
 * step.text     — the proposal's own sentence, unedited
 * step.action   — what the controller does: 'open' | 'close' | 'start' | 'stop' |
 *                 'wait' | 'check' | 'transfer' | 'dose' | 'reverse'
 * step.devices  — device tags from processes.js
 * step.durationH— hold time in hours, when the prose states one
 * step.interlock— the condition that releases the step
 */
const SECTIONS = Object.freeze([
  {
    id: 'input_water',
    numeral: 'I',
    title: 'Input water',
    slide: 22,
    area: 'ELP',
    steps: [
      { no: 1, text: 'All water coming to EQT directly.', action: 'transfer', devices: ['ELP-P-101'], interlock: 'CT high level' },
      { no: 2, text: 'Filter to be cleaned periodically.', action: 'check', devices: [], note: 'Manual task — no I/O point is allocated for it.' },
      { no: 3, text: 'Flow switch will be placed to monitor the flow level in EQT.', action: 'check', devices: ['EQT-LT-101'] },
      { no: 4, text: 'Monitor the EQT and check the status of OGT and CT.', action: 'check', devices: ['EQT-LT-101', 'OGT-LSH-101'] },
    ],
  },
  {
    id: 'reactor',
    numeral: 'II',
    title: 'Reactor process',
    slide: 22,
    area: 'R',
    cycle: 'sbr',
    steps: [
      { no: 1, text: 'Depend upon the level of INT-WT Reactor will ON.', action: 'check', devices: ['INT-LT-501'], interlock: 'INT-WT level below start setpoint',
        review: 'The reactor is fed from EQT, not INT-WT. Reading the downstream tank as the start permissive is most likely a transcription slip for EQT level.' },
      { no: 2, text: 'The inlet and outlet of the Primary Pump (RFP) will be opened.', action: 'open', devices: ['RFP-XV-201', 'RFP-XV-211'], phase: 'fill' },
      { no: 3, text: 'After 15 sec Primary Pump will be switched ON.', action: 'start', devices: ['RFP-P-201'], durationH: 15 / 3600, phase: 'fill' },
      { no: 4, text: 'The filling takes place for 1.5 hours then the pump will be switched OFF.', action: 'stop', devices: ['RFP-P-201'], durationH: 1.5, phase: 'fill' },
      { no: 5, text: 'After 15 sec switch OFF the two control valves.', action: 'close', devices: ['RFP-XV-201', 'RFP-XV-211'], durationH: 15 / 3600, phase: 'fill' },
      { no: 6, text: 'R1 tank corresponding valve open and then blower open.', action: 'open', devices: ['R-XV-311', 'R-B-301'], phase: 'aerate' },
      { no: 7, text: 'After 1.5 hours Feed Pump will OFF and the Air Blower will run for 2 hours.', action: 'start', devices: ['R-B-301'], durationH: 2, phase: 'aerate' },
      { no: 8, text: 'Check the level of INT-WT and EQT.', action: 'check', devices: ['INT-LT-501', 'EQT-LT-101'] },
      { no: 9, text: 'Open the Reactor (R2) input and output valve.', action: 'open', devices: ['R-XV-301'], phase: 'fill' },
      { no: 10, text: 'Switch ON the R2 Air Blower Valve and Pneumatic Valve then blower will run.', action: 'start', devices: ['R-XV-311', 'R-B-301'], phase: 'aerate' },
      { no: 11, text: 'After the aeration process, the settling phase will take place for next 1 hour.', action: 'wait', devices: [], durationH: 1, phase: 'settle' },
      { no: 12, text: 'Then Decay will be ON for 45 mins and goes down and reverse the decanter.', action: 'reverse', devices: ['R-M-301'], durationH: 0.75, phase: 'decant',
        review: '"Decay" reads as "decant" — the decanter lowers, draws supernatant for 45 minutes, then reverses to park.' },
      { no: 13, text: 'From decanter it will go to INT-WT.', action: 'transfer', devices: ['R-M-301'], phase: 'decant' },
    ],
  },
  {
    id: 'sludge',
    numeral: 'III',
    title: 'Sludge process',
    slide: 22,
    area: 'SHT',
    steps: [
      { no: 1, text: 'SHT works when MLSS (Mixed Liquor Suspended Solids) maintained.', action: 'check', devices: ['SHT-LT-401'] },
      { no: 2, text: "MLSS should be 30% to 50%. If it's more the STP will ON and the sludge is pumped using centrifugal pump then redirected to EQT.", action: 'start', devices: ['R-P-301', 'SHT-P-421'], interlock: 'MLSS above 50 %',
        review: 'MLSS is a concentration in mg/L, not a percentage. Read as a settled-sludge volume (SV30) of 30–50 %, the setpoint is workable; read literally it is not measurable with the instruments listed, and no MLSS analyser appears in the I/O schedule.' },
    ],
    setpoints: [
      { key: 'mlss_low_pct', label: 'Sludge volume — lower band', value: 30, unit: '%' },
      { key: 'mlss_high_pct', label: 'Sludge volume — transfer setpoint', value: 50, unit: '%' },
    ],
  },
  {
    id: 'int_wt',
    numeral: 'IV',
    title: 'Intermediate water tank',
    slide: 23,
    area: 'FFP',
    steps: [
      { no: 1, text: 'Water from R1 and R2 flows into the INT-WT.', action: 'transfer', devices: ['R-M-301'] },
      { no: 2, text: 'Liquid chlorine dosing happens between 0.5 ppm and 1 ppm. Below 0.5 ppm dosing will be ON; above 0.5 ppm dosing will be OFF.', action: 'dose', devices: ['FFP-P-501'], interlock: 'Residual chlorine below 0.5 ppm',
        review: 'No residual-chlorine analyser appears anywhere in the I/O schedule — the only analyser listed is the pH meter after the filters. As specified, this loop has no measurement to close on.' },
      { no: 3, text: 'When the FFP inlet and outlet of Primary Pump is ON.', action: 'open', devices: ['FFP-XV-501', 'FFP-XV-511'] },
      { no: 4, text: 'The pumped water is split into two lines. One line is directed to ACF & MGF filter and the other line is directed to Micron filter.', action: 'transfer', devices: ['FFP-P-501'] },
    ],
    setpoints: [
      { key: 'cl_low_ppm', label: 'Chlorine dosing ON below', value: 0.5, unit: 'ppm' },
      { key: 'cl_high_ppm', label: 'Chlorine residual upper band', value: 1.0, unit: 'ppm' },
    ],
  },
  {
    id: 'acf_mgf',
    numeral: 'V',
    title: 'ACF and MGF filter process',
    slide: 23,
    area: 'ACF',
    steps: [
      { no: 1, text: 'From these filter tanks, the water flows to the pH.', action: 'check', devices: ['ACF-AT-601'] },
      { no: 2, text: 'The three processes from ACF and MGF filter are: SOF to SWT, UFFP to FWT, ACF and MGF to IRR-WT.', action: 'transfer', devices: ['ACF-XV-611'] },
    ],
  },
  {
    id: 'softener',
    numeral: 'VI',
    title: 'Softener water tank',
    slide: 23,
    area: 'SFP',
    cycle: 'softener',
    steps: [
      { no: 1, text: 'The inlet and outlet of the Primary Pump (SFP) are switched ON.', action: 'open', devices: ['SFP-XV-701', 'SFP-XV-711'] },
      { no: 2, text: 'After 15 sec delay the pump are opened.', action: 'start', devices: ['SFP-P-701'], durationH: 15 / 3600 },
      { no: 3, text: 'Water flows through the SOF where the hardness of the water is reduced.', action: 'transfer', devices: ['SOF-XV-701'] },
      { no: 4, text: 'The SOF output valve is opened and the treated water is directed to SWT.', action: 'open', devices: ['SOF-XV-701'] },
      { no: 5, text: 'After another 15 sec, two control valves and pump are closed.', action: 'stop', devices: ['SFP-P-701', 'SFP-XV-701', 'SFP-XV-711'], durationH: 15 / 3600 },
      { no: 6, text: 'Brine solution is added to regenerate SOF.', action: 'dose', devices: ['SFP-P-701'], note: 'Brine agitator shares the SFP-P-701 group on the I/O schedule.' },
      { no: 7, text: 'When the SWT reaches its full level, the excess or overflow water is automatically redirected from the SOF to the IRR-WT.', action: 'transfer', devices: ['SWT-LT-1101', 'SOF-XV-701'], interlock: 'SWT at high level' },
    ],
  },
  {
    id: 'uf',
    numeral: 'VII',
    title: 'Ultrafiltration feed pump process',
    slide: 24,
    area: 'UF',
    cycle: 'uf',
    steps: [
      { no: 1, text: 'Water from ACF and MGF filter flows into UF.', action: 'transfer', devices: ['UF-XV-821'] },
      { no: 2, text: 'The inlet and outlet of the Primary Pump (UFFP) are switched ON.', action: 'open', devices: ['UF-XV-801', 'UF-XV-811'], phase: 'produce' },
      { no: 3, text: 'The output valve opens, initiating the UF process.', action: 'open', devices: ['UF-XV-821'], phase: 'produce' },
      { no: 4, text: 'Filtered water then flows into the Sintex Tank, and from there to the FWT.', action: 'transfer', devices: ['SNT-LT-801'], phase: 'produce' },
      { no: 5, text: 'This process takes place every 20 mins followed by a 1 min Flush Backwash.', action: 'wait', devices: [], durationH: 20 * MIN, phase: 'produce' },
      { no: 6, text: 'After that the Valves and Pump are switched OFF.', action: 'stop', devices: ['UF-P-801', 'UF-XV-801', 'UF-XV-811'], phase: 'backwash' },
      { no: 7, text: 'The UFBP inlet and outlet Primary Pump are opened.', action: 'open', devices: ['UF-XV-801', 'UF-XV-811'], phase: 'backwash' },
      { no: 8, text: 'After 15 sec delay the Pump is switched ON and the rinse valve is opened.', action: 'start', devices: ['UF-P-801', 'UF-XV-821'], durationH: 15 / 3600, phase: 'backwash' },
      { no: 9, text: 'After another 15 sec, two control valves and the pump are switched OFF.', action: 'stop', devices: ['UF-P-801'], durationH: 15 / 3600, phase: 'backwash' },
      { no: 10, text: 'The Backwash Valve is then opened, and the water is directed to the EQT.', action: 'open', devices: ['UF-XV-821'], phase: 'backwash' },
    ],
  },
  {
    id: 'horticulture',
    numeral: 'VIII',
    title: 'Horticulture water transfer pump process',
    slide: 24,
    area: 'HWTP',
    steps: [
      { no: 1, text: 'Depending on the pressure the HWTP is automatically controlled and the HWTP pumps will be monitored.', action: 'start', devices: ['HWT-P-901'], interlock: 'Header pressure below setpoint',
        review: 'Pressure is the stated control variable, but no pressure transmitter appears in the I/O schedule for this area — only a level transmitter and a water meter.' },
      { no: 2, text: 'Water flows from IRR-WT to the irrigation system.', action: 'transfer', devices: ['HWT-XV-911'] },
    ],
  },
  {
    id: 'flushing',
    numeral: 'IX',
    title: 'Flushing water transfer pump process',
    slide: 24,
    area: 'FWTP',
    steps: [
      { no: 1, text: 'Depending on the pressure the FWTP is automatically controlled and the FWTP pumps will be monitored.', action: 'start', devices: ['FWT-P-1001'], interlock: 'Header pressure below setpoint',
        review: 'Same gap as the horticulture header — no pressure transmitter is scheduled for this area.' },
      { no: 2, text: 'Water flows from FWT to the flush water system.', action: 'transfer', devices: ['FWT-XV-1011'] },
    ],
  },
  {
    id: 'soft_water',
    numeral: 'X',
    title: 'Soft water transfer pump process',
    slide: 24,
    area: 'SWTP',
    steps: [
      { no: 1, text: 'Depending on the pressure the SWTP is automatically controlled and the SWTP pumps will be monitored.', action: 'start', devices: ['SWT-P-1101'], interlock: 'Header pressure below setpoint',
        review: 'Same gap as the other two transfer headers — no pressure transmitter is scheduled.' },
      { no: 2, text: 'Water flows from SWT to the cooling tower.', action: 'transfer', devices: ['SWT-XV-1111'] },
    ],
  },
]);

/** The SBR cycle the reactor narrative describes, phase by phase. */
const SBR_CYCLE = Object.freeze({
  reactors: 2,
  feedPump_m3_h: 43, // RFP capacity, slide 5
  phases: Object.freeze([
    { key: 'fill', label: 'Fill', hours: 1.5, source: 'Slide 22, step II.2.3' },
    { key: 'aerate', label: 'Aeration', hours: 2.0, source: 'Slide 22, step II.2.6' },
    { key: 'settle', label: 'Settle', hours: 1.0, source: 'Slide 22, step II.6' },
    { key: 'decant', label: 'Decant', hours: 0.75, source: 'Slide 22, step II.7' },
  ]),
});

/** The UF production / backwash cycle from section VII. */
const UF_CYCLE = Object.freeze({
  feedPump_m3_h: 10, // UFFP, slide 11
  backwashPump_m3_h: 15, // UFBP, slide 11
  phases: Object.freeze([
    { key: 'produce', label: 'Production', hours: 20 * MIN, source: 'Slide 24, step VII.5' },
    { key: 'backwash', label: 'Flush backwash', hours: 1 * MIN, source: 'Slide 24, step VII.5' },
  ]),
});

const round = (n, dp = 1) => +Number(n).toFixed(dp);

/**
 * What the stated cycle times and pump capacities actually deliver, against the
 * 675 KLD the plant is designed for.
 *
 * The proposal states the phase durations and the pump capacity but never
 * multiplies them out. Doing so is the difference between a plant that meets
 * its duty and one that backs up into the equalisation tank every day.
 */
function cycleAnalysis() {
  const cycleHours = SBR_CYCLE.phases.reduce((a, p) => a + p.hours, 0);
  const cyclesPerDay = 24 / cycleHours;
  const fillHours = SBR_CYCLE.phases.find((p) => p.key === 'fill').hours;
  const volumePerFill = SBR_CYCLE.feedPump_m3_h * fillHours;
  const throughput = volumePerFill * cyclesPerDay * SBR_CYCLE.reactors;
  const shortfall = DESIGN_FLOW_KLD - throughput;

  const requiredFillHours = DESIGN_FLOW_KLD / (SBR_CYCLE.reactors * cyclesPerDay * SBR_CYCLE.feedPump_m3_h);
  const requiredPump = DESIGN_FLOW_KLD / (SBR_CYCLE.reactors * cyclesPerDay * fillHours);

  const ufCycleHours = UF_CYCLE.phases.reduce((a, p) => a + p.hours, 0);
  const ufCyclesPerDay = 24 / ufCycleHours;
  const ufProduced = UF_CYCLE.feedPump_m3_h * (20 * MIN) * ufCyclesPerDay;
  const ufBackwash = UF_CYCLE.backwashPump_m3_h * (1 * MIN) * ufCyclesPerDay;

  return {
    designFlow_m3_d: DESIGN_FLOW_KLD,
    sbr: {
      cycleHours: round(cycleHours, 2),
      cyclesPerDay: round(cyclesPerDay, 2),
      reactors: SBR_CYCLE.reactors,
      feedPump_m3_h: SBR_CYCLE.feedPump_m3_h,
      fillHours,
      volumePerFill_m3: round(volumePerFill),
      throughput_m3_d: round(throughput),
      shortfall_m3_d: round(shortfall),
      meetsDesignFlow: shortfall <= 0,
      requiredFillHours: round(requiredFillHours, 2),
      requiredFeedPump_m3_h: round(requiredPump),
      phases: SBR_CYCLE.phases.map((p) => ({ ...p, sharePct: round((p.hours / cycleHours) * 100) })),
    },
    uf: {
      cycleMinutes: round(ufCycleHours * 60),
      cyclesPerDay: round(ufCyclesPerDay),
      produced_m3_d: round(ufProduced),
      backwash_m3_d: round(ufBackwash),
      netToFwt_m3_d: round(ufProduced - ufBackwash),
      recoveryPct: round(((ufProduced - ufBackwash) / ufProduced) * 100),
      backwashReturnsTo: 'EQT',
    },
  };
}

/**
 * Review items raised by the narrative itself — the instruments it assumes but
 * never schedules, the terms that do not survive a literal reading, and the
 * hydraulic shortfall the cycle arithmetic exposes.
 */
function narrativeFindings() {
  const findings = [];

  for (const section of SECTIONS) {
    for (const step of section.steps) {
      if (!step.review) continue;
      findings.push({
        id: `narrative.${section.id}.${step.no}`,
        severity: 'medium',
        area: section.area,
        title: `${section.numeral}.${step.no} — ${section.title}`,
        derived: step.review,
        stated: step.text,
        source: `Slide ${section.slide}`,
        impact: 'The sequence cannot be commissioned as written until this is resolved.',
      });
    }
  }

  const analysis = cycleAnalysis();
  if (!analysis.sbr.meetsDesignFlow) {
    findings.push({
      id: 'narrative.sbr.capacity',
      severity: 'high',
      area: 'R',
      title: 'The stated SBR cycle cannot pass the design flow',
      derived: `${analysis.sbr.throughput_m3_d} m³/d — ${analysis.sbr.cyclesPerDay} cycles/day × ${analysis.sbr.volumePerFill_m3} m³ per fill × ${analysis.sbr.reactors} reactors`,
      stated: `${analysis.designFlow_m3_d} m³/d design influent (100 + 475 + 100 KLD)`,
      source: 'Slides 4, 5 and 22',
      impact: `Short by ${analysis.sbr.shortfall_m3_d} m³/d. Either the fill extends to ${analysis.sbr.requiredFillHours} h or the feed pump rises to ${analysis.sbr.requiredFeedPump_m3_h} m³/hr; otherwise the equalisation tank accumulates every day.`,
    });
  }

  return findings;
}

/** Flat step list with resolved timings, for the sequence timeline UI. */
function timeline(sectionId) {
  const section = SECTIONS.find((s) => s.id === sectionId);
  if (!section) return null;
  let elapsed = 0;
  const steps = section.steps.map((step) => {
    const at = elapsed;
    elapsed += step.durationH || 0;
    return { ...step, startHour: round(at, 3), endHour: round(elapsed, 3) };
  });
  return { ...section, steps, totalHours: round(elapsed, 3) };
}

module.exports = { SECTIONS, SBR_CYCLE, UF_CYCLE, cycleAnalysis, narrativeFindings, timeline };
