/**
 * SafeKrit — AppLayout
 *
 * The application shell. Since Phase 0 of the three-application plan the
 * sidebar is organised into three SURFACES — Operations, Digital Twin,
 * Maintenance — each gated by a capability from `auth/roles.js`, plus an
 * Administration group for admins. A surface a role cannot see is not
 * rendered at all (the server refuses its API regardless; this only decides
 * what is drawn). The last surface a person opened is remembered per browser
 * so the shell reopens where they left it.
 *
 * Pages that are not yet built by their phase point at the closest existing
 * page, so nothing in the nav is a dead link during the rollout.
 */
import { useState, useEffect, useMemo, useRef } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { useReducedMotion } from '../AccessibilityProvider';
import {
  Droplets, LayoutDashboard, FolderOpen, FileText, Settings,
  LogOut, ChevronLeft, ChevronRight, User, Menu, X, ShieldCheck, Bell,
  Activity, Boxes, Wrench, ScrollText, Gauge, LineChart, ClipboardList, Monitor,
} from 'lucide-react';
import { OnboardingTrigger } from '../OnboardingWizard';

// ── Surfaces ──────────────────────────────────────────────────────────────────
//
// `capability` gates the whole group. `items[].capability` (optional) gates a
// single link. `home` is where a click on the surface heading goes.
export const SURFACES = [
  {
    key: 'ops',
    label: 'Operations',
    icon: Activity,
    capability: 'ops.view',
    home: '/dashboard',
    items: [
      { icon: Monitor,         label: 'Live plant', path: '/live' },
      { icon: LayoutDashboard, label: 'Dashboard', path: '/dashboard' },
      { icon: FolderOpen,      label: 'Projects',  path: '/monitoring/projects' },
      { icon: Bell,            label: 'Alarms',    path: '/alarms' },
      { icon: LineChart,       label: 'Trends',    path: '/trends' },
      { icon: FileText,        label: 'Reports',   path: '/reports' },
    ],
  },
  {
    key: 'twin',
    label: 'Digital Twin',
    icon: Boxes,
    capability: 'twin.view',
    home: '/twin',
    items: [
      { icon: Boxes,      label: 'Twin',      path: '/twin' },
      { icon: FolderOpen, label: 'Projects',  path: '/projects' },
      { icon: Gauge,      label: 'Scenarios', path: '/reports/compare' },
    ],
  },
  {
    key: 'maintenance',
    label: 'Maintenance',
    icon: Wrench,
    capability: 'maintenance.view',
    home: '/tasks',
    items: [
      { icon: ClipboardList, label: 'Tasks',  path: '/tasks' },
      { icon: Bell,          label: 'Alarms', path: '/alarms' },
    ],
  },
];

/** Administration: not a surface — a group that only some roles see. */
const ADMIN_ITEMS = [
  { icon: ShieldCheck, label: 'Admin', path: '/admin', roles: ['admin', 'engineer', 'manager'] },
  { icon: ScrollText,  label: 'Audit', path: '/audit', capability: 'audit.read' },
];

const SETTINGS_ITEM = { icon: Settings, label: 'Settings', path: '/settings' };

const SURFACE_KEY = 'ws.surface';
const readSurface = () => { try { return localStorage.getItem(SURFACE_KEY); } catch { return null; } };
const writeSurface = (k) => { try { localStorage.setItem(SURFACE_KEY, k); } catch { /* private mode */ } };

/** Every surface that lists a link under this path, in nav order. */
export function surfacesForPath(pathname, surfaces = SURFACES) {
  return surfaces.filter(s => s.items.some(i => pathname.startsWith(i.path))).map(s => s.key);
}

/**
 * Which surface owns a path. A path can live in more than one surface while
 * placeholder links point at their nearest existing page (Alarms is both an
 * Operations page and, until Phase 2, the Maintenance home): the surface the
 * person chose keeps ownership if it is one of them; otherwise the first wins.
 */
export function surfaceForPath(pathname, surfaces = SURFACES, preferred = null) {
  const owners = surfacesForPath(pathname, surfaces);
  if (!owners.length) return null;
  return preferred && owners.includes(preferred) ? preferred : owners[0];
}

/** Longest-prefix match so `/reports/compare` resolves to Scenarios, not Reports. */
function activeItem(items, pathname) {
  let best = null;
  for (const it of items) {
    if (pathname.startsWith(it.path) && (!best || it.path.length > best.path.length)) best = it;
  }
  return best;
}

// Module-scope so React keeps the same component identity across renders —
// declaring this inside AppLayout remounted the whole sidebar on every render.
function SidebarContent({
  mobile = false,
  collapsed,
  surfaces,
  adminItems,
  user,
  pathname,
  currentSurface,
  onSelectSurface,
  onCloseDrawer,
  onLogout,
  onToggleCollapse,
}) {
  const expanded = !collapsed || mobile;
  // The open surface's links are listed first so a path shared between two
  // surfaces highlights the link in the one that is open.
  const ordered = [...surfaces].sort((a, b) => (a.key === currentSurface ? -1 : b.key === currentSurface ? 1 : 0));
  const allItems = [...ordered.flatMap(s => s.items), ...adminItems, SETTINGS_ITEM];
  const current = activeItem(allItems, pathname);
  const isActive = (item) => current && current.path === item.path && current.label === item.label;

  const linkClass = (active, tone = 'default') => {
    const on  = tone === 'admin' ? 'bg-amber-500/30 text-amber-100' : 'bg-white/20 text-white';
    const off = tone === 'admin'
      ? 'text-amber-200 hover:bg-amber-500/20 hover:text-amber-100'
      : 'text-brand-100 hover:bg-white/10 hover:text-white';
    return `flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${active ? on : off}`;
  };

  return (
    <div className="flex flex-col h-full">
      {/* Logo */}
      <div className={`flex items-center h-14 md:h-16 border-b border-brand-600 flex-shrink-0 px-4 ${mobile ? 'justify-between' : 'gap-3'}`}>
        <div className="flex items-center gap-3 min-w-0">
          <div className="flex-shrink-0 w-8 h-8 rounded-lg bg-white/20 flex items-center justify-center">
            <Droplets className="w-5 h-5" />
          </div>
          {expanded && <span className="font-bold text-base truncate">SafeKrit</span>}
        </div>
        {mobile && (
          <button onClick={onCloseDrawer}
            className="p-1.5 rounded-lg text-brand-100 hover:bg-white/10 hover:text-white transition-colors -mr-1">
            <X className="w-5 h-5" />
          </button>
        )}
      </div>

      {/* Nav */}
      <nav className="flex-1 py-3 px-2 overflow-y-auto space-y-3" aria-label="Main navigation">
        {surfaces.map((s) => {
          const SIcon = s.icon;
          const open = s.key === currentSurface;
          return (
            <section key={s.key} data-surface={s.key} data-open={open ? 'true' : 'false'} aria-label={s.label}>
              <button
                type="button"
                onClick={() => onSelectSurface(s.key)}
                aria-expanded={open}
                aria-controls={`surface-${s.key}${mobile ? '-m' : ''}`}
                title={s.label}
                className={`w-full flex items-center gap-3 px-3 py-1.5 rounded-lg text-[11px] font-semibold uppercase tracking-wider transition-colors
                  ${open ? 'text-white' : 'text-brand-200 hover:text-white hover:bg-white/10'}`}
              >
                <SIcon className="w-4 h-4 flex-shrink-0" aria-hidden="true" />
                {expanded && <span className="flex-1 text-left truncate">{s.label}</span>}
                {expanded && (
                  <ChevronRight className={`w-3.5 h-3.5 transition-transform ${open ? 'rotate-90' : ''}`} aria-hidden="true" />
                )}
              </button>
              {(open || !expanded) && (
                <div id={`surface-${s.key}${mobile ? '-m' : ''}`} className="mt-1 space-y-0.5">
                  {s.items.map(({ icon: Icon, label, path, badge }) => {
                    const active = isActive({ path, label });
                    return (
                      <Link
                        key={`${s.key}:${label}`}
                        to={path}
                        aria-current={active ? 'page' : undefined}
                        title={badge ? `${label} — arrives in ${badge}` : label}
                        className={`${linkClass(active)} ${expanded ? 'pl-9' : ''}`}
                      >
                        <Icon className="w-5 h-5 flex-shrink-0" aria-hidden="true" />
                        {expanded && <span className="flex-1 truncate">{label}</span>}
                        {expanded && badge && (
                          <span className="text-[9px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded bg-white/10 text-brand-200">
                            {badge}
                          </span>
                        )}
                      </Link>
                    );
                  })}
                </div>
              )}
            </section>
          );
        })}

        {/* Settings, then the admin group */}
        <div className="pt-2 border-t border-brand-600/60 space-y-0.5">
          <Link
            to={SETTINGS_ITEM.path}
            aria-current={isActive(SETTINGS_ITEM) ? 'page' : undefined}
            className={linkClass(isActive(SETTINGS_ITEM))}
          >
            <Settings className="w-5 h-5 flex-shrink-0" aria-hidden="true" />
            {expanded && <span>Settings</span>}
          </Link>
          {adminItems.map(({ icon: Icon, label, path }) => (
            <Link
              key={path}
              to={path}
              aria-current={isActive({ path, label }) ? 'page' : undefined}
              className={linkClass(isActive({ path, label }), 'admin')}
            >
              <Icon className="w-5 h-5 flex-shrink-0" aria-hidden="true" />
              {expanded && <span>{label}</span>}
            </Link>
          ))}
        </div>
      </nav>

      {/* User + actions */}
      <div className="border-t border-brand-600 p-2 flex-shrink-0">
        {expanded && user && (
          <div className="flex items-center gap-3 px-3 py-2 mb-1">
            <div className="w-8 h-8 rounded-full bg-white/20 flex items-center justify-center flex-shrink-0">
              <User className="w-4 h-4" />
            </div>
            <div className="min-w-0">
              <p className="text-sm font-medium truncate">{user.firstName} {user.lastName}</p>
              <p className="text-xs text-brand-200 capitalize">{user.role}</p>
            </div>
          </div>
        )}
        <button onClick={onLogout}
          className="flex items-center gap-3 w-full px-3 py-2 rounded-lg text-sm text-brand-100 hover:bg-white/10 hover:text-white transition-colors">
          <LogOut className="w-5 h-5 flex-shrink-0" />
          {expanded && <span>Sign out</span>}
        </button>
        {!mobile && (
          <button onClick={onToggleCollapse}
            className="flex items-center gap-3 w-full px-3 py-2 rounded-lg text-sm text-brand-100 hover:bg-white/10 hover:text-white transition-colors mt-1">
            {collapsed
              ? <ChevronRight className="w-5 h-5" />
              : <><ChevronLeft className="w-5 h-5" /><span>Collapse</span></>
            }
          </button>
        )}
      </div>
    </div>
  );
}

export default function AppLayout({ children, immersive = false, defaultCollapsed = false }) {
  const { user, can, logout } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const [collapsed, setCollapsed] = useState(() => {
    try { const v = localStorage.getItem('ws.navCollapsed'); if (v != null) return v === '1'; } catch { /* private mode */ }
    return defaultCollapsed;
  });
  const [drawerOpen, setDrawerOpen] = useState(false);

  // Surfaces this role may see, with per-link capability gates applied.
  const allow = (cap) => !cap || (typeof can === 'function' && can(cap));
  const surfaces = useMemo(
    () => SURFACES
      .filter(s => allow(s.capability))
      .map(s => ({ ...s, items: s.items.filter(i => allow(i.capability)) }))
      .filter(s => s.items.length > 0),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [user?.role, can],
  );
  const adminItems = useMemo(
    () => ADMIN_ITEMS.filter(i => (i.roles ? i.roles.includes(user?.role) : allow(i.capability))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [user?.role, can],
  );

  // The open surface: the one that owns the current path; otherwise the one
  // this browser last used; otherwise the first the role can see.
  const [chosenSurface, setChosenSurface] = useState(readSurface);
  const ownedBy = surfaceForPath(location.pathname, surfaces, chosenSurface);
  const firstKey = surfaces[0]?.key || null;
  const currentSurface = ownedBy
    || (surfaces.some(s => s.key === chosenSurface) ? chosenSurface : firstKey);

  useEffect(() => {
    if (ownedBy && ownedBy !== chosenSurface) { setChosenSurface(ownedBy); writeSurface(ownedBy); }
  }, [ownedBy, chosenSurface]);

  const selectSurface = (key) => {
    setChosenSurface(key);
    writeSurface(key);
    const s = surfaces.find(x => x.key === key);
    // Opening a surface that does not list the current page takes you to its
    // home; one that does (Alarms sits under Operations and Maintenance) stays.
    const owners = surfacesForPath(location.pathname, surfaces);
    if (s && !owners.includes(key)) navigate(s.home);
  };

  // Close mobile drawer on route change
  useEffect(() => { setDrawerOpen(false); }, [location.pathname]);

  // Page transition: the content fades and settles into place on every route
  // change (and on first paint), and the scroller returns to the top. It is a
  // CSS animation restarted by hand rather than a keyed remount, so a page
  // whose params change keeps its component instance and state. Reduced
  // motion — the OS preference or the ws.motion override — shows the page at
  // once instead (the stylesheet's reduced-motion rule catches the OS case
  // even without JS).
  const reducedMotion = useReducedMotion();
  const pageRef = useRef(null);
  const mainRef = useRef(null);
  useEffect(() => {
    if (typeof mainRef.current?.scrollTo === 'function') mainRef.current.scrollTo({ top: 0 });
    const el = pageRef.current;
    if (!el || reducedMotion) return;
    el.classList.remove('ws-page-enter');
    void el.offsetWidth; // flush the removal so the class re-applies as a fresh animation
    el.classList.add('ws-page-enter');
  }, [location.pathname, reducedMotion]);

  // Close drawer on resize to desktop
  useEffect(() => {
    const fn = () => { if (window.innerWidth >= 768) setDrawerOpen(false); };
    window.addEventListener('resize', fn);
    return () => window.removeEventListener('resize', fn);
  }, []);

  const handleLogout = async () => { await logout(); navigate('/login'); };

  const sidebarProps = {
    collapsed,
    surfaces,
    adminItems,
    user,
    pathname: location.pathname,
    currentSurface,
    onSelectSurface: selectSurface,
    onCloseDrawer: () => setDrawerOpen(false),
    onLogout: handleLogout,
    onToggleCollapse: () => setCollapsed(c => { const n = !c; try { localStorage.setItem('ws.navCollapsed', n ? '1' : '0'); } catch { /* private mode */ } return n; }),
  };

  // Header title: the active link's label, or the surface's, or the product's.
  // The open surface's links come first so a shared path names its link there.
  const surfaceMeta = surfaces.find(s => s.key === currentSurface);
  const everyItem = [
    ...(surfaceMeta?.items || []),
    ...surfaces.filter(s => s.key !== currentSurface).flatMap(s => s.items),
    ...adminItems, SETTINGS_ITEM,
  ];
  const active = activeItem(everyItem, location.pathname);
  const title = active?.label || surfaceMeta?.label || 'SafeKrit';

  // Mobile bottom bar: the open surface's links (max 5), plus Settings.
  const bottomItems = [...(surfaceMeta?.items || []).slice(0, 4), SETTINGS_ITEM];

  return (
    <div className="flex h-screen overflow-hidden bg-gray-50">

      {/* Desktop sidebar */}
      <aside aria-label="Sidebar navigation" className={`hidden md:flex flex-col bg-brand-700 text-white transition-all duration-200 flex-shrink-0
        ${collapsed ? 'w-16' : 'w-60'}`}>
        <SidebarContent {...sidebarProps} />
      </aside>

      {/* Mobile drawer backdrop */}
      {drawerOpen && (
        <div className="md:hidden fixed inset-0 bg-black/50 z-40" onClick={() => setDrawerOpen(false)} aria-hidden="true" />
      )}

      {/* Mobile drawer */}
      <aside id="mobile-drawer" aria-label="Mobile navigation" aria-hidden={!drawerOpen} className={`md:hidden fixed top-0 left-0 h-full w-72 max-w-[85vw] bg-brand-700 text-white z-50
        flex flex-col transition-transform duration-300
        ${drawerOpen ? 'translate-x-0' : '-translate-x-full'}`}>
        <SidebarContent {...sidebarProps} mobile />
      </aside>

      {/* Main area */}
      <div className="flex flex-col flex-1 overflow-hidden min-w-0">
        {/* Top bar */}
        <header className={`${immersive ? 'md:hidden ' : ''}h-14 md:h-16 bg-white border-b border-gray-200 flex items-center gap-3 px-4 md:px-6 flex-shrink-0`}>
          {/* Mobile hamburger */}
          <button
            className="md:hidden p-2 -ml-1 text-gray-500 hover:text-gray-700 rounded-lg hover:bg-gray-100 transition-colors"
            onClick={() => setDrawerOpen(true)}
            aria-label="Open navigation menu"
            aria-expanded={drawerOpen}
            aria-controls="mobile-drawer"
          >
            <Menu className="w-5 h-5" aria-hidden="true" />
          </button>

          <h1 className="text-base md:text-lg font-semibold text-gray-900 truncate flex-1">
            {surfaceMeta && active && active.label !== surfaceMeta.label && (
              <span className="hidden sm:inline text-gray-400 font-normal">{surfaceMeta.label} / </span>
            )}
            {title}
          </h1>

          <div className="flex items-center gap-2 flex-shrink-0">
            {/* Onboarding tour trigger */}
            <OnboardingTrigger userId={user?.id} userName={user?.firstName} />

            <div
              className="w-8 h-8 rounded-full bg-brand-100 flex items-center justify-center text-brand-700 font-medium text-sm flex-shrink-0"
              aria-label={`${user?.firstName} ${user?.lastName} — ${user?.role}`}
              role="img"
            >
              {user?.firstName?.[0]}{user?.lastName?.[0]}
            </div>
          </div>
        </header>

        {/* Page content — bottom padding for mobile bottom nav */}
        <main ref={mainRef} id="main-content" tabIndex="-1" className="flex-1 overflow-auto pb-16 md:pb-0 h-full" aria-label="Page content">
          <div ref={pageRef} data-page={location.pathname} className={`h-full ${reducedMotion ? '' : 'ws-page-enter'}`}>
            {children}
          </div>
        </main>
      </div>

      {/* Mobile bottom navigation bar — the open surface's links (Admin via hamburger) */}
      <nav aria-label="Bottom navigation" className="md:hidden fixed bottom-0 left-0 right-0 z-30 bg-white border-t border-gray-200 flex">
        {bottomItems.map(({ icon: Icon, label, path }) => {
          const isOn = active && active.path === path && active.label === label;
          return (
            <Link key={`${label}:${path}`} to={path}
              aria-label={label}
              aria-current={isOn ? 'page' : undefined}
              className={`flex-1 flex flex-col items-center justify-center py-2 gap-0.5 text-[10px] font-medium transition-colors
                ${isOn ? 'text-brand-600' : 'text-gray-400 hover:text-gray-600'}`}
            >
              <Icon className="w-5 h-5" aria-hidden="true" />
              <span>{label}</span>
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
