import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { usePaginatedReports } from '../hooks/usePaginatedReports';
import api from '../services/api';

vi.mock('../services/api', () => ({
  default: { get: vi.fn() },
}));

const run = (id, extra = {}) => ({ id, flowsheetName: `FS ${id}`, ...extra });

const PAGE_1 = {
  total: 3,
  runs: [run('r1'), run('r2')],
  nextCursor: '2026-01-02T00:00:00Z',
};

// Overlaps r2 on purpose so the dedupe path is exercised
const PAGE_2 = {
  total: 3,
  runs: [run('r2'), run('r3')],
  nextCursor: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  api.get.mockImplementation((url) => {
    if (url.includes('cursor=')) return Promise.resolve({ data: PAGE_2 });
    return Promise.resolve({ data: PAGE_1 });
  });
});

describe('usePaginatedReports', () => {
  it('loads the first page on mount', async () => {
    const { result } = renderHook(() => usePaginatedReports({ limit: 2 }));

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.runs.map(r => r.id)).toEqual(['r1', 'r2']);
    expect(result.current.total).toBe(3);
    expect(result.current.hasMore).toBe(true);
    expect(api.get).toHaveBeenCalledTimes(1);
  });

  it('loadMore appends the next page and dedupes overlapping rows', async () => {
    const { result } = renderHook(() => usePaginatedReports({ limit: 2 }));
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => { await result.current.loadMore(); });

    expect(result.current.runs.map(r => r.id)).toEqual(['r1', 'r2', 'r3']);
    expect(result.current.hasMore).toBe(false);
    // Second call carried the cursor from page 1
    expect(api.get.mock.calls[1][0]).toContain('cursor=');
  });

  it('refresh() clears the list and reloads from the top', async () => {
    const { result } = renderHook(() => usePaginatedReports({ limit: 2 }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(api.get).toHaveBeenCalledTimes(1);

    act(() => { result.current.refresh(); });

    // The reload actually fires (this used to blank the list permanently)
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.runs.map(r => r.id)).toEqual(['r1', 'r2']);
    expect(result.current.total).toBe(3);
  });

  it('patchRun updates a single row in place', async () => {
    const { result } = renderHook(() => usePaginatedReports({ limit: 2 }));
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => {
      result.current.patchRun('r1', { saved: true, savedLabel: 'Baseline' });
    });

    const r1 = result.current.runs.find(r => r.id === 'r1');
    const r2 = result.current.runs.find(r => r.id === 'r2');
    expect(r1.saved).toBe(true);
    expect(r1.savedLabel).toBe('Baseline');
    expect(r2.saved).toBeUndefined();
    // No extra network traffic
    expect(api.get).toHaveBeenCalledTimes(1);
  });
});
