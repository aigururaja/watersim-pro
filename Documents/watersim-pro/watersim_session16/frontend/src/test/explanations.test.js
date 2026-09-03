/**
 * Explanation coverage.
 *
 * WaterSim Pro is meant to be self-explanatory: every unit a user can drop on
 * the canvas, and every parameter they can edit, must have an ⓘ with real
 * content behind it. These tests fail the build when a new palette entry or a
 * new PARAM_DEFS row is added without documentation.
 */
import { describe, it, expect, vi } from 'vitest';
import { OP_INFO, PARAM_INFO, METRIC_INFO, paramInfo } from '../content/explanations';
import { PALETTE } from '../components/canvas/UnitOpPalette';
import { PARAM_DEFS } from '../pages/CanvasPage';

// CanvasPage pulls in the API client at import time — stub it, we only want
// the PARAM_DEFS constant. (vi.mock is hoisted above the imports above.)
vi.mock('../services/api', () => {
  const mock = { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() };
  return { default: mock, api: mock };
});

const PALETTE_TYPES = PALETTE.flatMap(group => group.items.map(i => i.type));

describe('OP_INFO covers the palette', () => {
  it('lists every unit type a user can add to the canvas', () => {
    const missing = PALETTE_TYPES.filter(type => !OP_INFO[type]);
    expect(missing).toEqual([]);
  });

  it('documents every type PARAM_DEFS knows about', () => {
    const missing = Object.keys(PARAM_DEFS).filter(type => !OP_INFO[type]);
    expect(missing).toEqual([]);
  });

  it.each(Object.keys(OP_INFO))('%s has a complete, non-empty explanation', (type) => {
    const op = OP_INFO[type];
    for (const field of ['title', 'tagline', 'what', 'how', 'watchFor']) {
      expect(typeof op[field], `${type}.${field}`).toBe('string');
      expect(op[field].trim().length, `${type}.${field}`).toBeGreaterThan(0);
    }
    // `what` / `how` / `watchFor` are prose, not one-word placeholders.
    expect(op.what.length, `${type}.what`).toBeGreaterThan(80);
    expect(op.how.length, `${type}.how`).toBeGreaterThan(80);
    expect(op.watchFor.length, `${type}.watchFor`).toBeGreaterThan(40);
  });
});

describe('PARAM_INFO covers every editable parameter', () => {
  const rows = Object.entries(PARAM_DEFS).flatMap(([opType, defs]) =>
    defs.map(def => ({ opType, key: def.key, label: def.label }))
  );

  it('has at least one parameter to check', () => {
    expect(rows.length).toBeGreaterThan(50);
  });

  it('resolves every PARAM_DEFS key through paramInfo()', () => {
    const missing = rows
      .filter(r => !paramInfo(r.opType, r.key))
      .map(r => `${r.opType}.${r.key}`);
    expect(missing).toEqual([]);
  });

  it('gives every resolved entry meaning, unit, typical and effect', () => {
    const incomplete = [];
    for (const r of rows) {
      const info = paramInfo(r.opType, r.key);
      for (const field of ['meaning', 'unit', 'typical', 'effect']) {
        if (typeof info[field] !== 'string' || !info[field].trim()) {
          incomplete.push(`${r.opType}.${r.key}.${field}`);
        }
      }
    }
    expect(incomplete).toEqual([]);
  });

  it('prefers an opType-specific entry over the bare-key fallback', () => {
    // Both clarifiers expose SOR_m3_m2_d but it behaves differently in each.
    const primary   = paramInfo('primary_clarifier', 'SOR_m3_m2_d');
    const secondary = paramInfo('secondary_clarifier', 'SOR_m3_m2_d');
    expect(primary).toBe(PARAM_INFO['primary_clarifier.SOR_m3_m2_d']);
    expect(secondary).toBe(PARAM_INFO['secondary_clarifier.SOR_m3_m2_d']);
    expect(primary).not.toBe(secondary);
    // An op type with no specific entry falls back to the bare key.
    expect(paramInfo('activated_sludge', 'SRT_d')).toBe(PARAM_INFO.SRT_d);
    // Unknown keys resolve to null so the row renders without an ⓘ.
    expect(paramInfo('activated_sludge', 'not_a_real_param')).toBeNull();
    expect(paramInfo('activated_sludge', undefined)).toBeNull();
  });
});

describe('METRIC_INFO', () => {
  it('covers the metrics the models actually return', () => {
    const expected = [
      'TSS_removal_pct', 'screenings_kg_d', 'grit_removed_kg_d', 'chamber_volume_m3',
      'headloss_m', 'area_m2', 'volume_m3', 'HRT_h', 'HRT_min', 'SOR_m3_m2_d',
      'SLR_kg_m2_d', 'sludge_Q_m3_d', 'sludge_TSS_mg_L', 'SRT_d', 'MLSS_mg_L',
      'O2_demand_kg_d', 'biomass_kg_d', 'WAS_m3_d', 'nitrification', 'denitrification',
      'BOD_effluent', 'NH4_effluent', 'NO3_effluent', 'TP_effluent', 'RAS_Q_m3_d',
      'RAS_TSS_mg_L', 'eff_TSS_mg_L', 'status', 'speed_pct', 'opening_pct',
      'Q_in_m3_d', 'Q_delivered_m3_d', 'Q_out_m3_d', 'blocked_Q_m3_d', 'power_kW',
      'energy_kWh_d', 'compliant', 'permit_violations', 'Q_in', 'Q_out',
    ];
    const missing = expected.filter(k => !METRIC_INFO[k]);
    expect(missing).toEqual([]);
  });

  it('explains each metric in one non-empty sentence', () => {
    for (const [key, sentence] of Object.entries(METRIC_INFO)) {
      expect(typeof sentence, key).toBe('string');
      expect(sentence.trim().length, key).toBeGreaterThan(20);
    }
  });
});
