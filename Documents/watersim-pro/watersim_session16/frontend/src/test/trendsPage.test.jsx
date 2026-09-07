/**
 * TrendsPage — the historian's window onto any tag.
 *
 * What is pinned: the registry is loaded and grouped; a selection queries the
 * history endpoint with the chosen window and puts the ids in the URL; the
 * response is drawn one chart per series with its statistics; the CSV and the
 * period report go through downloadFile with the same window; pinning writes
 * the selection where the dashboard will read it; and the selection cap holds.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import TrendsPage, { PINS_KEY, MAX_SELECTED } from '../pages/TrendsPage';
import api from '../services/api';
import { downloadFile } from '../utils/download';

vi.mock('../services/api', () => {
  const mock = { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn(), request: vi.fn() };
  return { default: mock, api: mock };
});
vi.mock('../utils/download', () => ({ downloadFile: vi.fn().mockResolvedValue('file'), default: vi.fn() }));
vi.mock('../components/layout/AppLayout', () => ({ default: ({ children }) => <div>{children}</div> }));

const T = (id, tag, name, area, extra = {}) => ({
  id, tag, name, area, signalType: 'AI', kind: 'flow_meter', engUnit: 'm3/d', binding: null, ...extra,
});
const TAGS = [
  T('t1', 'RFP-FT-201.FT', 'Reactor feed flow meter', 'RFP', { binding: { id: 'b1', quality: 'good', value: 612.4, at: '2026-09-07T09:00:00Z' } }),
  T('t2', 'EQT-LT-101.LT', 'EQT level transmitter', 'EQT', { kind: 'level_tx', engUnit: '%' }),
  T('t3', 'ACF-AT-601.AT', 'Filtered water pH analyser', 'ACF', { engUnit: 'pH' }),
  ...Array.from({ length: 9 }, (_, i) => T(`x${i}`, `SWT-LT-${1100 + i}.LT`, `Level ${i}`, 'SWT')),
  T('d1', 'RFP-P-201/1.XS', 'Pump 1 running', 'RFP', { signalType: 'DI', kind: 'pump', engUnit: null }),
];

const NOW = Date.parse('2026-09-07T10:00:00Z');
const series = (tagId, tag, name, unit, base) => ({
  tagId, tag, name, unit, area: 'RFP', kind: 'flow_meter', signalType: 'AI', rangeMin: null, rangeMax: null,
  points: Array.from({ length: 6 }, (_, i) => [NOW - (6 - i) * 60_000, base + i, base + i - 1, base + i + 1, base + i, 12]),
  stats: { min: base - 1, max: base + 6, avg: base + 2.5, last: base + 5, samples: 72 },
});
const HISTORY = {
  bucket: '1m', raw: false, from: new Date(NOW - 6 * 3600_000).toISOString(), to: new Date(NOW).toISOString(),
  columns: ['ts', 'avg', 'min', 'max', 'last', 'count'],
  series: [series('t1', 'RFP-FT-201.FT', 'Reactor feed flow meter', 'm3/d', 600)],
};

function mount(path = '/trends') {
  return render(<MemoryRouter initialEntries={[path]}><TrendsPage /></MemoryRouter>);
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  api.get.mockImplementation((url) => {
    if (url.startsWith('/tags/history')) return Promise.resolve({ data: HISTORY });
    if (url.startsWith('/tags')) return Promise.resolve({ data: { total: TAGS.length, tags: TAGS } });
    return Promise.reject(new Error(`unexpected GET ${url}`));
  });
});

describe('TrendsPage', () => {
  it('loads the registry, groups by area, and shows the PLC state per point', async () => {
    mount();
    const picker = await screen.findByRole('complementary', { name: 'Tag picker' });
    await within(picker).findByText('RFP-FT-201.FT');
    expect(api.get).toHaveBeenCalledWith('/tags?limit=1000');
    expect(within(picker).getByText('RFP')).toBeInTheDocument();
    expect(within(picker).getByText('EQT')).toBeInTheDocument();
    expect(within(picker).getByTitle('PLC good')).toBeInTheDocument();
    // The DI point is hidden until "analogue only" is switched off.
    expect(within(picker).queryByText('RFP-P-201/1.XS')).toBeNull();
    await userEvent.setup().click(within(picker).getByLabelText('Analogue and bound points only'));
    expect(within(picker).getByText('RFP-P-201/1.XS')).toBeInTheDocument();
    expect(screen.getByText('Pick a tag to start')).toBeInTheDocument();
  });

  it('selecting a tag queries the window, puts the ids in the URL and draws the series', async () => {
    const user = userEvent.setup();
    mount();
    const picker = await screen.findByRole('complementary', { name: 'Tag picker' });
    await within(picker).findByText('RFP-FT-201.FT');
    await user.click(within(picker).getByLabelText('RFP-FT-201.FT'));

    await waitFor(() => expect(api.get).toHaveBeenCalledWith(expect.stringMatching(/^\/tags\/history\?/)));
    const url = api.get.mock.calls.map((c) => c[0]).find((u) => u.startsWith('/tags/history'));
    const qs = new URLSearchParams(url.split('?')[1]);
    expect(qs.get('ids')).toBe('t1');
    expect(qs.get('range')).toBe('6h');
    expect(qs.get('bucket')).toBeNull(); // auto is the default and is not sent

    const chart = await screen.findByRole('region', { name: 'RFP-FT-201.FT trend' });
    expect(within(chart).getByText(/min/)).toHaveTextContent(/599/);
    expect(within(chart).getByText(/avg/)).toHaveTextContent(/602\.5/);
    expect(chart.querySelector('svg')).toBeTruthy();
    expect(screen.getByText(/at 1m resolution/)).toBeInTheDocument();
  });

  it('changing the range and resolution re-queries with them', async () => {
    const user = userEvent.setup();
    mount('/trends?ids=t1');
    await screen.findByRole('region', { name: 'RFP-FT-201.FT trend' });
    api.get.mockClear();
    await user.click(screen.getByRole('button', { name: '7 d' }));
    await waitFor(() => expect(api.get).toHaveBeenCalledWith(expect.stringContaining('range=7d')));
    fireEvent.change(screen.getByLabelText('Resolution'), { target: { value: '1h' } });
    await waitFor(() => expect(api.get).toHaveBeenCalledWith(expect.stringContaining('bucket=1h')));
  });

  it('exports CSV and the period report through downloadFile with the current window', async () => {
    const user = userEvent.setup();
    mount('/trends?ids=t1');
    await screen.findByRole('region', { name: 'RFP-FT-201.FT trend' });

    await user.click(screen.getByRole('button', { name: 'Export CSV' }));
    await waitFor(() => expect(downloadFile).toHaveBeenCalledWith(expect.stringMatching(/^\/tags\/history\.csv\?.*ids=t1/), expect.stringMatching(/\.csv$/)));

    await user.click(screen.getByRole('button', { name: 'Export PDF report' }));
    await waitFor(() => expect(downloadFile).toHaveBeenCalledWith('/reports/period', expect.stringMatching(/\.pdf$/), expect.objectContaining({
      method: 'POST', data: expect.objectContaining({ tagIds: ['t1'], format: 'pdf', from: HISTORY.from, to: HISTORY.to }),
    })));
    expect(await screen.findByText(/Period report \(PDF\) exported/)).toBeInTheDocument();

    downloadFile.mockRejectedValueOnce(Object.assign(new Error('nope'), { response: { data: { error: 'Python is missing' } } }));
    await user.click(screen.getByRole('button', { name: 'Export Excel report' }));
    expect(await screen.findByText(/Python is missing/)).toBeInTheDocument();
  });

  it('pins the selection where the dashboard reads it, and restores pins on the next visit', async () => {
    const user = userEvent.setup();
    const { unmount } = mount('/trends?ids=t1');
    await screen.findByRole('region', { name: 'RFP-FT-201.FT trend' });
    await user.click(screen.getByRole('button', { name: 'Pin to dashboard' }));
    expect(JSON.parse(localStorage.getItem(PINS_KEY))).toEqual([{ tagId: 't1', tag: 'RFP-FT-201.FT', name: 'Reactor feed flow meter', unit: 'm3/d' }]);
    expect(screen.getByRole('button', { name: 'Unpin from dashboard' })).toBeInTheDocument();
    unmount();

    mount('/trends');
    await waitFor(() => expect(api.get).toHaveBeenCalledWith(expect.stringContaining('ids=t1')));
  });

  it('never selects more than the cap', async () => {
    const user = userEvent.setup();
    mount();
    const picker = await screen.findByRole('complementary', { name: 'Tag picker' });
    await within(picker).findByText('RFP-FT-201.FT');
    const boxes = within(picker).getAllByRole('checkbox').filter((b) => b.getAttribute('aria-label')?.includes('-'));
    for (const b of boxes) { if (!b.disabled) await user.click(b); }
    const checked = within(picker).getAllByRole('checkbox').filter((b) => b.checked && b.getAttribute('aria-label')?.includes('-'));
    expect(checked).toHaveLength(MAX_SELECTED);
    expect(within(picker).getByText(`${MAX_SELECTED} of ${MAX_SELECTED} selected`, { exact: false })).toBeInTheDocument();
  });

  it('shows the server error when history cannot be read', async () => {
    api.get.mockImplementation((url) => {
      if (url.startsWith('/tags/history')) return Promise.reject({ response: { data: { details: [{ msg: 'from must be before to' }] } } });
      return Promise.resolve({ data: { total: TAGS.length, tags: TAGS } });
    });
    mount('/trends?ids=t1');
    expect(await screen.findByRole('alert')).toHaveTextContent('from must be before to');
  });
});
