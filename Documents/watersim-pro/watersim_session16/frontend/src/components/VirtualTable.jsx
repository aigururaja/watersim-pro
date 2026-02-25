/**
 * WaterSim Pro — VirtualTable
 * Session 16: Performance — drop-in virtualised replacement for large
 * paginated tables in ReportsPage.
 *
 * Props:
 *   rows           – full array of row data objects
 *   columns        – [{ key, header, width?, render(row,idx) }]
 *   rowHeight      – number (default 52px)
 *   containerHeight– number (default 520px)
 *   getRowKey      – (row) => string
 *   onRowClick     – optional (row) => void
 *   emptyState     – React node shown when rows is empty
 *   loading        – bool – shows skeleton overlay
 */
import { useRef } from 'react';
import { useVirtualScroll } from '../hooks/useVirtualScroll';

// ── Tiny skeleton row ──────────────────────────────────────────────────────────
function SkeletonRow({ cols }) {
  return (
    <div className="flex items-center border-b border-gray-100 px-4 gap-4" style={{ height: 52 }}>
      {cols.map((_, i) => (
        <div key={i} className="h-3 bg-gray-200 rounded animate-pulse" style={{ flex: 1 }} />
      ))}
    </div>
  );
}

export default function VirtualTable({
  rows = [],
  columns = [],
  rowHeight = 52,
  containerHeight = 520,
  getRowKey = (r, i) => i,
  onRowClick,
  emptyState = null,
  loading = false,
}) {
  const { containerProps, visibleItems, totalHeight } = useVirtualScroll({
    items: rows,
    itemHeight: rowHeight,
    containerHeight,
    overscan: 8,
  });

  if (loading) {
    return (
      <div className="border border-gray-200 rounded-lg overflow-hidden">
        {/* Header */}
        <div className="flex items-center bg-gray-50 border-b border-gray-200 px-4 py-2 gap-4">
          {columns.map(col => (
            <div key={col.key} className="text-xs font-semibold text-gray-500 uppercase tracking-wide" style={{ flex: col.flex ?? 1, width: col.width }}>
              {col.header}
            </div>
          ))}
        </div>
        {Array.from({ length: 8 }).map((_, i) => <SkeletonRow key={i} cols={columns} />)}
      </div>
    );
  }

  if (!rows.length && emptyState) return emptyState;

  return (
    <div className="border border-gray-200 rounded-lg overflow-hidden">
      {/* Sticky header */}
      <div className="flex items-center bg-gray-50 border-b border-gray-200 px-4 py-2 gap-4 sticky top-0 z-10">
        {columns.map(col => (
          <div
            key={col.key}
            className="text-xs font-semibold text-gray-500 uppercase tracking-wide"
            style={{ flex: col.flex ?? 1, width: col.width, minWidth: col.minWidth }}
          >
            {col.header}
          </div>
        ))}
      </div>

      {/* Scrollport */}
      <div {...containerProps}>
        {/* Total height spacer */}
        <div style={{ height: totalHeight, position: 'relative' }}>
          {visibleItems.map(({ item, index, top }) => (
            <div
              key={getRowKey(item, index)}
              onClick={onRowClick ? () => onRowClick(item) : undefined}
              className={`flex items-center border-b border-gray-100 px-4 gap-4 transition-colors
                ${onRowClick ? 'cursor-pointer hover:bg-blue-50' : ''}
                ${index % 2 === 0 ? 'bg-white' : 'bg-gray-50/40'}`}
              style={{ position: 'absolute', top, width: '100%', height: rowHeight }}
            >
              {columns.map(col => (
                <div
                  key={col.key}
                  className="truncate text-sm text-gray-700"
                  style={{ flex: col.flex ?? 1, width: col.width, minWidth: col.minWidth }}
                >
                  {col.render ? col.render(item, index) : item[col.key]}
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
