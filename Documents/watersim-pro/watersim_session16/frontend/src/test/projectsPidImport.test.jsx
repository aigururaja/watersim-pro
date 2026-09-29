/**
 * ProjectsPage — "Import from P&ID" on the Digital Twin list.
 *
 * Pins: only the twin list offers it; choosing a picture creates a twin
 * project and a flowsheet named after the file, stores the picture and opens
 * the canvas with `readPid`; a failure after the project exists keeps it,
 * lists it, and says how to retry.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() }));
vi.mock('../services/api', () => ({ default: api, api }));
vi.mock('../components/layout/AppLayout', () => ({ default: ({ children }) => <div>{children}</div> }));
vi.mock('../components/AccessibilityProvider', () => ({ useAnnounce: () => () => {} }));
const upload = vi.hoisted(() => vi.fn());
vi.mock('../utils/pidImage', async (importOriginal) => ({ ...(await importOriginal()), uploadPidPicture: upload }));

import ProjectsPage from '../pages/ProjectsPage';

function Where() {
  const { pathname, state } = useLocation();
  return <div data-testid="where">{pathname} readPid={String(!!state?.readPid)}</div>;
}
function mount(path, kind) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path={path} element={<ProjectsPage kind={kind} />} />
        <Route path="*" element={<Where />} />
      </Routes>
    </MemoryRouter>,
  );
}
const choose = (name) => fireEvent.change(document.querySelector('input[type="file"]'),
  { target: { files: [new File(['x'], name, { type: 'image/png' })] } });

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  upload.mockReset();
  api.get.mockResolvedValue({ data: [] });
});

describe('ProjectsPage — Import from P&ID', () => {
  it('is offered on the Digital Twin list only', async () => {
    mount('/monitoring/projects', 'monitoring');
    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/projects?kind=monitoring'));
    expect(screen.queryByRole('button', { name: /Import from P&ID/ })).toBeNull();
  });

  it('creates a model and a flowsheet from the file, then opens it to be read', async () => {
    api.post.mockImplementation((url) => Promise.resolve({
      data: url === '/projects' ? { id: 'p9', name: 'Hotel STP' } : { id: 'f9' },
    }));
    upload.mockResolvedValue({ fileName: 'Hotel STP.png' });
    mount('/projects', 'twin');

    await screen.findByRole('button', { name: /Import from P&ID/ });
    choose('Hotel STP.png');

    expect(await screen.findByTestId('where')).toHaveTextContent('/projects/p9/flowsheets/f9 readPid=true');
    expect(api.post).toHaveBeenCalledWith('/projects', expect.objectContaining({ name: 'Hotel STP', kind: 'twin' }));
    expect(api.post).toHaveBeenCalledWith('/projects/p9/flowsheets', expect.objectContaining({ name: 'Hotel STP' }));
    expect(upload).toHaveBeenCalledWith('p9', 'f9', expect.any(File));
  });

  it('keeps the new model and explains how to retry when the upload fails', async () => {
    api.post.mockImplementation((url) => Promise.resolve({
      data: url === '/projects' ? { id: 'p9', name: 'Hotel STP' } : { id: 'f9' },
    }));
    upload.mockRejectedValue(new Error('The image is too large even after shrinking it. Try a smaller file.'));
    mount('/projects', 'twin');

    await screen.findByRole('button', { name: /Import from P&ID/ });
    choose('Hotel STP.png');

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/"Hotel STP" was created/);
    expect(alert).toHaveTextContent(/Upload P&ID picture/);
    expect(screen.queryByTestId('where')).toBeNull();
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(2));   // list reloaded
  });
});
