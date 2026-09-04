import { lazy, Suspense } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './context/AuthContext';
import { Loader2 } from 'lucide-react';
import ErrorBoundary from './components/ErrorBoundary';
import AccessibilityProvider from './components/AccessibilityProvider';

// Code-split every page — each route loads its own chunk on demand.
const LoginPage      = lazy(() => import('./pages/LoginPage'));
const RegisterPage   = lazy(() => import('./pages/RegisterPage'));
const DashboardPage  = lazy(() => import('./pages/DashboardPage'));
const ProjectsPage   = lazy(() => import('./pages/ProjectsPage'));
const ProjectPage    = lazy(() => import('./pages/ProjectPage'));
const CanvasPage     = lazy(() => import('./pages/CanvasPage'));
const SettingsPage   = lazy(() => import('./pages/SettingsPage'));
const ReportPage     = lazy(() => import('./pages/ReportPage'));
const AdminPage      = lazy(() => import('./pages/AdminPage'));
const ReportsPage    = lazy(() => import('./pages/ReportsPage'));
const ComparisonPage = lazy(() => import('./pages/ComparisonPage'));
const AlarmsPage     = lazy(() => import('./pages/AlarmsPage'));

function PageLoader({ label = 'Loading WaterSim Pro…' }) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <div className="flex flex-col items-center gap-3">
        <Loader2 className="w-8 h-8 animate-spin text-brand-600" aria-hidden="true" />
        <p className="text-sm text-gray-500" role="status" aria-live="polite">{label}</p>
      </div>
    </div>
  );
}

function ProtectedRoute({ children }) {
  const { isAuthenticated, loading } = useAuth();
  if (loading) return <PageLoader />;
  return isAuthenticated ? children : <Navigate to="/login" replace />;
}

function PublicRoute({ children }) {
  const { isAuthenticated, loading } = useAuth();
  if (loading) return null;
  return !isAuthenticated ? children : <Navigate to="/dashboard" replace />;
}

function AppRoutes() {
  return (
    <Suspense fallback={<PageLoader />}>
      <Routes>
        {/* Redirect root */}
        <Route path="/" element={<Navigate to="/dashboard" replace />} />

        {/* Public */}
        <Route path="/login"    element={<PublicRoute><LoginPage /></PublicRoute>} />
        <Route path="/register" element={<PublicRoute><RegisterPage /></PublicRoute>} />

        {/* Protect routes within ErrorBoundary — each page has its own, plus this top-level one */}
        <Route path="/dashboard"  element={<ProtectedRoute><ErrorBoundary scope="Dashboard"><DashboardPage /></ErrorBoundary></ProtectedRoute>} />
        <Route path="/projects"   element={<ProtectedRoute><ErrorBoundary scope="Projects"><ProjectsPage /></ErrorBoundary></ProtectedRoute>} />
        <Route path="/projects/new" element={<ProtectedRoute><ErrorBoundary scope="Projects"><ProjectsPage autoOpen /></ErrorBoundary></ProtectedRoute>} />
        <Route path="/projects/:projectId" element={<ProtectedRoute><ErrorBoundary scope="Project"><ProjectPage /></ErrorBoundary></ProtectedRoute>} />
        <Route path="/projects/:projectId/flowsheets/:flowsheetId"
               element={<ProtectedRoute><ErrorBoundary scope="Canvas"><CanvasPage /></ErrorBoundary></ProtectedRoute>} />

        <Route path="/projects/:projectId/flowsheets/:flowsheetId/simulate/:runId/report"
               element={<ProtectedRoute><ErrorBoundary scope="Report"><ReportPage /></ErrorBoundary></ProtectedRoute>} />

        {/* Admin — accessible to admin + engineer roles (page guards internally) */}
        <Route path="/admin" element={<ProtectedRoute><ErrorBoundary scope="Admin"><AdminPage /></ErrorBoundary></ProtectedRoute>} />

        {/* Reports history + comparison */}
        <Route path="/reports" element={<ProtectedRoute><ErrorBoundary scope="Reports"><ReportsPage /></ErrorBoundary></ProtectedRoute>} />
        <Route path="/reports/compare" element={<ProtectedRoute><ErrorBoundary scope="Comparison"><ComparisonPage /></ErrorBoundary></ProtectedRoute>} />

        {/* Org-wide alarm event history */}
        <Route path="/alarms" element={<ProtectedRoute><ErrorBoundary scope="Alarms"><AlarmsPage /></ErrorBoundary></ProtectedRoute>} />

        {/* Simulations -> redirects to Reports */}
        <Route path="/simulations" element={<Navigate to="/reports" replace />} />
        {/* Settings */}
        <Route path="/settings"    element={<ProtectedRoute><ErrorBoundary scope="Settings"><SettingsPage /></ErrorBoundary></ProtectedRoute>} />
        <Route path="/settings/permits" element={<ProtectedRoute><ErrorBoundary scope="Settings"><SettingsPage /></ErrorBoundary></ProtectedRoute>} />
        {/* Per-project settings with projectId param for unit-costs */}
        <Route path="/projects/:projectId/settings" element={<ProtectedRoute><ErrorBoundary scope="Project Settings"><SettingsPage /></ErrorBoundary></ProtectedRoute>} />

        {/* Fallback */}
        <Route path="*" element={<Navigate to="/dashboard" replace />} />
      </Routes>
    </Suspense>
  );
}

export default function App() {
  return (
    <AuthProvider>
      {/* AccessibilityProvider must live inside BrowserRouter (in main.jsx) for useLocation */}
      <AccessibilityProvider>
        {/* Top-level ErrorBoundary catches anything that slips through page-level ones */}
        <ErrorBoundary scope="Application">
          <AppRoutes />
        </ErrorBoundary>
      </AccessibilityProvider>
    </AuthProvider>
  );
}
