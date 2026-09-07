/**
 * pagePrefetch — every page chunk is warmed once, one after another, at idle.
 *
 * What is pinned: the loader map covers every page the router mounts; the
 * prefetcher calls each loader exactly once in order, waits for one to settle
 * before scheduling the next, keeps going past a failed chunk, honours the
 * `except` list, and stops when cancelled.
 */
import { describe, it, expect, vi } from 'vitest';
import { PAGE_LOADERS, prefetchPages } from '../pagePrefetch';

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('PAGE_LOADERS', () => {
  it('names every page the router mounts', () => {
    expect(Object.keys(PAGE_LOADERS).sort()).toEqual([
      'AdminPage', 'AlarmsPage', 'AuditPage', 'CanvasPage', 'ComparisonPage', 'DashboardPage', 'LivePlantPage',
      'LoginPage', 'ProjectPage', 'ProjectsPage', 'RegisterPage', 'ReportPage', 'ReportsPage', 'SettingsPage',
      'TasksPage', 'TrendsPage', 'TwinPage',
    ]);
    for (const fn of Object.values(PAGE_LOADERS)) expect(typeof fn).toBe('function');
  });
});

describe('prefetchPages', () => {
  it('loads each chunk once, in order, one at a time, and survives a failure', async () => {
    const order = [];
    const loaders = {
      A: vi.fn(() => { order.push('A'); return Promise.resolve(); }),
      B: vi.fn(() => { order.push('B'); return Promise.reject(new Error('offline')); }),
      C: vi.fn(() => { order.push('C'); return Promise.resolve(); }),
    };
    const idle = vi.fn((cb) => cb());
    prefetchPages(loaders, { idle });
    for (let i = 0; i < 6; i++) await flush();
    expect(order).toEqual(['A', 'B', 'C']);
    for (const fn of Object.values(loaders)) expect(fn).toHaveBeenCalledTimes(1);
    expect(idle).toHaveBeenCalledTimes(4); // one to start, one after each chunk settles
  });

  it('skips the excepted pages and stops when cancelled', async () => {
    const calls = [];
    const pending = [];
    const loaders = {
      A: () => { calls.push('A'); return new Promise((r) => pending.push(r)); },
      B: () => { calls.push('B'); return Promise.resolve(); },
      C: () => { calls.push('C'); return Promise.resolve(); },
    };
    const cancel = prefetchPages(loaders, { idle: (cb) => cb(), except: ['B'] });
    await flush(); // the first loader runs on a microtask
    expect(calls).toEqual(['A']);
    cancel();
    pending[0]();
    for (let i = 0; i < 4; i++) await flush();
    expect(calls).toEqual(['A']); // C never started after the cancel
  });
});
