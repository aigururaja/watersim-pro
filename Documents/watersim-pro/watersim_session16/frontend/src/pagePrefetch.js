/**
 * Page chunks — one dynamic import per page, shared by the router (lazy) and
 * the prefetcher, so a chunk fetched ahead of time is the very one the route
 * resolves later.
 *
 * Why: every page is code-split. Without prefetching, the FIRST click on a
 * page waited for its chunk behind a full-screen loader that replaced the
 * whole shell, then the page appeared — the "not smooth the first time" the
 * plant reported. With the chunks warmed and the router in start-transition
 * mode (main.jsx), the current page stays put until the next one is ready.
 */
export const PAGE_LOADERS = {
  LoginPage:      () => import('./pages/LoginPage'),
  RegisterPage:   () => import('./pages/RegisterPage'),
  DashboardPage:  () => import('./pages/DashboardPage'),
  ProjectsPage:   () => import('./pages/ProjectsPage'),
  ProjectPage:    () => import('./pages/ProjectPage'),
  CanvasPage:     () => import('./pages/CanvasPage'),
  SettingsPage:   () => import('./pages/SettingsPage'),
  ReportPage:     () => import('./pages/ReportPage'),
  AdminPage:      () => import('./pages/AdminPage'),
  ReportsPage:    () => import('./pages/ReportsPage'),
  ComparisonPage: () => import('./pages/ComparisonPage'),
  AlarmsPage:     () => import('./pages/AlarmsPage'),
  AuditPage:      () => import('./pages/AuditPage'),
  TrendsPage:     () => import('./pages/TrendsPage'),
  TasksPage:      () => import('./pages/TasksPage'),
  LivePlantPage:  () => import('./pages/LivePlantPage'),
  TwinPage:       () => import('./pages/TwinPage'),
};

function requestIdle(cb) {
  if (typeof window !== 'undefined' && typeof window.requestIdleCallback === 'function') {
    return window.requestIdleCallback(cb, { timeout: 2000 });
  }
  return setTimeout(cb, 300);
}

/**
 * Warm every page chunk once the browser is idle, one after another so the
 * fetches never compete with the page a person is looking at. A chunk that
 * fails to load is simply left for the route to fetch when it is needed.
 * Returns a function that stops the queue (on unmount).
 *
 * @param {Record<string, () => Promise<unknown>>} loaders
 * @param {{ idle?: (cb: () => void) => unknown, except?: string[] }} options
 */
export function prefetchPages(loaders = PAGE_LOADERS, { idle = requestIdle, except = [] } = {}) {
  const queue = Object.entries(loaders).filter(([name]) => !except.includes(name)).map(([, fn]) => fn);
  let cancelled = false;
  const next = () => {
    if (cancelled || !queue.length) return;
    const load = queue.shift();
    Promise.resolve().then(load).catch(() => {}).then(() => { if (!cancelled) idle(next); });
  };
  idle(next);
  return () => { cancelled = true; };
}
