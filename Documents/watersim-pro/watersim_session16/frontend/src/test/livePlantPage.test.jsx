/**
 * LivePlantPage — the screen on the wall.
 *
 * What is pinned: the snapshot is drawn as areas with gauges and equipment
 * cards in their MEASURED state; a plc:update on the socket moves a gauge and
 * flips a drive; an alarm event lands on the strip and clears; Start opens the
 * confirmation and the confirmed write goes to the PLC write endpoint with the
 * right value; a viewer gets no control and no ack; pinned trends fetch history.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import LivePlantPage from '../pages/LivePlantPage';
import { measuredSnapshot, measuredState, describeState } from '../components/live/EquipmentCard';
import api from '../services/api';
import { can } from '../auth/roles';

let ROLE = 'operator';
vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'u1', firstName: 'Olivia', role: ROLE }, role: ROLE, can: (c) => can(ROLE, c) }),
  AuthProvider: ({ children }) => children,
}));
vi.mock('../services/api', () => {
  const mock = { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() };
  return { default: mock, api: mock };
});
vi.mock('../components/layout/AppLayout', () => ({ default: ({ children }) => <div>{children}</div> }));

// Capture the live handlers so a test can push socket messages.
let liveHandlers = {};
vi.mock('../hooks/useOrgLive', () => ({
  useOrgLive: (h) => { liveHandlers = h; return { connected: true, lastMessageAt: null }; },
  default: (h) => { liveHandlers = h; return { connected: true, lastMessageAt: null }; },
}));

const SNAPSHOT = {
  at: '2026-09-07T10:00:00Z',
  areas: [
    { code: 'RFP', name: 'Reactor Feed Pump Process', points: 4, good: 4, alarms: 0, critical: 0, equipment: 1, analog: 1 },
    { code: 'EQT', name: 'Equalisation tank', points: 1, good: 1, alarms: 0, critical: 0, equipment: 0, analog: 1 },
  ],
  tags: [
    { id: 'ft', tag: 'RFP-FT-201.FT', area: 'RFP', name: 'Reactor feed flow', signalType: 'AI', engUnit: 'm3/d', rangeMin: 0, rangeMax: 800, value: 612.5, quality: 'good', at: '2026-09-07T09:59:58Z' },
    { id: 'lt', tag: 'EQT-LT-101.LT', area: 'EQT', name: 'EQT level', signalType: 'AI', engUnit: '%', rangeMin: 0, rangeMax: 100, value: 61.2, quality: 'good', at: '2026-09-07T09:59:58Z' },
    { id: 'xs', tag: 'RFP-P-201/1.XS', area: 'RFP', name: 'Reactor feed pump 1', signalType: 'DI', value: 0, quality: 'good', at: '2026-09-07T09:59:58Z' },
    { id: 'xy', tag: 'RFP-P-201/1.XY', area: 'RFP', name: 'Reactor feed pump 1', signalType: 'DO', value: null, quality: 'unknown', direction: 'write' },
  ],
  equipment: [{
    key: 'RFP-P-201/1', loopTag: 'RFP-P-201', unit: 1, name: 'Reactor feed pump 1', area: 'RFP', kind: 'pump', opType: 'pump',
    flowsheetId: 'f1', projectId: 'p1', nodeId: 'rfp_p', running: false, tripped: false, opened: null, closed: null, quality: 'good', at: '2026-09-07T09:59:58Z',
    status: { tagId: 'xs', tag: 'RFP-P-201/1.XS', value: 0, quality: 'good' },
    command: { bindingId: 'b-cmd', tag: 'RFP-P-201/1.XY', flowsheetId: 'f1', projectId: 'p1', lastValue: null },
  }],
  alarms: { active: [
    { id: 'a1', severity: 'warning', message: 'EQT TSS 380 exceeded max 350', triggeredAt: '2026-09-07T09:50:00Z', acknowledged: false, ruleName: 'EQT solids', area: 'EQT', flowsheetId: 'f1' },
  ], counts: { critical: 0, warning: 1, info: 0, unacknowledged: 1 } },
  comms: { connections: [{ id: 'c1', name: 'ITC STP — Simulator', protocol: 'simulator', status: 'online', enabled: true, bindings: 4, good: 4, stale: 0, bad: 0 }], bindings: { total: 4, good: 4, stale: 0, bad: 0, unknown: 0 } },
  tasks: { counts: { assigned: 2, completed: 1 }, open: 2, awaitingApproval: 1, overdue: 0 },
};

function mount() {
  return render(<MemoryRouter initialEntries={['/live']}><LivePlantPage /></MemoryRouter>);
}

beforeEach(() => {
  vi.clearAllMocks();
  ROLE = 'operator';
  liveHandlers = {};
  localStorage.clear();
  api.get.mockImplementation((url) => {
    if (url.startsWith('/live/snapshot')) return Promise.resolve({ data: JSON.parse(JSON.stringify(SNAPSHOT)) });
    if (url.startsWith('/tags/history')) return Promise.resolve({ data: { series: [{ tagId: 'ft', points: [[1, 600], [2, 620], [3, 610]] }] } });
    return Promise.reject(new Error(`unexpected GET ${url}`));
  });
  api.post.mockResolvedValue({ data: { ok: true } });
});

describe('measured symbol state', () => {
  it('drives the symbol from contacts, never from a model', () => {
    const pump = { key: 'P', opType: 'pump', running: true, tripped: false, quality: 'good' };
    expect(measuredSnapshot(pump).metrics).toEqual({ status: 'ON', speed_pct: 100 });
    expect(measuredState(pump)).toBe('rest');
    expect(describeState(pump).label).toBe('Running');
    expect(measuredState({ ...pump, running: false })).toBe('off');
    expect(measuredState({ ...pump, tripped: true })).toBe('alarm');
    expect(measuredState({ ...pump, quality: 'stale' })).toBe('error');
    expect(measuredState({ key: 'P', opType: 'pump', running: null })).toBe('nomodel');
    const valve = { key: 'V', opType: 'valve', opened: true, closed: false, quality: 'good' };
    expect(measuredSnapshot(valve).metrics).toEqual({ status: 'OPEN', opening_pct: 100 });
    expect(describeState({ ...valve, opened: false, closed: false }).label).toBe('Travelling');
    const blower = { key: 'B', opType: 'blower', running: true, quality: 'good' };
    expect(measuredSnapshot(blower).derived).toEqual({ servedCount: 1, O2_served: 1 });
  });
});

describe('LivePlantPage', () => {
  it('draws areas with gauges and equipment in their measured state, plus comms and alarms', async () => {
    mount();
    const areas = await screen.findByRole('list', { name: 'Process areas' });
    const rfp = within(areas).getByRole('region', { name: 'Reactor Feed Pump Process' });
    // 612.5 m³/d reads "613" on a gauge: whole numbers above 100.
    expect(within(rfp).getByRole('img', { name: /RFP-FT-201\.FT 61[23] m3\/d/ })).toBeInTheDocument();
    const card = rfp.querySelector('[data-equipment="RFP-P-201/1"]');
    expect(card).toHaveAttribute('data-state', 'off');
    expect(within(card).getByText('Stopped')).toBeInTheDocument();
    expect(card.querySelector('svg g[data-running="false"] .mimic-spin')).toBeNull(); // the same pump as the schematic, impeller parked
    expect(screen.getByText(/0 critical · 1 warning · 1 unacknowledged/)).toBeInTheDocument();
    expect(screen.getByText(/2 open tasks · 1 awaiting approval/)).toBeInTheDocument();
    expect(screen.getByText('ITC STP — Simulator')).toBeInTheDocument();
    const strip = screen.getByRole('region', { name: 'Active alarms' });
    expect(within(strip).getByText(/EQT TSS 380/)).toBeInTheDocument();
    expect(screen.getByTestId('ws-status')).toHaveTextContent('live');
  });

  it('a plc:update on the socket moves the gauge and starts the pump', async () => {
    mount();
    await screen.findByRole('list', { name: 'Process areas' });
    act(() => {
      liveHandlers.onPlcUpdate([
        { tagId: 'ft', value: 700.25, quality: 'good', ts: '2026-09-07T10:00:05Z' },
        { tagId: 'xs', value: 1, quality: 'good', ts: '2026-09-07T10:00:05Z' },
      ]);
    });
    expect(await screen.findByRole('img', { name: /RFP-FT-201\.FT 700/ })).toBeInTheDocument();
    const card = document.querySelector('[data-equipment="RFP-P-201/1"]');
    await waitFor(() => expect(card).toHaveAttribute('data-state', 'rest'));
    expect(within(card).getByText('Running')).toBeInTheDocument();
    expect(card.querySelector('svg g[data-running="true"] .mimic-spin')).toBeTruthy(); // impeller spinning
    expect(within(card).getByRole('button', { name: 'stop RFP-P-201/1' })).toBeInTheDocument();
  });

  it('an alarm raised on the socket joins the strip, acknowledges, and clears', async () => {
    const user = userEvent.setup();
    mount();
    await screen.findByRole('region', { name: 'Active alarms' });
    act(() => {
      liveHandlers.onAlarmEvent({ transition: 'raised', event: { id: 'a2', severity: 'critical', message: 'R1 decant TSS 45 exceeded max 30', triggeredAt: '2026-09-07T10:00:10Z', acknowledged: false, ruleName: 'R1 decant', state: 'active' } });
    });
    const strip = screen.getByRole('region', { name: 'Active alarms' });
    expect(await within(strip).findByText(/R1 decant TSS 45/)).toBeInTheDocument();
    expect(screen.getByText(/1 critical · 1 warning · 2 unacknowledged/)).toBeInTheDocument();

    await user.click(within(strip).getByRole('button', { name: 'Acknowledge R1 decant' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/alarms/events/a2/ack'));

    act(() => { liveHandlers.onAlarmEvent({ transition: 'cleared', event: { id: 'a2', state: 'cleared' } }); });
    await waitFor(() => expect(within(strip).queryByText(/R1 decant TSS 45/)).toBeNull());
  });

  it('Start confirms, then writes 1 to the command binding through the PLC write endpoint', async () => {
    const user = userEvent.setup();
    mount();
    await screen.findByRole('list', { name: 'Process areas' });
    await user.click(screen.getByRole('button', { name: 'start RFP-P-201/1' }));
    const dlg = screen.getByRole('dialog', { name: 'Start RFP-P-201/1' });
    const confirm = within(dlg).getByRole('button', { name: /Start RFP-P-201\/1/ });
    expect(confirm).toBeDisabled();
    await user.click(within(dlg).getByLabelText('I am authorised to operate this equipment'));
    expect(confirm).toBeEnabled();
    await user.click(confirm);
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/projects/p1/flowsheets/f1/plc-bindings/b-cmd/write', { value: 1 }));
    expect(await screen.findByText(/start command written/)).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('shows the PLC refusal inside the dialog', async () => {
    const user = userEvent.setup();
    api.post.mockRejectedValueOnce({ response: { data: { error: 'PLC write failed: connection lost' } } });
    mount();
    await screen.findByRole('list', { name: 'Process areas' });
    await user.click(screen.getByRole('button', { name: 'start RFP-P-201/1' }));
    const dlg = screen.getByRole('dialog', { name: 'Start RFP-P-201/1' });
    await user.click(within(dlg).getByLabelText('I am authorised to operate this equipment'));
    await user.click(within(dlg).getByRole('button', { name: /Start RFP-P-201\/1/ }));
    expect(await within(dlg).findByRole('alert')).toHaveTextContent(/connection lost/);
  });

  it('a viewer sees the plant but neither control nor acknowledgement', async () => {
    ROLE = 'viewer';
    mount();
    await screen.findByRole('list', { name: 'Process areas' });
    expect(screen.queryByRole('button', { name: /start RFP-P-201/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Acknowledge/ })).toBeNull();
  });

  it('with a plant flowsheet the schematic is the default view: machines drawn from the canvas, selection opens the points panel with control', async () => {
    const user = userEvent.setup();
    const CANVAS = {
      nodes: [
        { id: 'in', type: 'unitOp', position: { x: 0, y: 0 }, data: { opType: 'inlet', label: 'Sewage', tags: [] } },
        { id: 'rfp_p', type: 'unitOp', position: { x: 300, y: 0 }, data: { opType: 'pump', label: 'RFP — Reactor feed pump', area: 'RFP', tags: ['RFP-P-201'] } },
        { id: 'ft_201', type: 'unitOp', position: { x: 600, y: 0 }, data: { opType: 'instrument', label: 'FT-201', area: 'RFP', tags: ['RFP-FT-201'] } },
      ],
      edges: [{ id: 'e1', source: 'in', target: 'rfp_p', data: { streamType: 'stream' } }, { id: 'e2', source: 'rfp_p', target: 'ft_201', data: { streamType: 'stream' } }],
    };
    api.get.mockImplementation((url) => {
      if (url.startsWith('/live/snapshot')) {
        const s = JSON.parse(JSON.stringify(SNAPSHOT));
        s.flowsheets = [{ id: 'f1', projectId: 'p1', name: 'ITC STP — Full plant', bound: 4 }];
        s.tags = s.tags.map((t) => (t.id === 'ft' ? { ...t, nodeId: 'ft_201', fn: 'FT' } : t.id === 'xs' ? { ...t, nodeId: 'rfp_p', fn: 'XS', value: 1 } : t));
        s.equipment = s.equipment.map((e) => ({ ...e, running: true, status: { ...e.status, value: 1 } })); // the pump runs, as its XS says
        return Promise.resolve({ data: s });
      }
      if (url === '/projects/p1/flowsheets/f1') return Promise.resolve({ data: { id: 'f1', canvas_data: CANVAS } });
      if (url.startsWith('/tags/history')) return Promise.resolve({ data: { series: [] } });
      return Promise.reject(new Error(`unexpected GET ${url}`));
    });
    mount();
    const mimic = await screen.findByTestId('mimic');
    expect(screen.getByRole('tab', { name: 'Schematic' })).toHaveAttribute('aria-selected', 'true');
    expect(mimic.querySelectorAll('[data-node]')).toHaveLength(3);
    expect(mimic.querySelector('[data-node="rfp_p"] [data-running]')).toHaveAttribute('data-running', 'true');
    expect(mimic.querySelector('[data-edge="e2"]')).toHaveAttribute('data-flowing', 'true');
    expect(mimic.querySelector('[data-node="ft_201"] [data-quality]')).toHaveAttribute('data-quality', 'good');

    await user.click(mimic.querySelector('[data-node="rfp_p"]'));
    const panel = await screen.findByRole('complementary', { name: 'Selected equipment' });
    expect(within(panel).getByText('RFP — Reactor feed pump')).toBeInTheDocument();
    expect(within(panel).getByText('RFP-P-201/1.XS')).toBeInTheDocument();
    expect(within(panel).getByText('ON')).toBeInTheDocument();
    await user.click(within(panel).getByRole('button', { name: 'stop RFP-P-201/1' }));
    expect(screen.getByRole('dialog', { name: 'Stop RFP-P-201/1' })).toBeInTheDocument();

    // Areas: each area is its own piece of the flow — the same machines and
    // pipes as the schematic, not a card per tag. The pipe from the inlet
    // outside the area is drawn to its (dimmed) far end, and it still flows.
    await user.click(screen.getByRole('tab', { name: 'Areas' }));
    const list = await screen.findByRole('list', { name: 'Process areas' });
    const rfp = within(list).getByRole('region', { name: 'Reactor Feed Pump Process' });
    expect(rfp).toHaveAttribute('data-view', 'flow');
    const area = within(rfp).getByTestId('mimic');
    expect(area.querySelectorAll('[data-node]')).toHaveLength(3);
    expect(area.querySelector('[data-node="in"]')).toHaveAttribute('data-neighbour', 'true');
    expect(area.querySelector('[data-node="rfp_p"]')).not.toHaveAttribute('data-neighbour');
    expect(area.querySelector('[data-node="rfp_p"] .mimic-spin')).toBeTruthy();
    expect(area.querySelector('[data-edge="e1"]')).toHaveAttribute('data-flowing', 'true');
    expect(area.querySelector('[data-edge="e2"]')).toHaveAttribute('data-flowing', 'true');
    expect(within(rfp).queryByRole('img', { name: /RFP-FT-201/ })).toBeNull(); // no separate tag cards
    expect(rfp.querySelector('[data-equipment]')).toBeNull();
    expect(within(rfp).getByText(/1\/1 running/)).toBeInTheDocument();
    // The area with nothing on the canvas keeps its cards.
    const eqt = within(list).getByRole('region', { name: 'Equalisation tank' });
    expect(eqt).toHaveAttribute('data-view', 'cards');
    expect(within(eqt).getByRole('img', { name: /EQT-LT-101.LT 61.2 %/ })).toBeInTheDocument();
    // Selecting a machine inside an area opens the same points panel.
    await user.click(area.querySelector('[data-node="rfp_p"]'));
    expect(within(await screen.findByRole('complementary', { name: 'Selected equipment' })).getByText('RFP-P-201/1.XS')).toBeInTheDocument();
  });

  it('pinned trends fetch their history and draw a sparkline', async () => {
    localStorage.setItem('ws.trendPins', JSON.stringify([{ tagId: 'ft', tag: 'RFP-FT-201.FT', name: 'Reactor feed flow', unit: 'm3/d' }]));
    mount();
    const pinned = await screen.findByRole('region', { name: 'Pinned trends' });
    await waitFor(() => expect(api.get).toHaveBeenCalledWith(expect.stringMatching(/^\/tags\/history\?ids=ft&range=6h/)));
    expect(await within(pinned).findByRole('img', { name: 'RFP-FT-201.FT trend' })).toBeInTheDocument();
    expect(within(pinned).getByText('610')).toBeInTheDocument();
  });
});
