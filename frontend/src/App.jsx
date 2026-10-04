import { Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider, useAuth } from './context/AuthContext';
import Layout from './components/Layout';
import AuthPage from './pages/AuthPage';
import Dashboard from './pages/Dashboard';
import ExportsPage from './pages/ExportsPage';
import JobDetailPage from './pages/JobDetailPage';
import JobsPage from './pages/JobsPage';
import LeadDetailPage from './pages/LeadDetailPage';
import LeadsPage from './pages/LeadsPage';
import ListsPage from './pages/ListsPage';
import ScrapePage from './pages/ScrapePage';
import SettingsPage from './pages/SettingsPage';
import { Spinner } from './components/ui';

/** Blocks a route until the session is known, then requires a signed-in user. */
function RequireAuth({ children }) {
  const { user, loading } = useAuth();
  if (loading) return <Spinner label="Loading LeadForge AI…" />;
  if (!user) return <Navigate to="/login" replace />;
  return children;
}

/** Signed-in users should not see the login/register screens again. */
function RedirectIfAuthed({ children }) {
  const { user, loading } = useAuth();
  if (loading) return <Spinner label="Loading LeadForge AI…" />;
  if (user) return <Navigate to="/" replace />;
  return children;
}

export default function App() {
  return (
    <AuthProvider>
      <Routes>
        <Route
          path="/login"
          element={
            <RedirectIfAuthed>
              <AuthPage mode="login" />
            </RedirectIfAuthed>
          }
        />
        <Route
          path="/register"
          element={
            <RedirectIfAuthed>
              <AuthPage mode="register" />
            </RedirectIfAuthed>
          }
        />

        <Route
          element={
            <RequireAuth>
              <Layout />
            </RequireAuth>
          }
        >
          <Route index element={<Dashboard />} />
          <Route path="scrape" element={<ScrapePage />} />
          <Route path="jobs" element={<JobsPage />} />
          <Route path="jobs/:id" element={<JobDetailPage />} />
          <Route path="leads" element={<LeadsPage />} />
          <Route path="leads/:id" element={<LeadDetailPage />} />
          <Route path="lists" element={<ListsPage />} />
          <Route path="exports" element={<ExportsPage />} />
          <Route path="settings" element={<SettingsPage />} />
        </Route>

        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AuthProvider>
  );
}