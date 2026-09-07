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
const AuditPage      = lazy(() => import('./pages/AuditPage'));
const TrendsPage     = lazy(() => import('./pages/TrendsPage'));
const TasksPage      = lazy(() => import('./pages/TasksPage'));
const LivePlantPage  = lazy(() => import('./pages/LivePlantPage'));
const TwinPage       = lazy(() => import('./pages/TwinPage'));

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
        <Route path="/projects"   element={<ProtectedRoute><ErrorBoundary scope="Projects"><ProjectsPage kind="twin" /></ErrorBoundary></ProtectedRoute>} />
        <Route path="/projects/new" element={<ProtectedRoute><ErrorBoundary scope="Projects"><ProjectsPage kind="twin" autoOpen /></ErrorBoundary></ProtectedRoute>} />
        <Route path="/projects/:projectId" element={<ProtectedRoute><ErrorBoundary scope="Project"><ProjectPage /></ErrorBoundary></ProtectedRoute>} />
        <Route path="/projects/:projectId/flowsheets/:flowsheetId"
               element={<ProtectedRoute><ErrorBoundary scope="Canvas"><CanvasPage /></ErrorBoundary></ProtectedRoute>} />

        {/* Operations: MONITORING projects — the plant as wired. The same pages
            under their own base, so the sidebar stays on Operations. */}
        <Route path="/monitoring/projects" element={<ProtectedRoute><ErrorBoundary scope="Projects"><ProjectsPage kind="monitoring" /></ErrorBoundary></ProtectedRoute>} />
        <Route path="/monitoring/projects/new" element={<ProtectedRoute><ErrorBoundary scope="Projects"><ProjectsPage kind="monitoring" autoOpen /></ErrorBoundary></ProtectedRoute>} />
        <Route path="/monitoring/projects/:projectId" element={<ProtectedRoute><ErrorBoundary scope="Project"><ProjectPage /></ErrorBoundary></ProtectedRoute>} />
        <Route path="/monitoring/projects/:projectId/flowsheets/:flowsheetId"
               element={<ProtectedRoute><ErrorBoundary scope="Canvas"><CanvasPage /></ErrorBoundary></ProtectedRoute>} />
        <Route path="/monitoring/projects/:projectId/flowsheets/:flowsheetId/simulate/:runId/report"
               element={<ProtectedRoute><ErrorBoundary scope="Report"><ReportPage /></ErrorBoundary></ProtectedRoute>} />
        <Route path="/monitoring/projects/:projectId/settings" element={<ProtectedRoute><ErrorBoundary scope="Project Settings"><SettingsPage /></ErrorBoundary></ProtectedRoute>} />

        <Route path="/projects/:projectId/flowsheets/:flowsheetId/simulate/:runId/report"
               element={<ProtectedRoute><ErrorBoundary scope="Report"><ReportPage /></ErrorBoundary></ProtectedRoute>} />

        {/* Admin — accessible to admin + engineer roles (page guards internally) */}
        <Route path="/admin" element={<ProtectedRoute><ErrorBoundary scope="Admin"><AdminPage /></ErrorBoundary></ProtectedRoute>} />
        {/* Audit trail — admin only (capability audit.read; the page explains itself to the rest) */}
        <Route path="/audit" element={<ProtectedRoute><ErrorBoundary scope="Audit"><AuditPage /></ErrorBoundary></ProtectedRoute>} />

        {/* Reports history + comparison */}
        <Route path="/reports" element={<ProtectedRoute><ErrorBoundary scope="Reports"><ReportsPage /></ErrorBoundary></ProtectedRoute>} />
        <Route path="/reports/compare" element={<ProtectedRoute><ErrorBoundary scope="Comparison"><ComparisonPage /></ErrorBoundary></ProtectedRoute>} />

        {/* Org-wide alarm event history */}
        <Route path="/alarms" element={<ProtectedRoute><ErrorBoundary scope="Alarms"><AlarmsPage /></ErrorBoundary></ProtectedRoute>} />

        {/* Historian trends: any tag over any window, from the Phase 1 historian */}
        <Route path="/trends" element={<ProtectedRoute><ErrorBoundary scope="Trends"><TrendsPage /></ErrorBoundary></ProtectedRoute>} />

        {/* The live plant screen: measured states, alarms, comms, control (Phase 3) */}
        <Route path="/live" element={<ProtectedRoute><ErrorBoundary scope="Live plant"><LivePlantPage /></ErrorBoundary></ProtectedRoute>} />

        {/* The digital twin: the model beside the plant, what-if, virtual commissioning (Phase 4) */}
        <Route path="/twin" element={<ProtectedRoute><ErrorBoundary scope="Twin"><TwinPage /></ErrorBoundary></ProtectedRoute>} />
        <Route path="/twin/:flowsheetId" element={<ProtectedRoute><ErrorBoundary scope="Twin"><TwinPage /></ErrorBoundary></ProtectedRoute>} />

        {/* Maintenance tasks: the alarm → task → approval workflow (Phase 2) */}
        <Route path="/tasks" element={<ProtectedRoute><ErrorBoundary scope="Tasks"><TasksPage /></ErrorBoundary></ProtectedRoute>} />

        {/* The plant definition: process areas, I/O schedule, control narrative,
            costing, and the review of everywhere the proposal disagrees with itself */}

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
