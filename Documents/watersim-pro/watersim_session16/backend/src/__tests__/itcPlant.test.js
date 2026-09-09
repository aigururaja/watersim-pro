/**
 * SafeKrit — ITC STP plant definition tests  (Session 18)
 *
 * The plant module is a transcription of a commercial proposal plus arithmetic
 * derived from it. Both halves need guarding, for different reasons:
 *
 *   TRANSCRIPTION — if a printed figure is edited by accident, every derived
 *     total and every discrepancy finding shifts underneath it. The tests below
 *     pin the proposal's OWN numbers (slide totals, quoted costs, device
 *     quantities) so a typo fails the build rather than becoming the new truth.
 *
 *   DERIVATION — the reconciliation is the product's whole claim: that it can
 *     tell a client where their proposal disagrees with itself. Each known
 *     discrepancy is asserted by id, so silently losing one is a test failure.
 *
 * Pure engine tests — no DB required.
 */

'use strict';

const plant = require('../plants/itcStp');
const { PROCESSES, SIGNAL_RULES } = require('../plants/itcStp/processes');
const io = require('../plants/itcStp/ioSchedule');
const costing = require('../plants/itcStp/costing');
const narrative = require('../plants/itcStp/narrative');
const { buildFlowsheet, buildNodeParams } = require('../plants/itcStp/flowsheet');
const { runSteadyState } = require('../simulation/solver');

// ── Transcription: the proposal's own figures ────────────────────────────────

describe('Proposal transcription', () => {
  it('has all eleven process areas, numbered 1–11', () => {
    expect(PROCESSES).toHaveLength(11);
    expect(PROCESSES.map((p) => p.no)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  });

  it('gives every device a tag, a quantity and a known kind', () => {
    for (const proc of PROCESSES) {
      for (const d of proc.devices) {
        expect(typeof d.tag).toBe('string');
        expect(d.tag.length).toBeGreaterThan(3);
        expect(d.qty).toBeGreaterThan(0);
        expect(SIGNAL_RULES[d.kind]).toBeDefined();
      }
    }
  });

  it('uses a unique tag for every device', () => {
    const tags = PROCESSES.flatMap((p) => p.devices.map((d) => d.tag));
    expect(new Set(tags).size).toBe(tags.length);
  });

  it("each process table's rows sum to the totals printed on that slide", () => {
    for (const proc of PROCESSES) {
      const rowSum = { DI: 0, DO: 0, AI: 0, AO: 0 };
      for (const d of proc.devices) {
        for (const t of ['DI', 'DO', 'AI', 'AO']) rowSum[t] += d.printed[t] || 0;
      }
      expect({ area: proc.area, ...rowSum }).toEqual({ area: proc.area, ...proc.printedTotals });
    }
  });

  it('totals 210 DI / 116 DO / 17 AI across the process tables (slides 4–14)', () => {
    const totals = io.plantTotals();
    expect(totals.printed).toEqual({ DI: 210, DO: 116, AI: 17, AO: 0 });
  });

  it('totals 212 DI / 116 DO / 18 AI on the Pump & Valve list (slide 15)', () => {
    expect(io.plantTotals().summary).toEqual({ DI: 212, DO: 116, AI: 18, AO: 0 });
  });
});

// ── Derivation: signals the listed devices actually need ─────────────────────

describe('Derived I/O schedule', () => {
  it('expands every device into one row per wired point', () => {
    const rows = io.buildTagList();
    const totals = io.plantTotals().derived;
    const counted = rows.reduce((acc, r) => ({ ...acc, [r.type]: (acc[r.type] || 0) + 1 }), {});
    expect(counted.DI).toBe(totals.DI);
    expect(counted.DO).toBe(totals.DO);
    expect(counted.AI).toBe(totals.AI);
  });

  it('gives every signal a unique tag', () => {
    const tags = io.buildTagList().map((r) => r.tag);
    expect(new Set(tags).size).toBe(tags.length);
  });

  it('assigns every signal to one of the four quoted PLC nodes', () => {
    const nodes = io.nodeLoading();
    expect(nodes).toHaveLength(4);
    const total = nodes.reduce((a, n) => a + n.DI + n.DO + n.AI, 0);
    const t = io.plantTotals().derived;
    expect(total).toBe(t.DI + t.DO + t.AI);
  });

  it('follows the signal rules: a valve is 2 DI + 1 DO, a decanter VFD 2 DI + 2 DO', () => {
    expect(io.derivedIo({ kind: 'butterfly_valve', qty: 5 })).toEqual({ DI: 10, DO: 5, AI: 0, AO: 0 });
    expect(io.derivedIo({ kind: 'decanter_vfd', qty: 2 })).toEqual({ DI: 4, DO: 4, AI: 0, AO: 0 });
    expect(io.derivedIo({ kind: 'level_tx', qty: 3 })).toEqual({ DI: 0, DO: 0, AI: 3, AO: 0 });
  });

  it('fits inside the quoted 4-node panel capacity, with headroom reported', () => {
    const rows = io.capacityHeadroom();
    const di = rows.find((r) => r.type === 'DI');
    expect(di.capacity).toBe(240);
    expect(di.spareAgainstDerived).toBeGreaterThanOrEqual(0);
    expect(di.utilisationPct).toBeGreaterThan(50);
  });
});

// ── The reconciliation: the discrepancies this product exists to surface ─────

describe('Proposal reconciliation', () => {
  const ids = () => plant.review().map((f) => f.id);

  it('flags the Sludge Process DI count, which is 8 on slide 7 and 10 on slide 15', () => {
    expect(ids()).toContain('io.summary.sludge.DI');
  });

  it('flags the Filter Feed AI count, which is 3 on slide 8 and 4 on slide 15', () => {
    expect(ids()).toContain('io.summary.filter_feed.AI');
  });

  it('flags all four costing quantities against the equipment list', () => {
    expect(ids()).toEqual(expect.arrayContaining(['qty.valves', 'qty.pumps', 'qty.tank_level', 'qty.flow_ph']));
    const valves = plant.review().find((f) => f.id === 'qty.valves');
    expect(valves.derived).toBe(73);
    expect(valves.stated).toBe(58);
  });

  it('flags the two monitoring-only totals that do not equal the sum of their parts', () => {
    expect(ids()).toEqual(expect.arrayContaining([
      'cost.scenario.option1.monitoring_only',
      'cost.scenario.option2.monitoring_only',
    ]));
  });

  it('flags that the pneumatic valve option is priced but never offered', () => {
    expect(ids()).toContain('cost.scenario.unquoted');
  });

  it('flags the SBR cycle against the design flow', () => {
    expect(ids()).toContain('narrative.sbr.capacity');
  });

  it('flags the chlorine loop that has no analyser to close on', () => {
    expect(ids()).toContain('instr.no_residual_chlorine');
  });

  it('gives every finding a severity, a source and an impact', () => {
    for (const f of plant.review()) {
      expect(['high', 'medium', 'low']).toContain(f.severity);
      for (const field of ['id', 'area', 'title', 'source', 'impact']) {
        expect(typeof f[field]).toBe('string');
        expect(f[field].length).toBeGreaterThan(0);
      }
    }
  });

  it('ranks high-severity findings first', () => {
    const order = plant.review().map((f) => f.severity);
    const firstMedium = order.indexOf('medium');
    if (firstMedium !== -1) expect(order.slice(firstMedium)).not.toContain('high');
  });
});

// ── Costing: the four totals that DO reconcile must keep reconciling ─────────

describe('Costing engine', () => {
  it('renders Indian digit grouping', () => {
    expect(costing.formatINR(5600880)).toBe('₹56,00,880');
    expect(costing.formatINR(1625000)).toBe('₹16,25,000');
    expect(costing.formatINR(240000)).toBe('₹2,40,000');
    expect(costing.formatINR(999)).toBe('₹999');
  });

  it('reproduces the four monitoring-and-control totals quoted on slide 20 exactly', () => {
    const grid = costing.scenarioGrid();
    const at = (opt, valve) => grid.find((r) => r.optionId === opt && r.valveOptionId === valve);
    expect(at('option1', 'new_electrical').computedTotal).toBe(5600880);
    expect(at('option1', 'retrofit_electrical').computedTotal).toBe(4230880);
    expect(at('option2', 'new_electrical').computedTotal).toBe(5270880);
    expect(at('option2', 'retrofit_electrical').computedTotal).toBe(3900880);
    for (const row of [
      at('option1', 'new_electrical'), at('option1', 'retrofit_electrical'),
      at('option2', 'new_electrical'), at('option2', 'retrofit_electrical'),
    ]) {
      expect(row.variance).toBe(0);
    }
  });

  it('prices the pneumatic option the proposal costed but never offered', () => {
    const grid = costing.scenarioGrid();
    const pneumatic = grid.filter((r) => r.valveOptionId === 'new_pneumatic');
    expect(pneumatic).toHaveLength(2);
    for (const row of pneumatic) {
      expect(row.quotedInProposal).toBe(false);
      expect(row.computedTotal).toBeGreaterThan(0);
    }
  });

  it('reproduces the monitoring device total of ₹16,25,000 from its four lines', () => {
    const mon = costing.monitoringCost();
    expect(mon.computedTotals.total).toBe(1625000);
    expect(mon.variance.total).toBe(0);
  });

  it("every scenario's breakdown sums to its own total", () => {
    for (const row of costing.scenarioGrid()) {
      const sum = row.breakdown.reduce((a, b) => a + b.amount, 0);
      expect(sum).toBe(row.computedTotal);
    }
  });
});

// ── Control narrative ────────────────────────────────────────────────────────

describe('Control narrative', () => {
  it('carries all ten sections with the proposal wording intact', () => {
    expect(narrative.SECTIONS).toHaveLength(10);
    for (const s of narrative.SECTIONS) {
      expect(s.steps.length).toBeGreaterThan(0);
      for (const step of s.steps) expect(step.text.length).toBeGreaterThan(10);
    }
  });

  it('names only devices that exist in the equipment list', () => {
    const known = new Set(PROCESSES.flatMap((p) => p.devices.map((d) => d.tag)));
    const unknown = narrative.SECTIONS
      .flatMap((s) => s.steps.flatMap((st) => st.devices || []))
      .filter((tag) => !known.has(tag));
    expect(unknown).toEqual([]);
  });

  it('computes the SBR cycle at 5.25 h and 4.57 cycles per day', () => {
    const a = narrative.cycleAnalysis();
    expect(a.sbr.cycleHours).toBe(5.25);
    expect(a.sbr.cyclesPerDay).toBeCloseTo(4.57, 2);
    expect(a.sbr.volumePerFill_m3).toBe(64.5);
  });

  it('finds the cycle short of the 675 KLD design flow, and says by how much', () => {
    const a = narrative.cycleAnalysis();
    expect(a.sbr.meetsDesignFlow).toBe(false);
    expect(a.sbr.throughput_m3_d).toBeCloseTo(589.7, 1);
    expect(a.sbr.shortfall_m3_d).toBeCloseTo(85.3, 1);
    expect(a.sbr.requiredFeedPump_m3_h).toBeGreaterThan(43);
  });

  it('computes the UF cycle at 21 min with about 92 % recovery', () => {
    const a = narrative.cycleAnalysis();
    expect(a.uf.cycleMinutes).toBe(21);
    expect(a.uf.recoveryPct).toBeGreaterThan(90);
    expect(a.uf.recoveryPct).toBeLessThan(95);
  });

  it('builds a timeline with monotonic start times', () => {
    const t = narrative.timeline('reactor');
    let last = -1;
    for (const step of t.steps) {
      expect(step.startHour).toBeGreaterThanOrEqual(last);
      last = step.startHour;
    }
  });
});

// ── The flowsheet solves ─────────────────────────────────────────────────────

describe('ITC flowsheet', () => {
  const solved = () => runSteadyState(buildFlowsheet(), { nodeParams: buildNodeParams() });

  it('references only nodes that exist, on every edge', () => {
    const { nodes, edges } = buildFlowsheet();
    const ids = new Set(nodes.map((n) => n.id));
    for (const e of edges) {
      expect(ids.has(e.source)).toBe(true);
      expect(ids.has(e.target)).toBe(true);
    }
  });

  it('tags every node with the process area it belongs to', () => {
    for (const n of buildFlowsheet().nodes) expect(typeof n.data.area).toBe('string');
  });

  it('only cites device tags that exist in the equipment list', () => {
    const known = new Set(PROCESSES.flatMap((p) => p.devices.map((d) => d.tag)));
    const unknown = buildFlowsheet().nodes
      .flatMap((n) => n.data.tags || [])
      .filter((t) => !known.has(t));
    expect(unknown).toEqual([]);
  });

  it('converges without degrading, despite six recycle streams', () => {
    const r = solved();
    expect(r.converged).toBe(true);
    expect(r.degraded).toBe(false);
  });

  it('reports the full 675 KLD influent, not just the first inlet', () => {
    const r = solved();
    expect(r.summary.inletCount).toBe(3);
    expect(r.summary.influent.Q).toBeCloseTo(675, 0);
  });

  it('grades the three product waters and excludes the solids and reject exports', () => {
    const r = solved();
    const byType = r.summary.boundaries.reduce((acc, b) => {
      acc[b.dischargeType] = (acc[b.dischargeType] || 0) + 1;
      return acc;
    }, {});
    expect(byType).toEqual({ water: 3, solids: 1, reject: 1 });
    expect(r.summary.gradedOutletCount).toBe(3);
    // The 180,000 mg/L cake must not reach the effluent quality figure.
    expect(r.summary.effluent.TSS).toBeLessThan(100);
  });

  it('names the outlet on every permit violation when there is more than one', () => {
    const r = solved();
    for (const v of r.summary.permit_violations) expect(typeof v.outlet).toBe('string');
  });

  it('warns that each reactor is short of cycle capacity', () => {
    const r = solved();
    const backlog = r.warnings.filter((w) => /no cycle slot/.test(w));
    expect(backlog).toHaveLength(2);
  });

  it('leaves no plain forward split without an explicit ratio', () => {
    const r = solved();
    expect(r.warnings.filter((w) => /No splitRatios provided/.test(w))).toEqual([]);
  });
});

// ── Boundary types on the outlet model ───────────────────────────────────────

describe('Outlet discharge types', () => {
  const outlet = require('../simulation/models/outlet');
  const { Stream } = require('../simulation/stream');
  const dirty = () => ({ influent: new Stream({ Q: 10, TSS: 180000, BOD: 90000 }) });

  it('defaults to a graded water discharge, so existing sheets are unchanged', () => {
    const r = outlet.solve(dirty(), {});
    expect(r.metrics.graded).toBe(true);
    expect(r.metrics.discharge_type).toBe('water');
    expect(r.metrics.compliant).toBe(false);
  });

  it('never grades a solids export against a water permit, and says why', () => {
    const r = outlet.solve(dirty(), { discharge_type: 'solids' });
    expect(r.metrics.graded).toBe(false);
    expect(r.metrics.compliant).toBeNull();
    expect(r.metrics.permit_violations).toEqual([]);
    expect(r.metrics.not_graded_because).toMatch(/hauled/);
  });

  it('treats an unknown discharge type as a graded water discharge', () => {
    const r = outlet.solve(dirty(), { discharge_type: 'nonsense' });
    expect(r.metrics.discharge_type).toBe('water');
    expect(r.metrics.graded).toBe(true);
  });
});
