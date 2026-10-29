import { describe, it, expect } from 'vitest';
import { layoutPidUnits, CELL_W, CELL_H } from '../utils/pidLayout';

const CARD_W = 168;
const CARD_H = 116;
const overlaps = (a, b) => Math.abs(a.x - b.x) < CARD_W && Math.abs(a.y - b.y) < CARD_H;
const noOverlap = (pos) => {
  const list = Object.values(pos);
  for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
    if (overlaps(list[i], list[j])) return false;
  }
  return true;
};
const chain = (n) => Array.from({ length: n - 1 }, (_, i) => ({ from: `u${i + 1}`, to: `u${i + 2}` }));

describe('layoutPidUnits', () => {
  it('keeps a well spread drawing as drawn', () => {
    const units = [{ id: 'u1', x: 0.1, y: 0.5 }, { id: 'u2', x: 0.5, y: 0.5 }, { id: 'u3', x: 0.9, y: 0.5 }];
    const pos = layoutPidUnits(units, chain(3), { w: 1200, h: 800, ox: 10, oy: 20 });
    expect(pos.u1).toEqual({ x: 10 + 120 - 84, y: 20 + 400 - 58 });
    expect(noOverlap(pos)).toBe(true);
  });

  it('stretches a small picture until the cards clear each other', () => {
    const units = [{ id: 'u1', x: 0.2, y: 0.5 }, { id: 'u2', x: 0.5, y: 0.5 }, { id: 'u3', x: 0.8, y: 0.5 }];
    const pos = layoutPidUnits(units, chain(3), { w: 300, h: 200 });
    expect(noOverlap(pos)).toBe(true);
    expect(pos.u2.x - pos.u1.x).toBeGreaterThanOrEqual(CELL_W - 1);
    expect(pos.u1.x).toBeLessThan(pos.u2.x);   // order kept
  });

  it('falls back to flow order when units share a spot', () => {
    const units = [
      { id: 'u1', x: 0.5, y: 0.5 }, { id: 'u2', x: 0.5, y: 0.5 },
      { id: 'u3', x: 0.51, y: 0.5 }, { id: 'u4', x: 0.5, y: 0.52 },
    ];
    const pos = layoutPidUnits(units, chain(4), { w: 600, h: 400 });
    expect(noOverlap(pos)).toBe(true);
    expect(pos.u2.x - pos.u1.x).toBe(CELL_W);
    expect(pos.u4.x - pos.u3.x).toBe(CELL_W);
  });

  it('stacks branches in one column and survives a recycle loop', () => {
    const units = ['u1', 'u2', 'u3', 'u4'].map((id) => ({ id, x: 0.5, y: 0.5 }));
    const connections = [{ from: 'u1', to: 'u2' }, { from: 'u1', to: 'u3' }, { from: 'u2', to: 'u4' }, { from: 'u4', to: 'u2' }];
    const pos = layoutPidUnits(units, connections, { w: 600, h: 400 });
    expect(noOverlap(pos)).toBe(true);
    expect(pos.u2.x).toBe(pos.u3.x);
    expect(Math.abs(pos.u2.y - pos.u3.y)).toBe(CELL_H);
  });
});
