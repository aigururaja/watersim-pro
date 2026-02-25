# WaterSim Pro — Project State File
> Keep this file updated at each session end. Hand it to the new chat to resume.

## Current Phase: Session 16 — Performance
## Overall Progress: Phase 1–6 ✅ | Sessions 12–15 ✅ | Session 16 ✅

---

## ✅ Session 16 — Performance: Canvas Optimisation, Virtual Scrolling, Cursor Pagination

### Scope
Three pillars:
1. **Canvas performance** — `useCallback` on all hot handlers, `React.memo` on panels and edges, debounced auto-save, `useMemo` for derived state, dev-mode FPS overlay.
2. **Virtual scrolling** — `useVirtualScroll` hook + `VirtualTable` component replace the plain `<table>` in `ReportsPage`. Only visible rows are in the DOM regardless of list size.
3. **Cursor-based API pagination** — backend switches from `OFFSET` to keyset (`completed_at`) cursor pagination; frontend uses `usePaginatedReports` hook with IntersectionObserver infinite scroll.

---

### New Frontend Files

#### `frontend/src/hooks/useVirtualScroll.js`
Low-level virtual-scroll primitive. Takes `{ items, itemHeight, overscan, containerHeight }`, returns `{ containerProps, visibleItems, totalHeight, offsetY }`. Uses `IntersectionObserver`-free approach (onScroll + absolute positioning). Fixed row height for O(1) slice math.

#### `frontend/src/components/VirtualTable.jsx`
Drop-in replacement for large `<table>` renders. Props:
- `rows` – full data array
- `columns` – `[{ key, header, flex?, width?, render(row,idx) }]`
- `rowHeight` (default 52), `containerHeight` (default 520)
- `getRowKey`, `onRowClick`, `emptyState`, `loading`

Shows a skeleton overlay when `loading=true`. Sticky header row stays fixed while the virtualised body scrolls. Alternating row fills via `index % 2`.

#### `frontend/src/hooks/usePaginatedReports.js`
Cursor-based data-fetching hook for the reports list. Replaces the old page/offset state machine.

Key behaviours:
- Initial load and filter-change load run automatically via `useEffect`.
- `loadMore()` appends the next page — deduplicates by `id` to be safe.
- `sentinelRef` callback ref attaches an `IntersectionObserver` with `rootMargin: 200px` to a bottom sentinel `<div>`, auto-triggering `loadMore`.
- `refresh()` resets cursor/runs so the list reloads from scratch (used by the Refresh button).
- Exposes `{ runs, total, loading, loadingMore, error, hasMore, loadMore, refresh, sentinelRef }`.

#### `frontend/src/hooks/useCanvasPerf.js`
Dev-only performance monitor for the flowsheet canvas.
- Counts RAF frames every 1 s to produce a live `fps` value.
- Returns `{ fps, nodeCount, edgeCount, PerfOverlay }`.
- `<PerfOverlay />` renders a semi-transparent HUD in the bottom-left of the canvas (green ≥55fps, amber ≥30, red <30). Renders `null` in production (`import.meta.env.DEV`).
- Logs console warnings when `nodeCount > 50` or `edgeCount > 100`.

---

### New Backend Files

#### `backend/src/db/migrations/004_performance_indexes.js`
Six `CONCURRENTLY` indexes for fast cursor pagination and filter queries:

| Index | Covers |
|---|---|
| `idx_sim_runs_completed_at_desc` | All list queries — `ORDER BY completed_at DESC` |
| `idx_sim_runs_flowsheet_completed` | Per-project filter + sort |
| `idx_sim_runs_mode_completed` | Mode filter + sort |
| `idx_sim_runs_compliant_true` | `compliance=pass` partial index |
| `idx_sim_runs_compliant_false` | `compliance=fail` partial index |
| `idx_saved_reports_run_saved_by` | JOIN in `RUN_SELECT` LEFT JOIN |

All are partial (WHERE `status = 'completed'`) so they stay small and fast as completed runs accumulate.

---

### Modified Backend Files

#### `backend/src/routes/reports_org.js` — `GET /reports`
Switched from `OFFSET` to **keyset cursor pagination**:
- New query param: `cursor` (ISO datetime string = `completed_at` of last fetched row)
- Removed: `page` param
- Changed: `limit` default 30 → 40; max stays 100
- Response shape change: `{ total, runs, nextCursor }` — `nextCursor` is `null` when no more rows
- Fetches `limit + 1` rows to detect `hasMore` without a second COUNT query on the paginated set
- Count query still runs in parallel using the base SQL (without cursor clause) to report accurate total

---

### Modified Frontend Files

#### `frontend/src/pages/CanvasPage.jsx`
Multiple performance upgrades:

| Change | Before | After |
|---|---|---|
| `save()` | plain `async` function | `useCallback` with deps `[projectId, flowsheetId, nodes, edges]` |
| Auto-save | Manual button only | `useEffect` debounce: saves 3 s after last unsaved change |
| `updateParam()` | plain function (new ref every render) | `useCallback([sendEvent])` |
| `summary`, `costBreakdown`, `warnings` | recomputed every render | `useMemo` |
| `StreamEdge` | plain function | `React.memo` — skips re-render when edge props unchanged |
| `ParamPanel` | plain function | `React.memo` — skips re-render when node/result unchanged |
| `SummaryPanel` | plain function | `React.memo` — skips re-render when summary/costs unchanged |
| `useMemo` import | missing | added |
| `useCanvasPerf` | not present | imported, `<PerfOverlay />` rendered inside ReactFlow |

#### `frontend/src/pages/ReportsPage.jsx`
Full pagination and rendering overhaul:

| Change | Before | After |
|---|---|---|
| Data fetching | `loadRuns()` + useState page/offset | `usePaginatedReports` hook |
| Pagination UI | Prev/Next buttons | Infinite scroll via `sentinelRef` |
| Table rendering | Plain `<table>` with all rows in DOM | `VirtualTable` — only visible rows rendered |
| `RunActions` | Inline inside `RunRow` | Extracted as standalone component for `VirtualTable` column renderers |
| Column definitions | Table header JSX | `useMemo`-stabilised column array |
| Filter state | `{ page, limit, projectId, mode, compliance }` | `{ projectId, mode, compliance }` (no page) |
| Refresh | Calls `loadRuns()` | Calls `refresh()` from hook |
| Error handling | Only on initial load | `useEffect` on `runsError` from hook |

---

### Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Fixed-height virtual rows | 56 px for reports | Enables O(1) slice math; no ResizeObserver needed |
| Keyset cursor = `completed_at` | ISO timestamp | Indexed column; stable even when rows insert at head |
| Fetch limit+1 for hasMore | +1 trick | Avoids second COUNT query per page |
| Auto-save debounce 3 s | 3000 ms | Long enough to avoid thrashing on rapid edits; short enough to feel safe |
| PerfOverlay dev-only | `import.meta.env.DEV` | Zero production overhead; Vite tree-shakes the RAF loop |
| `React.memo` on StreamEdge | Memo | ReactFlow re-renders all edges on any node position change without memo |
| Separate `RunActions` component | Extracted | VirtualTable column renderers are closures; component identity must be stable |
| 6 partial indexes | Partial on `status='completed'` | Only completed runs are queried; partial indexes stay lean |

---

## Key API Changes (Session 16)

### GET /reports — new cursor response shape
```
GET /api/v1/reports?limit=40&projectId=uuid&compliance=pass
→ { total: 312, runs: [...], nextCursor: "2025-11-14T09:21:33Z" }

GET /api/v1/reports?limit=40&cursor=2025-11-14T09:21:33Z
→ { total: 312, runs: [...], nextCursor: "2025-10-02T14:55:00Z" }

GET /api/v1/reports?limit=40&cursor=2025-09-01T00:00:00Z  (last page)
→ { total: 312, runs: [...], nextCursor: null }
```

---

## How to Resume
> "We are building WaterSim Pro — a React + Node.js + PostgreSQL web-based process simulation platform for wastewater treatment. Sessions 1–16 are complete. SESSION_STATE_session16.md documents everything. We are starting Session 17: [next task]."

## Next Session Ideas
- **Notifications** — WebSocket real-time toasts, email on run complete
- **User preferences** — theme (dark mode), units (SI/imperial), timezone, density
- **Comments & annotations** — threaded comments on flowsheets and reports
- **Advanced simulation** — sensitivity analysis, Monte Carlo, batch parameter sweeps
- **Integration testing** — Playwright/Cypress E2E tests
- **Documentation site** — Storybook + Docusaurus
