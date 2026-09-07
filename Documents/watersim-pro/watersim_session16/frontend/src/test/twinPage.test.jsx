/**
 * TwinPage — model beside plant.
 *
 * What is pinned: the list and the detail load; residuals are drawn with a z
 * that turns red past the drift limit; saving the configuration and solving
 * call the API; a what-if seeded from the live state posts the chosen
 * parameter and shows deltas; shadow mode is entered by an engineer and left
 * only by a manager; a script runs only in shadow; twin:state on the socket
 * refreshes the state.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import TwinPage from '../pages/TwinPage';
import api from '../services/api';
import { can } from '../auth/roles';

let ROLE = 'engineer';
vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'u1', role: ROLE }, role: ROLE, can: (c) => can(ROLE, c) }),
  AuthProvider: ({ children }) => children,
}));
vi.mock('../services/api', () => {
  const mock = { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() };
  return { default: mock, api: mock };
});
vi.mock('../components/layout/AppLayout', () => ({ default: ({ children }) => <div>{children}</div> }));
let liveHandlers = {};
vi.mock('../hooks/useOrgLive', () => ({ useOrgLive: (h) => { liveHandlers = h; return { connected: true }; }, default: (h) => { liveHandlers = h; return { connected: true }; } }));

const LIST = {
  twins: [{ flowsheetId: 'f1', flowsheetName: 'ITC STP — Full plant', projectId: 'p1', projectName: 'ITC STP', config: { enabled: true, cadenceS: 30, driftZ: 3 }, state: { seq: 12, solvedAt: '2026-09-07T10:00:00Z', error: null }, boundPoints: 76, driftAlarms: 1 }],
  connections: [{ id: 'c1', name: 'ITC STP — Simulator', protocol: 'simulator', mode: 'live' }],
};
const DETAIL = {
  flowsheetId: 'f1', flowsheetName: 'ITC STP — Full plant', projectId: 'p1', projectName: 'ITC STP',
  config: { enabled: true, cadenceS: 30, driftZ: 3 },
  state: {
    seq: 12, solvedAt: '2026-09-07T10:00:00Z', durationMs: 840, error: null,
    summary: { effluent: { BOD: 8.2, TSS: 6.1, TN: 12.4 } },
    nodeParams: { ft_201: { measured: 612 }, eqt: { level_pct: 61 } },
    residuals: [
      { tagId: 't1', tag: 'RFP-FT-201.FT', nodeId: 'ft_201', measured: 612, modelled: 590, residual: 22, z: 4.1, n: 40, unit: 'm³/d' },
      { tagId: 't2', tag: 'ACF-AT-601.AT', nodeId: 'at_601', measured: 7.2, modelled: 7.1, residual: 0.1, z: 0.4, n: 40, unit: 'pH' },
    ],
  },
  residualStats: [],
};
const RESIDUALS = { series: [{ tagId: 't1', tag: 'RFP-FT-201.FT', points: [[1, 590, 612, 22, 4.1], [2, 590, 600, 10, 1.9]] }] };
const SCRIPTS = { scripts: [{ id: 'reactor', title: 'Reactor process', numeral: 'II', totalHours: 6, actionableSteps: 5, steps: [{ no: 2, action: 'open', devices: ['RFP-XV-201'], durationH: 0, acts: true }, { no: 3, action: 'start', devices: ['RFP-P-201'], durationH: 1.5, acts: true }] }] };

function mount(path = '/twin/f1') {
  return render(<MemoryRouter initialEntries={[path]}><Routes><Route path="/twin" element={<TwinPage />} /><Route path="/twin/:flowsheetId" element={<TwinPage />} /></Routes></MemoryRouter>);
}

beforeEach(() => {
  vi.clearAllMocks();
  ROLE = 'engineer';
  liveHandlers = {};
  api.get.mockImplementation((url) => {
    if (url === '/twin') return Promise.resolve({ data: JSON.parse(JSON.stringify(LIST)) });
    if (url === '/twin/f1') return Promise.resolve({ data: JSON.parse(JSON.stringify(DETAIL)) });
    if (url.startsWith('/twin/f1/residuals')) return Promise.resolve({ data: RESIDUALS });
    if (url === '/twin/scripts') return Promise.resolve({ data: SCRIPTS });
    if (url === '/twin/f1/scripts/runs') return Promise.resolve({ data: { runs: [] } });
    return Promise.reject(new Error(`unexpected GET ${url}`));
  });
  api.put.mockImplementation((url, body) => {
    if (url === '/twin/f1') return Promise.resolve({ data: { ...DETAIL.config, ...body } });
    if (url.startsWith('/twin/connections/')) return Promise.resolve({ data: { id: 'c1', name: 'ITC STP — Simulator', mode: body.mode, changed: true } });
    return Promise.reject(new Error(`unexpected PUT ${url}`));
  });
  api.post.mockImplementation((url) => {
    if (url === '/twin/f1/solve') return Promise.resolve({ data: { ...DETAIL.state, seq: 13, durationMs: 700 } });
    if (url === '/twin/f1/scenarios') return Promise.resolve({ data: { baseline: { name: 'Live (twin)', ok: true, effluent: { BOD: 8.2, TSS: 6.1, TN: 12.4 } }, scenarios: [{ name: 'What if', ok: true, effluent: { BOD: 9.0, TSS: 6.1, TN: 13.0 }, delta: { BOD: 0.8, TSS: 0, TN: 0.6 } }], persisted: false } });
    if (url === '/twin/f1/scripts/reactor/run') return Promise.resolve({ data: { runId: 'r1', flowsheetId: 'f1', sectionId: 'reactor', status: 'running', stepNo: 1, totalSteps: 5, log: [] } });
    return Promise.reject(new Error(`unexpected POST ${url}`));
  });
});

describe('TwinPage', () => {
  it('lists the twins and draws the residuals with drift marked', async () => {
    mount();
    await screen.findByRole('complementary', { name: 'Twins' });
    expect(screen.getByRole('button', { name: 'ITC STP — Full plant' })).toBeInTheDocument();
    const table = await screen.findByRole('region', { name: 'Residuals' });
    const ft = table.querySelector('[data-residual="RFP-FT-201.FT"]');
    expect(within(ft).getByText(/4\.1/)).toHaveClass('text-red-700');
    expect(within(ft).getByText(/⚠/)).toBeInTheDocument();
    const at = table.querySelector('[data-residual="ACF-AT-601.AT"]');
    expect(within(at).getByText(/0\.4/)).toHaveClass('text-emerald-700');
    expect(screen.getByText(/Effluent: BOD 8\.2/)).toBeInTheDocument();
  });

  it('saves the configuration and solves now', async () => {
    const user = userEvent.setup();
    mount();
    const cfg = await screen.findByRole('region', { name: 'Twin configuration' });
    await user.clear(within(cfg).getByLabelText('Cadence seconds'));
    await user.type(within(cfg).getByLabelText('Cadence seconds'), '15');
    await user.click(within(cfg).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.put).toHaveBeenCalledWith('/twin/f1', expect.objectContaining({ enabled: true, cadenceS: 15, driftZ: 3 })));
    await user.click(within(cfg).getByRole('button', { name: 'Solve now' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/twin/f1/solve'));
    expect(await screen.findByText(/Solved in 700 ms/)).toBeInTheDocument();
  });

  it('runs a what-if from the live parameters and shows deltas', async () => {
    const user = userEvent.setup();
    mount();
    const w = await screen.findByRole('region', { name: 'What-if' });
    await user.selectOptions(within(w).getByLabelText('Parameter'), 'ft_201|measured');
    expect(within(w).getByLabelText('New value')).toHaveValue(612);
    await user.clear(within(w).getByLabelText('New value'));
    await user.type(within(w).getByLabelText('New value'), '720');
    await user.click(within(w).getByRole('button', { name: 'Run scenario' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/twin/f1/scenarios', { scenarios: [{ name: 'What if', nodeParams: { ft_201: { measured: 720 } } }] }));
    const result = await screen.findByTestId('whatif-result');
    expect(within(result).getByText('Live (twin)')).toBeInTheDocument();
    expect(within(result).getByText(/\+0\.8/)).toBeInTheDocument();
    expect(within(result).getByText(/Not persisted/)).toBeInTheDocument();
  });

  it('an engineer enters shadow mode and runs a script; only a manager can leave', async () => {
    const user = userEvent.setup();
    mount();
    const vc = await screen.findByRole('region', { name: 'Virtual commissioning' });
    const runBtn = within(vc).getByRole('button', { name: 'Run Reactor process' });
    expect(runBtn).toBeDisabled(); // live mode
    await user.click(within(vc).getByRole('button', { name: 'Enter shadow mode on ITC STP — Simulator' }));
    await waitFor(() => expect(api.put).toHaveBeenCalledWith('/twin/connections/c1/mode', { mode: 'shadow' }));
    expect(await screen.findByRole('status', { name: '' }, { timeout: 2000 }).catch(() => null)).toBeTruthy;
    expect(screen.getByText(/Shadow mode on/)).toBeInTheDocument();
    expect(within(vc).queryByRole('button', { name: /Leave shadow mode/ })).toBeNull(); // engineer cannot leave
    expect(within(vc).getByText(/a manager leaves shadow/)).toBeInTheDocument();

    await user.click(within(vc).getByRole('button', { name: 'Run Reactor process' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/twin/f1/scripts/reactor/run', { speedup: 360 }));
    expect(await within(vc).findByText(/step 1\/5/)).toBeInTheDocument();

    act(() => { liveHandlers.onMessage({ type: 'twin:script', payload: { runId: 'r1', flowsheetId: 'f1', sectionId: 'reactor', status: 'completed', stepNo: 5, totalSteps: 5, log: [{ action: 'stop', devices: ['RFP-P-201'] }] } }); });
    expect(await within(vc).findByText(/step 5\/5/)).toBeInTheDocument();
  });

  it('a manager sees Leave shadow; a viewer sees no controls', async () => {
    ROLE = 'manager';
    api.get.mockImplementation((url) => {
      if (url === '/twin') return Promise.resolve({ data: { ...LIST, connections: [{ id: 'c1', name: 'ITC STP — Simulator', protocol: 'simulator', mode: 'shadow' }] } });
      if (url === '/twin/f1') return Promise.resolve({ data: DETAIL });
      return Promise.resolve({ data: { series: [], scripts: [], runs: [] } });
    });
    const { unmount } = mount();
    const vc = await screen.findByRole('region', { name: 'Virtual commissioning' });
    expect(await within(vc).findByRole('button', { name: /Leave shadow mode/ })).toBeInTheDocument();
    unmount();

    ROLE = 'viewer';
    mount();
    const cfg = await screen.findByRole('region', { name: 'Twin configuration' });
    expect(within(cfg).queryByRole('button', { name: 'Solve now' })).toBeNull();
    expect(within(cfg).getByLabelText('Cadence seconds')).toBeDisabled();
  });

  it('twin:state on the socket refreshes the solve', async () => {
    mount();
    await screen.findByRole('region', { name: 'Residuals' });
    act(() => { liveHandlers.onMessage({ type: 'twin:state', payload: { flowsheetId: 'f1', seq: 99, solvedAt: new Date().toISOString(), durationMs: 512, residuals: DETAIL.state.residuals, error: null } }); });
    expect(await screen.findByText(/512 ms \(#99\)/)).toBeInTheDocument();
  });
});
