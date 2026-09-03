import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import LiveChartsDock from '../components/canvas/LiveChartsDock';

const point = (idx, over = {}) => ({
  idx,
  time: '10:00:00',
  BOD: 8, TSS: 10, TN: 12, NH4: 1.2, TP: 0.9,
  Qin: 4800, Qeff: 4500,
  compliant: true,
  costYr: 500000, lcow: 0.61,
  converged: true,
  ...over,
});

describe('LiveChartsDock', () => {
  it('renders nothing with an empty history', () => {
    const { container } = render(
      <LiveChartsDock history={[]} collapsed={false} onToggle={() => {}} onClear={() => {}} />
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('shows run counter, compliance chip, and cost strip', () => {
    render(
      <LiveChartsDock
        history={[point(1), point(2, { costYr: 520000, compliant: false })]}
        permitLimits={{ BOD: 20, TSS: 20 }}
        collapsed={false}
        onToggle={() => {}}
        onClear={() => {}}
      />
    );
    expect(screen.getByText(/Live Charts/)).toBeInTheDocument();
    expect(screen.getByText(/run #2/)).toBeInTheDocument();
    expect(screen.getByText('violations')).toBeInTheDocument();
    expect(screen.getByText(/Annual cost/i)).toBeInTheDocument();
    expect(screen.getByText(/LCOW/i)).toBeInTheDocument();
  });

  it('collapses to the header bar and fires callbacks', () => {
    const onToggle = vi.fn();
    const onClear = vi.fn();
    render(
      <LiveChartsDock
        history={[point(1)]}
        collapsed={true}
        onToggle={onToggle}
        onClear={onClear}
      />
    );
    expect(screen.queryByText(/Effluent quality per run/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('▴ Show'));
    expect(onToggle).toHaveBeenCalled();
    fireEvent.click(screen.getByText('Clear'));
    expect(onClear).toHaveBeenCalled();
  });

  it('flags a non-converged latest run', () => {
    render(
      <LiveChartsDock
        history={[point(1, { converged: false })]}
        collapsed={false}
        onToggle={() => {}}
        onClear={() => {}}
      />
    );
    expect(screen.getByText('not converged')).toBeInTheDocument();
  });
});
