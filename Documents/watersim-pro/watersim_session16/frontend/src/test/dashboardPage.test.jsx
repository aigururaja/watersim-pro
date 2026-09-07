/**
 * DashboardPage — a different home screen per login.
 *
 * What is pinned: the page asks GET /dashboard once and draws exactly the
 * sections the server sent, in order; a viewer gets the plant overview and
 * nothing to act on; an operator's console carries tasks on their desk and
 * the drives; a manager's overview carries approvals and the team; an
 * administrator gets the audit trail and system health; an engineer's desk
 * carries the twin and PLC health; a plc:update moves a reading in place; an
 * alarm event reloads.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import DashboardPage from '../pages/DashboardPage';
import api from '../services/api';

let ROLE = 'operator';
vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'u1', firstName: 'Olivia', role: ROLE, organisation: { name: 'ITC STP' } }, role: ROLE, can: () => true }),
  AuthProvider: ({ children }) => children,
}));
vi.mock('../services/api', () => {
  const mock = { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() };
  return { default: mock, api: mock };
});
vi.mock('../components/layout/AppLayout', () => ({ default: ({ children }) => <div>{children}</div> }));
vi.mock('../components/OnboardingWizard', () => ({ default: () => null, hasCompletedOnboarding: () => true }));
let liveHandlers = {};
vi.mock('../hooks/useOrgLive', () => ({
  useOrgLive: (h) => { liveHandlers = h; return { connected: true }; },
  default: (h) => { liveHandlers = h; return { connected: true }; },
}));

const PLANT = {
  at: '2026-09-07T10:00:00Z', flowsheet: { id: 'f1', projectId: 'p1', name: 'ITC STP — Full plant' }, areas: 18,
  bindings: { total: 76, good: 49, stale: 0, bad: 0, unknown: 27 },
  connections: [{ id: 'c1', name: 'ITC STP — Simulator', protocol: 'simulator', status: 'online', enabled: true, bindings: 76, good: 49 }],
  drives: { total: 15, running: 13, stopped: 1, tripped: 1 }, valves: { total: 16, open: 15, closed: 1 },
  alarms: { critical: 1, warning: 2, info: 0, unacknowledged: 2 }, tasks: { open: 3, overdue: 1, awaitingApproval: 1 },
};
const ALARMS = { counts: PLANT.alarms, active: [{ id: 'a1', severity: 'critical', message: 'RFP-P-201/1 tripped', triggeredAt: '2026-09-07T09:50:00Z', acknowledged: false }], last24h: { critical: 1, warning: 4, info: 0, cleared: 3 }, mttaMinutes: 12.4, noisy: [{ ruleId: 'r1', name: 'EQT solids', severity: 'warning', n: 7 }] };
const READINGS = { items: [{ id: 'ft', tag: 'RFP-FT-201.FT', name: 'Reactor feed flow', area: 'RFP', fn: 'FT', value: 612.5, unit: 'm3/d', quality: 'good', at: '2026-09-07T09:59:58Z', rangeMin: 0, rangeMax: 800 }], total: 1 };

const BY_ROLE = {
  viewer: { role: 'viewer', sections: ['plant', 'alarms', 'readings'], plant: PLANT, alarms: ALARMS, readings: READINGS },
  operator: {
    role: 'operator', sections: ['plant', 'alarms', 'equipment', 'myTasks', 'readings'], plant: PLANT, alarms: ALARMS, readings: READINGS,
    equipment: { running: 13, total: 15, tripped: [{ key: 'RFP-P-201/1', name: 'Reactor feed pump 1', tripped: true }], stopped: [{ key: 'FFP-P-501/2', name: 'Filter feed pump 2' }] },
    myTasks: { items: [{ id: 't1', number: 12, title: 'Hose down the fine screen', priority: 'medium', state: 'assigned', dueAt: '2026-09-07T18:00:00Z', overdue: false, mine: true }], total: 1, overdue: 0, unassigned: 0 },
  },
  engineer: {
    role: 'engineer', sections: ['plant', 'alarms', 'myTasks', 'twin', 'plc', 'counters', 'projects', 'runs'], plant: PLANT, alarms: ALARMS,
    myTasks: { items: [{ id: 't2', number: 13, title: 'Grease the reactor feed pump', priority: 'high', state: 'open', dueAt: null, overdue: false, mine: false }], total: 1, overdue: 0, unassigned: 1 },
    twin: { items: [{ flowsheetId: 'f2', flowsheetName: 'ITC STP — Full plant', projectId: 'p2', projectName: 'ITC STP — Digital twin', imported: true, enabled: true, cadenceS: 30, driftZ: 3, solvedAt: '2026-09-07T09:59:30Z', error: null, residuals: 6, worst: { tag: 'RFP-FT-201.FT', z: 0.8 }, driftAlarms: 0 }] },
    plc: { connections: PLANT.connections, bindings: PLANT.bindings, unhealthy: [] },
    counters: { days: 7, items: [{ key: 'RFP-P-201/1', name: 'Reactor feed pump 1', runHours: 61.5, starts: 12, trips: 1 }] },
    projects: { monitoring: 1, twin: 1, total: 2, recent: [{ id: 'p1', name: 'ITC STP — Monitoring & Control', kind: 'monitoring', updatedAt: '2026-09-07T09:00:00Z', flowsheets: 1 }] },
    runs: { items: [] },
  },
  manager: {
    role: 'manager', sections: ['plant', 'approvals', 'alarms', 'myTasks', 'counters', 'notifications', 'team'], plant: PLANT, alarms: ALARMS,
    approvals: { awaiting: [{ id: 't3', number: 9, title: 'Replace blower belt', priority: 'high', completedAt: '2026-09-07T08:00:00Z', assignedToName: 'Eli Engineer' }], overdue: [], counts: { awaiting: 1, overdue: 1, open: 3, approved7d: 4, created7d: 6, rejected: 0 } },
    myTasks: { items: [], total: 0, overdue: 0, unassigned: 0 },
    counters: { days: 7, items: [] }, notifications: { last24h: { sent: 8, pending: 0, failed: 1, dead: 0, email: 6, whatsapp: 3, webhook: 0 }, subscriptions: { n: 7, enabled: 7 } },
    team: { byRole: { admin: { total: 1, active: 1 }, engineer: { total: 1, active: 1 } }, total: 2, active: 2, recentLogins: [{ id: 'u2', name: 'Eli Engineer', role: 'engineer', lastLoginAt: '2026-09-07T09:00:00Z', active: true }] },
  },
  admin: {
    role: 'admin', sections: ['plant', 'approvals', 'team', 'integrations', 'notifications', 'plc', 'twin', 'audit', 'system'], plant: PLANT,
    approvals: { awaiting: [], overdue: [], counts: { awaiting: 0, overdue: 0, open: 0, approved7d: 0, created7d: 0, rejected: 0 } },
    team: { byRole: {}, total: 4, active: 4, recentLogins: [] },
    integrations: { apiKeys: { active: 1, total: 2, lastUsedAt: '2026-09-07T09:30:00Z' }, webhooks: [{ id: 'w1', name: 'CMMS hydrogen', url: 'https://cmms.example/hook', enabled: true, lastStatus: 200, failures: 0, healthy: true }] },
    notifications: { last24h: { sent: 0, pending: 0, failed: 0, dead: 0 }, subscriptions: { n: 7, enabled: 7 } },
    plc: { connections: PLANT.connections, bindings: PLANT.bindings, unhealthy: [] }, twin: { items: [] },
    audit: { items: [{ id: 'l1', action: 'project.import', actor: 'Ada Admin', actorRole: 'admin', at: '2026-09-07T09:45:00Z' }] },
    system: { uptimeS: 4000, node: 'v22', samplesLastHour: 1200, historian: [{ name: 'rollup_1m', lastRunAt: '2026-09-07T09:59:00Z', lastError: null }], partitions: 4 },
  },
};

const mount = () => render(<MemoryRouter><DashboardPage /></MemoryRouter>);

beforeEach(() => {
  vi.clearAllMocks();
  liveHandlers = {};
  api.get.mockImplementation((url) => (url === '/dashboard' ? Promise.resolve({ data: JSON.parse(JSON.stringify(BY_ROLE[ROLE])) }) : Promise.reject(new Error(`unexpected GET ${url}`))));
});

describe('DashboardPage', () => {
  it('a viewer gets the plant overview with alarms and readings, and nothing to act on', async () => {
    ROLE = 'viewer';
    mount();
    expect(await screen.findByRole('heading', { name: 'Plant overview' })).toBeInTheDocument();
    expect(api.get).toHaveBeenCalledWith('/dashboard');
    expect(screen.getByTestId('plant-strip')).toHaveTextContent('49');
    const sections = [...screen.getByRole('list', { name: 'Dashboard sections' }).children].map((li) => li.querySelector('section')?.getAttribute('aria-label'));
    expect(sections).toEqual(['Alarms', 'Key readings']);
    expect(screen.queryByTestId('card-my-tasks')).toBeNull();
    expect(screen.queryByTestId('card-approvals')).toBeNull();
    expect(screen.getByText('RFP-P-201/1 tripped')).toBeInTheDocument();
  });

  it("an operator's console carries the drives and the tasks on their desk; readings move on plc:update", async () => {
    ROLE = 'operator';
    mount();
    expect(await screen.findByRole('heading', { name: 'Operator console' })).toBeInTheDocument();
    expect(within(screen.getByTestId('card-equipment')).getByText('Reactor feed pump 1')).toBeInTheDocument();
    expect(within(screen.getByTestId('card-my-tasks')).getByText('Hose down the fine screen')).toBeInTheDocument();
    expect(screen.queryByTestId('card-twin')).toBeNull();
    const tile = screen.getByTestId('card-readings').querySelector('[data-tag="RFP-FT-201.FT"]');
    expect(tile).toHaveTextContent('613');
    await act(async () => { liveHandlers.onPlcUpdate({ values: [{ tagId: 'ft', value: 640.2, quality: 'good', ts: '2026-09-07T10:00:05Z' }] }); });
    expect(tile).toHaveTextContent('640');
    // An alarm event reloads the numbers (debounced).
    await act(async () => { liveHandlers.onAlarmEvent({ event: { id: 'a2' }, transition: 'raised' }); });
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(2), { timeout: 3000 });
  });

  it("an engineer's desk carries the twin, PLC health, run hours and projects", async () => {
    ROLE = 'engineer';
    mount();
    expect(await screen.findByRole('heading', { name: "Engineer's desk" })).toBeInTheDocument();
    expect(within(screen.getByTestId('card-twin')).getByText('ITC STP — Digital twin')).toBeInTheDocument();
    expect(within(screen.getByTestId('card-plc')).getByText('ITC STP — Simulator')).toBeInTheDocument();
    expect(within(screen.getByTestId('card-counters')).getByText('RFP-P-201/1')).toBeInTheDocument();
    expect(within(screen.getByTestId('card-my-tasks')).getByText('for your role')).toBeInTheDocument();
    expect(within(screen.getByTestId('card-alarms')).getByText('EQT solids')).toBeInTheDocument(); // noisy rules, engineers and managers only
    expect(screen.queryByTestId('card-team')).toBeNull();
  });

  it("a manager's overview carries approvals, notifications and the team", async () => {
    ROLE = 'manager';
    mount();
    expect(await screen.findByRole('heading', { name: "Manager's overview" })).toBeInTheDocument();
    expect(within(screen.getByTestId('card-approvals')).getByText('Replace blower belt')).toBeInTheDocument();
    expect(within(screen.getByTestId('card-notifications')).getByText(/6 email · 3 WhatsApp/)).toBeInTheDocument();
    expect(within(screen.getByTestId('card-team')).getByText('Eli Engineer')).toBeInTheDocument();
    expect(screen.queryByTestId('card-audit')).toBeNull();
  });

  it('an administrator gets integrations, the audit trail and system health', async () => {
    ROLE = 'admin';
    mount();
    expect(await screen.findByRole('heading', { name: 'Administration' })).toBeInTheDocument();
    expect(within(screen.getByTestId('card-integrations')).getByText('CMMS hydrogen')).toBeInTheDocument();
    expect(within(screen.getByTestId('card-audit')).getByText('project.import')).toBeInTheDocument();
    expect(within(screen.getByTestId('card-system')).getByText('rollup_1m')).toBeInTheDocument();
    expect(screen.queryByTestId('card-my-tasks')).toBeNull();
  });

  it('shows the error and retries', async () => {
    ROLE = 'operator';
    api.get.mockRejectedValueOnce({ response: { data: { error: 'boom' } } });
    mount();
    expect(await screen.findByRole('alert')).toHaveTextContent('boom');
  });
});
