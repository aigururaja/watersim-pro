import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import PLCBindDialog from '../components/plc/PLCBindDialog';
import PLCConnectionsTab from '../components/plc/PLCConnectionsTab';
import PLCLiveChip from '../components/plc/PLCLiveChip';
import {
  bindingKey, bindingsToMap, liveFromBindings, mergePlcValues, worstQuality,
} from '../components/plc/plcState';
import api from '../services/api';

vi.mock('../services/api', () => {
  const mock = { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() };
  return { default: mock, api: mock };
});

const PROTOCOLS = [
  {
    protocol: 'modbus_tcp',
    label: 'Modbus TCP',
    status: 'available',
    addressHint: 'e.g. 40001 (holding register)',
    configFields: [
      { key: 'host', label: 'Host', type: 'string', required: true, placeholder: '10.0.0.5' },
      { key: 'port', label: 'Port', type: 'number', required: false, default: 502 },
      { key: 'password', label: 'Password', type: 'password', required: false },
    ],
  },
  {
    protocol: 'opcua',
    label: 'OPC UA',
    status: 'stub',
    addressHint: 'ns=2;s=Channel1.Device1.Tag1',
    configFields: [{ key: 'endpoint', label: 'Endpoint URL', type: 'string', required: true }],
  },
];

const CONNECTIONS = [
  {
    id: 'c1', name: 'Plant PLC', protocol: 'modbus_tcp', enabled: true,
    status: 'connected', last_seen: '2026-09-03T10:00:00Z', last_error: null,
    config: { host: '10.0.0.5', port: 502 },
  },
  {
    id: 'c2', name: 'Old rig', protocol: 'modbus_tcp', enabled: false,
    status: 'error', last_seen: null, last_error: 'timeout', config: {},
  },
];

const mockGets = () => {
  api.get.mockImplementation((url) => {
    if (url === '/plc/protocols')   return Promise.resolve({ data: PROTOCOLS });
    if (url === '/plc/connections') return Promise.resolve({ data: CONNECTIONS });
    return Promise.reject(Object.assign(new Error('not found'), { response: { status: 404 } }));
  });
};

beforeEach(() => {
  vi.clearAllMocks();
  mockGets();
  api.post.mockResolvedValue({ data: {} });
  api.patch.mockResolvedValue({ data: {} });
  api.delete.mockResolvedValue({ data: {} });
});

// ── PLCBindDialog ────────────────────────────────────────────────────────────

describe('PLCBindDialog', () => {
  const renderDialog = (props = {}) => render(
    <PLCBindDialog
      projectId="p1"
      flowsheetId="f1"
      nodeId="n1"
      paramKey="Q"
      paramLabel="Flow (m³/d)"
      nodeLabel="Inlet"
      binding={null}
      onClose={() => {}}
      onSaved={() => {}}
      onRemoved={() => {}}
      {...props}
    />
  );

  it('lists only enabled connections and shows the protocol address hint', async () => {
    renderDialog();
    // Enabled connection appears with its protocol label…
    expect(await screen.findByText(/Plant PLC \(Modbus TCP\)/)).toBeInTheDocument();
    // …the disabled one does not.
    expect(screen.queryByText(/Old rig/)).not.toBeInTheDocument();
    // Address hint from the selected connection's protocol drives placeholder + help text.
    expect(screen.getByPlaceholderText('e.g. 40001 (holding register)')).toBeInTheDocument();
    expect(screen.getByText(/Address format: e\.g\. 40001/)).toBeInTheDocument();
  });

  it('POSTs the upsert payload in the contract shape', async () => {
    const onSaved = vi.fn();
    renderDialog({ onSaved });
    await screen.findByText(/Plant PLC/);

    fireEvent.change(screen.getByLabelText(/^Address/), { target: { value: '40001' } });
    fireEvent.change(screen.getByLabelText(/Direction/), { target: { value: 'read_write' } });
    fireEvent.change(screen.getByLabelText(/Scale/), { target: { value: '0.5' } });
    fireEvent.change(screen.getByLabelText(/Offset/), { target: { value: '10' } });
    fireEvent.click(screen.getByRole('button', { name: /Save binding/ }));

    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
    expect(api.post).toHaveBeenCalledWith(
      '/projects/p1/flowsheets/f1/plc-bindings',
      {
        nodeId: 'n1',
        paramKey: 'Q',
        connectionId: 'c1',       // auto-selected first enabled connection
        address: '40001',
        direction: 'read_write',
        scale: 0.5,
        offset: 10,
        pollIntervalMs: null,     // optional field left empty
        enabled: true,
      }
    );
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
  });

  it('offers Remove binding for an existing binding and DELETEs it', async () => {
    const onRemoved = vi.fn();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderDialog({
      onRemoved,
      binding: {
        id: 'b9', connection_id: 'c1', address: '40002', direction: 'read',
        scale: 1, offset_val: 0, poll_interval_ms: 1000, enabled: true,
      },
    });
    await screen.findByText(/Plant PLC/);
    fireEvent.click(screen.getByRole('button', { name: /Remove binding/ }));
    await waitFor(() =>
      expect(api.delete).toHaveBeenCalledWith('/projects/p1/flowsheets/f1/plc-bindings/b9'));
    await waitFor(() => expect(onRemoved).toHaveBeenCalled());
    window.confirm.mockRestore();
  });
});

// ── PLCConnectionsTab ────────────────────────────────────────────────────────

describe('PLCConnectionsTab', () => {
  it('renders connection rows with protocol label and test result', async () => {
    render(<PLCConnectionsTab canEdit showToast={() => {}} />);
    expect(await screen.findByText('Plant PLC')).toBeInTheDocument();
    expect(screen.getAllByText(/Modbus TCP/).length).toBeGreaterThan(0);
    expect(screen.getByText('Old rig')).toBeInTheDocument();

    // Test button hits POST /plc/connections/:id/test and shows ok + latency
    api.post.mockResolvedValueOnce({ data: { ok: true, message: 'Connected', latencyMs: 12 } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Test' })[0]);
    expect(await screen.findByText(/Connected · 12 ms/)).toBeInTheDocument();
    expect(api.post).toHaveBeenCalledWith('/plc/connections/c1/test');
  });

  it('disables stub protocols in the add form and renders dynamic config fields', async () => {
    render(<PLCConnectionsTab canEdit showToast={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: /Add connection/ }));

    const stubOption = screen.getByRole('option', { name: /OPC UA \(driver not installed\)/ });
    expect(stubOption).toBeDisabled();
    const availableOption = screen.getByRole('option', { name: 'Modbus TCP' });
    expect(availableOption).not.toBeDisabled();

    // Config fields from configFields: host text, port number (default), password type
    expect(screen.getByLabelText(/Host/)).toBeInTheDocument();
    expect(screen.getByLabelText(/Port/)).toHaveAttribute('type', 'number');
    expect(screen.getByLabelText(/Port/)).toHaveValue(502); // default applied
    expect(screen.getByLabelText(/^Password/)).toHaveAttribute('type', 'password');

    // Required validation: host empty → save disabled
    const save = screen.getByRole('button', { name: /Create connection/ });
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/Connection name/), { target: { value: 'New PLC' } });
    fireEvent.change(screen.getByLabelText(/Host/), { target: { value: '10.1.1.1' } });
    expect(save).not.toBeDisabled();

    fireEvent.click(save);
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/plc/connections', {
      name: 'New PLC',
      protocol: 'modbus_tcp',
      config: { port: 502, host: '10.1.1.1' },
      enabled: true,
    }));
  });

  it('is read-only for viewers', async () => {
    render(<PLCConnectionsTab canEdit={false} showToast={() => {}} />);
    expect(await screen.findByText('Plant PLC')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Add connection/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Plant PLC enabled')).toBeDisabled();
  });
});

// ── PLCLiveChip ──────────────────────────────────────────────────────────────

describe('PLCLiveChip', () => {
  const chip = (live) => {
    const { container } = render(<PLCLiveChip live={live} />);
    return container.querySelector('[data-quality]');
  };

  it('renders value + relative time for a good read', () => {
    const el = chip({ bindingId: 'b1', value: 42.5, quality: 'good', ts: Date.now() - 10_000 });
    expect(el).toHaveAttribute('data-quality', 'good');
    expect(el.textContent).toContain('42.5');
    expect(el.textContent).toMatch(/10s ago/);
  });

  it('marks stale and bad qualities', () => {
    expect(chip({ value: 1, quality: 'stale', ts: Date.now() })).toHaveAttribute('data-quality', 'stale');
    expect(chip({ value: 1, quality: 'bad', ts: Date.now() })).toHaveAttribute('data-quality', 'bad');
  });

  it("shows '— no data yet' before the first read", () => {
    const el = chip(undefined);
    expect(el).toHaveAttribute('data-quality', 'unknown');
    expect(el.textContent).toContain('— no data yet');
  });
});

// ── plc:update state merge (reducer level) ───────────────────────────────────

describe('plcState reducers', () => {
  it('bindingsToMap keys rows by nodeId:paramKey', () => {
    const map = bindingsToMap([
      { id: 'b1', node_id: 'n1', param_key: 'Q' },
      { id: 'b2', node_id: 'n2', param_key: 'DO_set_mg_L' },
      null,
    ]);
    expect(Object.keys(map)).toEqual(['n1:Q', 'n2:DO_set_mg_L']);
    expect(map[bindingKey('n1', 'Q')].id).toBe('b1');
  });

  it('liveFromBindings seeds chips from persisted last values', () => {
    const live = liveFromBindings([
      { id: 'b1', node_id: 'n1', param_key: 'Q', last_value: 4800, quality: 'good', last_read_at: 'T1' },
      { id: 'b2', node_id: 'n2', param_key: 'DO', last_value: null, quality: null }, // never read
    ]);
    expect(live['n1:Q']).toEqual({ bindingId: 'b1', value: 4800, quality: 'good', ts: 'T1' });
    expect(live['n2:DO']).toBeUndefined();
  });

  it('mergePlcValues merges a plc:update payload into existing state', () => {
    const prev = {
      'n1:Q': { bindingId: 'b1', value: 100, quality: 'good', ts: 1000 },
    };
    const next = mergePlcValues(prev, [
      { bindingId: 'b1', nodeId: 'n1', paramKey: 'Q', value: 120, quality: 'good', ts: 2000 },
      { bindingId: 'b2', nodeId: 'n2', paramKey: 'DO', value: 1.8, quality: 'stale', ts: 2000 },
    ]);
    expect(next).not.toBe(prev);                 // new reference on change
    expect(next['n1:Q']).toEqual({ bindingId: 'b1', value: 120, quality: 'good', ts: 2000 });
    expect(next['n2:DO']).toEqual({ bindingId: 'b2', value: 1.8, quality: 'stale', ts: 2000 });
    expect(prev['n1:Q'].value).toBe(100);        // prev untouched
  });

  it('mergePlcValues accepts polled plc-values rows (lastReadAt) and keeps prior fields', () => {
    const prev = { 'n1:Q': { bindingId: 'b1', value: 100, quality: 'good', ts: 1000 } };
    const next = mergePlcValues(prev, [
      { bindingId: 'b1', nodeId: 'n1', paramKey: 'Q', value: 105, quality: 'good', lastReadAt: 3000 },
    ]);
    expect(next['n1:Q'].ts).toBe(3000);
    // No-op inputs return the same reference (no spurious re-renders)
    expect(mergePlcValues(prev, [])).toBe(prev);
    expect(mergePlcValues(prev, undefined)).toBe(prev);
    expect(mergePlcValues(prev, [{ value: 1 }])).toBe(prev); // missing node/param ignored
  });

  it('worstQuality ranks good < stale < unknown < bad and treats missing keys as unknown', () => {
    const live = {
      'n1:Q': { quality: 'good' },
      'n2:DO': { quality: 'stale' },
    };
    expect(worstQuality(live, ['n1:Q'])).toBe('good');
    expect(worstQuality(live, ['n1:Q', 'n2:DO'])).toBe('stale');
    expect(worstQuality(live, ['n1:Q', 'n3:missing'])).toBe('unknown');
    expect(worstQuality({ ...live, 'n4:X': { quality: 'bad' } })).toBe('bad');
    expect(worstQuality({}, [])).toBe(null);
  });
});
