/**
 * VirtualTable — wide tables scroll sideways inside their card instead of
 * losing columns.
 *
 * What is pinned: minRowWidth() adds fixed widths, flexible columns at their
 * minWidth (or the floor), the gaps and the padding; the rendered table is a
 * horizontal scroller whose inner block carries that minimum width, so the
 * header and the rows move together; the loading skeleton does the same.
 */
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import VirtualTable, { minRowWidth } from '../components/VirtualTable';

vi.mock('../hooks/useVirtualScroll', () => ({
  useVirtualScroll: ({ items, itemHeight }) => ({
    containerProps: { style: { height: 200, overflowY: 'auto' } },
    visibleItems: items.map((item, index) => ({ item, index, top: index * itemHeight })),
    totalHeight: items.length * itemHeight,
  }),
}));

const COLUMNS = [
  { key: 'a', header: 'A', flex: '0 0 100px', width: 100 },
  { key: 'b', header: 'B', flex: 2, minWidth: 180 },
  { key: 'c', header: 'C', flex: 1 },               // no minWidth → the 120px floor
  { key: 'd', header: 'D', flex: '0 0 50px', width: '50' },
];

describe('minRowWidth', () => {
  it('sums fixed widths, flexible minimums and the floor, plus gaps and padding', () => {
    // 100 + 180 + 120 + 50 = 450 cells, 3 gaps of 16, 32 padding
    expect(minRowWidth(COLUMNS)).toBe(450 + 48 + 32);
    expect(minRowWidth([])).toBe(32);
    expect(minRowWidth([{ key: 'x', header: 'X' }])).toBe(120 + 32);
  });
});

describe('VirtualTable', () => {
  it('scrolls sideways as one unit, header and rows inside the same minimum width', () => {
    const rows = [{ a: '1', b: 'two', c: 'three', d: '4' }, { a: '5', b: 'six', c: 'seven', d: '8' }];
    const { getByTestId, getByText } = render(<VirtualTable rows={rows} columns={COLUMNS} getRowKey={(r) => r.a} />);
    const scroller = getByTestId('virtual-table');
    expect(scroller.className).toMatch(/overflow-x-auto/);
    expect(scroller.className).not.toMatch(/overflow-hidden/);
    const inner = scroller.firstElementChild;
    expect(inner.style.minWidth).toBe('530px');
    expect(inner.contains(getByText('B'))).toBe(true);     // header
    expect(inner.contains(getByText('six'))).toBe(true);   // a row
  });

  it('the loading skeleton keeps the same minimum width', () => {
    const { container } = render(<VirtualTable rows={[]} columns={COLUMNS} loading />);
    const scroller = container.firstElementChild;
    expect(scroller.className).toMatch(/overflow-x-auto/);
    expect(scroller.firstElementChild.style.minWidth).toBe('530px');
  });

  it('shows the empty state instead of a table when there are no rows', () => {
    const { queryByTestId, getByText } = render(<VirtualTable rows={[]} columns={COLUMNS} emptyState={<p>Nothing here</p>} />);
    expect(queryByTestId('virtual-table')).toBeNull();
    expect(getByText('Nothing here')).toBeTruthy();
  });
});
