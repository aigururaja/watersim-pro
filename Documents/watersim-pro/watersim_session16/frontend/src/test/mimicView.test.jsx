/**
 * MimicView — the schematic drawn from the flowsheet, driven by measured states.
 *
 * What is pinned: pipes exist for every edge; a running pump spins and the
 * line after it flows; a closed valve stops the flow downstream and an open
 * one lets it through; a tank shows only a MEASURED level; an inlet always
 * supplies; clicking a machine selects it; the flow logic is pure.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import MimicView from '../components/mimic/MimicView';
import { propagateFlow, routePipe, familyOf, streamStyle } from '../components/mimic/mimicLayout';

const N = (id, opType, x, y, extra = {}) => ({ id, type: 'unitOp', position: { x, y }, data: { opType, label: `${id} label`, tags: [id.toUpperCase()], ...extra } });
const NODES = [
  N('in', 'inlet', 0, 0), N('p1', 'pump', 250, 0), N('v1', 'valve', 500, 0), N('t1', 'equalisation_tank', 750, 120), N('ft', 'instrument', 1000, 120), N('out', 'outlet', 1250, 120),
];
const EDGES = [
  { id: 'e1', source: 'in', target: 'p1', data: { streamType: 'stream' } },
  { id: 'e2', source: 'p1', target: 'v1', data: { streamType: 'stream' } },
  { id: 'e3', source: 'v1', target: 't1', data: { streamType: 'stream' } },
  { id: 'e4', source: 't1', target: 'ft', data: { streamType: 'stream' } },
  { id: 'e5', source: 'ft', target: 'out', data: { streamType: 'filtrate' } },
];
const states = (o) => new Map(Object.entries(o).map(([k, v]) => [k, { readings: {}, ...v }]));

describe('flow logic', () => {
  it('a running pump pushes, a closed valve blocks, a tank with a measured level feeds on', () => {
    let r = propagateFlow(NODES, EDGES, states({ p1: { running: true }, v1: { opened: true } }));
    expect([...r.flowing].sort()).toEqual(['e1', 'e2', 'e3', 'e4', 'e5']);
    r = propagateFlow(NODES, EDGES, states({ p1: { running: true }, v1: { opened: false } }));
    expect([...r.flowing].sort()).toEqual(['e1', 'e2']);
    r = propagateFlow(NODES, EDGES, states({ p1: { running: false }, v1: { opened: true } }));
    expect([...r.flowing].sort()).toEqual(['e1']);
    // Nothing arrives, but the tank is 60 % full: its outlet still runs.
    r = propagateFlow(NODES, EDGES, states({ p1: { running: false }, t1: { level: 60 } }));
    expect([...r.flowing].sort()).toEqual(['e1', 'e4', 'e5']);
    expect(r.active.has('out')).toBe(true);
  });

  it('routes pipes orthogonally with corners for flanges, and names stream colours', () => {
    const straight = routePipe({ x: 0, y: 10 }, { x: 100, y: 10 });
    expect(straight.corners).toHaveLength(0);
    expect(straight.length).toBe(100);
    const stepped = routePipe({ x: 0, y: 0 }, { x: 200, y: 100 });
    expect(stepped.corners).toHaveLength(2);
    expect(stepped.d).toMatch(/^M 0 0/);
    const back = routePipe({ x: 300, y: 0 }, { x: 0, y: 0 });
    expect(back.corners.length).toBe(4);
    expect(familyOf('sbr_reactor')).toBe('tank');
    expect(familyOf('nonsense')).toBe('basin');
    expect(streamStyle('was').kind).toBe('sludge');
    expect(streamStyle('filtrate').kind).toBe('water');
  });
});

describe('MimicView', () => {
  it('draws every pipe and machine, spins the running pump, and shows a measured level', () => {
    const { container } = render(
      <MimicView nodes={NODES} edges={EDGES} states={states({ p1: { running: true }, v1: { opened: true }, t1: { level: 61.2 }, ft: { readings: { FT: { value: 612, quality: 'good', rangeMin: 0, rangeMax: 800 } } } })} />,
    );
    expect(container.querySelectorAll('[data-edge]')).toHaveLength(5);
    expect(container.querySelectorAll('[data-node]')).toHaveLength(6);
    const pump = container.querySelector('[data-node="p1"] [data-running]');
    expect(pump).toHaveAttribute('data-running', 'true');
    expect(container.querySelector('[data-node="p1"] .mimic-spin')).toBeTruthy();
    expect(container.querySelector('[data-node="v1"] [data-open]')).toHaveAttribute('data-open', 'true');
    expect(container.querySelector('[data-node="t1"] [data-level]')).toHaveAttribute('data-level', '61');
    expect(container.querySelector('[data-edge="e2"]')).toHaveAttribute('data-flowing', 'true');
    expect(container.querySelector('[data-edge="e2"] .mimic-flow')).toBeTruthy();
    // The flow meter after the tank governs the speed of the line it sits on.
    expect(container.querySelector('[data-edge="e4"]').style.getPropertyValue('--mimic-flow-speed')).toBe('1.07s');
    expect(screen.getByText(/5 of 5 lines flowing/)).toBeInTheDocument();
  });

  it('parks a stopped pump, stops the line after a shut valve, and hides an unmeasured level', () => {
    const { container } = render(
      <MimicView nodes={NODES} edges={EDGES} states={states({ p1: { running: false }, v1: { opened: false } })} />,
    );
    expect(container.querySelector('[data-node="p1"] [data-running]')).toHaveAttribute('data-running', 'false');
    expect(container.querySelector('[data-node="p1"] .mimic-spin')).toBeNull();
    expect(container.querySelector('[data-node="v1"] [data-open]')).toHaveAttribute('data-open', 'false');
    expect(container.querySelector('[data-edge="e3"]')).toHaveAttribute('data-flowing', 'false');
    expect(container.querySelector('[data-edge="e3"] .mimic-flow')).toBeNull();
    expect(container.querySelector('[data-node="t1"] [data-level]')).toHaveAttribute('data-level', 'unknown');
    expect(screen.getByText(/1 of 5 lines flowing/)).toBeInTheDocument();
  });

  it('focus draws one area with its pipes to dimmed neighbours; flow still comes from the whole plant', () => {
    // Focus on the valve and tank only: the pump upstream (outside) is running, so the line into the area flows.
    const { container } = render(
      <MimicView nodes={NODES} edges={EDGES} states={states({ p1: { running: true }, v1: { opened: true } })} focus={new Set(['v1', 't1'])} compact />,
    );
    const drawn = [...container.querySelectorAll('[data-node]')].map((n) => n.getAttribute('data-node')).sort();
    expect(drawn).toEqual(['ft', 'p1', 't1', 'v1']); // area + the machines its pipes reach; the inlet and outlet are not drawn
    expect(container.querySelector('[data-node="p1"]')).toHaveAttribute('data-neighbour', 'true');
    expect(container.querySelector('[data-node="v1"]')).not.toHaveAttribute('data-neighbour');
    expect([...container.querySelectorAll('[data-edge]')].map((e) => e.getAttribute('data-edge')).sort()).toEqual(['e2', 'e3', 'e4']);
    expect(container.querySelector('[data-edge="e2"]')).toHaveAttribute('data-flowing', 'true');
    expect(container.querySelector('[data-edge="e4"]')).toHaveAttribute('data-flowing', 'true');
    expect(screen.getByText(/3 of 3 lines flowing/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Fit area' })).toBeInTheDocument();
    expect(screen.queryByText(/wheel to zoom/)).toBeNull();
  });

  it('selects a machine on click and marks it', () => {
    const onSelect = vi.fn();
    const { container, rerender } = render(<MimicView nodes={NODES} edges={EDGES} states={states({})} onSelect={onSelect} />);
    fireEvent.click(container.querySelector('[data-node="p1"]'));
    expect(onSelect).toHaveBeenCalledWith('p1');
    rerender(<MimicView nodes={NODES} edges={EDGES} states={states({})} onSelect={onSelect} selected="p1" />);
    expect(container.querySelector('[data-node="p1"]')).toHaveClass('mimic-node--selected');
    expect(screen.getByRole('button', { name: 'Fit plant' })).toBeInTheDocument();
  });
});
