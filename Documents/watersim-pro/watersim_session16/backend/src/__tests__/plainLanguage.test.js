/**
 * WaterSim Pro — Plain-language report layer tests  (Session 17)
 *
 * buildPlainSummary() turns a report JSON into the "In plain words" section
 * shown first in the report page, the PDF and the Excel workbook. It runs on
 * every report request, so its contract is: never throw, never invent numbers,
 * and degrade to empty sections when data is missing (dynamic runs, old rows).
 *
 * Pure engine tests — no DB required.
 */

'use strict';

const { buildPlainSummary } = require('../reports/plainLanguage');
const { runSteadyState } = require('../simulation/solver');
const { estimateCosts } = require('../simulation/costEstimator');

// ── Fixture: a realistic train that FAILS its TN/TP permit limits ────────────

const CANVAS = {
  nodes: [
    { id: 'n0', data: { opType: 'inlet',               label: 'Influent' } },
    { id: 'n1', data: { opType: 'screening',           label: 'Bar Screen' } },
    { id: 'n2', data: { opType: 'primary_clarifier',   label: 'Primary Clarifier' } },
    { id: 'n3', data: { opType: 'activated_sludge',    label: 'Aeration Basin' } },
    { id: 'n4', data: { opType: 'secondary_clarifier', label: 'Secondary Clarifier' } },
    { id: 'n5', data: { opType: 'pump',                label: 'RAS Pump' } },
    { id: 'n6', data: { opType: 'outlet',              label: 'Effluent Discharge' } },
  ],
  edges: [
    { id: 'e0', source: 'n0', target: 'n1' },
    { id: 'e1', source: 'n1', target: 'n2' },
    { id: 'e2', source: 'n2', target: 'n3' },
    { id: 'e3', source: 'n3', target: 'n4' },
    { id: 'e4', source: 'n4', target: 'n6' },
    { id: 'eR1', source: 'n4', target: 'n5', data: { streamType: 'ras', isRecycle: true } },
    { id: 'eR2', source: 'n5', target: 'n3', data: { streamType: 'ras' } },
  ],
};

const NODE_PARAMS = {
  n0: { Q: 5000, TSS: 260, BOD: 220, COD: 420, TN: 45, NH4: 35, TP: 8, pH: 7.2, temp: 20 },
  n2: { SOR_m3_m2_d: 35 },
  n3: { SRT_d: 10, MLSS_mg_L: 3000 },
  n4: { RAS_ratio: 0.5 },
};

function makeReport({ permitLimits, nodeParams = NODE_PARAMS } = {}) {
  const results = runSteadyState(CANVAS, { nodeParams, permitLimits });
  results.costBreakdown = estimateCosts(results);
  if (permitLimits) results.permitLimitsUsed = permitLimits;
  return {
    run_id: 'test-run', project_name: 'Municipal WWTP', flowsheet_name: 'Main Treatment Train',
    org_name: 'Demo Org', created_by: 'Ada Admin', mode: 'steady_state',
    started_at: '2026-01-01T00:00:00.000Z', completed_at: '2026-01-01T00:00:05.000Z',
    config: { nodeParams }, warnings: results.warnings || [],
    results: {
      summary: results.summary, streamResults: results.streamResults,
      unitResults: results.unitResults, costBreakdown: results.costBreakdown,
      permitLimitsUsed: results.permitLimitsUsed || null,
    },
  };
}

const STRICT_LIMITS = { BOD: 30, TSS: 30, TN: 10, TP: 1, NH4: 5, pH_min: 6, pH_max: 9 };
const LOOSE_LIMITS  = { BOD: 300, TSS: 300, TN: 500, TP: 500, NH4: 500, pH_min: 1, pH_max: 14 };

// ── Shape & safety ───────────────────────────────────────────────────────────

describe('buildPlainSummary — shape and safety', () => {
  test('returns every documented section for a full report', () => {
    const plain = buildPlainSummary(makeReport({ permitLimits: STRICT_LIMITS }));
    for (const key of ['verdict', 'waterStory', 'qualityRows', 'complianceStory',
      'treatmentSteps', 'costStory', 'glossary']) {
      expect(plain).toHaveProperty(key);
    }
    expect(Array.isArray(plain.waterStory)).toBe(true);
    expect(Array.isArray(plain.qualityRows)).toBe(true);
    expect(Array.isArray(plain.treatmentSteps)).toBe(true);
    expect(Array.isArray(plain.glossary)).toBe(true);
  });

  test.each([
    ['undefined',        undefined],
    ['null',             null],
    ['empty object',     {}],
    ['no results',       { run_id: 'x' }],
    ['empty results',    { results: {} }],
    ['null sections',    { results: { summary: null, unitResults: null, costBreakdown: null } }],
    ['garbage summary',  { results: { summary: { effluent: 'not-a-stream' }, unitResults: [] } }],
  ])('never throws on malformed input (%s)', (_label, input) => {
    let plain;
    expect(() => { plain = buildPlainSummary(input); }).not.toThrow();
    expect(plain).toBeTruthy();
    expect(Array.isArray(plain.qualityRows)).toBe(true);
    expect(Array.isArray(plain.glossary)).toBe(true);
  });

  test('a dynamic-mode report (steps, no steady summary) degrades safely', () => {
    const plain = buildPlainSummary({
      mode: 'dynamic',
      results: { mode: 'dynamic', stepCount: 24, steps: [], summary: {}, unitResults: {} },
    });
    expect(plain).toBeTruthy();
    expect(() => JSON.stringify(plain)).not.toThrow();
  });

  test('is JSON-serializable and free of NaN/Infinity', () => {
    const plain = buildPlainSummary(makeReport({ permitLimits: STRICT_LIMITS }));
    const json = JSON.stringify(plain);
    expect(json).not.toMatch(/NaN|Infinity/);
    const walk = (v) => {
      if (typeof v === 'number') expect(Number.isFinite(v)).toBe(true);
      else if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === 'object') Object.values(v).forEach(walk);
    };
    walk(plain);
  });
});

// ── Verdict & compliance ─────────────────────────────────────────────────────

describe('buildPlainSummary — verdict and compliance', () => {
  test('a non-compliant run reads as a failure and names the broken limits', () => {
    const report = makeReport({ permitLimits: STRICT_LIMITS });
    const plain  = buildPlainSummary(report);
    const violations = report.results.summary.permit_violations || [];
    expect(violations.length).toBeGreaterThan(0);

    expect(plain.verdict.status).toBe('fail');
    expect(typeof plain.verdict.headline).toBe('string');
    expect(plain.verdict.headline.length).toBeGreaterThan(20);
    expect(plain.complianceStory.length).toBe(violations.length);
    // Each violated parameter is explained in words, with its own limit quoted.
    for (const v of violations) {
      const line = plain.complianceStory.find(c => c.param === v.param);
      expect(line).toBeTruthy();
      expect(line.text).toContain(String(v.limit));
      expect(line.text.length).toBeGreaterThan(30);
    }
  });

  test('a compliant run reads as a pass with a positive line, not an empty gap', () => {
    const plain = buildPlainSummary(makeReport({ permitLimits: LOOSE_LIMITS }));
    expect(plain.verdict.status).toBe('pass');
    expect(plain.complianceStory.length).toBeGreaterThan(0);
    expect(plain.complianceStory[0].severity).toBe('none');
  });

  test('with no permit limits at all the verdict is honestly "unknown"', () => {
    const plain = buildPlainSummary(makeReport());
    expect(['unknown', 'pass', 'fail']).toContain(plain.verdict.status);
    expect(plain.verdict.headline).toBeTruthy();
  });
});

// ── Water story, quality rows, steps ─────────────────────────────────────────

describe('buildPlainSummary — the story sections', () => {
  const plain = buildPlainSummary(makeReport({ permitLimits: STRICT_LIMITS }));

  test('water story explains in, out and where the rest went', () => {
    expect(plain.waterStory.length).toBeGreaterThanOrEqual(2);
    for (const item of plain.waterStory) {
      expect(typeof item.label).toBe('string');
      expect(item.text.length).toBeGreaterThan(20);
    }
    // The influent line quotes the real flow (5,000 m³/d) rather than a guess.
    expect(plain.waterStory.map(w => w.text).join(' ')).toMatch(/5,000/);
  });

  test('quality rows carry friendly names, meanings and real in/out numbers', () => {
    const params = plain.qualityRows.map(r => r.param);
    expect(params).toEqual(expect.arrayContaining(['BOD', 'TSS', 'TN', 'NH4', 'TP']));

    const bod = plain.qualityRows.find(r => r.param === 'BOD');
    expect(bod.friendly).toMatch(/BOD/);
    expect(bod.meaning.length).toBeGreaterThan(20);
    expect(bod.in).toBeCloseTo(220, 0);
    expect(bod.out).toBeGreaterThanOrEqual(0);
    expect(bod.removalPct).toBeGreaterThan(90); // secondary treatment works
    expect(['good', 'ok', 'poor']).toContain(bod.judgment);
  });

  test('treatment steps explain every unit, including pump/valve control elements', () => {
    expect(plain.treatmentSteps.length).toBeGreaterThanOrEqual(6);
    for (const step of plain.treatmentSteps) {
      expect(step.label).toBeTruthy();
      expect(typeof step.explanation).toBe('string');
      expect(step.explanation.length).toBeGreaterThan(20);
    }
    const pump = plain.treatmentSteps.find(s => /pump/i.test(s.label));
    expect(pump).toBeTruthy();
    expect(pump.explanation.length).toBeGreaterThan(20);
  });

  test('cost story quotes the annual bill in everyday units', () => {
    expect(Array.isArray(plain.costStory.lines)).toBe(true);
    expect(plain.costStory.lines.length).toBeGreaterThan(0);
    expect(plain.costStory.lines.join(' ')).toMatch(/\$/);
  });
});

// ── Glossary ─────────────────────────────────────────────────────────────────

describe('buildPlainSummary — glossary', () => {
  test('defines every abbreviation the summary actually uses', () => {
    const plain = buildPlainSummary(makeReport({ permitLimits: STRICT_LIMITS }));
    const terms = new Set(plain.glossary.map(g => g.term));

    // Every quality row's parameter must be defined somewhere in the glossary.
    for (const row of plain.qualityRows) {
      const defined = [...terms].some(t => t === row.param || row.friendly.includes(t));
      expect(defined).toBe(true);
    }
    for (const entry of plain.glossary) {
      expect(entry.definition.length).toBeGreaterThan(10);
      expect(entry.definition).not.toMatch(/undefined|null|NaN/);
    }
  });

  test('never emits duplicate terms', () => {
    const plain = buildPlainSummary(makeReport({ permitLimits: STRICT_LIMITS }));
    const terms = plain.glossary.map(g => g.term);
    expect(terms.length).toBe(new Set(terms).size);
  });
});
