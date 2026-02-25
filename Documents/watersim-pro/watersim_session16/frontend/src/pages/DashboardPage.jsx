import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import AppLayout from '../components/layout/AppLayout';
import OnboardingWizard, { hasCompletedOnboarding } from '../components/OnboardingWizard';
import { SkeletonStatCard, SkeletonRecentProject } from '../components/Skeleton';
import { FolderOpen, Activity, Cpu, Droplets, ArrowRight, Plus, Clock } from 'lucide-react';
import api from '../utils/api';

export default function DashboardPage() {
  const { user } = useAuth();
  const [projects, setProjects] = useState([]);
  const [loading, setLoading]   = useState(true);
  const [showOnboarding, setShowOnboarding] = useState(false);

  useEffect(() => {
    api.get('/projects').then(({ data }) => setProjects(data)).catch(() => {}).finally(() => setLoading(false));
  }, []);

  // Show onboarding when user has no projects and hasn't completed it before
  useEffect(() => {
    if (!loading && user && projects.length === 0 && !hasCompletedOnboarding(user.id)) {
      setShowOnboarding(true);
    }
  }, [loading, projects.length, user]);

  const totalFlowsheets = projects.reduce((n, p) => n + (p.flowsheet_count || 0), 0);
  const recentProjects  = projects.slice(0, 3);

  const statCards = [
    { icon: FolderOpen, label: 'Projects',       value: loading ? null : projects.length,       color: 'bg-blue-50 text-blue-600' },
    { icon: Cpu,        label: 'Flowsheets',      value: loading ? null : totalFlowsheets,        color: 'bg-purple-50 text-purple-600' },
    { icon: Activity,   label: 'Simulation Runs', value: '—',                                    color: 'bg-green-50 text-green-600' },
    { icon: Droplets,   label: 'Unit Operations', value: '0',                                    color: 'bg-teal-50 text-teal-600' },
  ];

  return (
    <AppLayout>
      {showOnboarding && user && (
        <OnboardingWizard
          userId={user.id}
          userName={user.firstName}
          onComplete={() => setShowOnboarding(false)}
        />
      )}

      <div className="p-4 md:p-6 space-y-4 md:space-y-6 max-w-7xl mx-auto">
        {/* Welcome */}
        <div>
          <h2 className="text-2xl font-bold text-gray-900">
            Welcome back, {user?.firstName} 👋
          </h2>
          <p className="text-gray-500 mt-1 text-sm">
            {user?.organisation?.name} · <span className="capitalize">{user?.role}</span>
          </p>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4" role="list" aria-label="Summary statistics">
          {statCards.map(({ icon: Icon, label, value, color }) => (
            loading && value === null
              ? <SkeletonStatCard key={label} />
              : (
                <div key={label} className="card p-5 flex items-center gap-4" role="listitem">
                  <div className={`w-11 h-11 rounded-xl flex items-center justify-center flex-shrink-0 ${color}`} aria-hidden="true">
                    <Icon className="w-5 h-5" />
                  </div>
                  <div>
                    <p className="text-2xl font-bold text-gray-900" aria-label={`${value} ${label}`}>{value}</p>
                    <p className="text-sm text-gray-500">{label}</p>
                  </div>
                </div>
              )
          ))}
        </div>

        {/* Quick actions + recent projects */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="card p-6">
            <h3 className="font-semibold text-gray-900 mb-1">New Project</h3>
            <p className="text-sm text-gray-500 mb-4">
              Start a new wastewater or water purification simulation project.
            </p>
            <Link to="/projects/new" className="btn-primary text-sm inline-flex">
              <Plus className="w-4 h-4" aria-hidden="true" /> Create project
            </Link>
          </div>

          <div className="card p-6">
            <h3 className="font-semibold text-gray-900 mb-3">Recent Projects</h3>
            {loading ? (
              <div className="space-y-1" aria-busy="true" aria-label="Loading recent projects">
                {[1, 2].map(i => <SkeletonRecentProject key={i} />)}
              </div>
            ) : recentProjects.length === 0 ? (
              <p className="text-sm text-gray-500 mb-4">No projects yet. Create your first project to get started.</p>
            ) : (
              <nav aria-label="Recent projects" className="space-y-1 mb-4">
                {recentProjects.map(p => (
                  <Link key={p.id} to={`/projects/${p.id}`}
                    className="flex items-center justify-between p-2 rounded-lg hover:bg-gray-50 group transition-colors">
                    <div className="flex items-center gap-2 min-w-0">
                      <FolderOpen className="w-4 h-4 text-brand-400 flex-shrink-0" aria-hidden="true" />
                      <span className="text-sm font-medium text-gray-700 truncate">{p.name}</span>
                    </div>
                    <span className="text-xs text-gray-400 flex items-center gap-1 flex-shrink-0 ml-2" aria-label={`Last updated ${new Date(p.updated_at).toLocaleDateString()}`}>
                      <Clock className="w-3 h-3" aria-hidden="true" />
                      {new Date(p.updated_at).toLocaleDateString()}
                    </span>
                  </Link>
                ))}
              </nav>
            )}
            <Link to="/projects" className="btn-secondary text-sm inline-flex">
              <ArrowRight className="w-4 h-4" aria-hidden="true" /> View all projects
            </Link>
          </div>
        </div>

        {/* Phase indicator */}
        <div className="card p-6 border-l-4 border-brand-500" role="note" aria-label="Phase status">
          <div className="flex items-start gap-3">
            <div className="w-8 h-8 rounded-full bg-brand-100 flex items-center justify-center flex-shrink-0 mt-0.5" aria-hidden="true">
              <span className="text-brand-700 font-bold text-xs">1</span>
            </div>
            <div>
              <p className="font-semibold text-gray-900">Phase 1 — Foundation</p>
              <p className="text-sm text-gray-500 mt-1">
                Auth, RBAC, project/flowsheet management, and canvas shell are active. Simulation engine coming in Phase 2.
              </p>
              <div className="flex gap-2 mt-3 flex-wrap" role="list" aria-label="Phase features">
                {['Auth & RBAC ✅', 'Projects CRUD ✅', 'Flowsheet CRUD ✅', 'Canvas Shell ✅', 'Simulation Engine 🔜'].map(s => (
                  <span key={s} role="listitem" className="text-xs px-2 py-1 bg-gray-100 text-gray-600 rounded-full">{s}</span>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </AppLayout>
  );
}
