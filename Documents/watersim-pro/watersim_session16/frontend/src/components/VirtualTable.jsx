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

const GAP = 16;      // gap-4 between cells
const PADDING = 32;  // px-4 on both sides
const FLEX_MIN = 120; // a flexible column with no minWidth of its own

/**
 * The narrowest the row can be without any cell collapsing: fixed widths as
 * given, flexible columns at their minWidth (or a floor). Narrower than this
 * the table scrolls sideways inside its card instead of clipping columns —
 * the Alarms list lost its Task column on a laptop and the Audit trail its
 * Details and IP on a tablet when the card simply hid the overflow.
 */
export function minRowWidth(columns) {
  const cells = columns.reduce((sum, col) => {
    const fixed = parseInt(col.width, 10);
    const min = parseInt(col.minWidth, 10);
    return sum + (Number.isFinite(fixed) ? fixed : Number.isFinite(min) ? min : FLEX_MIN);
  }, 0);
  return cells + GAP * Math.max(columns.length - 1, 0) + PADDING;
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
  const minWidth = minRowWidth(columns);

  if (loading) {
    return (
      <div className="border border-gray-200 rounded-lg overflow-x-auto">
        <div style={{ minWidth }}>
          {/* Header */}
          <div className="flex items-center bg-gray-50 border-b border-gray-200 px-4 py-2 gap-4">
            {columns.map(col => (
              <div key={col.key} className="text-xs font-semibold text-gray-500 uppercase tracking-wide" style={{ flex: col.flex ?? 1, width: col.width, minWidth: col.minWidth }}>
                {col.header}
              </div>
            ))}
          </div>
          {Array.from({ length: 8 }).map((_, i) => <SkeletonRow key={i} cols={columns} />)}
        </div>
      </div>
    );
  }

  if (!rows.length && emptyState) return emptyState;

  return (
    // Sideways scroll lives here, on the whole table, so the header and the
    // rows move together and every column stays reachable on a narrow screen.
    <div className="border border-gray-200 rounded-lg overflow-x-auto" data-testid="virtual-table">
      <div style={{ minWidth }}>
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
    </div>
  );
}
