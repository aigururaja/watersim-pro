/**
 * The canvas drawn as the Live plant draws it.
 *
 * What is pinned: without a CanvasStyleContext the sheet's node and edge are
 * the drafting card and process line (every older test keeps passing); in the
 * 'mimic' style the node is the same machine the Live plant draws — a pump
 * spins when its control says ON and parks when it says OFF, a valve turns
 * its handwheel, a tank shows only a level the model reported, an instrument
 * reads the model — while the switch, ⓘ and readout are the same components;
 * an edge is a pipe that carries water when the stream has flow and moves
 * only in live view.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { ReactFlowProvider } from 'reactflow';
import CanvasNode from '../components/canvas/CanvasNode';
import CanvasEdge from '../components/canvas/CanvasEdge';
import { CanvasStyleContext, readCanvasStyle, writeCanvasStyle } from '../components/canvas/canvasStyle';
import { mimicStateOf, instrumentReading, tagFunction } from '../components/canvas/MimicNode';
import { labelPoint } from '../components/canvas/PipeEdge';
import { setFrame, resetLiveStore } from '../components/canvas/liveStore';
import { routePipe } from '../components/mimic/mimicLayout';

const mimic = (ui) => render(<ReactFlowProvider><CanvasStyleContext.Provider value="mimic">{ui}</CanvasStyleContext.Provider></ReactFlowProvider>);
const node = (id, opType, params = {}, extra = {}) => <CanvasNode id={id} data={{ opType, label: `${opType} label`, params, ...extra }} selected={false} xPos={0} yPos={0} />;

beforeEach(() => { resetLiveStore(); localStorage.clear(); });
afterEach(cleanup);

describe('canvas style', () => {
  it('defaults to the drafting card without a provider, so nothing older changes', () => {
    const { container } = render(<ReactFlowProvider>{node('p1', 'pump', { running: 1 })}</ReactFlowProvider>);
    expect(container.querySelector('svg.ws-frame')).toHaveAttribute('viewBox', '0 0 144 60');
    expect(container.querySelector('[data-running]')).toBeNull();
    expect(container.querySelector('[data-style="mimic"]')).toBeNull();
  });

  it('is realistic unless the person chose the drawing, and remembers the choice', () => {
    expect(readCanvasStyle()).toBe('mimic');
    writeCanvasStyle('drawing');
    expect(readCanvasStyle()).toBe('drawing');
    writeCanvasStyle('mimic');
    expect(readCanvasStyle()).toBe('mimic');
  });
});

describe('MimicNode', () => {
  it('draws a pump as the Live plant does: spinning when ON, parked when OFF, the same switch on top', () => {
    const { container, unmount } = mimic(node('p1', 'pump', { running: 1 }));
    const card = container.querySelector('.ws-node');
    expect(card).toHaveAttribute('data-style', 'mimic');
    expect(card).toHaveAttribute('data-op', 'pump');
    expect(container.querySelector('svg.ws-frame')).toHaveAttribute('viewBox', '0 0 168 116');
    expect(container.querySelector('[data-running]')).toHaveAttribute('data-running', 'true');
    expect(container.querySelector('.mimic-spin')).toBeTruthy();
    expect(screen.getByRole('switch', { name: 'Toggle pump' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByText('ON')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'About pump label' })).toBeInTheDocument();
    unmount();

    const off = mimic(node('p2', 'pump', { running: 0 }));
    expect(off.container.querySelector('[data-running]')).toHaveAttribute('data-running', 'false');
    expect(off.container.querySelector('.mimic-spin')).toBeNull();
    expect(off.container.querySelector('.ws-node')).toHaveAttribute('data-state', 'off');
    expect(screen.getByRole('switch', { name: 'Toggle pump' })).toHaveAttribute('aria-checked', 'false');
  });

  it('turns a valve handwheel with `open`, and an OFF verdict from the model parks a pump the control says is ON', () => {
    const { container, unmount } = mimic(node('v1', 'valve', { open: 1 }));
    expect(container.querySelector('[data-open]')).toHaveAttribute('data-open', 'true');
    expect(screen.getByRole('switch', { name: 'Toggle valve' })).toHaveAttribute('aria-checked', 'true'); // the pill and the symbol both say OPEN
    unmount();
    const shut = mimic(node('v2', 'valve', { open: 0 }));
    expect(shut.container.querySelector('[data-open]')).toHaveAttribute('data-open', 'false');

    expect(mimicStateOf('pump', 'drive', { metrics: { status: 'OFF' }, hasResults: true }, { running: 1 }, 'rest').running).toBe(false);
    expect(mimicStateOf('blower', 'drive', { metrics: {}, hasResults: false }, {}, 'rest').running).toBeUndefined();
    expect(mimicStateOf('pump', 'drive', { metrics: {} }, { running: 1 }, 'alarm').tripped).toBe(true);
  });

  it('a tank shows a level only when the model reported one; an instrument reads its transmitter, else the model', () => {
    setFrame({
      live: false,
      unitResults: {
        t1: { type: 'equalisation_tank', metrics: { level_pct: 61.2 } },
        ft: { type: 'instrument', metrics: { modelled: 612.4, measured: -1, unit: 'm³/d' } },
      },
      nodes: [{ id: 't1', data: { opType: 'equalisation_tank' } }, { id: 't2', data: { opType: 'equalisation_tank' } }, { id: 'ft', data: { opType: 'instrument' } }],
      edges: [],
    });
    const { container } = mimic(
      <>
        {node('t1', 'equalisation_tank')}
        {node('t2', 'equalisation_tank')}
        {node('ft', 'instrument', { range_min: 0, range_max: 800 }, { tags: ['RFP-FT-201'] })}
      </>,
    );
    const levels = container.querySelectorAll('[data-level]');
    expect(levels[0]).toHaveAttribute('data-level', '61');
    expect(levels[1]).toHaveAttribute('data-level', 'unknown');
    expect(container.querySelector('[data-quality]')).toHaveAttribute('data-quality', 'good');
    expect(container.textContent).toContain('612');

    expect(tagFunction({ tags: ['RFP-FT-201'] })).toBe('FT');
    expect(tagFunction({ tags: [] })).toBeNull();
    expect(instrumentReading({ metrics: { measured: 590, modelled: 612 }, hasResults: true }, {}).value).toBe(590);
    expect(instrumentReading({ metrics: { measured: -1, modelled: 612 }, hasResults: true }, { range_min: 0, range_max: 800 })).toMatchObject({ value: 612, rangeMin: 0, rangeMax: 800, quality: 'good' });
    expect(instrumentReading({ metrics: {}, hasResults: false }, {}).quality).toBe('unknown');
  });
});

describe('PipeEdge', () => {
  const edge = (data) => (
    <svg><CanvasEdge id="e1" source="a" target="b" sourceX={0} sourceY={58} targetX={300} targetY={58} data={data} selected={false} /></svg>
  );

  it('is a pipe: empty with no flow, carrying still water from a saved result, moving only live', () => {
    const dry = mimic(edge({ streamResult: { Q: 0 } }));
    const g = dry.container.querySelector('[data-edge="e1"]');
    expect(g).toHaveAttribute('data-wet', 'false');
    expect(g).toHaveAttribute('data-flowing', 'false');
    expect(dry.container.querySelector('.mimic-flow')).toBeNull();
    dry.unmount();

    const still = mimic(edge({ streamResult: { Q: 500 } }));
    const g2 = still.container.querySelector('[data-edge="e1"]');
    expect(g2).toHaveAttribute('data-wet', 'true');
    expect(g2).toHaveAttribute('data-flowing', 'false'); // values always, motion only live
    expect(still.container.querySelector('.mimic-flow')).toBeNull();
    expect(still.container.querySelector('.react-flow__edge-interaction')).toBeTruthy(); // ReactFlow's hit area survives
    still.unmount();

    setFrame({ live: true, streamResults: { e1: { Q: 500 } }, nodes: [], edges: [{ id: 'e1', source: 'a', target: 'b' }] });
    const live = mimic(edge({}));
    const g3 = live.container.querySelector('[data-edge="e1"]');
    expect(g3).toHaveAttribute('data-flowing', 'true');
    expect(live.container.querySelector('.mimic-flow')).toBeTruthy();
    expect(live.container.querySelector('.mimic-bubbles')).toBeTruthy();
    expect(g3.style.getPropertyValue('--mimic-flow-speed')).toMatch(/s$/);
  });

  it('a recycle line is coloured as one, and the flow tag sits on the run', () => {
    const { container } = mimic(edge({ streamResult: { Q: 120 }, isRecycle: true, streamType: 'recycle' }));
    expect(container.querySelector('[data-edge="e1"]')).toHaveAttribute('data-service', 'recycle');
    expect(labelPoint(routePipe({ x: 0, y: 10 }, { x: 100, y: 10 }))).toEqual({ x: 50, y: 10 });
    expect(labelPoint(routePipe({ x: 0, y: 0 }, { x: 200, y: 100 }))).toEqual({ x: 100, y: 50 });
    const back = labelPoint(routePipe({ x: 300, y: 0 }, { x: 0, y: 0 }));
    expect(back.y).toBeGreaterThan(0);
  });
});
