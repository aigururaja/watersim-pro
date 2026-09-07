/**
 * ITC STP — I/O schedule and four-way reconciliation.
 *
 * The proposal states its I/O count four times and the four do not agree:
 *
 *   derived  — one signal per physical point, from `SIGNAL_RULES` × device qty
 *   printed  — the DI/DO/AI/AO cells of each process table (slides 4–14)
 *   summary  — the same areas on the Pump & Valve list (slide 15)
 *   capacity — the panel sizing quoted in the architectures (slides 17–19)
 *
 * A panel order placed against the wrong one of those is wrong by tens of
 * points, so this module does not pick a winner. It expands every device into
 * its individual signals (`buildTagList`), totals them, and lists every place
 * the four columns diverge (`reconcile`) with the slide reference, so the
 * discrepancy is a review item rather than a surprise at commissioning.
 *
 * Everything here is a pure function of `processes.js` + `proposal.js`.
 */
'use strict';

const { PROCESSES, SIGNAL_RULES, KIND_LABELS, COST_FAMILY } = require('./processes');
const { ARCHITECTURES, PRICED_QUANTITIES } = require('./proposal');

const SIGNAL_TYPES = ['DI', 'DO', 'AI', 'AO'];

const zero = () => ({ DI: 0, DO: 0, AI: 0, AO: 0 });

const addInto = (target, source) => {
  for (const t of SIGNAL_TYPES) target[t] += (source && source[t]) || 0;
  return target;
};

/** Per-signal labels for a device kind — one entry per point that gets wired. */
const DI_POINTS = {
  butterfly_valve: ['Open limit switch', 'Close limit switch'],
  ball_valve: ['Open limit switch', 'Close limit switch'],
  bypass_valve: ['Open limit switch', 'Close limit switch'],
  air_valve: ['Open limit switch', 'Close limit switch'],
  pump: ['Run status', 'Trip status'],
  dosing_pump: ['Run status', 'Trip status'],
  agitator: ['Run status', 'Trip status'],
  air_blower: ['Run status', 'Trip status'],
  decanter_vfd: ['Run status', 'Trip status'],
  level_switch: ['High level'],
};

const DO_POINTS = {
  butterfly_valve: ['Open / close command'],
  ball_valve: ['Open / close command'],
  bypass_valve: ['Open / close command'],
  air_valve: ['Open / close command'],
  pump: ['Start / stop command'],
  dosing_pump: ['Start / stop command'],
  agitator: ['Start / stop command'],
  air_blower: ['Start / stop command'],
  decanter_vfd: ['Start / stop command', 'Forward / reverse command'],
};

const AI_POINTS = {
  level_tx: ['Level'],
  flow_meter: ['Flow'],
  ph_analyser: ['pH'],
};

/**
 * PLC node assignment, following the four nodes the architectures name.
 * MCC panel takes the feed/transfer areas, Reactor its own node, Motor side the
 * filtration train, VFD panel the decanters and the variable-speed drives.
 */
const NODE_OF_AREA = {
  ELP: 'Node 1 — MCC panel',
  RFP: 'Node 1 — MCC panel',
  SHT: 'Node 1 — MCC panel',
  R: 'Node 2 — Reactor',
  FFP: 'Node 3 — Motor side',
  ACF: 'Node 3 — Motor side',
  SFP: 'Node 3 — Motor side',
  UF: 'Node 3 — Motor side',
  HWTP: 'Node 4 — VFD panel',
  FWTP: 'Node 4 — VFD panel',
  SWTP: 'Node 4 — VFD panel',
};

/** The signal counts a device actually needs, from its kind and quantity. */
function derivedIo(device) {
  const rule = SIGNAL_RULES[device.kind];
  if (!rule) return zero();
  const qty = Number(device.qty) || 0;
  return { DI: rule.DI * qty, DO: rule.DO * qty, AI: rule.AI * qty, AO: rule.AO * qty };
}

/**
 * Every individual signal in the plant, one row per wired point.
 *
 * Tags are `<device tag>/<n>.<ISA function letters>` — e.g. two inlet valves
 * under `ELP-XV-101` become `ELP-XV-101/1.ZSO`, `ELP-XV-101/1.ZSC`,
 * `ELP-XV-101/1.XY`, then the same three for unit 2.
 *
 * ISA-5.1 THROUGHOUT. Device tags are `<area>-<code>-<loop>` where `code` is
 * either a single-letter EQUIPMENT class (P pump, B blower, M motor drive —
 * equipment numbering is outside ISA-5.1's scope, and a lone letter can never be
 * mistaken for a loop tag, which always has two or more) or an ISA-5.1 function
 * set (XV, LT, LSH, FT, AT). Signal suffixes are ISA-5.1 function letters:
 * ZSO/ZSC position switches, XY relay outputs, XS/XA status/trip, LT/FT/AT
 * transmitters. Two relays in one loop take the standard's suffix letters, A/B.
 * `isaTags.test.js` enforces every one of these against the letter tables.
 *
 * @returns {Array<object>} rows: { tag, signal, type, device, kind, area, process, node, description }
 */
function buildTagList() {
  const rows = [];

  const push = (proc, device, unit, type, point, abbrev) => {
    const unitTag = device.qty > 1 ? `${device.tag}/${unit}` : device.tag;
    rows.push({
      tag: `${unitTag}.${abbrev}`,
      deviceTag: device.tag,
      unit,
      type,
      signal: point,
      device: device.name,
      kind: device.kind,
      kindLabel: KIND_LABELS[device.kind] || device.kind,
      area: proc.area,
      processId: proc.id,
      processNo: proc.no,
      processName: proc.name,
      node: NODE_OF_AREA[proc.area] || 'Node 1 — MCC panel',
      costFamily: COST_FAMILY[device.kind] || null,
      description: `${proc.area} · ${device.name} — ${point}`,
    });
  };

  const abbrevOf = (kind, type, index) => {
    if (type === 'DI') {
      // Position switches carry the ISA-5.1 O / C modifiers (open / closed).
      // Run and trip status use X (unclassified) + S (switch) / A (alarm) — the
      // letters the standard itself assigns to motor status, since no measured
      // variable describes "running". Y (state) is the letter-purist alternative;
      // X is what every panel builder reads without a legend.
      if (DI_POINTS[kind] && DI_POINTS[kind][index] === 'Open limit switch') return 'ZSO';
      if (DI_POINTS[kind] && DI_POINTS[kind][index] === 'Close limit switch') return 'ZSC';
      if (kind === 'level_switch') return 'LSH';
      return index === 0 ? 'XS' : 'XA';
    }
    if (type === 'DO') {
      // A discrete output that drives a solenoid or a motor starter is a relay:
      // ISA-5.1 succeeding letter Y (relay / solenoid / converter). C would read
      // as a CONTROLLER and R as a RECORDER — both were used here once, and
      // both were wrong. A drive with two relays in one loop (start/stop and
      // forward/reverse) takes ISA-5.1 suffix letters, A and B, so neither
      // output is the unmarked one.
      if (kind === 'decanter_vfd') return index === 0 ? 'XY-A' : 'XY-B';
      return 'XY';
    }
    if (kind === 'level_tx') return 'LT';
    if (kind === 'flow_meter') return 'FT';
    if (kind === 'ph_analyser') return 'AT';
    return 'AI';
  };

  for (const proc of PROCESSES) {
    for (const device of proc.devices) {
      const qty = Number(device.qty) || 0;
      for (let unit = 1; unit <= qty; unit += 1) {
        (DI_POINTS[device.kind] || []).forEach((point, i) =>
          push(proc, device, unit, 'DI', point, abbrevOf(device.kind, 'DI', i)));
        (DO_POINTS[device.kind] || []).forEach((point, i) =>
          push(proc, device, unit, 'DO', point, abbrevOf(device.kind, 'DO', i)));
        (AI_POINTS[device.kind] || []).forEach((point, i) =>
          push(proc, device, unit, 'AI', point, abbrevOf(device.kind, 'AI', i)));
      }
    }
  }

  return rows;
}

/** Derived / printed / summary totals for one process area. */
function processTotals(proc) {
  const derived = zero();
  for (const device of proc.devices) addInto(derived, derivedIo(device));
  return {
    processNo: proc.no,
    processId: proc.id,
    processName: proc.name,
    area: proc.area,
    slide: proc.slide,
    derived,
    printed: { ...zero(), ...proc.printedTotals },
    summary: { ...zero(), ...proc.summaryTotals },
  };
}

/** Whole-plant totals in all four columns. */
function plantTotals() {
  const derived = zero();
  const printed = zero();
  const summary = zero();
  for (const proc of PROCESSES) {
    const t = processTotals(proc);
    addInto(derived, t.derived);
    addInto(printed, t.printed);
    addInto(summary, t.summary);
  }
  const capacity = ARCHITECTURES.find((a) => a.id === 'arch1').capacity;
  return { derived, printed, summary, capacity: { ...zero(), ...capacity } };
}

/** Device counts by costing family — derived from the equipment list. */
function deviceCounts() {
  const counts = {};
  const byKind = {};
  for (const proc of PROCESSES) {
    for (const device of proc.devices) {
      const family = COST_FAMILY[device.kind];
      const qty = Number(device.qty) || 0;
      byKind[device.kind] = (byKind[device.kind] || 0) + qty;
      if (family) counts[family] = (counts[family] || 0) + qty;
    }
  }
  return { byFamily: counts, byKind };
}

const FAMILY_LABEL = {
  valves: 'Valves',
  pumps: 'Pumps, blowers, agitators & decanters',
  tank_level: 'Tank level instruments',
  flow_ph: 'Flow meters & pH analyser',
};

/**
 * Every place the proposal disagrees with itself.
 *
 * Each finding carries what the app derived, what the proposal states, where
 * the statement is, and what it costs to get wrong — so it reads as a review
 * item for the client, not as a complaint about the document.
 *
 * @returns {Array<{id,severity,area,title,derived,stated,source,impact}>}
 */
function reconcile() {
  const findings = [];

  // ── 1. Per-process I/O: printed table vs slide-15 summary list ────────────
  for (const proc of PROCESSES) {
    const t = processTotals(proc);
    for (const type of SIGNAL_TYPES) {
      if (t.printed[type] !== t.summary[type]) {
        findings.push({
          id: `io.summary.${proc.id}.${type}`,
          severity: 'high',
          area: proc.area,
          title: `${proc.name} — ${type} count differs between the process table and the Pump & Valve list`,
          derived: t.derived[type],
          stated: `${t.printed[type]} on slide ${proc.slide}, ${t.summary[type]} on slide 15`,
          source: `Slides ${proc.slide} and 15`,
          impact: `${Math.abs(t.printed[type] - t.summary[type])} ${type} point(s) are either unpriced or double-counted for this area.`,
        });
      }
    }
    // ── 2. Per-process I/O: printed table vs the signals the devices need ───
    for (const type of SIGNAL_TYPES) {
      if (t.printed[type] !== t.derived[type]) {
        findings.push({
          id: `io.derived.${proc.id}.${type}`,
          severity: t.derived[type] > t.printed[type] ? 'high' : 'medium',
          area: proc.area,
          title: `${proc.name} — ${type} count does not match the listed devices`,
          derived: t.derived[type],
          stated: t.printed[type],
          source: `Slide ${proc.slide}`,
          impact: t.derived[type] > t.printed[type]
            ? `The listed devices need ${t.derived[type] - t.printed[type]} more ${type} point(s) than the table allows.`
            : `The table allows ${t.printed[type] - t.derived[type]} more ${type} point(s) than the listed devices need.`,
        });
      }
    }
  }

  // ── 3. Device quantities: equipment list vs the quantities priced ─────────
  const { byFamily } = deviceCounts();
  for (const family of Object.keys(PRICED_QUANTITIES)) {
    const derived = byFamily[family] || 0;
    const priced = PRICED_QUANTITIES[family];
    if (derived !== priced) {
      findings.push({
        id: `qty.${family}`,
        severity: derived > priced ? 'high' : 'medium',
        area: 'Commercial',
        title: `${FAMILY_LABEL[family]} — ${derived} on the equipment list, ${priced} priced`,
        derived,
        stated: priced,
        source: 'Slides 4–15 against slide 16',
        impact: derived > priced
          ? `${derived - priced} device(s) appear in the process tables but are not in the monitoring or control price.`
          : `${priced - derived} device(s) are priced but do not appear in the process tables.`,
      });
    }
  }

  // ── 4. Plant I/O against the panel capacity that was quoted ──────────────
  const totals = plantTotals();
  for (const type of SIGNAL_TYPES) {
    if (totals.capacity[type] === 0) continue;
    const spare = totals.capacity[type] - totals.derived[type];
    if (spare < 0) {
      findings.push({
        id: `capacity.${type}`,
        severity: 'high',
        area: 'Architecture',
        title: `${type} capacity is short of the wired points`,
        derived: totals.derived[type],
        stated: totals.capacity[type],
        source: 'Slides 17–19',
        impact: `${-spare} ${type} point(s) have nowhere to land in the quoted 4-node panel set.`,
      });
    }
  }

  return findings;
}

/** Spare capacity in the quoted panels, against each of the three counts. */
function capacityHeadroom() {
  const totals = plantTotals();
  const rows = [];
  for (const type of SIGNAL_TYPES) {
    const capacity = totals.capacity[type];
    if (!capacity && !totals.derived[type]) continue;
    rows.push({
      type,
      capacity,
      derived: totals.derived[type],
      printed: totals.printed[type],
      summary: totals.summary[type],
      spareAgainstDerived: capacity - totals.derived[type],
      spareAgainstSummary: capacity - totals.summary[type],
      utilisationPct: capacity ? +((totals.derived[type] / capacity) * 100).toFixed(1) : null,
    });
  }
  return rows;
}

/** Tag-list totals grouped by PLC node — what each panel has to carry. */
function nodeLoading() {
  const tags = buildTagList();
  const byNode = new Map();
  for (const row of tags) {
    if (!byNode.has(row.node)) byNode.set(row.node, { node: row.node, ...zero(), areas: new Set() });
    const entry = byNode.get(row.node);
    entry[row.type] += 1;
    entry.areas.add(row.area);
  }
  return [...byNode.values()]
    .map((e) => ({ ...e, areas: [...e.areas].sort() }))
    .sort((a, b) => a.node.localeCompare(b.node));
}

module.exports = {
  SIGNAL_TYPES,
  derivedIo,
  buildTagList,
  processTotals,
  plantTotals,
  deviceCounts,
  reconcile,
  capacityHeadroom,
  nodeLoading,
  NODE_OF_AREA,
};
