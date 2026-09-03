/**
 * UnitOpNode flow-control (pump / valve) toggle tests.
 *
 * The node renders a state pill + a toggle switch for opType 'pump'/'valve':
 *   - on-state derived from params.running / params.open with robust coercion
 *     (undefined → ON, numeric 1/0 preferred, 'false'/'off' strings → OFF)
 *   - the switch fires data.onControlToggle(paramKey, 1|0) — or the
 *     NodeControlContext callback with the node id when no data handler exists
 *   - the click never bubbles (it must not open the node's param panel)
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ReactFlowProvider } from 'reactflow';
import UnitOpNode from '../components/canvas/UnitOpNode';
import { NodeControlContext, isControlOn, controlPct } from '../components/canvas/controlState';

// Handle needs ReactFlow's zustand store — provide it around every render.
function renderNode(ui) {
  return render(<ReactFlowProvider>{ui}</ReactFlowProvider>);
}

describe('UnitOpNode — flow-control switch', () => {
  it('renders a switch for a pump and reflects ON from params', () => {
    renderNode(<UnitOpNode id="n1" data={{ label: 'Feed Pump', opType: 'pump', params: { running: 1 } }} />);
    const sw = screen.getByRole('switch', { name: 'Toggle pump' });
    expect(sw).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByText('ON')).toBeInTheDocument();
  });

  it('reflects OFF from params.running = 0', () => {
    renderNode(<UnitOpNode id="n1" data={{ label: 'Feed Pump', opType: 'pump', params: { running: 0 } }} />);
    expect(screen.getByRole('switch', { name: 'Toggle pump' })).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByText('OFF')).toBeInTheDocument();
  });

  it('defaults to ON when the param is undefined and coerces "false" to OFF', () => {
    const { unmount } = renderNode(
      <UnitOpNode id="v1" data={{ label: 'Valve', opType: 'valve', params: {} }} />
    );
    expect(screen.getByRole('switch', { name: 'Toggle valve' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByText('OPEN')).toBeInTheDocument();
    unmount();

    renderNode(<UnitOpNode id="v1" data={{ label: 'Valve', opType: 'valve', params: { open: 'false' } }} />);
    expect(screen.getByRole('switch', { name: 'Toggle valve' })).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByText('CLOSED')).toBeInTheDocument();
  });

  it('shows the throttle percentage in the pill while running below 100 %', () => {
    renderNode(
      <UnitOpNode id="n1" data={{ label: 'Feed Pump', opType: 'pump', params: { running: 1, speed_pct: 70 } }} />
    );
    expect(screen.getByText('70%')).toBeInTheDocument();
  });

  it('fires onControlToggle("running", 0) when clicked while on', async () => {
    const onControlToggle = vi.fn();
    renderNode(
      <UnitOpNode id="n1" data={{ label: 'Feed Pump', opType: 'pump', params: { running: 1 }, onControlToggle }} />
    );
    await userEvent.click(screen.getByRole('switch', { name: 'Toggle pump' }));
    expect(onControlToggle).toHaveBeenCalledTimes(1);
    expect(onControlToggle).toHaveBeenCalledWith('running', 0);
  });

  it('fires onControlToggle("open", 1) when clicked while closed', async () => {
    const onControlToggle = vi.fn();
    renderNode(
      <UnitOpNode id="v1" data={{ label: 'Valve', opType: 'valve', params: { open: 0 }, onControlToggle }} />
    );
    await userEvent.click(screen.getByRole('switch', { name: 'Toggle valve' }));
    expect(onControlToggle).toHaveBeenCalledWith('open', 1);
  });

  it('stops propagation — the click never reaches the node body', async () => {
    const onControlToggle = vi.fn();
    const parentClick = vi.fn();
    renderNode(
      <div onClick={parentClick}>
        <UnitOpNode id="n1" data={{ label: 'Feed Pump', opType: 'pump', params: { running: 1 }, onControlToggle }} />
      </div>
    );
    await userEvent.click(screen.getByRole('switch', { name: 'Toggle pump' }));
    expect(onControlToggle).toHaveBeenCalledTimes(1);
    expect(parentClick).not.toHaveBeenCalled();
  });

  it('falls back to NodeControlContext with the node id when data has no handler', async () => {
    const ctxToggle = vi.fn();
    render(
      <ReactFlowProvider>
        <NodeControlContext.Provider value={ctxToggle}>
          <UnitOpNode id="node_7" data={{ label: 'Valve', opType: 'valve', params: { open: 1 } }} />
        </NodeControlContext.Provider>
      </ReactFlowProvider>
    );
    await userEvent.click(screen.getByRole('switch', { name: 'Toggle valve' }));
    expect(ctxToggle).toHaveBeenCalledWith('node_7', 'open', 0);
  });

  it('renders no switch for non-control op types', () => {
    renderNode(<UnitOpNode id="n1" data={{ label: 'Inlet', opType: 'inlet', params: {} }} />);
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
  });
});

describe('controlState coercion helpers', () => {
  it('isControlOn mirrors the backend coercion', () => {
    for (const off of [0, '0', false, 'false', 'off', ' OFF ']) expect(isControlOn(off)).toBe(false);
    for (const on of [1, '1', true, 'true', undefined, null, 2, 'yes']) expect(isControlOn(on)).toBe(true);
  });

  it('controlPct clamps to 0–100 and defaults to 100', () => {
    expect(controlPct(undefined)).toBe(100);
    expect(controlPct('')).toBe(100);
    expect(controlPct(NaN)).toBe(100);
    expect(controlPct(150)).toBe(100);
    expect(controlPct(-5)).toBe(0);
    expect(controlPct(70)).toBe(70);
  });
});
