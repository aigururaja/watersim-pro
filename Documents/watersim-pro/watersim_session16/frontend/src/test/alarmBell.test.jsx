/**
 * The per-parameter alarm bell, and the row it lives on.
 *
 * The row already carried two affordances before the alarm layer existed — the
 * PLC bind button and the ⓘ InfoTip — and the brief for the bell was explicitly
 * "must not disturb" either. The last test in this file is that contract: all
 * three render together, and each fires only its own handler.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AlarmBell from '../components/alarms/AlarmBell';
import { ParamRow } from '../pages/CanvasPage';

const RULE = {
  id: 'r1', name: 'SRT too long',
  target_type: 'param', node_id: 'n3', param_key: 'SRT_d',
  min_value: null, max_value: 25, severity: 'critical', enabled: true,
};

const ACTIVE = {
  id: 'e1', ruleId: 'r1', ruleName: 'SRT too long', state: 'active',
  severity: 'critical', message: 'Aeration Basin SRT_d 31 exceeded max 25',
  triggeredAt: '2026-09-04T03:00:00.000Z',
};

const PREVIEW = {
  ruleId: 'r1', ruleName: 'SRT too long', severity: 'critical',
  targetType: 'param', nodeId: 'n3', paramKey: 'SRT_d', value: 31,
  message: 'Aeration Basin SRT_d 31 exceeded max 25',
};

const bell = (props = {}) => {
  const { container } = render(
    <AlarmBell paramLabel="SRT (days)" nodeLabel="Aeration Basin" onClick={() => {}} {...props} />
  );
  return container.querySelector('[data-alarm-state]');
};

// ── The four states ─────────────────────────────────────────────────────────

describe('AlarmBell', () => {
  it('is OUTLINED and offers to create when the parameter has no rule', () => {
    const el = bell({ rule: null });
    expect(el).toHaveAttribute('data-alarm-state', 'none');
    expect(el.tagName).toBe('BUTTON');
    expect(el).toHaveAccessibleName('Add alarm rule on SRT (days)');
    // Outlined = no fill, muted ink.
    expect(el).toHaveStyle({ background: 'transparent' });
    expect(el.className).not.toMatch(/ws-alarm-bell/);
  });

  it('is FILLED and offers to edit once a rule exists', () => {
    const el = bell({ rule: RULE });
    expect(el).toHaveAttribute('data-alarm-state', 'set');
    expect(el).toHaveAccessibleName('Edit alarm rule on SRT (days)');
    expect(el).toHaveStyle({ background: '#DBEAFE' });
    // The tooltip says what the limit actually IS, not just that one exists.
    expect(el).toHaveAttribute('title', expect.stringContaining('Aeration Basin SRT_d above 25'));
    expect(el.className).not.toMatch(/ws-alarm-bell/);
  });

  it('is ALARMED — severity-coloured and pulsing — while an event is open', () => {
    const el = bell({ rule: RULE, activeEvent: ACTIVE });
    expect(el).toHaveAttribute('data-alarm-state', 'active');
    expect(el).toHaveAttribute('data-severity', 'critical');
    // The pulse reuses the card ring's own 1.0s blink (canvas-motion.css). It
    // is NOT `.ws-anim`-gated: that gate is scoped to `.ws-sheet`, and the
    // params panel is in the right rail — the class would be inert there.
    expect(el.className).toMatch(/ws-alarm-bell/);
    expect(el.className).not.toMatch(/ws-anim\b/);
    // Colour is never the only channel — the state is in the label too.
    expect(el).toHaveAccessibleName(/Critical alarm active on SRT \(days\)/);
    expect(el).toHaveAttribute('title', expect.stringContaining(ACTIVE.message));
  });

  it('shows a PREVIEW breach distinctly from a persisted one', () => {
    const el = bell({ rule: RULE, previewAlarm: PREVIEW });
    expect(el).toHaveAttribute('data-alarm-state', 'would');
    // Dashed, not filled — nothing has actually happened yet.
    expect(el.style.border).toMatch(/dashed/);
    expect(el.className).not.toMatch(/ws-alarm-bell/);
    expect(el).toHaveAccessibleName(/would fire/);
    expect(el).toHaveAttribute('title', expect.stringContaining('Would fire on the current values'));

    // A real open event outranks the preview — the record wins over the what-if.
    const both = bell({ rule: RULE, previewAlarm: PREVIEW, activeEvent: ACTIVE });
    expect(both).toHaveAttribute('data-alarm-state', 'active');
  });

  it('calls the handler and never lets the click reach the node body', async () => {
    const onClick = vi.fn();
    const parentClick = vi.fn();
    render(
      <div onClick={parentClick}>
        <AlarmBell paramLabel="SRT (days)" rule={RULE} onClick={onClick} />
      </div>
    );
    await userEvent.click(screen.getByRole('button', { name: /Edit alarm rule/ }));
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(parentClick).not.toHaveBeenCalled();
  });

  // ── Role gating ───────────────────────────────────────────────────────────

  it('gives a viewer state without a control', () => {
    const el = bell({ rule: RULE, activeEvent: ACTIVE, canEdit: false });
    expect(el.tagName).not.toBe('BUTTON');
    expect(el).toHaveAttribute('data-alarm-state', 'active');
    expect(el).toHaveAccessibleName('Critical alarm active on SRT (days)');
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('shows a viewer nothing at all on a parameter with no rule', () => {
    // An inert grey bell on every row would be pure noise.
    expect(bell({ rule: null, canEdit: false })).toBeNull();
  });
});

// ── The row the bell shares ─────────────────────────────────────────────────

describe('ParamRow — three affordances, one row', () => {
  const DEF = { key: 'SRT_d', label: 'SRT (days)', type: 'number', step: 1 };

  const renderRow = (props = {}) => render(
    <ParamRow
      opType="activated_sludge"
      def={DEF}
      value={12}
      onChange={() => {}}
      nodeLabel="Aeration Basin"
      {...props}
    />
  );

  it('renders the ⓘ, the PLC bind button and the bell together', () => {
    // The busiest a row ever gets: documented, PLC-bound AND alarmed.
    renderRow({
      onBind: vi.fn(), onAlarm: vi.fn(), alarmRule: RULE,
      binding: { id: 'b1', connection_name: 'Plant PLC', address: '40001' },
      live: { value: 12, quality: 'good', ts: Date.now() },
    });

    // SRT_d is documented in explanations.js, so the row carries an InfoTip.
    expect(screen.getByRole('button', { name: 'About SRT (days)' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit PLC binding for SRT (days)' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit alarm rule on SRT (days)' })).toBeInTheDocument();
    // …and the parameter input itself is still there and editable.
    expect(screen.getByRole('spinbutton')).toHaveValue(12);
  });

  it('each affordance fires only its own handler', async () => {
    const onBind = vi.fn();
    const onAlarm = vi.fn();
    renderRow({ onBind, onAlarm, alarmRule: null });

    await userEvent.click(screen.getByRole('button', { name: 'Add alarm rule on SRT (days)' }));
    expect(onAlarm).toHaveBeenCalledTimes(1);
    expect(onBind).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: 'Bind SRT (days) to a PLC tag' }));
    expect(onBind).toHaveBeenCalledTimes(1);
    expect(onAlarm).toHaveBeenCalledTimes(1);
  });

  it('renders the bell outlined with no rule and alarmed with an active event', () => {
    const { container, rerender } = renderRow({ onAlarm: vi.fn(), alarmRule: null });
    expect(container.querySelector('[data-alarm-state]')).toHaveAttribute('data-alarm-state', 'none');

    rerender(
      <ParamRow
        opType="activated_sludge" def={DEF} value={12} onChange={() => {}}
        nodeLabel="Aeration Basin" onAlarm={vi.fn()}
        alarmRule={RULE} activeAlarm={ACTIVE}
      />
    );
    const el = container.querySelector('[data-alarm-state]');
    expect(el).toHaveAttribute('data-alarm-state', 'active');
    expect(el).toHaveAttribute('data-severity', 'critical');
  });

  it('omits the bell entirely when the page supplies no alarm handler', () => {
    const { container } = renderRow({ onBind: vi.fn() });
    expect(container.querySelector('[data-alarm-state]')).toBeNull();
    // The PLC button is untouched by the bell's absence.
    expect(screen.getByRole('button', { name: /Bind SRT \(days\)/ })).toBeInTheDocument();
  });

  it('keeps all three inside the row label, so none can be pushed out', () => {
    const { container } = renderRow({ onBind: vi.fn(), onAlarm: vi.fn(), alarmRule: RULE });
    const label = container.querySelector('label');
    expect(within(label).getByRole('button', { name: 'About SRT (days)' })).toBeInTheDocument();
    expect(within(label).getByRole('button', { name: /PLC tag/ })).toBeInTheDocument();
    expect(within(label).getByRole('button', { name: /alarm rule/ })).toBeInTheDocument();
  });
});
