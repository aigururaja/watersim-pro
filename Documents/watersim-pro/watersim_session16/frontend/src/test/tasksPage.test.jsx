/**
 * TasksPage — the maintenance board and the detail panel.
 *
 * What is pinned: tasks land in the column for their state; the detail panel
 * shows the server's allowed actions and nothing more; a transition posts the
 * action (with the note the action requires) and refreshes; the assign
 * action carries the chosen assignee; creating a task posts the form; and a
 * viewer sees no "New task".
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import TasksPage from '../pages/TasksPage';
import api from '../services/api';
import { can } from '../auth/roles';

let ROLE = 'manager';
vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'u-mgr', firstName: 'Meera', role: ROLE, email: 'm@x' }, role: ROLE, can: (c) => can(ROLE, c) }),
  AuthProvider: ({ children }) => children,
}));
vi.mock('../services/api', () => {
  const mock = { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() };
  return { default: mock, api: mock };
});
vi.mock('../components/layout/AppLayout', () => ({ default: ({ children }) => <div>{children}</div> }));

const task = (over) => ({
  id: 't1', number: 'WO-00001', title: 'R1 decant carrying solids', description: 'TSS 45 exceeded max 30.', priority: 'urgent',
  severity: 'critical', state: 'assigned', requiresApproval: true, requiresAck: true, acknowledgedAt: null,
  assignedTo: 'u-eng', assignedToName: 'Process Engineer', assignedToRole: 'engineer', dueAt: new Date(Date.now() + 3600_000).toISOString(),
  overdue: false, flowsheetId: 'f1', flowsheetName: 'ITC STP', projectId: 'p1', tag: 'R-LT-301/1.LT', createdSource: 'evaluator',
  createdByName: 'system · evaluator', event: { state: 'active', severity: 'critical' }, ...over,
});
const LIST = {
  total: 3, counts: { open: 1, assigned: 1, in_progress: 0, completed: 1, approved: 0, rejected: 0, cancelled: 0 },
  tasks: [
    task(),
    task({ id: 't2', number: 'WO-00002', title: 'Replace seal', state: 'open', assignedTo: null, assignedToName: null, priority: 'medium', requiresAck: false, severity: null, event: null }),
    task({ id: 't3', number: 'WO-00003', title: 'Belt check', state: 'completed', priority: 'low', requiresAck: false, completionNote: 'done' }),
  ],
};
const DETAIL = (over = {}) => ({
  ...task(over),
  allowedActions: over.allowedActions || ['assign', 'start', 'acknowledge', 'cancel'],
  transitions: [{ id: 'x1', action: 'create', fromState: null, toState: 'assigned', actorName: 'system · evaluator', createdAt: new Date().toISOString(), note: 'Assigned to engineer' }],
  comments: [],
});
const ASSIGNEES = { assignees: [{ id: 'u-eng', name: 'Process Engineer', role: 'engineer', openTasks: 2 }, { id: 'u-eng2', name: 'Second Engineer', role: 'engineer', openTasks: 0 }] };

function mount(path = '/tasks') {
  return render(<MemoryRouter initialEntries={[path]}><TasksPage /></MemoryRouter>);
}

beforeEach(() => {
  vi.clearAllMocks();
  ROLE = 'manager';
  api.get.mockImplementation((url) => {
    if (url.startsWith('/tasks/assignees')) return Promise.resolve({ data: ASSIGNEES });
    if (url.startsWith('/tasks/t1')) return Promise.resolve({ data: DETAIL() });
    if (url.startsWith('/tasks/t3')) return Promise.resolve({ data: DETAIL({ id: 't3', number: 'WO-00003', state: 'completed', allowedActions: ['approve', 'reject', 'cancel'] }) });
    if (url.startsWith('/tasks/t9')) return Promise.resolve({ data: DETAIL({ id: 't9', number: 'WO-00009', title: 'Grease the decanter drive' }) });
    if (url.startsWith('/tasks')) return Promise.resolve({ data: LIST });
    return Promise.reject(new Error(`unexpected GET ${url}`));
  });
  api.post.mockImplementation((url, body) => {
    if (url.endsWith('/transition')) return Promise.resolve({ data: { ...task(), number: 'WO-00001', state: body.action === 'start' ? 'in_progress' : 'assigned' } });
    if (url.endsWith('/comments')) return Promise.resolve({ data: { id: 'c1' } });
    if (url === '/tasks') return Promise.resolve({ data: task({ id: 't9', number: 'WO-00009', title: body.title, state: 'assigned' }) });
    return Promise.reject(new Error(`unexpected POST ${url}`));
  });
});

describe('TasksPage', () => {
  it('lays the board out by state and shows the manager-ack flag', async () => {
    mount();
    const board = await screen.findByRole('list', { name: 'Task board' });
    const col = (name) => within(board).getByRole('region', { name });
    expect(within(col('Assigned')).getByText('R1 decant carrying solids')).toBeInTheDocument();
    expect(within(col('Open')).getByText('Replace seal')).toBeInTheDocument();
    expect(within(col('Awaiting approval')).getByText('Belt check')).toBeInTheDocument();
    expect(within(board).queryByRole('region', { name: 'Closed' })).toBeNull(); // collapsed until asked
    expect(within(col('Assigned')).getByText(/needs manager ack/)).toBeInTheDocument();
    // "open" here means not yet closed: the completed task still counts.
    expect(screen.getByText(/3 open · 1 awaiting approval/)).toBeInTheDocument();
  });

  it('opens the detail from ?open=, shows only the allowed actions, and posts a transition', async () => {
    const user = userEvent.setup();
    mount('/tasks?open=t1');
    const panel = await screen.findByRole('complementary', { name: 'Task detail' });
    await within(panel).findByText('WO-00001');
    expect(within(panel).getByRole('button', { name: 'Start work' })).toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: 'Acknowledge alarm' })).toBeInTheDocument();
    expect(within(panel).queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(within(panel).getAllByText(/system · evaluator/).length).toBeGreaterThan(0);

    await user.click(within(panel).getByRole('button', { name: 'Start work' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/tasks/t1/transition', { action: 'start', note: undefined }));
    expect(await screen.findByText(/WO-00001: Start work/)).toBeInTheDocument();
  });

  it('assign sends the chosen assignee; reject demands a note', async () => {
    const user = userEvent.setup();
    mount('/tasks?open=t1');
    const panel = await screen.findByRole('complementary', { name: 'Task detail' });
    await within(panel).findByText('WO-00001');
    await user.selectOptions(within(panel).getByLabelText('Assignee'), 'u-eng2');
    await user.click(within(panel).getByRole('button', { name: /Assign/ }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/tasks/t1/transition', { action: 'assign', note: undefined, assignedTo: 'u-eng2' }));

    // A completed task offers approve/reject; reject with an empty note never posts.
    const promptSpy = vi.spyOn(window, 'prompt').mockReturnValue('   ');
    const { unmount } = mount('/tasks?open=t3');
    unmount();
    mount('/tasks?open=t3');
    const p3 = (await screen.findAllByRole('complementary', { name: 'Task detail' })).at(-1);
    await within(p3).findByRole('button', { name: 'Reject' });
    api.post.mockClear();
    await user.click(within(p3).getByRole('button', { name: 'Reject' }));
    expect(api.post).not.toHaveBeenCalled();
    expect((await screen.findAllByText(/A note is required/)).length).toBeGreaterThan(0);
    promptSpy.mockReturnValue('Attach the vibration reading');
    await user.click(within(p3).getByRole('button', { name: 'Reject' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/tasks/t3/transition', { action: 'reject', note: 'Attach the vibration reading' }));
    promptSpy.mockRestore();
  });

  it('creates a task from the dialog and opens it', async () => {
    const user = userEvent.setup();
    mount();
    await screen.findByRole('list', { name: 'Task board' });
    await user.click(screen.getByRole('button', { name: 'New task' }));
    const dlg = screen.getByRole('dialog', { name: 'New task' });
    await user.type(within(dlg).getByLabelText('Title'), 'Grease the decanter drive');
    await user.selectOptions(within(dlg).getByLabelText('Priority'), 'high');
    await user.click(within(dlg).getByRole('button', { name: 'Create task' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/tasks', expect.objectContaining({ title: 'Grease the decanter drive', priority: 'high', assignedTo: null })));
    expect(await screen.findByText(/WO-00009 created/)).toBeInTheDocument();
  });

  it('a viewer gets the board without the New task button or any action', async () => {
    ROLE = 'viewer';
    mount('/tasks?open=t1');
    await screen.findByRole('list', { name: 'Task board' });
    expect(screen.queryByRole('button', { name: 'New task' })).toBeNull();
    expect(api.get).not.toHaveBeenCalledWith('/tasks/assignees');
  });

  it('Mine filters the query', async () => {
    const user = userEvent.setup();
    mount();
    await screen.findByRole('list', { name: 'Task board' });
    await user.click(screen.getByLabelText('Mine'));
    await waitFor(() => expect(api.get).toHaveBeenCalledWith(expect.stringContaining('assignedTo=me')));
  });
});
