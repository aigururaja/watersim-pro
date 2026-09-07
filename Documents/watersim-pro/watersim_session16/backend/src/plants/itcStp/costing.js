/**
 * ITC STP — costing engine.
 *
 * Recomputes every total on proposal slides 16–20 from its own line items and
 * reports where the recomputed figure differs from the quoted one. The point is
 * not to correct the proposal but to make its arithmetic inspectable: a client
 * comparing ₹56,00,880 against ₹52,70,880 should be able to see the five lines
 * each is made of.
 *
 * It also prices the combinations the proposal costed but never carried into
 * the overall table — most notably the pneumatic valve option (slide 16,
 * option 3, ₹21,85,880), which is priced in detail and then absent from
 * slide 20 altogether.
 *
 * All amounts are rupees. `formatINR` renders the Indian digit grouping the
 * proposal uses (₹56,00,880 — not ₹5,600,880).
 */
'use strict';

const {
  MONITORING_COST,
  VALVE_CONTROL_OPTIONS,
  PUMP_CONTROL,
  ARCHITECTURES,
  OVERALL_OPTIONS,
  ADD_ONS,
} = require('./proposal');

/** Indian digit grouping: last three digits, then pairs. */
function formatINR(amount) {
  if (amount == null || !Number.isFinite(Number(amount))) return '—';
  const n = Math.round(Number(amount));
  const sign = n < 0 ? '-' : '';
  const s = String(Math.abs(n));
  if (s.length <= 3) return `${sign}₹${s}`;
  const last3 = s.slice(-3);
  const rest = s.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',');
  return `${sign}₹${rest},${last3}`;
}

const sum = (rows, key) => rows.reduce((acc, r) => acc + (Number(r[key]) || 0), 0);

/** Slide 16 upper table, recomputed. */
function monitoringCost() {
  const lines = MONITORING_COST.lines.map((l) => ({ ...l, lineTotal: l.device + l.cabling + l.install }));
  const computed = {
    device: sum(lines, 'device'),
    cabling: sum(lines, 'cabling'),
    install: sum(lines, 'install'),
  };
  computed.total = computed.device + computed.cabling + computed.install;
  return {
    ...MONITORING_COST,
    lines,
    computedTotals: computed,
    variance: {
      device: computed.device - MONITORING_COST.quotedTotals.device,
      cabling: computed.cabling - MONITORING_COST.quotedTotals.cabling,
      install: computed.install - MONITORING_COST.quotedTotals.install,
      total: computed.total - MONITORING_COST.quotedTotals.total,
    },
  };
}

/** Slide 16 lower table, recomputed — one entry per valve actuation option. */
function valveControlOptions() {
  return VALVE_CONTROL_OPTIONS.map((opt) => {
    const base = opt.device + opt.cabling + opt.install;
    const extras = opt.extras.reduce((acc, e) => acc + e.device + e.cabling + e.install, 0);
    const computedTotal = base + extras;
    return {
      ...opt,
      baseTotal: base,
      extrasTotal: extras,
      computedTotal,
      variance: computedTotal - opt.quotedTotal,
    };
  });
}

/** Pump control hardware, recomputed. */
function pumpControl() {
  const computedTotal = PUMP_CONTROL.device + PUMP_CONTROL.cabling + PUMP_CONTROL.install;
  return { ...PUMP_CONTROL, computedTotal, variance: computedTotal - PUMP_CONTROL.quotedTotal };
}

/** Mandatory (non-optional) automation cost of one architecture, by variant. */
function architectureCost(archId, { variant = null, includeOptional = false } = {}) {
  const arch = ARCHITECTURES.find((a) => a.id === archId);
  if (!arch) return { total: 0, items: [] };
  const items = arch.items.filter((i) => {
    if (!includeOptional && i.optional) return false;
    if (i.variant && variant && i.variant !== variant) return false;
    if (i.variant && !variant) return false;
    return true;
  });
  return { architecture: arch, items, total: sum(items, 'cost') };
}

/**
 * The scenario grid: every combination of automation architecture and valve
 * actuation strategy, priced from first principles.
 *
 * The proposal's slide-20 table is a 2×3 subset of this grid. The pneumatic
 * column, priced on slide 16, is the one it omits.
 */
function scenarioGrid() {
  const monitoring = monitoringCost().computedTotals.total;
  const valves = valveControlOptions();
  const pumps = pumpControl().computedTotal;

  const controlArchitectures = [
    { id: 'option1', label: 'Option 1 — Siemens SCADA & Controller', archId: 'arch1', variant: null },
    { id: 'option2', label: 'Option 2 — IOT nodes & ICMES software', archId: 'arch2', variant: null },
  ];

  const rows = [];

  for (const ctrl of controlArchitectures) {
    const auto = architectureCost(ctrl.archId, { variant: ctrl.variant });
    for (const valve of valves) {
      const total = monitoring + valve.computedTotal + pumps + auto.total;
      const quoted = OVERALL_OPTIONS.find((o) => o.id === ctrl.id)?.quoted?.[valve.id] ?? null;
      rows.push({
        optionId: ctrl.id,
        optionLabel: ctrl.label,
        valveOptionId: valve.id,
        valveOptionLabel: valve.label,
        scope: 'monitoring_and_control',
        breakdown: [
          { label: 'Input monitoring devices', amount: monitoring },
          { label: `Valve control — ${valve.label}`, amount: valve.computedTotal },
          { label: 'Pump control — contactors & relays', amount: pumps },
          ...auto.items.map((i) => ({ label: i.label, amount: i.cost })),
        ],
        computedTotal: total,
        quotedTotal: quoted,
        variance: quoted == null ? null : total - quoted,
        quotedInProposal: quoted != null,
      });
    }
  }

  // Monitoring-only uses architecture 3, which prices a Siemens and an ICMES variant.
  const monitoringOnly = [
    { id: 'option1', label: 'Option 1 — Siemens SCADA & Controller', variant: 'siemens' },
    { id: 'option2', label: 'Option 2 — IOT nodes & ICMES software', variant: 'icmes' },
  ];
  for (const ctrl of monitoringOnly) {
    const auto = architectureCost('arch3', { variant: ctrl.variant });
    const total = monitoring + auto.total;
    const quoted = OVERALL_OPTIONS.find((o) => o.id === ctrl.id)?.quoted?.monitoring_only ?? null;
    rows.push({
      optionId: ctrl.id,
      optionLabel: ctrl.label,
      valveOptionId: 'monitoring_only',
      valveOptionLabel: 'Monitoring only — no valve actuation',
      scope: 'monitoring_only',
      breakdown: [
        { label: 'Input monitoring devices', amount: monitoring },
        ...auto.items.map((i) => ({ label: i.label, amount: i.cost })),
      ],
      computedTotal: total,
      quotedTotal: quoted,
      variance: quoted == null ? null : total - quoted,
      quotedInProposal: quoted != null,
    });
  }

  return rows;
}

/**
 * Where the proposal's own totals do not follow from its own line items.
 * Returns one finding per unexplained figure, never a silent correction.
 */
function costFindings() {
  const findings = [];

  const mon = monitoringCost();
  for (const key of ['device', 'cabling', 'install', 'total']) {
    if (mon.variance[key] !== 0) {
      findings.push({
        id: `cost.monitoring.${key}`,
        severity: 'high',
        area: 'Commercial',
        title: `Input monitoring ${key} total does not equal the sum of its lines`,
        derived: formatINR(mon.computedTotals[key]),
        stated: formatINR(MONITORING_COST.quotedTotals[key]),
        source: 'Slide 16',
        impact: `Difference of ${formatINR(Math.abs(mon.variance[key]))}.`,
      });
    }
  }

  for (const opt of valveControlOptions()) {
    if (opt.variance !== 0) {
      findings.push({
        id: `cost.valve.${opt.id}`,
        severity: 'high',
        area: 'Commercial',
        title: `Valve control option ${opt.option} total does not equal device + cabling + installation`,
        derived: formatINR(opt.computedTotal),
        stated: formatINR(opt.quotedTotal),
        source: 'Slide 16',
        impact: `Difference of ${formatINR(Math.abs(opt.variance))}.`,
      });
    }
  }

  for (const row of scenarioGrid()) {
    if (row.variance != null && row.variance !== 0) {
      findings.push({
        id: `cost.scenario.${row.optionId}.${row.valveOptionId}`,
        severity: 'high',
        area: 'Commercial',
        title: `${row.optionLabel} · ${row.valveOptionLabel} — quoted total does not equal the sum of its parts`,
        derived: formatINR(row.computedTotal),
        stated: formatINR(row.quotedTotal),
        source: 'Slide 20 against slides 16–19',
        impact: row.variance < 0
          ? `The quote is ${formatINR(-row.variance)} above the priced line items; the excess is unattributed.`
          : `The quote is ${formatINR(row.variance)} below the priced line items.`,
      });
    }
  }

  const unquoted = scenarioGrid().filter((r) => !r.quotedInProposal);
  if (unquoted.length) {
    findings.push({
      id: 'cost.scenario.unquoted',
      severity: 'medium',
      area: 'Commercial',
      title: `${unquoted.length} priced combination(s) never reach the overall option table`,
      derived: unquoted.map((r) => `${r.optionLabel.split('—')[0].trim()} · ${r.valveOptionLabel} = ${formatINR(r.computedTotal)}`).join(' · '),
      stated: 'Absent from slide 20',
      source: 'Slide 16 option 3 against slide 20',
      impact: 'The pneumatic actuator option is costed in full on slide 16 but cannot be compared on the decision table.',
    });
  }

  return findings;
}

/** Optional line items priced once, plus the ICMES add-on for option 1. */
function addOns() {
  return ADD_ONS.map((a) => ({ ...a, formatted: formatINR(a.cost) }));
}

/** Every architecture with its mandatory and optional cost split out. */
function architectures() {
  return ARCHITECTURES.map((arch) => {
    const mandatory = arch.items.filter((i) => !i.optional);
    const optional = arch.items.filter((i) => i.optional);
    return {
      ...arch,
      mandatoryTotal: sum(mandatory, 'cost'),
      optionalTotal: sum(optional, 'cost'),
      total: sum(arch.items, 'cost'),
    };
  });
}

module.exports = {
  formatINR,
  monitoringCost,
  valveControlOptions,
  pumpControl,
  architectureCost,
  architectures,
  scenarioGrid,
  costFindings,
  addOns,
};
