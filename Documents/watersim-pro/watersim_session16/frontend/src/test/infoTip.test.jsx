/**
 * InfoTip — the reusable ⓘ affordance.
 *
 * It renders collapsed, expands its INLINE detail block on click (no portal),
 * closes on a second click or on Escape, and keeps aria-expanded in step.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import InfoTip, { InfoFacts } from '../components/InfoTip';

function renderTip(extra = {}) {
  return render(
    <InfoTip
      label="About SRT (days)"
      title="SRT (days)"
      detail={<span>Sludge age — the master dial of the biology.</span>}
      {...extra}
    >
      {(infoButton) => (
        <div>
          <span>SRT (days)</span>
          {infoButton}
        </div>
      )}
    </InfoTip>
  );
}

describe('InfoTip', () => {
  it('renders collapsed, with the button labelled and aria-expanded false', () => {
    renderTip();
    const btn = screen.getByRole('button', { name: 'About SRT (days)' });
    expect(btn).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('note')).not.toBeInTheDocument();
    expect(screen.queryByText(/master dial/)).not.toBeInTheDocument();
  });

  it('expands on click and shows the detail inline', async () => {
    renderTip();
    const btn = screen.getByRole('button', { name: 'About SRT (days)' });
    await userEvent.click(btn);

    expect(btn).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('note')).toBeInTheDocument();
    expect(screen.getByText(/master dial/)).toBeInTheDocument();
    // The panel is a real sibling in the flow, not a portal escape hatch.
    expect(document.body.querySelectorAll('[role="note"]')).toHaveLength(1);
    expect(btn).toHaveAttribute('aria-controls', screen.getByRole('note').id);
  });

  it('closes when the button is clicked again', async () => {
    renderTip();
    const btn = screen.getByRole('button', { name: 'About SRT (days)' });
    await userEvent.click(btn);
    expect(btn).toHaveAttribute('aria-expanded', 'true');

    await userEvent.click(btn);
    expect(btn).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('note')).not.toBeInTheDocument();
  });

  it('closes on Escape', async () => {
    renderTip();
    const btn = screen.getByRole('button', { name: 'About SRT (days)' });
    await userEvent.click(btn);
    expect(screen.getByRole('note')).toBeInTheDocument();

    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('note')).not.toBeInTheDocument();
    expect(btn).toHaveAttribute('aria-expanded', 'false');
  });

  it('is keyboard operable — Tab reaches it and Enter toggles it open', async () => {
    renderTip();
    const btn = screen.getByRole('button', { name: 'About SRT (days)' });
    await userEvent.tab();
    expect(btn).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    expect(btn).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('note')).toBeInTheDocument();
  });

  it('does not let the click reach an enclosing row handler', async () => {
    const rowClick = vi.fn();
    render(
      <div onClick={rowClick}>
        <InfoTip label="About X" detail={<span>detail</span>}>
          {(infoButton) => <div>row {infoButton}</div>}
        </InfoTip>
      </div>
    );
    await userEvent.click(screen.getByRole('button', { name: 'About X' }));
    expect(screen.getByRole('note')).toBeInTheDocument();
    expect(rowClick).not.toHaveBeenCalled();
  });

  it('appends the button inline when children is not a function', () => {
    render(
      <InfoTip label="About Y" detail={<span>detail</span>}>
        <span>Y label</span>
      </InfoTip>
    );
    expect(screen.getByText('Y label')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'About Y' })).toBeInTheDocument();
  });
});

describe('InfoFacts', () => {
  it('renders each supplied fact and skips the empty ones', () => {
    render(
      <InfoFacts
        facts={[
          { label: 'What it is', value: 'Sludge age.' },
          { label: 'Unit', value: 'days' },
          { label: 'Typical', value: '' },
          { label: 'Effect', value: undefined },
        ]}
      />
    );
    expect(screen.getByText('What it is')).toBeInTheDocument();
    expect(screen.getByText('Sludge age.')).toBeInTheDocument();
    expect(screen.getByText('Unit')).toBeInTheDocument();
    expect(screen.queryByText('Typical')).not.toBeInTheDocument();
    expect(screen.queryByText('Effect')).not.toBeInTheDocument();
  });

  it('renders nothing when every fact is empty', () => {
    const { container } = render(<InfoFacts facts={[{ label: 'Unit', value: '' }]} />);
    expect(container).toBeEmptyDOMElement();
  });
});
