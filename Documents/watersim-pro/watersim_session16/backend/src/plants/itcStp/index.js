/**
 * ITC STP — the assembled plant definition.
 *
 * One import point for everything derived from "Project Proposal v2":
 *
 *   processes    the eleven process areas and their devices          (slides 4–15)
 *   proposal     the commercial tables, verbatim                     (slides 16–20)
 *   narrative    the control narrative as structured sequences       (slides 22–24)
 *   flowsheet    the schematic as canvas_data                        (slide 3)
 *   ioSchedule   the tag list and the four-way I/O reconciliation
 *   costing      every quoted total, recomputed from its line items
 *   diagram      the process flow diagram, generated from the flow
 *
 * `review()` is the headline: every finding from all three engines, ranked, in
 * one list. It is what the plant review page and the handover document both
 * read, so a discrepancy can never appear in one and be missing from the other.
 */
'use strict';

const processes = require('./processes');
const proposal = require('./proposal');
const narrative = require('./narrative');
const ioSchedule = require('./ioSchedule');
const costing = require('./costing');
const flowsheet = require('./flowsheet');
const diagram = require('./diagram');

const PLANT_ID = 'itc-stp';

const IDENTITY = Object.freeze({
  id: PLANT_ID,
  name: 'ITC — Sewage Treatment Plant',
  shortName: 'ITC STP',
  ...proposal.PARTIES,
  designFlowKld: proposal.DESIGN_FLOW_KLD,
  influent: proposal.INFLUENT,
  sourceDocument: 'Project Proposal v2 — Sewage Treatment Plant',
  processCount: processes.PROCESSES.length,
});

/**
 * Treated-water criteria for this plant.
 *
 * The proposal states NO effluent quality requirement anywhere — not a limit,
 * not a target, and no analyser beyond the single pH meter after the filters.
 * That is itself a review finding (`quality.no_stated_limits` below): a
 * monitoring and control system is being priced with nothing to monitor
 * quality against.
 *
 * The limits here are therefore a TEMPLATE, not a permit. They reflect the
 * criteria normally applied to treated sewage reused for flushing, horticulture
 * and cooling-tower make-up in Indian buildings, which is where all three of
 * this plant's product waters go. They must be confirmed with ITC and the
 * consenting authority before they mean anything.
 */
const REUSE_CRITERIA = Object.freeze({
  name: 'Treated water for in-building reuse — TEMPLATE, to be confirmed',
  confirmed: false,
  basis: 'Criteria commonly applied to treated sewage reused for flushing, horticulture and cooling-tower make-up. The proposal states no limits of its own.',
  limits: Object.freeze({
    BOD: 10,
    TSS: 10,
    NH4: 5,
    TN: null,   // not applicable to non-potable reuse; left unset deliberately
    TP: null,   // no phosphorus removal exists in this plant — see the finding
    pH_min: 6.5,
    pH_max: 8.5,
  }),
});

const SEVERITY_RANK = { high: 0, medium: 1, low: 2 };

/** Findings the plant raises that belong to none of the three engines. */
function plantFindings() {
  return [
    {
      id: 'quality.no_stated_limits',
      severity: 'high',
      area: 'Scope',
      title: 'No treated-water quality requirement appears anywhere in the proposal',
      derived: 'The app applies a reuse TEMPLATE (BOD 10, TSS 10, NH₄ 5, pH 6.5–8.5) so the plant can be graded at all.',
      stated: 'No limit, target or standard is named on any slide.',
      source: 'Slides 1–25',
      impact: 'A monitoring and control system is being priced with no quality target to control to, and no analyser except one pH meter. Alarm setpoints, report pass/fail and the ICMES dashboards all need this settled first.',
    },
    {
      id: 'quality.no_p_removal',
      severity: 'medium',
      area: 'Process',
      title: 'The plant has no phosphorus removal step',
      derived: 'Phosphorus passes the SBR, the filters and the softener essentially untouched and reaches the irrigation, flushing and cooling-tower lines at close to its influent concentration.',
      stated: 'No chemical P removal, no EBPR zone and no alum or ferric dosing appears in any process area.',
      source: 'Slides 4–14',
      impact: 'Acceptable for horticulture, where phosphorus is a fertiliser. It matters for cooling-tower make-up, where it feeds biological fouling, and it rules out any future discharge to surface water.',
    },
    {
      id: 'instr.no_residual_chlorine',
      severity: 'high',
      area: 'FFP',
      title: 'Chlorine is dosed to a band that nothing measures',
      derived: 'The control narrative closes the INT-WT dosing loop on residual chlorine at 0.5–1 ppm, but the I/O schedule contains one analyser in the whole plant and it is a pH meter.',
      stated: 'Slide 23 step IV.2; slides 8 and 9 for the instrument list.',
      source: 'Slides 8, 9 and 23',
      impact: 'As specified, the dosing pump can only be run on a timer. Reuse water for flushing normally has to carry a measured residual, so this is a compliance instrument, not a convenience.',
    },
  ];
}

/**
 * Every finding, from every engine, ranked. High severity first, then by area.
 * @returns {Array<{id,severity,area,title,derived,stated,source,impact}>}
 */
function review() {
  const all = [
    ...ioSchedule.reconcile(),
    ...costing.costFindings(),
    ...narrative.narrativeFindings(),
    ...plantFindings(),
  ];
  return all.sort((a, b) => {
    const s = (SEVERITY_RANK[a.severity] ?? 3) - (SEVERITY_RANK[b.severity] ?? 3);
    return s !== 0 ? s : String(a.area).localeCompare(String(b.area));
  });
}

/** Counts by severity, for the review page's header. */
function reviewSummary() {
  const findings = review();
  const bySeverity = { high: 0, medium: 0, low: 0 };
  for (const f of findings) bySeverity[f.severity] = (bySeverity[f.severity] || 0) + 1;
  return { total: findings.length, bySeverity };
}

/** The whole plant, ready to serve. */
function snapshot() {
  return {
    identity: IDENTITY,
    processes: processes.PROCESSES,
    signalRules: processes.SIGNAL_RULES,
    kindLabels: processes.KIND_LABELS,
    io: {
      totals: ioSchedule.plantTotals(),
      perProcess: processes.PROCESSES.map(ioSchedule.processTotals),
      deviceCounts: ioSchedule.deviceCounts(),
      capacityHeadroom: ioSchedule.capacityHeadroom(),
      nodeLoading: ioSchedule.nodeLoading(),
      tagCount: ioSchedule.buildTagList().length,
    },
    narrative: {
      sections: narrative.SECTIONS,
      cycleAnalysis: narrative.cycleAnalysis(),
    },
    commercial: {
      monitoring: costing.monitoringCost(),
      valveOptions: costing.valveControlOptions(),
      pumpControl: costing.pumpControl(),
      architectures: costing.architectures(),
      scenarios: costing.scenarioGrid(),
      addOns: costing.addOns(),
      icmesFeatures: proposal.ICMES_FEATURES,
    },
    reuseCriteria: REUSE_CRITERIA,
    review: review(),
    reviewSummary: reviewSummary(),
  };
}

module.exports = {
  PLANT_ID,
  IDENTITY,
  REUSE_CRITERIA,
  processes,
  proposal,
  narrative,
  ioSchedule,
  costing,
  flowsheet,
  diagram,
  plantFindings,
  review,
  reviewSummary,
  snapshot,
};
