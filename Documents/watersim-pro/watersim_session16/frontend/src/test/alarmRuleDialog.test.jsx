/**
 * AlarmRuleDialog — the target picker is the product rule.
 *
 * "Limits only on valid parameters" is enforced twice: the backend derives the
 * legal set from the flowsheet's own canvas, and this dialog makes an illegal
 * one unreachable. The second half is what these tests pin — in particular
 * `there is no free-text control that can submit an arbitrary target`, which is
 * the one a future "let me just type it" convenience would quietly undo.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AlarmRuleDialog from '../components/alarms/AlarmRuleDialog';
import api from '../services/api';

vi.mock('../services/api', () => {
  const mock = { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() };
  return { default: mock, api: mock };
});

// A miniature of GET /alarm-targets: all three groups, two nodes.
const TARGETS = [
  { targetType: 'param', nodeId: 'n2', nodeLabel: 'Grit Chamber', paramKey: 'HRT_min', label: 'Grit Chamber · HRT_min', kind: 'parameter' },
  { targetType: 'param', nodeId: 'n3', nodeLabel: 'Aeration Basin', paramKey: 'SRT_d', label: 'Aeration Basin · SRT_d', kind: 'parameter' },
  { targetType: 'param', nodeId: 'n3', nodeLabel: 'Aeration Basin', paramKey: 'MLSS_mg_L', label: 'Aeration Basin · MLSS_mg_L', kind: 'parameter' },
  { targetType: 'node_output', nodeId: 'n3', nodeLabel: 'Aeration Basin', paramKey: 'NH4', label: 'Aeration Basin outflow · NH4', kind: 'quality' },
  { targetType: 'node_output', nodeId: 'n2', nodeLabel: 'Grit Chamber', paramKey: 'TSS', label: 'Grit Chamber outflow · TSS', kind: 'quality' },
  { targetType: 'effluent', nodeId: null, nodeLabel: 'Plant effluent', paramKey: 'TN', label: 'Plant effluent · TN', kind: 'quality' },
  { targetType: 'effluent', nodeId: null, nodeLabel: 'Plant effluent', paramKey: 'TSS', label: 'Plant effluent · TSS', kind: 'quality' },
];

const EXISTING_RULE = {
  id: 'r1', name: 'Effluent nitrogen over permit',
  target_type: 'effluent', node_id: null, param_key: 'TN',
  min_value: null, max_value: 10, severity: 'critical', enabled: true,
};

const renderDialog = (props = {}) => render(
  <AlarmRuleDialog
    projectId="p1" flowsheetId="f1"
    rule={null} prefill={null}
    onClose={() => {}} onSaved={() => {}} onDeleted={() => {}}
    {...props}
  />
);

/** Wait for the targets to land, then hand back the target <select>. */
async function targetSelect() {
  await screen.findByRole('option', { name: /Grit Chamber · HRT_min/ });
  return screen.getByLabelText('Alarm target');
}

beforeEach(() => {
  vi.clearAllMocks();
  api.get.mockResolvedValue({ data: TARGETS });
  api.post.mockResolvedValue({ data: { id: 'new' } });
  api.patch.mockResolvedValue({ data: { id: 'r1' } });
  api.delete.mockResolvedValue({ data: {} });
});

// ── The picker ──────────────────────────────────────────────────────────────

describe('AlarmRuleDialog — target picker', () => {
  it('loads the flowsheet targets and groups them under the three headings', async () => {
    const { container } = renderDialog();
    await targetSelect();

    expect(api.get).toHaveBeenCalledWith('/projects/p1/flowsheets/f1/alarm-targets');

    const groups = [...container.querySelectorAll('optgroup')].map(g => g.label);
    expect(groups).toEqual([
      'Node parameters (3)',
      'Water leaving a node (2)',
      'Plant effluent (2)',
    ]);
  });

  it('shows every target as "nodeLabel · paramKey" plus its friendly label', async () => {
    renderDialog();
    await targetSelect();
    expect(screen.getByRole('option', { name: 'Grit Chamber · HRT_min — Grit Chamber · HRT_min' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Aeration Basin · NH4 — Aeration Basin outflow · NH4' })).toBeInTheDocument();
    // A plant-effluent row has no node, so it leads with the parameter.
    expect(screen.getByRole('option', { name: 'TN — Plant effluent · TN' })).toBeInTheDocument();
  });

  it('the filter narrows which server options are rendered — and nothing else', async () => {
    const { container } = renderDialog();
    await targetSelect();
    expect(container.querySelectorAll('option').length).toBeGreaterThan(7);

    fireEvent.change(screen.getByLabelText('Filter targets'), { target: { value: 'aeration' } });

    const shown = [...container.querySelectorAll('optgroup option')].map(o => o.textContent);
    expect(shown.every(t => /Aeration Basin/.test(t))).toBe(true);
    expect(shown).toHaveLength(3);          // SRT_d, MLSS_mg_L, and the NH4 outflow
    expect(screen.getByText(/Showing 3 of 7/)).toBeInTheDocument();

    // Nothing matches → the count says so and no option is invented.
    fireEvent.change(screen.getByLabelText('Filter targets'), { target: { value: 'zzz-not-a-thing' } });
    expect(container.querySelectorAll('optgroup option')).toHaveLength(0);
    expect(screen.getByText(/Clear the filter to see all 7 targets/)).toBeInTheDocument();
  });

  it('THE INVARIANT: there is no free-text control that can submit an arbitrary target', async () => {
    const { container } = renderDialog();
    await targetSelect();

    // 1. Every free-text/number input in the dialog is accounted for, and none
    //    of them is a target field. Adding a "paramKey" or "nodeId" box would
    //    fail here.
    const freeText = [...container.querySelectorAll('input')]
      .filter(i => !['checkbox', 'radio'].includes(i.type))
      .map(i => i.getAttribute('aria-label') || i.id);
    expect(freeText.sort()).toEqual(['alarm-max', 'alarm-min', 'alarm-name', 'Filter targets'].sort());

    // 2. The target is chosen from a <select> whose every option came from the
    //    server payload — no option exists that the API did not send.
    const select = screen.getByLabelText('Alarm target');
    const optionValues = [...select.querySelectorAll('optgroup option')].map(o => o.value);
    const legal = new Set(TARGETS.map(t => `${t.targetType}|${t.nodeId ?? ''}|${t.paramKey}`));
    expect(optionValues.length).toBe(TARGETS.length);
    expect(optionValues.every(v => legal.has(v))).toBe(true);

    // 3. Typing a real-looking target into the filter creates NOTHING: the
    //    option list stays empty and Save stays disabled.
    fireEvent.change(screen.getByLabelText('Filter targets'), { target: { value: 'chamberType' } });
    expect(container.querySelectorAll('optgroup option')).toHaveLength(0);
    fireEvent.change(screen.getByLabelText('Name *'), { target: { value: 'sneaky' } });
    fireEvent.change(screen.getByLabelText('Maximum'), { target: { value: '5' } });
    expect(screen.getByRole('button', { name: /Create alarm/ })).toBeDisabled();

    // 4. Even forcing an unknown value onto the select (what a tampered client
    //    would do) cannot be saved: the key is resolved back through the
    //    server's own list before anything is posted.
    fireEvent.change(select, { target: { value: 'param|n999|chamberType' } });
    expect(screen.getByRole('button', { name: /Create alarm/ })).toBeDisabled();
    fireEvent.submit(select.closest('form'));
    expect(api.post).not.toHaveBeenCalled();
  });

  it('posts the target fields taken from the RESOLVED server row', async () => {
    const onSaved = vi.fn();
    renderDialog({ onSaved });
    const select = await targetSelect();

    fireEvent.change(select, { target: { value: 'param|n3|SRT_d' } });
    fireEvent.change(screen.getByLabelText('Name *'), { target: { value: 'SRT too long' } });
    fireEvent.change(screen.getByLabelText('Maximum'), { target: { value: '25' } });
    fireEvent.change(screen.getByLabelText(/Severity/), { target: { value: 'critical' } });
    fireEvent.click(screen.getByRole('button', { name: /Create alarm/ }));

    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
    expect(api.post).toHaveBeenCalledWith('/projects/p1/flowsheets/f1/alarms', {
      name: 'SRT too long',
      minValue: null,
      maxValue: 25,
      severity: 'critical',
      enabled: true,
      targetType: 'param',
      nodeId: 'n3',
      paramKey: 'SRT_d',
    });
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
  });

  it('preselects the target a param row\'s bell prefilled', async () => {
    renderDialog({ prefill: { targetType: 'param', nodeId: 'n2', paramKey: 'HRT_min' } });
    const select = await targetSelect();
    expect(select).toHaveValue('param|n2|HRT_min');
    // …and suggests a name from it, so the fastest path is one click.
    expect(screen.getByLabelText('Name *')).toHaveValue('Grit Chamber · HRT_min');
  });

  it('warns instead of failing when the targets cannot be loaded', async () => {
    api.get.mockRejectedValueOnce(new Error('boom'));
    renderDialog();
    expect(await screen.findByText(/Could not load the alarm targets/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Create alarm/ })).toBeDisabled();
  });
});

// ── Client-side validation ──────────────────────────────────────────────────

describe('AlarmRuleDialog — limits', () => {
  it('blocks a submit with NEITHER min nor max, client-side', async () => {
    renderDialog();
    const select = await targetSelect();
    fireEvent.change(select, { target: { value: 'effluent||TN' } });
    fireEvent.change(screen.getByLabelText('Name *'), { target: { value: 'No limits' } });

    // The reason is stated, the button is dead, and nothing reaches the network.
    expect(screen.getByText(/At least one of minValue \/ maxValue must be a finite number/)).toBeInTheDocument();
    const submit = screen.getByRole('button', { name: /Create alarm/ });
    expect(submit).toBeDisabled();

    fireEvent.click(submit);
    fireEvent.submit(select.closest('form'));
    expect(api.post).not.toHaveBeenCalled();

    // Adding one limit unblocks it.
    fireEvent.change(screen.getByLabelText('Maximum'), { target: { value: '10' } });
    expect(screen.getByRole('button', { name: /Create alarm/ })).not.toBeDisabled();
  });

  it('blocks an inverted window with the same wording the server uses', async () => {
    renderDialog();
    const select = await targetSelect();
    fireEvent.change(select, { target: { value: 'effluent||TN' } });
    fireEvent.change(screen.getByLabelText('Name *'), { target: { value: 'Backwards' } });
    fireEvent.change(screen.getByLabelText('Minimum'), { target: { value: '10' } });
    fireEvent.change(screen.getByLabelText('Maximum'), { target: { value: '5' } });

    expect(screen.getByText('minValue must be less than maxValue')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Create alarm/ })).toBeDisabled();
  });

  it('previews the sentence the rule will read as', async () => {
    renderDialog();
    const select = await targetSelect();
    fireEvent.change(select, { target: { value: 'effluent||TN' } });
    fireEvent.change(screen.getByLabelText('Maximum'), { target: { value: '10' } });
    expect(screen.getByText('Effluent TN above 10 mg/L')).toBeInTheDocument();
  });
});

// ── Server errors, shown verbatim ───────────────────────────────────────────

describe('AlarmRuleDialog — server messages', () => {
  const submitSomething = async () => {
    const select = await targetSelect();
    fireEvent.change(select, { target: { value: 'param|n2|HRT_min' } });
    fireEvent.change(screen.getByLabelText('Name *'), { target: { value: 'Whatever' } });
    fireEvent.change(screen.getByLabelText('Maximum'), { target: { value: '5' } });
    fireEvent.click(screen.getByRole('button', { name: /Create alarm/ }));
  };

  it('shows a 422 detail message VERBATIM', async () => {
    const msg = "'chamberType' is not a numeric parameter of a Grit Chamber (valid: HRT_min)";
    api.post.mockRejectedValueOnce({
      response: { status: 422, data: { error: 'Validation failed', details: [{ msg, path: 'target' }] } },
    });
    renderDialog();
    await submitSomething();

    const alert = await screen.findByRole('alert');
    // Word for word — not paraphrased, not swallowed by a generic failure.
    expect(alert).toHaveTextContent(msg);
  });

  it('shows the 409 duplicate-target message verbatim', async () => {
    api.post.mockRejectedValueOnce({
      response: { status: 409, data: { error: 'An alarm rule already exists for this target' } },
    });
    renderDialog();
    await submitSomething();
    expect(await screen.findByRole('alert'))
      .toHaveTextContent('An alarm rule already exists for this target');
  });
});

// ── Editing ─────────────────────────────────────────────────────────────────

describe('AlarmRuleDialog — editing', () => {
  it('preloads every field from the rule', async () => {
    renderDialog({ rule: EXISTING_RULE });
    const select = await targetSelect();
    expect(select).toHaveValue('effluent||TN');
    expect(screen.getByLabelText('Name *')).toHaveValue('Effluent nitrogen over permit');
    expect(screen.getByLabelText('Maximum')).toHaveValue(10);
    expect(screen.getByLabelText('Minimum')).toHaveValue(null);
    expect(screen.getByLabelText(/Severity/)).toHaveValue('critical');
    expect(screen.getByRole('checkbox')).toBeChecked();
    expect(screen.getByRole('button', { name: /Save changes/ })).toBeInTheDocument();
  });

  it('PATCHes only the limits when the target did not move', async () => {
    renderDialog({ rule: EXISTING_RULE });
    await targetSelect();
    fireEvent.change(screen.getByLabelText('Maximum'), { target: { value: '8' } });
    fireEvent.click(screen.getByRole('button', { name: /Save changes/ }));

    await waitFor(() => expect(api.patch).toHaveBeenCalledTimes(1));
    const [url, body] = api.patch.mock.calls[0];
    expect(url).toBe('/projects/p1/flowsheets/f1/alarms/r1');
    expect(body).toEqual({ name: 'Effluent nitrogen over permit', minValue: null, maxValue: 8, severity: 'critical', enabled: true });
    expect(body.targetType).toBeUndefined();   // the target is not re-sent
  });

  it('sends the new target when the selection DOES move', async () => {
    renderDialog({ rule: EXISTING_RULE });
    const select = await targetSelect();
    fireEvent.change(select, { target: { value: 'node_output|n3|NH4' } });
    fireEvent.click(screen.getByRole('button', { name: /Save changes/ }));

    await waitFor(() => expect(api.patch).toHaveBeenCalledTimes(1));
    expect(api.patch.mock.calls[0][1]).toMatchObject({
      targetType: 'node_output', nodeId: 'n3', paramKey: 'NH4',
    });
  });

  it('deletes behind a confirm', async () => {
    const onDeleted = vi.fn();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderDialog({ rule: EXISTING_RULE, onDeleted });
    await targetSelect();

    await userEvent.click(screen.getByRole('button', { name: /Delete rule/ }));
    await waitFor(() => expect(api.delete).toHaveBeenCalledWith('/projects/p1/flowsheets/f1/alarms/r1'));
    await waitFor(() => expect(onDeleted).toHaveBeenCalled());
    window.confirm.mockRestore();
  });

  it('does not delete when the confirm is declined', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    renderDialog({ rule: EXISTING_RULE });
    await targetSelect();
    await userEvent.click(screen.getByRole('button', { name: /Delete rule/ }));
    expect(api.delete).not.toHaveBeenCalled();
    window.confirm.mockRestore();
  });

  it('offers no Delete when creating', async () => {
    renderDialog();
    await targetSelect();
    expect(screen.queryByRole('button', { name: /Delete rule/ })).not.toBeInTheDocument();
  });

  it('keeps an orphaned target editable without re-sending it', async () => {
    // The rule points at a node that has since been deleted from the canvas, so
    // GET /alarm-targets no longer lists it.
    const orphan = { ...EXISTING_RULE, id: 'r9', target_type: 'param', node_id: 'gone', param_key: 'SRT_d' };
    renderDialog({ rule: orphan });
    await targetSelect();

    expect(screen.getByText(/no longer on the canvas/)).toBeInTheDocument();
    const select = screen.getByLabelText('Alarm target');
    expect(within(select).getByRole('option', { name: /no longer on this flowsheet/ })).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Maximum'), { target: { value: '30' } });
    fireEvent.click(screen.getByRole('button', { name: /Save changes/ }));
    await waitFor(() => expect(api.patch).toHaveBeenCalled());
    expect(api.patch.mock.calls[0][1].targetType).toBeUndefined();
  });
});
