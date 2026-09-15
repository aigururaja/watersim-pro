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
  LogOut, ChevronLeft, ChevronRight, Menu, X, ShieldCheck, Bell,
  Activity, Boxes, Wrench, ScrollText, Gauge, LineChart, ClipboardList, Monitor, Crown, Eye,
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

/** The tier chip under the product name, one per role — the console's identity line. */
const ROLE_CHIP = {
  admin:    { icon: ShieldCheck, label: 'Admin console',    className: 'bg-white text-ink' },
  manager:  { icon: Crown,       label: 'Manager console',  className: 'bg-star text-ink' },
  engineer: { icon: Wrench,      label: 'Engineer console', className: 'bg-accent text-white' },
  operator: { icon: Activity,    label: 'Operator console', className: 'bg-white/15 text-white' },
  viewer:   { icon: Eye,         label: 'Viewer',           className: 'bg-white/15 text-white' },
};

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

  // Console links: 44px tall, 14px radius, white on ink when active.
  const linkClass = (active) =>
    `flex items-center gap-3 min-h-[40px] rounded-xl text-sm font-medium transition-colors ${expanded ? 'px-3' : 'justify-center px-0'}
     ${active ? 'bg-white/15 text-white' : 'text-white/70 hover:bg-white/10 hover:text-white'}`;
  const groupLabel = 'px-3 pt-3 pb-1 text-[10px] font-bold uppercase tracking-[0.12em]';
  const chip = ROLE_CHIP[user?.role] || ROLE_CHIP.viewer;
  const ChipIcon = chip.icon;
  const initials = `${user?.firstName?.[0] || ''}${user?.lastName?.[0] || ''}`.toUpperCase() || '?';

  return (
    <div className="flex flex-col h-full">
      {/* Identity: product, tier chip, organisation */}
      <div className={`flex-shrink-0 ${expanded ? 'px-5 pt-5 pb-2' : 'px-2 py-4'} ${mobile ? 'flex items-start justify-between gap-2' : ''}`}>
        {expanded ? (
          <div className="min-w-0">
            <div className="flex items-center gap-2.5">
              <span className="w-8 h-8 rounded-xl bg-white/15 flex items-center justify-center flex-shrink-0" aria-hidden="true">
                <Droplets className="w-[18px] h-[18px]" />
              </span>
              <span className="font-extrabold text-lg tracking-tight truncate">SafeKrit</span>
            </div>
            <div className={`mt-3 inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide ${chip.className}`} data-testid="tier-chip">
              <ChipIcon className="w-3 h-3" aria-hidden="true" />
              {chip.label}
            </div>
            {user?.organisation?.name && (
              <div className="text-white/60 text-[12px] mt-2 truncate" title={user.organisation.name}>{user.organisation.name}</div>
            )}
          </div>
        ) : (
          <span className="mx-auto w-9 h-9 rounded-xl bg-white/15 flex items-center justify-center" title="SafeKrit" aria-hidden="true">
            <Droplets className="w-5 h-5" />
          </span>
        )}
        {mobile && (
          <button onClick={onCloseDrawer} aria-label="Close navigation"
            className="p-2 rounded-xl text-white/70 hover:bg-white/10 hover:text-white transition-colors -mr-2">
            <X className="w-5 h-5" />
          </button>
        )}
      </div>

      {/* Nav: one group per surface (the open one shows its links), then administration */}
      <nav className="flex-1 py-1 px-3 overflow-y-auto" aria-label="Main navigation">
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
                className={`w-full flex items-center gap-2 rounded-xl transition-colors
                  ${expanded ? groupLabel : 'justify-center py-2 mt-1'}
                  ${open ? 'text-white/80' : 'text-white/40 hover:text-white/80'}`}
              >
                <SIcon className={expanded ? 'w-3.5 h-3.5 flex-shrink-0' : 'w-5 h-5'} aria-hidden="true" />
                {expanded && <span className="flex-1 text-left truncate">{s.label}</span>}
                {expanded && (
                  <ChevronRight className={`w-3 h-3 transition-transform ${open ? 'rotate-90' : ''}`} aria-hidden="true" />
                )}
              </button>
              {(open || !expanded) && (
                <div id={`surface-${s.key}${mobile ? '-m' : ''}`} className="space-y-0.5">
                  {s.items.map(({ icon: Icon, label, path, badge }) => {
                    const active = isActive({ path, label });
                    return (
                      <Link
                        key={`${s.key}:${label}`}
                        to={path}
                        aria-current={active ? 'page' : undefined}
                        title={badge ? `${label} — arrives in ${badge}` : label}
                        className={linkClass(active)}
                      >
                        <Icon className="w-[18px] h-[18px] flex-shrink-0" aria-hidden="true" />
                        {expanded && <span className="flex-1 truncate">{label}</span>}
                        {expanded && badge && (
                          <span className="pill bg-white/10 text-white/60 normal-case">{badge}</span>
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
        {expanded && <div className={`${groupLabel} text-white/40`}>Administration</div>}
        <div className={`space-y-0.5 ${expanded ? '' : 'mt-2 pt-2 border-t border-white/10'}`}>
          <Link
            to={SETTINGS_ITEM.path}
            aria-current={isActive(SETTINGS_ITEM) ? 'page' : undefined}
            title="Settings"
            className={linkClass(isActive(SETTINGS_ITEM))}
          >
            <Settings className="w-[18px] h-[18px] flex-shrink-0" aria-hidden="true" />
            {expanded && <span>Settings</span>}
          </Link>
          {adminItems.map(({ icon: Icon, label, path }) => (
            <Link
              key={path}
              to={path}
              aria-current={isActive({ path, label }) ? 'page' : undefined}
              title={label}
              className={linkClass(isActive({ path, label }))}
            >
              <Icon className="w-[18px] h-[18px] flex-shrink-0" aria-hidden="true" />
              {expanded && <span>{label}</span>}
            </Link>
          ))}
        </div>
      </nav>

      {/* Person + actions */}
      <div className="flex-shrink-0 border-t border-white/10 px-3 py-3">
        {expanded && user && (
          <div className="flex items-center gap-3 px-2 py-1.5">
            <span className="w-8 h-8 rounded-full bg-white text-ink text-xs font-bold flex items-center justify-center flex-shrink-0" aria-hidden="true">{initials}</span>
            <div className="min-w-0 flex-1">
              <p className="text-[13px] font-medium truncate text-white/90">{user.firstName} {user.lastName}</p>
              <p className="text-[11px] text-white/40 capitalize">{user.role}</p>
            </div>
            <button onClick={onLogout} title="Sign out" aria-label="Sign out"
              className="p-2 rounded-xl text-white/70 hover:bg-white/10 hover:text-white transition-colors">
              <LogOut className="w-4 h-4" />
            </button>
          </div>
        )}
        {!expanded && (
          <button onClick={onLogout} title="Sign out" aria-label="Sign out" className={linkClass(false)}>
            <LogOut className="w-[18px] h-[18px]" />
          </button>
        )}
        {!mobile && (
          <button onClick={onToggleCollapse} className={`${linkClass(false)} mt-1 text-white/50`}
            aria-label={collapsed ? 'Expand navigation' : 'Collapse navigation'} title={collapsed ? 'Expand' : 'Collapse'}>
            {collapsed
              ? <ChevronRight className="w-[18px] h-[18px]" />
              : <><ChevronLeft className="w-[18px] h-[18px]" /><span>Collapse</span></>
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
    <div className="flex h-screen overflow-hidden bg-ground">

      {/* Desktop sidebar */}
      <aside aria-label="Sidebar navigation" className={`hidden md:flex flex-col bg-ink text-white transition-all duration-200 flex-shrink-0
        ${collapsed ? 'w-16' : 'w-[248px]'}`}>
        <SidebarContent {...sidebarProps} />
      </aside>

      {/* Mobile drawer backdrop */}
      {drawerOpen && (
        <div className="md:hidden fixed inset-0 bg-ink/50 z-40" onClick={() => setDrawerOpen(false)} aria-hidden="true" />
      )}

      {/* Mobile drawer */}
      <aside id="mobile-drawer" aria-label="Mobile navigation" aria-hidden={!drawerOpen} className={`md:hidden fixed top-0 left-0 h-full w-72 max-w-[85vw] bg-ink text-white z-50
        flex flex-col transition-transform duration-300
        ${drawerOpen ? 'translate-x-0' : '-translate-x-full'}`}>
        <SidebarContent {...sidebarProps} mobile />
      </aside>

      {/* Main area */}
      <div className="flex flex-col flex-1 overflow-hidden min-w-0">
        {/* Top strip: the page title and the menu on phones; on desktop only
            the tour trigger and the avatar, on the ground, because every page
            carries its own heading the way the console does. */}
        <header className={`${immersive ? 'md:hidden ' : ''}h-14 md:h-12 bg-white/90 md:bg-transparent backdrop-blur md:backdrop-blur-none border-b border-line md:border-0 flex items-center gap-3 px-4 md:px-8 flex-shrink-0`}>
          {/* Mobile hamburger */}
          <button
            className="md:hidden p-2 -ml-2 text-ink-2 hover:text-ink rounded-xl hover:bg-ground transition-colors"
            onClick={() => setDrawerOpen(true)}
            aria-label="Open navigation menu"
            aria-expanded={drawerOpen}
            aria-controls="mobile-drawer"
          >
            <Menu className="w-5 h-5" aria-hidden="true" />
          </button>

          <h1 className="md:hidden text-[15px] font-bold tracking-tight text-ink truncate flex-1">
            {surfaceMeta && active && active.label !== surfaceMeta.label && (
              <span className="hidden sm:inline text-ink-3 font-normal">{surfaceMeta.label} / </span>
            )}
            {title}
          </h1>
          <div className="hidden md:block flex-1" />

          <div className="flex items-center gap-2 flex-shrink-0">
            {/* Onboarding tour trigger */}
            <OnboardingTrigger userId={user?.id} userName={user?.firstName} />

            <div
              className="w-8 h-8 rounded-full bg-ink text-white flex items-center justify-center font-bold text-xs flex-shrink-0"
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
      <nav aria-label="Bottom navigation" className="md:hidden fixed bottom-0 left-0 right-0 z-30 bg-white border-t border-line flex">
        {bottomItems.map(({ icon: Icon, label, path }) => {
          const isOn = active && active.path === path && active.label === label;
          return (
            <Link key={`${label}:${path}`} to={path}
              aria-label={label}
              aria-current={isOn ? 'page' : undefined}
              className={`flex-1 flex flex-col items-center justify-center py-2 gap-0.5 text-[10px] font-medium transition-colors
                ${isOn ? 'text-brand-600' : 'text-ink-3 hover:text-ink-2'}`}
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
