/**
 * ProjectsPage — two lists: the plants Operations monitors, the models the
 * Digital Twin runs. What is pinned: each list asks the API for its own kind
 * and creates its own kind; a monitoring project opens under
 * /monitoring/projects; only the twin list offers "Import from live", which
 * lists the monitored plants and imports the chosen one into a new twin
 * project that opens under /projects.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import ProjectsPage from '../pages/ProjectsPage';
import api from '../services/api';

vi.mock('../services/api', () => {
  const mock = { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() };
  return { default: mock, api: mock };
});
vi.mock('../components/layout/AppLayout', () => ({ default: ({ children }) => <div>{children}</div> }));
vi.mock('../components/AccessibilityProvider', () => ({ useAnnounce: () => () => {} }));

const PLANT = { id: 'p-mon', name: 'ITC STP — Monitoring & Control', kind: 'monitoring', status: 'active', tags: [], flowsheet_count: 1, updated_at: '2026-09-07T10:00:00Z' };
const MODEL = { id: 'p-twin', name: 'ITC STP — Digital twin', kind: 'twin', status: 'active', tags: [], flowsheet_count: 1, updated_at: '2026-09-07T10:00:00Z', source_project_id: 'p-mon', source_project_name: 'ITC STP — Monitoring & Control' };

function Where() { const { pathname } = useLocation(); return <div data-testid="where">{pathname}</div>; }
function mount(path, kind) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path={path} element={<><ProjectsPage kind={kind} /><Where /></>} />
        <Route path="*" element={<Where />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  api.get.mockImplementation((url) => {
    if (url === '/projects?kind=monitoring') return Promise.resolve({ data: [PLANT] });
    if (url === '/projects?kind=twin') return Promise.resolve({ data: [MODEL] });
    return Promise.reject(new Error(`unexpected GET ${url}`));
  });
});

describe('ProjectsPage', () => {
  it('Operations lists the monitored plants, creates a monitoring project, and opens it on its own surface', async () => {
    const user = userEvent.setup();
    api.post.mockResolvedValue({ data: { ...PLANT, id: 'p-new', name: 'New plant' } });
    mount('/monitoring/projects', 'monitoring');
    expect(await screen.findByRole('heading', { name: /Monitoring projects/ })).toBeInTheDocument();
    expect(api.get).toHaveBeenCalledWith('/projects?kind=monitoring');
    expect(screen.getByText('ITC STP — Monitoring & Control')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Import from live/ })).toBeNull();

    await user.click(screen.getByRole('button', { name: /New plant/ }));
    const dialog = screen.getByRole('dialog', { name: 'New monitoring project' });
    await user.type(within(dialog).getByPlaceholderText(/ITC hotel STP/), 'New plant');
    await user.click(within(dialog).getByRole('button', { name: 'Create Project' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/projects', expect.objectContaining({ name: 'New plant', kind: 'monitoring' })));
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/monitoring/projects/p-new'));
  });

  it('the Digital Twin lists the models, says where an imported one came from, and imports a plant from live', async () => {
    const user = userEvent.setup();
    api.post.mockResolvedValue({ data: { ...MODEL, id: 'p-imported', name: 'ITC STP — Monitoring & Control — twin' } });
    mount('/projects', 'twin');
    expect(await screen.findByRole('heading', { name: /Twin projects/ })).toBeInTheDocument();
    expect(api.get).toHaveBeenCalledWith('/projects?kind=twin');
    expect(screen.getByText(/from live: ITC STP — Monitoring & Control/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Import from live/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Import from live' });
    await user.click(await within(dialog).findByRole('radio', { name: 'ITC STP — Monitoring & Control' }));
    expect(within(dialog).getByLabelText('Twin project name')).toHaveValue('ITC STP — Monitoring & Control — twin');
    await user.click(within(dialog).getByRole('button', { name: 'Import' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/projects/p-mon/import-to-twin', { name: 'ITC STP — Monitoring & Control — twin' }));
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/projects/p-imported'));
  });
});
