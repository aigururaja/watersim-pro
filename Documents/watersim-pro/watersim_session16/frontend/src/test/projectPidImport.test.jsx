/**
 * ProjectPage — "Import from P&ID".
 *
 * Pins: the button creates a flowsheet named after the file, stores the
 * picture on it, and opens the canvas with `readPid` so the AI reading starts
 * there; a failed upload keeps the new flowsheet and says so.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() }));
vi.mock('../services/api', () => ({ default: api, api }));
vi.mock('../components/layout/AppLayout', () => ({
  default: ({ children }) => <div>{children}</div>,
}));

const upload = vi.hoisted(() => vi.fn());
vi.mock('../utils/pidImage', async (importOriginal) => ({
  ...(await importOriginal()),
  uploadPidPicture: upload,
}));

import ProjectPage from '../pages/ProjectPage';

function CanvasStub() {
  const { state } = useLocation();
  return <div data-testid="canvas">canvas readPid={String(!!state?.readPid)}</div>;
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/projects/p1']}>
      <Routes>
        <Route path="/projects/:projectId" element={<ProjectPage />} />
        <Route path="/projects/:projectId/flowsheets/:flowsheetId" element={<CanvasStub />} />
      </Routes>
    </MemoryRouter>,
  );
}

const choose = (name) => fireEvent.change(document.querySelector('input[type="file"]'),
  { target: { files: [new File(['x'], name, { type: 'image/png' })] } });

describe('ProjectPage — Import from P&ID', () => {
  beforeEach(() => {
    for (const fn of Object.values(api)) fn.mockReset();
    upload.mockReset();
    api.get.mockImplementation((url) => Promise.resolve({
      data: url.endsWith('/flowsheets') ? [] : { id: 'p1', name: 'Hotel STP' },
    }));
  });

  it('creates a flowsheet from the file, uploads the picture and opens it to be read', async () => {
    api.post.mockResolvedValue({ data: { id: 'f9' } });
    upload.mockResolvedValue({ fileName: 'Hotel STP P&ID.png' });
    renderPage();

    await screen.findByRole('button', { name: /Import from P&ID/ });
    choose('Hotel STP P&ID.png');

    expect(await screen.findByTestId('canvas')).toHaveTextContent('readPid=true');
    expect(api.post).toHaveBeenCalledWith('/projects/p1/flowsheets',
      expect.objectContaining({ name: 'Hotel STP P&ID' }));
    expect(upload).toHaveBeenCalledWith('p1', 'f9', expect.any(File));
  });

  it('keeps the new flowsheet and explains when the upload fails', async () => {
    api.post.mockResolvedValue({ data: { id: 'f9' } });
    upload.mockRejectedValue(new Error('The image is too large even after shrinking it. Try a smaller file.'));
    renderPage();

    await screen.findByRole('button', { name: /Import from P&ID/ });
    choose('huge.png');

    expect(await screen.findByText(/Flowsheet created, but the picture could not be uploaded/)).toBeTruthy();
    expect(screen.queryByTestId('canvas')).toBeNull();
    await waitFor(() => expect(api.get.mock.calls.filter(([u]) => u.endsWith('/flowsheets')).length).toBeGreaterThan(1));
  });
});
