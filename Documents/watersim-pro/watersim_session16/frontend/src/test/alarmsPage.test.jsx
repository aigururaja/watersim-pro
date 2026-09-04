/**
 * AlarmsPage — the org-wide alarm history.
 *
 * The two things worth pinning are the ones a user acts on: that a row from the
 * API renders everything an operator needs to triage it, and that Ack hits the
 * endpoint and updates the row in place (optimistically, and reverting when the
 * server refuses).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import AlarmsPage from '../pages/AlarmsPage';
import api from '../services/api';
import { downloadFile } from '../utils/download';

vi.mock('../services/api', () => {
  const mock = { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn(), request: vi.fn() };
  return { default: mock, api: mock };
});

vi.mock('../utils/download', () => ({
  downloadFile: vi.fn().mockResolvedValue('file'),
  default: vi.fn(),
}));

// The page reads the user's role for the acknowledge gate.
let ROLE = 'engineer';
vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'u1', firstName: 'Eddie', role: ROLE } }),
  AuthProvider: ({ children }) => children,
}));

vi.mock('../components/AccessibilityProvider', () => ({
  useAnnounce: () => () => {},
  useReducedMotion: () => false,
  default: ({ children }) => children,
}));

// AppLayout drags in the whole sidebar/router surface — the page under test is
// what matters here, so it is reduced to a passthrough.
vi.mock('../components/layout/AppLayout', () => ({
  default: ({ children }) => <div>{children}</div>,
}));

// GET /alarms/events (formatEvent shape).
const EVENTS = [
  {
    id: 'e1', ruleId: 'r1', ruleName: 'Effluent nitrogen over permit',
    flowsheetId: 'f1', flowsheetName: 'Main Treatment Train',
    projectId: 'p1', projectName: 'Municipal WWTP — Demo',
    runId: 'run1', source: 'simulation', state: 'active', severity: 'critical',
    message: 'Effluent TN 52.85 exceeded max 10',
    value: 53.07, limitMin: null, limitMax: 10,
    triggeredAt: '2026-09-04T03:31:30.785Z', lastSeenAt: '2026-09-04T04:18:03.155Z',
    clearedAt: null, acknowledged: false, acknowledgedBy: null,
    acknowledgedByName: null, acknowledgedAt: null,
  },
  {
    id: 'e2', ruleId: 'r2', ruleName: 'Aeration DO low',
    flowsheetId: 'f2', flowsheetName: 'RO Skid',
    projectId: 'p2', projectName: 'Industrial RO System',
    runId: null, source: 'plc', state: 'cleared', severity: 'warning',
    message: 'Aeration Basin DO 0.8 below min 1.5',
    value: 0.8, limitMin: 1.5, limitMax: null,
    triggeredAt: '2026-09-03T09:00:00.000Z', lastSeenAt: '2026-09-03T09:30:00.000Z',
    clearedAt: '2026-09-03T10:00:00.000Z', acknowledged: true,
    acknowledgedByName: 'Olivia Operator', acknowledgedAt: '2026-09-03T10:05:00.000Z',
  },
];

const mockList = (events = EVENTS, total = events.length) => {
  api.get.mockImplementation((url) => {
    if (url.startsWith('/alarms/events')) return Promise.resolve({ data: { total, events } });
    return Promise.reject(new Error(`unexpected GET ${url}`));
  });
};

const renderPage = () => render(<MemoryRouter><AlarmsPage /></MemoryRouter>);

beforeEach(() => {
  vi.clearAllMocks();
  ROLE = 'engineer';
  mockList();
  api.post.mockResolvedValue({ data: {} });
  downloadFile.mockResolvedValue('file');
});

// ── Rendering ───────────────────────────────────────────────────────────────

describe('AlarmsPage — rows', () => {
  it('renders a row per event from the mocked payload', async () => {
    renderPage();
    expect(await screen.findByText('Effluent nitrogen over permit')).toBeInTheDocument();
    expect(screen.getByText('Aeration DO low')).toBeInTheDocument();
    expect(screen.getByText('Effluent TN 52.85 exceeded max 10')).toBeInTheDocument();

    expect(api.get).toHaveBeenCalledWith(expect.stringContaining('/alarms/events?'));
    expect(api.get.mock.calls[0][0]).toContain('limit=50');
    expect(api.get.mock.calls[0][0]).toContain('offset=0');
  });

  it('shows severity, state and source as distinct pills', async () => {
    const { container } = renderPage();
    await screen.findByText('Effluent nitrogen over permit');

    expect(container.querySelector('[data-severity="critical"]')).toHaveTextContent('Critical');
    expect(container.querySelector('[data-severity="warning"]')).toHaveTextContent('Warning');
    expect(container.querySelector('[data-state="active"]')).toHaveTextContent('Active');
    expect(container.querySelector('[data-state="cleared"]')).toHaveTextContent('Cleared');
    expect(container.querySelector('[data-source="simulation"]')).toHaveTextContent('Simulation');
    expect(container.querySelector('[data-source="plc"]')).toHaveTextContent('PLC');
  });

  it('prints both a relative and an absolute timestamp', async () => {
    renderPage();
    await screen.findByText('Effluent nitrogen over permit');
    // Relative for scanning, absolute underneath for the record.
    expect(screen.getAllByText(/ago|just now/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Sep\s+4,\s+2026/).length).toBeGreaterThan(0);
  });

  it('shows the value against its limit', async () => {
    renderPage();
    await screen.findByText('Effluent nitrogen over permit');
    expect(screen.getByText('53.07')).toBeInTheDocument();
    expect(screen.getByText('max 10')).toBeInTheDocument();
    expect(screen.getByText('min 1.5')).toBeInTheDocument();
  });

  it('links a row back to the flowsheet that raised it', async () => {
    renderPage();
    const link = await screen.findByRole('link', { name: 'Main Treatment Train' });
    expect(link).toHaveAttribute('href', '/projects/p1/flowsheets/f1');
  });

  it('shows an EmptyState pointing at where rules are made', async () => {
    mockList([], 0);
    renderPage();
    expect(await screen.findByText('No alarms')).toBeInTheDocument();
    expect(screen.getByText(/click the 🔔 on any parameter/)).toBeInTheDocument();
  });

  it('surfaces a load failure without blanking the page', async () => {
    api.get.mockRejectedValueOnce({ response: { data: { error: 'Alarm service unavailable' } } });
    renderPage();
    expect(await screen.findByRole('alert')).toHaveTextContent('Alarm service unavailable');
  });
});

// ── Acknowledge ─────────────────────────────────────────────────────────────

describe('AlarmsPage — acknowledge', () => {
  it('calls the ack endpoint and updates the row', async () => {
    // POST /alarms/events/:id/ack answers with `RETURNING *` — snake_case, and
    // with acknowledged_by as a bare UUID (no display name).
    api.post.mockResolvedValueOnce({
      data: {
        id: 'e1', rule_id: 'r1', flowsheet_id: 'f1', state: 'active', severity: 'critical',
        message: 'Effluent TN 52.85 exceeded max 10', value: 53.07, limit_max: 10,
        triggered_at: '2026-09-04T03:31:30.785Z',
        acknowledged: true, acknowledged_by: 'u1', acknowledged_at: '2026-09-04T05:00:00.000Z',
      },
    });
    renderPage();
    const ackBtn = await screen.findByRole('button', { name: /Acknowledge alarm Effluent nitrogen over permit/ });

    await userEvent.click(ackBtn);

    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/alarms/events/e1/ack'));
    // The row now reads as acknowledged, and the button is gone. The name the
    // optimistic update put there survives the nameless server response.
    await waitFor(() => expect(screen.getByText('You')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /Acknowledge alarm Effluent nitrogen/ })).not.toBeInTheDocument();
  });

  it('reverts the row when the server refuses', async () => {
    api.post.mockRejectedValueOnce({ response: { data: { error: 'Acknowledge failed' } } });
    renderPage();
    const ackBtn = await screen.findByRole('button', { name: /Acknowledge alarm Effluent nitrogen over permit/ });

    await userEvent.click(ackBtn);

    // The optimistic update is rolled back — the button comes back…
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Acknowledge alarm Effluent nitrogen over permit/ })).toBeInTheDocument());
    // …and the failure is said out loud.
    expect(await screen.findByRole('status')).toHaveTextContent('Acknowledge failed');
  });

  it('offers no Ack on an already-acknowledged row', async () => {
    renderPage();
    await screen.findByText('Aeration DO low');
    expect(screen.getByText('Olivia Operator')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Acknowledge alarm Aeration DO low/ })).not.toBeInTheDocument();
  });

  it('acknowledges a selection in bulk', async () => {
    const many = [
      EVENTS[0],
      { ...EVENTS[0], id: 'e3', ruleName: 'TSS over permit', acknowledged: false },
    ];
    mockList(many);
    api.post.mockResolvedValue({ data: { acknowledged: true } });
    renderPage();
    await screen.findByText('TSS over permit');

    await userEvent.click(screen.getByRole('checkbox', { name: /Select alarm Effluent nitrogen over permit/ }));
    await userEvent.click(screen.getByRole('checkbox', { name: /Select alarm TSS over permit/ }));
    expect(screen.getByText('2 alarms selected')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /Acknowledge selected/ }));

    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(2));
    expect(api.post).toHaveBeenCalledWith('/alarms/events/e1/ack');
    expect(api.post).toHaveBeenCalledWith('/alarms/events/e3/ack');
    expect(await screen.findByRole('status')).toHaveTextContent('Acknowledged 2 of 2');
  });

  it('gives a viewer no acknowledge affordance at all', async () => {
    ROLE = 'viewer';
    renderPage();
    await screen.findByText('Effluent nitrogen over permit');
    expect(screen.queryByRole('button', { name: /Acknowledge alarm/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  });

  it('lets an operator acknowledge (operator+ is the backend gate)', async () => {
    ROLE = 'operator';
    renderPage();
    expect(await screen.findByRole('button', { name: /Acknowledge alarm Effluent nitrogen/ })).toBeInTheDocument();
  });
});

// ── Filters, paging and exports ─────────────────────────────────────────────

describe('AlarmsPage — filters, paging, exports', () => {
  it('sends each filter to the API and offers to clear them', async () => {
    renderPage();
    await screen.findByText('Effluent nitrogen over permit');

    await userEvent.selectOptions(screen.getByLabelText('Filter by severity'), 'critical');
    await waitFor(() => expect(api.get.mock.calls.at(-1)[0]).toContain('severity=critical'));

    await userEvent.selectOptions(screen.getByLabelText('Filter by state'), 'active');
    await waitFor(() => expect(api.get.mock.calls.at(-1)[0]).toContain('state=active'));

    await userEvent.selectOptions(screen.getByLabelText('Filter by acknowledgement'), 'false');
    await waitFor(() => expect(api.get.mock.calls.at(-1)[0]).toContain('acknowledged=false'));

    // Flowsheet options are learned from the events themselves.
    await userEvent.selectOptions(screen.getByLabelText('Filter by flowsheet'), 'f1');
    await waitFor(() => expect(api.get.mock.calls.at(-1)[0]).toContain('flowsheetId=f1'));

    await userEvent.click(screen.getByRole('button', { name: /Clear filters/ }));
    await waitFor(() => expect(api.get.mock.calls.at(-1)[0]).not.toContain('severity='));
  });

  it('covers the whole day when a to-date is given', async () => {
    renderPage();
    await screen.findByText('Effluent nitrogen over permit');
    const to = screen.getByLabelText('Triggered to date');
    await userEvent.type(to, '2026-09-04');
    await waitFor(() => expect(api.get.mock.calls.at(-1)[0]).toContain('2026-09-04T23%3A59%3A59.999Z'));
  });

  it('loads more with an offset and de-dupes what comes back', async () => {
    const page2 = [{ ...EVENTS[0], id: 'e9', ruleName: 'Second page alarm' }];
    api.get
      .mockResolvedValueOnce({ data: { total: 3, events: EVENTS } })
      .mockResolvedValueOnce({ data: { total: 3, events: [EVENTS[0], ...page2] } });
    renderPage();
    await screen.findByText('Effluent nitrogen over permit');

    await userEvent.click(await screen.findByRole('button', { name: /Load more \(2 of 3\)/ }));

    await waitFor(() => expect(api.get.mock.calls.at(-1)[0]).toContain('offset=2'));
    expect(await screen.findByText('Second page alarm')).toBeInTheDocument();
    // e1 came back on both pages and must not be listed twice.
    expect(screen.getAllByText('Effluent nitrogen over permit')).toHaveLength(1);
  });

  it('exports CSV and PDF through downloadFile, carrying the current filters', async () => {
    renderPage();
    await screen.findByText('Effluent nitrogen over permit');
    await userEvent.selectOptions(screen.getByLabelText('Filter by severity'), 'critical');

    await userEvent.click(screen.getByRole('button', { name: /Export CSV/ }));
    await waitFor(() => expect(downloadFile).toHaveBeenCalledWith(
      expect.stringContaining('/alarms/events/export.csv?severity=critical'),
      expect.stringMatching(/^watersim_alarms_.*\.csv$/)
    ));

    await userEvent.click(screen.getByRole('button', { name: /Alarm report \(PDF\)/ }));
    await waitFor(() => expect(downloadFile).toHaveBeenCalledWith(
      expect.stringContaining('/alarms/report/pdf?severity=critical'),
      expect.stringMatching(/^watersim_alarms_.*\.pdf$/)
    ));
  });

  it('says so when an export fails rather than failing silently', async () => {
    downloadFile.mockRejectedValueOnce(new Error('nope'));
    renderPage();
    await screen.findByText('Effluent nitrogen over permit');
    await userEvent.click(screen.getByRole('button', { name: /Export CSV/ }));
    expect(await screen.findByRole('status')).toHaveTextContent('CSV export failed');
  });

  it('reports when everything is loaded', async () => {
    renderPage();
    await screen.findByText('Effluent nitrogen over permit');
    const footer = await screen.findByText(/All 2 alarm events loaded/);
    expect(footer).toBeInTheDocument();
    expect(within(footer).queryByRole('button')).toBeNull();
  });
});
