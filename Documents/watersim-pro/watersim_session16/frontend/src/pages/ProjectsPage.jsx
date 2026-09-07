/**
 * ProjectsPage — two lists, one page.
 *
 *   kind = 'monitoring'   Operations → Projects. The plant as built and wired:
 *                         its flowsheet, tags and PLC points; what the Live
 *                         plant screen watches. Created here, opened under
 *                         /monitoring/projects.
 *   kind = 'twin'         Digital Twin → Projects. A model to run beside the
 *                         plant, or a design study. Created here, or IMPORTED
 *                         from a monitoring project (the flowsheets copied and
 *                         linked to their live source, so the twin reads the
 *                         plant's measurements). Opened under /projects.
 */
import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Plus, FolderOpen, Clock, Layers, Archive, Trash2, MoreVertical, Search, X, ChevronDown, Download, Radio, Boxes, Monitor, Loader2,
} from 'lucide-react';
import AppLayout from '../components/layout/AppLayout';
import { SkeletonProjectCard } from '../components/Skeleton';
import EmptyState from '../components/EmptyState';
import { useAnnounce } from '../components/AccessibilityProvider';
import api from '../services/api';
import { baseForKind, TWIN_BASE } from '../utils/projectBase';

const PROJECT_TYPES = [
  { value: 'wastewater',        label: 'Wastewater Treatment' },
  { value: 'water_purification', label: 'Water Purification' },
  { value: 'combined',          label: 'Combined' },
];

const STATUS_COLORS = {
  active:   'bg-green-100 text-green-700',
  archived: 'bg-gray-100 text-gray-500',
};

const KIND_COPY = {
  monitoring: {
    title: 'Monitoring projects',
    icon: Monitor,
    lead: (n) => `${n} plant${n !== 1 ? 's' : ''} monitored in your organisation`,
    create: 'New plant',
    createTitle: 'New monitoring project',
    namePlaceholder: 'ITC hotel STP — 675 KLD',
    emptyTitle: 'No plants yet',
    emptyBody: 'Add the plant you operate: its flowsheet, tags and PLC points. Operations watches it on the Live plant screen.',
    emptyAction: '+ Add the first plant',
  },
  twin: {
    title: 'Twin projects',
    icon: Boxes,
    lead: (n) => `${n} model${n !== 1 ? 's' : ''} in your organisation`,
    create: 'New model',
    createTitle: 'New twin project',
    namePlaceholder: 'Municipal WWTP — Phase 2 study',
    emptyTitle: 'No twin projects yet',
    emptyBody: 'Import the plant you monitor and run the twin beside it, or create a model from scratch.',
    emptyAction: '+ Create a model',
  },
};

function CreateProjectModal({ kind, onClose, onCreate }) {
  const copy = KIND_COPY[kind];
  const [form, setForm] = useState({ name: '', description: '', projectType: 'wastewater', tags: '' });
  const [saving, setSaving] = useState(false);
  const [error, setError]   = useState('');

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setSaving(true);
    try {
      const tags = form.tags.split(',').map(t => t.trim()).filter(Boolean);
      const { data } = await api.post('/projects', {
        name:        form.name,
        description: form.description || undefined,
        projectType: form.projectType,
        tags,
        kind,
      });
      onCreate(data);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to create project');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-end sm:items-center justify-center z-50 p-0 sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="create-project-title"
      onClick={onClose}
      onKeyDown={e => e.key === 'Escape' && onClose()}
    >
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg p-6 md:p-8 max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-6">
          <h2 id="create-project-title" className="text-xl font-bold text-gray-900">{copy.createTitle}</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 p-1 rounded-lg hover:bg-gray-100" aria-label="Close dialog">
            <X className="w-5 h-5" aria-hidden="true" />
          </button>
        </div>

        {error && (
          <div className="mb-4 px-4 py-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">{error}</div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="label">Project Name *</label>
            <input className="input" value={form.name}
              onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
              placeholder={copy.namePlaceholder} required maxLength={200} />
          </div>

          <div>
            <label className="label">Type *</label>
            <div className="relative">
              <select
                className="input pr-8 appearance-none"
                value={form.projectType}
                onChange={e => setForm(f => ({ ...f, projectType: e.target.value }))}>
                {PROJECT_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
              <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none" />
            </div>
          </div>

          <div>
            <label className="label">Description</label>
            <textarea className="input resize-none" rows={3} value={form.description}
              onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
              placeholder="Brief description of the project scope…" />
          </div>

          <div>
            <label className="label">Tags <span className="text-gray-400 font-normal">(comma-separated)</span></label>
            <input className="input" value={form.tags}
              onChange={e => setForm(f => ({ ...f, tags: e.target.value }))}
              placeholder="activated-sludge, phase-2, demo" />
          </div>

          <div className="flex justify-end gap-3 pt-2">
            <button type="button" onClick={onClose}
              className="px-4 py-2 text-sm font-medium text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200 transition-colors">
              Cancel
            </button>
            <button type="submit" disabled={saving}
              className="btn-primary text-sm disabled:opacity-60">
              {saving ? 'Creating…' : 'Create Project'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/**
 * Import from live: pick a monitoring project, name the twin, and the server
 * copies its flowsheets — each linked to the live one it came from.
 */
function ImportFromLiveModal({ onClose, onImported }) {
  const [sources, setSources] = useState(null);
  const [picked, setPicked]   = useState(null);
  const [name, setName]       = useState('');
  const [busy, setBusy]       = useState(false);
  const [error, setError]     = useState('');

  useEffect(() => {
    let cancelled = false;
    api.get('/projects?kind=monitoring')
      .then(({ data }) => { if (!cancelled) setSources(data.filter(p => p.status !== 'archived')); })
      .catch(err => { if (!cancelled) { setError(err.response?.data?.error || 'Could not load the monitored plants'); setSources([]); } });
    return () => { cancelled = true; };
  }, []);

  const pick = (p) => { setPicked(p); setName(`${p.name} — twin`); };

  const submit = async (e) => {
    e.preventDefault();
    if (!picked) return;
    setBusy(true);
    setError('');
    try {
      const { data } = await api.post(`/projects/${picked.id}/import-to-twin`, { name: name.trim() || undefined });
      onImported(data);
    } catch (err) {
      setError(err.response?.data?.error || 'Import failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-end sm:items-center justify-center z-50 p-0 sm:p-4"
      role="dialog" aria-modal="true" aria-labelledby="import-live-title"
      onClick={onClose} onKeyDown={e => e.key === 'Escape' && onClose()}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg p-6 md:p-8 max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-2">
          <h2 id="import-live-title" className="text-xl font-bold text-gray-900">Import from live</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 p-1 rounded-lg hover:bg-gray-100" aria-label="Close dialog">
            <X className="w-5 h-5" aria-hidden="true" />
          </button>
        </div>
        <p className="text-sm text-gray-500 mb-4">
          Copy a monitored plant into a twin project. Its flowsheets are copied and stay linked to the plant, so the twin runs on the plant's measurements. PLC points are not copied: the twin never writes to the plant.
        </p>

        {error && <div className="mb-4 px-4 py-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">{error}</div>}

        <form onSubmit={submit} className="space-y-4">
          <div role="radiogroup" aria-label="Monitored plants" className="space-y-1 max-h-64 overflow-y-auto">
            {sources === null && <div className="text-sm text-gray-400 flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Loading plants…</div>}
            {sources && sources.length === 0 && <div className="text-sm text-gray-400">No monitored plants yet. Add one under Operations → Projects first.</div>}
            {sources && sources.map(p => (
              <label key={p.id} className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer ${picked?.id === p.id ? 'border-brand-400 bg-brand-50' : 'border-gray-200 hover:bg-gray-50'}`}>
                <input type="radio" name="source" className="mt-1" checked={picked?.id === p.id} onChange={() => pick(p)} aria-label={p.name} />
                <span className="min-w-0">
                  <span className="block text-sm font-semibold text-gray-900 truncate">{p.name}</span>
                  <span className="block text-xs text-gray-500">{p.flowsheet_count ?? 0} flowsheet{(p.flowsheet_count ?? 0) === 1 ? '' : 's'}{p.description ? ` · ${p.description}` : ''}</span>
                </span>
              </label>
            ))}
          </div>

          {picked && (
            <div>
              <label className="label" htmlFor="import-twin-name">Twin project name</label>
              <input id="import-twin-name" className="input" value={name} onChange={e => setName(e.target.value)} maxLength={200} />
            </div>
          )}

          <div className="flex justify-end gap-3 pt-2">
            <button type="button" onClick={onClose} className="px-4 py-2 text-sm font-medium text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200 transition-colors">Cancel</button>
            <button type="submit" disabled={!picked || busy} className="btn-primary text-sm disabled:opacity-60">
              {busy ? 'Importing…' : 'Import'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function ProjectCard({ project, onArchive, onDelete, onClick }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const Icon = project.kind === 'monitoring' ? Monitor : FolderOpen;

  return (
    <div
      className="card p-5 cursor-pointer hover:border-brand-300 hover:shadow-md transition-all group relative"
      onClick={onClick}
      data-kind={project.kind || 'twin'}
    >
      {/* Header */}
      <div className="flex items-start justify-between gap-2 mb-2">
        <div className="flex items-center gap-2 min-w-0">
          <div className="w-9 h-9 rounded-lg bg-brand-50 flex items-center justify-center flex-shrink-0">
            <Icon className="w-5 h-5 text-brand-600" />
          </div>
          <h3 className="font-semibold text-gray-900 text-sm truncate">{project.name}</h3>
        </div>

        {/* Context menu */}
        <div className="relative flex-shrink-0" onClick={e => e.stopPropagation()}>
          <button
            onClick={() => setMenuOpen(o => !o)}
            aria-label={`Actions for ${project.name}`}
            className="p-1.5 rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-100 opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity">
            <MoreVertical className="w-4 h-4" />
          </button>
          {menuOpen && (
            <>
              <div className="fixed inset-0 z-10" onClick={() => setMenuOpen(false)} />
              <div className="absolute right-0 top-8 z-20 bg-white border border-gray-200 rounded-xl shadow-xl py-1 min-w-[150px]">
                <button
                  className="flex items-center gap-2 w-full px-4 py-2 text-sm text-gray-700 hover:bg-gray-50"
                  onClick={() => { onArchive(project); setMenuOpen(false); }}>
                  <Archive className="w-4 h-4" />
                  {project.status === 'archived' ? 'Unarchive' : 'Archive'}
                </button>
                <button
                  className="flex items-center gap-2 w-full px-4 py-2 text-sm text-red-600 hover:bg-red-50"
                  onClick={() => { onDelete(project); setMenuOpen(false); }}>
                  <Trash2 className="w-4 h-4" />
                  Delete
                </button>
              </div>
            </>
          )}
        </div>
      </div>

      {/* Where a twin came from */}
      {project.source_project_name && (
        <p className="text-xs text-emerald-700 mb-2 ml-11 flex items-center gap-1 truncate" title={`Imported from ${project.source_project_name}; runs on its measurements`}>
          <Radio className="w-3 h-3 flex-shrink-0" /> from live: {project.source_project_name}
        </p>
      )}

      {/* Description */}
      {project.description && (
        <p className="text-xs text-gray-500 mb-3 line-clamp-2 ml-11">{project.description}</p>
      )}

      {/* Tags */}
      {project.tags?.length > 0 && (
        <div className="flex flex-wrap gap-1 mb-3 ml-11">
          {project.tags.slice(0, 3).map(tag => (
            <span key={tag} className="px-2 py-0.5 bg-gray-100 text-gray-600 rounded-full text-xs">{tag}</span>
          ))}
          {project.tags.length > 3 && (
            <span className="px-2 py-0.5 bg-gray-100 text-gray-400 rounded-full text-xs">+{project.tags.length - 3}</span>
          )}
        </div>
      )}

      {/* Footer */}
      <div className="flex items-center justify-between ml-11 mt-auto pt-1">
        <div className="flex items-center gap-3 text-xs text-gray-400">
          <span className="flex items-center gap-1">
            <Layers className="w-3 h-3" /> {project.flowsheet_count ?? 0}
          </span>
          <span className="flex items-center gap-1">
            <Clock className="w-3 h-3" /> {new Date(project.updated_at).toLocaleDateString()}
          </span>
        </div>
        <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${STATUS_COLORS[project.status] || STATUS_COLORS.active}`}>
          {project.status}
        </span>
      </div>
    </div>
  );
}

export default function ProjectsPage({ kind = 'twin', autoOpen = false }) {
  const navigate = useNavigate();
  const announce = useAnnounce();
  const copy = KIND_COPY[kind] || KIND_COPY.twin;
  const base = baseForKind(kind);
  const isTwin = kind === 'twin';
  const [projects, setProjects]     = useState([]);
  const [loading, setLoading]       = useState(true);
  const [error, setError]           = useState('');
  const [showCreate, setShowCreate] = useState(!!autoOpen);
  const [showImport, setShowImport] = useState(false);
  const [search, setSearch]         = useState('');
  const [filter, setFilter]         = useState('active'); // 'active' | 'archived' | 'all'

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const { data } = await api.get(`/projects?kind=${kind}`);
      setProjects(data);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to load projects');
    } finally {
      setLoading(false);
    }
  }, [kind]);

  useEffect(() => { load(); }, [load]);

  const handleCreate = (project) => {
    setProjects(ps => [project, ...ps]);
    setShowCreate(false);
    navigate(`${base}/${project.id}`);
  };

  const handleImported = (project) => {
    setProjects(ps => [project, ...ps]);
    setShowImport(false);
    announce(`"${project.name}" imported from live`);
    navigate(`${TWIN_BASE}/${project.id}`);
  };

  const handleArchive = async (project) => {
    const newStatus = project.status === 'archived' ? 'active' : 'archived';
    try {
      const { data } = await api.patch(`/projects/${project.id}`, { status: newStatus });
      setProjects(ps => ps.map(p => p.id === project.id ? { ...p, ...data } : p));
      announce(`Project "${project.name}" ${newStatus === 'archived' ? 'archived' : 'unarchived'}`);
    } catch {
      alert('Failed to update project status');
    }
  };

  const handleDelete = async (project) => {
    if (!confirm(`Delete "${project.name}"? This cannot be undone.`)) return;
    try {
      await api.delete(`/projects/${project.id}`);
      setProjects(ps => ps.filter(p => p.id !== project.id));
      announce(`Project "${project.name}" deleted`);
    } catch {
      alert('Failed to delete project');
    }
  };

  const filtered = projects.filter(p => {
    const matchesSearch = !search ||
      p.name.toLowerCase().includes(search.toLowerCase()) ||
      p.description?.toLowerCase().includes(search.toLowerCase()) ||
      p.tags?.some(t => t.toLowerCase().includes(search.toLowerCase()));
    const matchesFilter = filter === 'all' || p.status === filter;
    return matchesSearch && matchesFilter;
  });

  const TitleIcon = copy.icon;

  return (
    <AppLayout>
      <div className="p-4 md:p-6 space-y-4 md:space-y-6 max-w-7xl mx-auto" data-projects-kind={kind}>
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div>
            <h2 className="text-2xl font-bold text-gray-900 flex items-center gap-2"><TitleIcon className="w-6 h-6 text-brand-600" aria-hidden="true" /> {copy.title}</h2>
            <p className="text-gray-500 text-sm mt-0.5">{copy.lead(projects.length)}</p>
          </div>
          <div className="flex items-center gap-2">
            {isTwin && (
              <button className="btn-secondary text-sm" onClick={() => setShowImport(true)}>
                <Download className="w-4 h-4" /> Import from live
              </button>
            )}
            <button className="btn-primary text-sm" onClick={() => setShowCreate(true)}>
              <Plus className="w-4 h-4" /> {copy.create}
            </button>
          </div>
        </div>

        {/* Toolbar */}
        <div className="flex flex-col sm:flex-row gap-3">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
            <input
              className="input pl-9"
              placeholder="Search projects…"
              value={search}
              onChange={e => setSearch(e.target.value)}
              aria-label="Search projects"
              type="search"
            />
          </div>
          <div className="flex rounded-lg border border-gray-200 bg-white overflow-hidden flex-shrink-0" role="group" aria-label="Filter projects by status">
            {['active', 'archived', 'all'].map(f => (
              <button key={f}
                onClick={() => setFilter(f)}
                aria-pressed={filter === f}
                className={`px-4 py-2 text-sm font-medium capitalize transition-colors
                  ${filter === f ? 'bg-brand-600 text-white' : 'text-gray-600 hover:bg-gray-50'}`}>
                {f}
              </button>
            ))}
          </div>
        </div>

        {/* Content */}
        {loading && (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4" aria-busy="true" aria-label="Loading projects">
            {[1, 2, 3].map(i => <SkeletonProjectCard key={i} />)}
          </div>
        )}

        {error && (
          <EmptyState
            icon={FolderOpen}
            title="Failed to load projects"
            description={error}
            action={{ label: 'Retry', onClick: load }}
          />
        )}

        {!loading && !error && filtered.length === 0 && (
          <div className="card">
            {search || filter !== 'active' ? (
              <EmptyState
                icon={Search}
                title="No matching projects"
                description="Try different keywords or adjust the status filter."
                action={{ label: 'Clear search', onClick: () => { setSearch(''); setFilter('active'); } }}
              />
            ) : (
              <EmptyState
                icon={TitleIcon}
                title={copy.emptyTitle}
                description={copy.emptyBody}
                action={isTwin
                  ? { label: 'Import from live', onClick: () => setShowImport(true) }
                  : { label: copy.emptyAction, onClick: () => setShowCreate(true) }}
              />
            )}
          </div>
        )}

        {!loading && !error && filtered.length > 0 && (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4" role="list" aria-label={`${filtered.length} projects`}>
            {filtered.map(project => (
              <div key={project.id} role="listitem">
                <ProjectCard
                  project={project}
                  onArchive={handleArchive}
                  onDelete={handleDelete}
                  onClick={() => navigate(`${base}/${project.id}`)}
                />
              </div>
            ))}
          </div>
        )}
      </div>

      {showCreate && (
        <CreateProjectModal kind={kind} onClose={() => setShowCreate(false)} onCreate={handleCreate} />
      )}
      {showImport && (
        <ImportFromLiveModal onClose={() => setShowImport(false)} onImported={handleImported} />
      )}
    </AppLayout>
  );
}
