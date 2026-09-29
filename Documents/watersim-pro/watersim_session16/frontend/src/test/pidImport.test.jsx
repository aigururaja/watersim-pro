/**
 * PidImport — upload a P&ID picture and let AI build the diagram from it.
 *
 * Pins: no bar until a picture exists; with one, the bar offers Build diagram;
 * the AI proposal is shown for review and only reaches the canvas on confirm;
 * a server error (e.g. no API key) is shown in the bar; and the canvas menu's
 * imperative `openPicker` reaches the hidden file input.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRef } from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ReactFlowProvider } from 'reactflow';

const api = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn(), post: vi.fn(), delete: vi.fn() }));
vi.mock('../services/api', () => ({ default: api, api }));

import PidImport from '../components/canvas/PidImport';

const STORED = {
  width: 800, height: 400, fileName: 'plant-pid.png',
  placement: { x: 0, y: 0, scale: 1.5 },
};

function mount({ ref, onBuild } = {}) {
  return render(
    <ReactFlowProvider>
      <PidImport ref={ref} projectId="p1" flowsheetId="f1" onBuild={onBuild} />
    </ReactFlowProvider>,
  );
}

describe('PidImport', () => {
  beforeEach(() => { api.get.mockReset(); api.put.mockReset(); api.post.mockReset(); api.delete.mockReset(); });

  it('shows nothing when the flowsheet has no picture', async () => {
    api.get.mockResolvedValue({ status: 204, data: '' });
    mount();
    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/projects/p1/flowsheets/f1/background'));
    expect(screen.queryByText(/P&ID/)).toBeNull();
    expect(screen.queryByRole('button', { name: /Build diagram/ })).toBeNull();
  });

  it('offers Build diagram once a picture is stored, and draws no picture', async () => {
    api.get.mockResolvedValue({ status: 200, data: STORED });
    const { container } = mount();
    expect(await screen.findByRole('button', { name: /Build diagram/ })).toBeTruthy();
    expect(screen.getByText(/plant-pid\.png/)).toBeTruthy();
    expect(container.querySelector('img')).toBeNull();
  });

  it('reads the drawing, shows it for review, and hands the result to the canvas', async () => {
    api.get.mockResolvedValue({ status: 200, data: STORED });
    const proposal = {
      units: [
        { id: 'u1', type: 'inlet', label: 'Raw Sewage', x: 0.1, y: 0.5, params: {} },
        { id: 'u2', type: 'activated_sludge', label: 'Aeration Tank', x: 0.5, y: 0.5, params: {} },
        { id: 'u3', type: 'outlet', label: 'Treated Water', x: 0.9, y: 0.5, params: {} },
      ],
      connections: [{ from: 'u1', to: 'u2' }, { from: 'u2', to: 'u3' }],
      skipped: [{ label: 'FT-101', reason: 'flow transmitter' }],
      warnings: [], notes: '',
    };
    api.post.mockResolvedValue({ data: proposal });
    const onBuild = vi.fn();
    mount({ onBuild });

    fireEvent.click(await screen.findByRole('button', { name: /Build diagram/ }));
    expect(api.post).toHaveBeenCalledWith('/projects/p1/flowsheets/f1/background/read');

    await screen.findByRole('dialog');
    expect(screen.getByText('Blocks to create (3)')).toBeTruthy();
    expect(screen.getByText('Aeration Tank')).toBeTruthy();
    expect(screen.getByText('FT-101')).toBeTruthy();
    expect(onBuild).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /Create & simulate/ }));
    expect(onBuild).toHaveBeenCalledTimes(1);
    const [got, pid, opts] = onBuild.mock.calls[0];
    expect(got).toBe(proposal);
    expect(pid.placement).toEqual(STORED.placement);
    expect(opts).toEqual({ simulate: true });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  describe('uploading', () => {
    // jsdom cannot decode images or draw on a canvas: stand in for both.
    let restore;
    beforeEach(() => {
      restore = [
        [globalThis, 'Image', globalThis.Image],
        [URL, 'createObjectURL', URL.createObjectURL],
        [URL, 'revokeObjectURL', URL.revokeObjectURL],
        [HTMLCanvasElement.prototype, 'getContext', HTMLCanvasElement.prototype.getContext],
        [HTMLCanvasElement.prototype, 'toDataURL', HTMLCanvasElement.prototype.toDataURL],
      ];
      globalThis.Image = class {
        set src(_v) { this.naturalWidth = 1000; this.naturalHeight = 500; setTimeout(() => this.onload()); }
      };
      URL.createObjectURL = () => 'blob:pid';
      URL.revokeObjectURL = () => {};
      HTMLCanvasElement.prototype.getContext = () => ({ fillRect() {}, drawImage() {} });
      HTMLCanvasElement.prototype.toDataURL = () => 'data:image/webp;base64,AAAA';
      api.get.mockResolvedValue({ status: 204, data: '' });
    });
    afterEach(() => { for (const [obj, key, value] of restore) obj[key] = value; });

    const upload = (container, name) => fireEvent.change(container.querySelector('input[type="file"]'),
      { target: { files: [new File(['x'], name, { type: 'image/png' })] } });

    it('starts reading as soon as a picture is uploaded', async () => {
      api.put.mockResolvedValue({ data: STORED });
      api.post.mockResolvedValue({ data: {
        units: [{ id: 'u1', type: 'inlet', label: 'Raw Sewage', x: 0.1, y: 0.5, params: {} }],
        connections: [], skipped: [], warnings: [], notes: '',
      } });
      const { container } = mount();
      upload(container, 'plant.png');

      await screen.findByRole('dialog');
      expect(api.put).toHaveBeenCalledWith('/projects/p1/flowsheets/f1/background',
        expect.objectContaining({ fileName: 'plant.png', width: 1000, height: 500 }));
      expect(api.post).toHaveBeenCalledWith('/projects/p1/flowsheets/f1/background/read');
      expect(screen.getByText('Blocks to create (1)')).toBeTruthy();
    });

    it('does not try to read when the upload fails', async () => {
      api.put.mockRejectedValue({ response: { status: 422, data: { error: 'Image must be a PNG, JPEG or WebP' } } });
      const { container } = mount();
      upload(container, 'plant.png');
      expect(await screen.findByRole('alert')).toHaveTextContent(/PNG, JPEG or WebP/);
      expect(api.post).not.toHaveBeenCalled();
    });
  });

  it('reads by itself when opened from Import from P&ID, exactly once', async () => {
    api.get.mockResolvedValue({ status: 200, data: STORED });
    api.post.mockResolvedValue({ data: {
      units: [{ id: 'u1', type: 'inlet', label: 'Raw Sewage', x: 0.1, y: 0.5, params: {} }],
      connections: [], skipped: [], warnings: [], notes: '',
    } });
    const onAutoRead = vi.fn();
    const { rerender } = render(
      <ReactFlowProvider>
        <PidImport projectId="p1" flowsheetId="f1" autoRead onAutoRead={onAutoRead} />
      </ReactFlowProvider>,
    );
    await screen.findByRole('dialog');
    expect(api.post).toHaveBeenCalledTimes(1);
    expect(onAutoRead).toHaveBeenCalledTimes(1);

    // The canvas clears the flag afterwards; re-rendering must not read again.
    rerender(
      <ReactFlowProvider>
        <PidImport projectId="p1" flowsheetId="f1" autoRead={false} onAutoRead={onAutoRead} />
      </ReactFlowProvider>,
    );
    expect(api.post).toHaveBeenCalledTimes(1);
  });

  it('shows the server message when AI reading is not set up', async () => {
    api.get.mockResolvedValue({ status: 200, data: STORED });
    api.post.mockRejectedValue({ response: { status: 503, data: { error: 'AI reading is not set up yet. Add ANTHROPIC_API_KEY to backend/.env and restart the server.' } } });
    mount();
    fireEvent.click(await screen.findByRole('button', { name: /Build diagram/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/ANTHROPIC_API_KEY/);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('opens the file picker from the canvas menu', async () => {
    api.get.mockResolvedValue({ status: 204, data: '' });
    const ref = createRef();
    const { container } = mount({ ref });
    const input = container.querySelector('input[type="file"]');
    const click = vi.spyOn(input, 'click');
    ref.current.openPicker();
    expect(click).toHaveBeenCalled();
  });
});
