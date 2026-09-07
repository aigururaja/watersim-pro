/**
 * DashboardPage — the home screen, built for the role that logged in.
 *
 * One call to GET /dashboard returns the sections this role gets (the server
 * decides; see backend routes/dashboard.js), and RoleDashboard draws them:
 * a viewer's plant overview, an operator's console, an engineer's desk, a
 * manager's overview, an administrator's page. Alarm and task events on the
 * organisation socket refresh it; PLC updates move the readings in place;
 * and it reconciles itself once a minute regardless.
 */
import { useState, useEffect, useCallback, useRef } from 'react';
import { RefreshCw, AlertCircle } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import AppLayout from '../components/layout/AppLayout';
import OnboardingWizard, { hasCompletedOnboarding } from '../components/OnboardingWizard';
import { SkeletonStatCard, SkeletonCard } from '../components/Skeleton';
import RoleDashboard, { ROLE_META } from '../components/dashboard/RoleDashboards';
import { useOrgLive } from '../hooks/useOrgLive';
import { relTime } from '../components/alarms/alarmState';
import api from '../services/api';

const RECONCILE_MS = 60_000;

export default function DashboardPage() {
  const { user } = useAuth();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [showOnboarding, setShowOnboarding] = useState(false);
  const reloadTimer = useRef(null);

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const { data: d } = await api.get('/dashboard');
      setData(d);
      setError(null);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to load dashboard data');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { const t = setInterval(() => load(true), RECONCILE_MS); return () => clearInterval(t); }, [load]);

  // An alarm or task event changes the numbers: reload, at most once a second and a half.
  const bump = useCallback(() => {
    if (reloadTimer.current) return;
    reloadTimer.current = setTimeout(() => { reloadTimer.current = null; load(true); }, 1500);
  }, [load]);
  useEffect(() => () => { if (reloadTimer.current) clearTimeout(reloadTimer.current); }, []);

  // PLC values move the readings in place, no round trip.
  const applyValues = useCallback(({ values }) => {
    if (!Array.isArray(values) || !values.length) return;
    setData((d) => {
      if (!d?.readings?.items?.length) return d;
      const byTag = new Map(values.filter((v) => v.tagId).map((v) => [v.tagId, v]));
      let changed = false;
      const items = d.readings.items.map((r) => {
        const v = byTag.get(r.id);
        if (!v) return r;
        changed = true;
        return { ...r, value: v.value, quality: v.quality, at: v.ts };
      });
      return changed ? { ...d, readings: { ...d.readings, items } } : d;
    });
  }, []);

  useOrgLive({ onPlcUpdate: applyValues, onAlarmEvent: bump, onTaskEvent: bump });

  // First-run help for the people who can build a plant: no projects yet, and they have not been through it.
  useEffect(() => {
    if (!loading && !error && user && data?.projects && data.projects.total === 0 && !hasCompletedOnboarding(user.id)) {
      setShowOnboarding(true);
    }
  }, [loading, error, data, user]);

  const role = data?.role || user?.role || 'viewer';
  const meta = ROLE_META[role] || ROLE_META.viewer;

  return (
    <AppLayout>
      {showOnboarding && user && (
        <OnboardingWizard userId={user.id} userName={user.firstName} onComplete={() => setShowOnboarding(false)} />
      )}

      <div className="p-4 md:p-6 space-y-4 md:space-y-6 max-w-[1600px] mx-auto">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="text-2xl font-bold text-gray-900">{meta.title}</h2>
            <p className="text-gray-500 mt-1 text-sm">
              Welcome back, {user?.firstName} 👋 · {user?.organisation?.name} · <span className="capitalize">{role}</span>
            </p>
            <p className="text-gray-400 text-xs mt-0.5">{meta.blurb}</p>
          </div>
          <div className="flex items-center gap-2 text-[11px] text-gray-400">
            {data?.at && <span>updated {relTime(data.at)}</span>}
            <button onClick={() => load(true)} disabled={loading} className="btn-secondary text-xs py-1 disabled:opacity-50" aria-label="Refresh">
              <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            </button>
          </div>
        </div>

        {error && (
          <div role="alert" className="card p-5 border-l-4 border-red-500 flex items-center justify-between gap-4 flex-wrap">
            <div className="flex items-center gap-3">
              <AlertCircle className="w-5 h-5 text-red-500 flex-shrink-0" aria-hidden="true" />
              <div>
                <p className="font-semibold text-gray-900 text-sm">Could not load dashboard</p>
                <p className="text-sm text-gray-500">{error}</p>
              </div>
            </div>
            <button onClick={() => load()} className="btn-secondary text-sm">
              <RefreshCw className="w-4 h-4" aria-hidden="true" /> Retry
            </button>
          </div>
        )}

        {loading && !data && (
          <div className="space-y-4" aria-busy="true" aria-label="Loading dashboard">
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">{[1, 2, 3, 4].map((i) => <SkeletonStatCard key={i} />)}</div>
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">{[1, 2, 3].map((i) => <SkeletonCard key={i} lines={4} />)}</div>
          </div>
        )}

        {data && <RoleDashboard data={data} />}
      </div>
    </AppLayout>
  );
}
