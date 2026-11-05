import { describe, it, expect } from 'vitest';
import { pidEdgeRoles } from '../utils/pidPorts';

// The separator drawing that came back with four blocks and no lines, now
// with its vessel and lines: one feed, three outlets.
const units = [
  { id: 'u1', type: 'inlet', label: '3 Phase Inlet' },
  { id: 'u5', type: 'three_phase_separator', label: 'Separator' },
  { id: 'u2', type: 'outlet', label: 'Vapor Outlet' },
  { id: 'u3', type: 'outlet', label: 'Oil Outlet' },
  { id: 'u4', type: 'outlet', label: 'Water Outlet' },
];

describe('pidEdgeRoles', () => {
  it('names the separator outlet each line leaves by', () => {
    const connections = [
      { from: 'u1', to: 'u5' },
      { from: 'u5', to: 'u2' },
      { from: 'u5', to: 'u3' },
      { from: 'u5', to: 'u4' },
    ];
    expect(pidEdgeRoles(units, connections)).toEqual([null, 'gas', 'oil', 'water']);
  });

  it('follows a single-file run to the labelled block', () => {
    const withPump = [...units, { id: 'p1', type: 'pump', label: 'P-101' }];
    const connections = [
      { from: 'u5', to: 'p1' },
      { from: 'p1', to: 'u3' },
    ];
    expect(pidEdgeRoles(withPump, connections)).toEqual(['oil', null]);
  });

  it('reads oily water as water and leaves unknown lines plain', () => {
    const more = [...units,
      { id: 'w', type: 'outlet', label: 'Oily water to sump' },
      { id: 'x', type: 'outlet', label: 'To unit 200' }];
    expect(pidEdgeRoles(more, [{ from: 'u5', to: 'w' }, { from: 'u5', to: 'x' }])).toEqual(['water', null]);
  });

  it('never sets a role on lines from single-outlet blocks', () => {
    expect(pidEdgeRoles(units, [{ from: 'u1', to: 'u2' }])).toEqual([null]);
  });
});
