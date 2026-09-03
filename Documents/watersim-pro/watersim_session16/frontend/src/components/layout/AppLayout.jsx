import { useState, useEffect } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import {
  Droplets, LayoutDashboard, FolderOpen, FileText, Settings,
  LogOut, ChevronLeft, ChevronRight, User, Menu, X, ShieldCheck,
} from 'lucide-react';
import { OnboardingTrigger } from '../OnboardingWizard';

const baseNavItems = [
  { icon: LayoutDashboard, label: 'Dashboard', path: '/dashboard' },
  { icon: FolderOpen,      label: 'Projects',  path: '/projects' },
  { icon: FileText,        label: 'Reports',   path: '/reports' },
  { icon: Settings,        label: 'Settings',  path: '/settings' },
];

const adminNavItem = { icon: ShieldCheck, label: 'Admin', path: '/admin' };

// Module-scope so React keeps the same component identity across renders —
// declaring this inside AppLayout remounted the whole sidebar on every render.
function SidebarContent({
  mobile = false,
  collapsed,
  navItems,
  user,
  pathname,
  onCloseDrawer,
  onLogout,
  onToggleCollapse,
}) {
  return (
    <div className="flex flex-col h-full">
      {/* Logo */}
      <div className={`flex items-center h-14 md:h-16 border-b border-brand-600 flex-shrink-0 px-4 ${mobile ? 'justify-between' : 'gap-3'}`}>
        <div className="flex items-center gap-3 min-w-0">
          <div className="flex-shrink-0 w-8 h-8 rounded-lg bg-white/20 flex items-center justify-center">
            <Droplets className="w-5 h-5" />
          </div>
          {(!collapsed || mobile) && (
            <span className="font-bold text-base truncate">WaterSim Pro</span>
          )}
        </div>
        {mobile && (
          <button onClick={onCloseDrawer}
            className="p-1.5 rounded-lg text-brand-100 hover:bg-white/10 hover:text-white transition-colors -mr-1">
            <X className="w-5 h-5" />
          </button>
        )}
      </div>

      {/* Nav */}
      <nav className="flex-1 py-4 space-y-1 px-2 overflow-y-auto" aria-label="Main navigation">
        {navItems.map(({ icon: Icon, label, path }) => {
          const active = pathname.startsWith(path);
          const isAdmin = path === '/admin';
          return (
            <div key={path}>
              {isAdmin && <div className="my-2 border-t border-brand-600 opacity-40" role="separator" />}
              <Link
                to={path}
                aria-current={active ? 'page' : undefined}
                className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors
                  ${active
                    ? isAdmin
                      ? 'bg-amber-500/30 text-amber-100'
                      : 'bg-white/20 text-white'
                    : isAdmin
                      ? 'text-amber-200 hover:bg-amber-500/20 hover:text-amber-100'
                      : 'text-brand-100 hover:bg-white/10 hover:text-white'}`}
              >
                <Icon className="w-5 h-5 flex-shrink-0" aria-hidden="true" />
                {(!collapsed || mobile) && <span>{label}</span>}
              </Link>
            </div>
          );
        })}
      </nav>

      {/* User + actions */}
      <div className="border-t border-brand-600 p-2 flex-shrink-0">
        {(!collapsed || mobile) && user && (
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
          {(!collapsed || mobile) && <span>Sign out</span>}
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

export default function AppLayout({ children }) {
  const { user, logout } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const [collapsed, setCollapsed] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);

  // Build nav items — show Admin link for admin and engineer roles
  const canAccessAdmin = ['admin', 'engineer'].includes(user?.role);
  const navItems = canAccessAdmin
    ? [...baseNavItems, adminNavItem]
    : baseNavItems;

  // Close mobile drawer on route change
  useEffect(() => { setDrawerOpen(false); }, [location.pathname]);

  // Close drawer on resize to desktop
  useEffect(() => {
    const fn = () => { if (window.innerWidth >= 768) setDrawerOpen(false); };
    window.addEventListener('resize', fn);
    return () => window.removeEventListener('resize', fn);
  }, []);

  const handleLogout = async () => { await logout(); navigate('/login'); };

  const sidebarProps = {
    collapsed,
    navItems,
    user,
    pathname: location.pathname,
    onCloseDrawer: () => setDrawerOpen(false),
    onLogout: handleLogout,
    onToggleCollapse: () => setCollapsed(c => !c),
  };

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
        <header className="h-14 md:h-16 bg-white border-b border-gray-200 flex items-center gap-3 px-4 md:px-6 flex-shrink-0">
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
            {navItems.find(n => location.pathname.startsWith(n.path))?.label || 'WaterSim Pro'}
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
        <main id="main-content" tabIndex="-1" className="flex-1 overflow-auto pb-16 md:pb-0 h-full" aria-label="Page content">
          {children}
        </main>
      </div>

      {/* Mobile bottom navigation bar — base items only (Admin accessible via hamburger) */}
      <nav aria-label="Bottom navigation" className="md:hidden fixed bottom-0 left-0 right-0 z-30 bg-white border-t border-gray-200 flex">
        {baseNavItems.map(({ icon: Icon, label, path }) => {
          const active = location.pathname.startsWith(path);
          return (
            <Link key={path} to={path}
              aria-label={label}
              aria-current={active ? 'page' : undefined}
              className={`flex-1 flex flex-col items-center justify-center py-2 gap-0.5 text-[10px] font-medium transition-colors
                ${active ? 'text-brand-600' : 'text-gray-400 hover:text-gray-600'}`}
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
