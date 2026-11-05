import { describe, it, expect } from 'vitest';
import { splitPidParams } from '../utils/pidParams';

describe('splitPidParams', () => {
  it('splits by the block settings', () => {
    expect(splitPidParams({ Q: 1850, design_pressure_barg: 7 }, new Set(['Q'])))
      .toEqual({ kept: [['Q', 1850]], unused: [['design_pressure_barg', 7]] });
  });
  it('keeps everything when the settings are not known, and copes with no params', () => {
    expect(splitPidParams({ a: 1 }, null)).toEqual({ kept: [['a', 1]], unused: [] });
    expect(splitPidParams(undefined, new Set())).toEqual({ kept: [], unused: [] });
  });
});
