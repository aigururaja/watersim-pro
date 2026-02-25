/**
 * EmptyState — a friendly, contextual empty-state component.
 *
 * Usage:
 *   <EmptyState
 *     icon={FolderOpen}
 *     title="No projects yet"
 *     description="Create your first project to start building simulations."
 *     action={{ label: '+ New Project', onClick: () => setShowCreate(true) }}
 *   />
 *
 *   // With secondary action
 *   <EmptyState
 *     icon={Search}
 *     title="No results"
 *     description="Nothing matched your search. Try different keywords."
 *     action={{ label: 'Clear search', onClick: clearSearch }}
 *     secondaryAction={{ label: 'View all', onClick: clearFilters }}
 *   />
 *
 *   // Compact (inline, e.g. inside a table cell)
 *   <EmptyState compact icon={Cpu} title="No simulations" />
 */

import { FolderOpen } from 'lucide-react';

export default function EmptyState({
  icon: Icon = FolderOpen,
  title,
  description,
  action,         // { label, onClick, href }
  secondaryAction, // { label, onClick, href }
  compact = false,
  className = '',
}) {
  return (
    <div
      role="status"
      aria-label={title}
      className={`flex flex-col items-center justify-center text-center
        ${compact ? 'py-8 px-4' : 'py-14 px-6'}
        ${className}`}
    >
      {/* Icon badge */}
      <div
        className={`rounded-2xl bg-brand-50 flex items-center justify-center mb-4 flex-shrink-0
          ${compact ? 'w-10 h-10' : 'w-16 h-16'}`}
        aria-hidden="true"
      >
        <Icon className={`text-brand-400 ${compact ? 'w-5 h-5' : 'w-8 h-8'}`} />
      </div>

      <p className={`font-semibold text-gray-900 ${compact ? 'text-sm' : 'text-base'} mb-1`}>
        {title}
      </p>

      {description && (
        <p className={`text-gray-400 ${compact ? 'text-xs' : 'text-sm'} max-w-xs mb-5`}>
          {description}
        </p>
      )}

      {/* Actions */}
      {(action || secondaryAction) && (
        <div className="flex flex-wrap gap-3 items-center justify-center">
          {action && (
            <ActionButton {...action} variant="primary" compact={compact} />
          )}
          {secondaryAction && (
            <ActionButton {...secondaryAction} variant="secondary" compact={compact} />
          )}
        </div>
      )}
    </div>
  );
}

function ActionButton({ label, onClick, href, variant, compact }) {
  const cls = `${variant === 'primary' ? 'btn-primary' : 'btn-secondary'} ${compact ? 'text-xs' : 'text-sm'}`;
  if (href) {
    return <a href={href} className={cls}>{label}</a>;
  }
  return (
    <button type="button" onClick={onClick} className={cls}>
      {label}
    </button>
  );
}


// ─── Pre-built empty states for common app scenarios ─────────────────────────

import { FolderOpen as _FolderOpen, Cpu, Search, Camera, FileText, Inbox, AlertCircle } from 'lucide-react';

export const EmptyStates = {
  /** No projects exist yet — first-run experience */
  noProjects: (props) => (
    <EmptyState
      icon={_FolderOpen}
      title="No projects yet"
      description="Create your first project to start building wastewater treatment simulations."
      {...props}
    />
  ),

  /** Projects exist but search/filter returned nothing */
  noSearchResults: (props) => (
    <EmptyState
      icon={Search}
      title="No matching projects"
      description="Try different keywords or adjust the status filter."
      {...props}
    />
  ),

  /** Project has no flowsheets */
  noFlowsheets: (props) => (
    <EmptyState
      icon={Cpu}
      title="No flowsheets yet"
      description="Create a flowsheet to start designing your treatment train."
      {...props}
    />
  ),

  /** No snapshots saved */
  noSnapshots: (props) => (
    <EmptyState
      icon={Camera}
      title="No snapshots saved"
      description="Save a snapshot from any flowsheet to create a versioned checkpoint you can restore later."
      {...props}
    />
  ),

  /** No simulation runs */
  noSimulations: (props) => (
    <EmptyState
      icon={_FolderOpen}
      title="No simulation runs"
      description="Run a simulation from the canvas to see results here."
      {...props}
    />
  ),

  /** Generic error state (e.g. failed API request) */
  fetchError: ({ onRetry, ...props }) => (
    <EmptyState
      icon={AlertCircle}
      title="Failed to load"
      description="Something went wrong fetching this data. Check your connection and try again."
      action={onRetry ? { label: 'Retry', onClick: onRetry } : undefined}
      {...props}
    />
  ),

  /** Empty inbox / no notifications */
  noNotifications: (props) => (
    <EmptyState
      icon={Inbox}
      title="You're all caught up"
      description="No notifications right now."
      compact
      {...props}
    />
  ),

  /** No reports generated */
  noReports: (props) => (
    <EmptyState
      icon={FileText}
      title="No reports generated"
      description="Run a simulation to generate a compliance report."
      {...props}
    />
  ),
};
