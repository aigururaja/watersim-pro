import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, FolderOpen, Clock, Layers, Archive, Trash2, MoreVertical, Search, X, ChevronDown } from 'lucide-react';
import AppLayout from '../components/layout/AppLayout';
import { SkeletonProjectCard } from '../components/Skeleton';
import EmptyState from '../components/EmptyState';
import { useAnnounce } from '../components/AccessibilityProvider';
import api from '../services/api';

const PROJECT_TYPES = [
  { value: 'wastewater',        label: 'Wastewater Treatment' },
  { value: 'water_purification', label: 'Water Purification' },
  { value: 'combined',          label: 'Combined' },
];

const STATUS_COLORS = {
  active:   'bg-green-100 text-green-700',
  archived: 'bg-gray-100 text-gray-500',
};

function CreateProjectModal({ onClose, onCreate }) {
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
          <h2 id="create-project-title" className="text-xl font-bold text-gray-900">New Project</h2>
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
              placeholder="Municipal WWTP — Phase 2" required maxLength={200} />
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

function ProjectCard({ project, onArchive, onDelete, onClick }) {
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <div
      className="card p-5 cursor-pointer hover:border-brand-300 hover:shadow-md transition-all group relative"
      onClick={onClick}
    >
      {/* Header */}
      <div className="flex items-start justify-between gap-2 mb-2">
        <div className="flex items-center gap-2 min-w-0">
          <div className="w-9 h-9 rounded-lg bg-brand-50 flex items-center justify-center flex-shrink-0">
            <FolderOpen className="w-5 h-5 text-brand-600" />
          </div>
          <h3 className="font-semibold text-gray-900 text-sm truncate">{project.name}</h3>
        </div>

        {/* Context menu */}
        <div className="relative flex-shrink-0" onClick={e => e.stopPropagation()}>
          <button
            onClick={() => setMenuOpen(o => !o)}
            className="p-1.5 rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-100 opacity-0 group-hover:opacity-100 transition-opacity">
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

export default function ProjectsPage() {
  const navigate = useNavigate();
  const announce = useAnnounce();
  const [projects, setProjects]     = useState([]);
  const [loading, setLoading]       = useState(true);
  const [error, setError]           = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [search, setSearch]         = useState('');
  const [filter, setFilter]         = useState('active'); // 'active' | 'archived' | 'all'

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const { data } = await api.get('/projects');
      setProjects(data);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to load projects');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleCreate = (project) => {
    setProjects(ps => [project, ...ps]);
    setShowCreate(false);
    navigate(`/projects/${project.id}`);
  };

  const handleArchive = async (project) => {
    const newStatus = project.status === 'archived' ? 'active' : 'archived';
    try {
      const { data } = await api.patch(`/projects/${project.id}`, { status: newStatus });
      setProjects(ps => ps.map(p => p.id === project.id ? data : p));
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

  return (
    <AppLayout>
      <div className="p-4 md:p-6 space-y-4 md:space-y-6 max-w-7xl mx-auto">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div>
            <h2 className="text-2xl font-bold text-gray-900">Projects</h2>
            <p className="text-gray-500 text-sm mt-0.5">
              {projects.length} project{projects.length !== 1 ? 's' : ''} in your organisation
            </p>
          </div>
          <button className="btn-primary text-sm" onClick={() => setShowCreate(true)}>
            <Plus className="w-4 h-4" /> New Project
          </button>
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
                icon={FolderOpen}
                title="No projects yet"
                description="Create your first project to start building wastewater treatment simulations."
                action={{ label: '+ Create first project', onClick: () => setShowCreate(true) }}
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
                  onClick={() => navigate(`/projects/${project.id}`)}
                />
              </div>
            ))}
          </div>
        )}
      </div>

      {showCreate && (
        <CreateProjectModal onClose={() => setShowCreate(false)} onCreate={handleCreate} />
      )}
    </AppLayout>
  );
}
