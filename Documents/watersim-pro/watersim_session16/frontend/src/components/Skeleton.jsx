/**
 * Skeleton — reusable shimmer loading placeholders.
 *
 * All skeletons use the `animate-pulse` Tailwind utility so they
 * respect `prefers-reduced-motion` when Tailwind's motion-safe
 * variants are active.
 *
 * Usage:
 *   <Skeleton className="h-4 w-32" />
 *   <SkeletonCard />
 *   <SkeletonProjectCard />
 *   <SkeletonStatCard />
 *   <SkeletonTable rows={5} cols={4} />
 *   <SkeletonText lines={3} />
 */

// ── Base ──────────────────────────────────────────────────────────────────────

export function Skeleton({ className = '', rounded = 'rounded-md' }) {
  return (
    <div
      aria-hidden="true"
      className={`bg-gray-200 animate-pulse motion-reduce:animate-none ${rounded} ${className}`}
    />
  );
}

// ── Text block ────────────────────────────────────────────────────────────────

export function SkeletonText({ lines = 3, className = '' }) {
  const widths = ['w-full', 'w-5/6', 'w-4/6', 'w-3/4', 'w-2/3', 'w-1/2'];
  return (
    <div aria-hidden="true" className={`space-y-2 ${className}`}>
      {Array.from({ length: lines }).map((_, i) => (
        <Skeleton
          key={i}
          className={`h-3 ${widths[i % widths.length]}`}
        />
      ))}
    </div>
  );
}

// ── Stat card (Dashboard) ─────────────────────────────────────────────────────

export function SkeletonStatCard() {
  return (
    <div aria-hidden="true" aria-label="Loading…" className="card p-5 flex items-center gap-4">
      <Skeleton className="w-11 h-11 flex-shrink-0" rounded="rounded-xl" />
      <div className="flex-1 space-y-2">
        <Skeleton className="h-6 w-12" />
        <Skeleton className="h-3 w-20" />
      </div>
    </div>
  );
}

// ── Project card (ProjectsPage) ───────────────────────────────────────────────

export function SkeletonProjectCard() {
  return (
    <div aria-hidden="true" aria-label="Loading…" className="card p-5">
      <div className="flex items-center gap-3 mb-3">
        <Skeleton className="w-9 h-9 flex-shrink-0" rounded="rounded-lg" />
        <Skeleton className="h-4 w-2/3" />
      </div>
      <Skeleton className="h-3 w-full mb-2" />
      <Skeleton className="h-3 w-3/4 mb-4" />
      <div className="flex gap-2">
        <Skeleton className="h-5 w-16" rounded="rounded-full" />
        <Skeleton className="h-5 w-12" rounded="rounded-full" />
      </div>
    </div>
  );
}

// ── Flowsheet card (ProjectPage) ──────────────────────────────────────────────

export function SkeletonFlowsheetCard() {
  return (
    <div aria-hidden="true" aria-label="Loading…" className="card p-5">
      <div className="flex items-center justify-between mb-3">
        <Skeleton className="h-4 w-1/2" />
        <Skeleton className="h-4 w-8" />
      </div>
      <Skeleton className="h-3 w-full mb-2" />
      <div className="flex gap-4 mt-3">
        <Skeleton className="h-3 w-10" />
        <Skeleton className="h-3 w-16" />
        <Skeleton className="h-3 w-24" />
      </div>
    </div>
  );
}

// ── Generic card ──────────────────────────────────────────────────────────────

export function SkeletonCard({ lines = 2, className = '' }) {
  return (
    <div aria-hidden="true" aria-label="Loading…" className={`card p-5 space-y-3 ${className}`}>
      <Skeleton className="h-5 w-1/2" />
      <SkeletonText lines={lines} />
    </div>
  );
}

// ── Table ─────────────────────────────────────────────────────────────────────

export function SkeletonTable({ rows = 4, cols = 4 }) {
  return (
    <div aria-hidden="true" className="w-full overflow-x-auto">
      <table className="w-full">
        <thead>
          <tr>
            {Array.from({ length: cols }).map((_, i) => (
              <th key={i} className="p-3">
                <Skeleton className="h-3 w-20" />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: rows }).map((_, row) => (
            <tr key={row} className="border-t border-gray-100">
              {Array.from({ length: cols }).map((_, col) => (
                <td key={col} className="p-3">
                  <Skeleton className={`h-3 ${col === 0 ? 'w-32' : 'w-16'}`} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Dashboard recent-projects row ─────────────────────────────────────────────

export function SkeletonRecentProject() {
  return (
    <div aria-hidden="true" className="flex items-center justify-between p-2">
      <div className="flex items-center gap-2 min-w-0 flex-1">
        <Skeleton className="w-4 h-4 flex-shrink-0" rounded="rounded" />
        <Skeleton className="h-3 w-40" />
      </div>
      <Skeleton className="h-3 w-20 flex-shrink-0 ml-2" />
    </div>
  );
}

// ── Report KPI card ───────────────────────────────────────────────────────────

export function SkeletonKpiCard() {
  return (
    <div aria-hidden="true" className="card p-4 space-y-2">
      <Skeleton className="h-3 w-20" />
      <Skeleton className="h-7 w-24" />
      <Skeleton className="h-2 w-16" />
    </div>
  );
}

// ── Page-level loading overlay ────────────────────────────────────────────────

export function SkeletonPage({ children }) {
  return (
    <div aria-busy="true" aria-label="Loading page content…">
      {children}
    </div>
  );
}
