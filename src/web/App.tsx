import { lazy, Suspense } from 'react';
import { Navigate, Route, Routes } from 'react-router';
import { useSession } from './lib/session';
import { errorText } from './lib/api';
import { PageSpinner } from './components/ui/misc';
import { Button } from './components/ui/button';
import { SetupPage } from './pages/setup/SetupPage';
import { LoginPage } from './pages/auth/LoginPage';
import { RecoverPage } from './pages/auth/RecoverPage';
import { TwoFactorPage } from './pages/auth/TwoFactorPage';
import { ChangePasswordPage } from './pages/auth/ChangePasswordPage';
import { AppShell } from './components/layout/AppShell';

// Larger areas load on demand (the mail client pulls in the rich text editor).
const MailPage = lazy(() => import('./pages/mail/MailPage'));
const AdminRoutes = lazy(() => import('./pages/admin/AdminRoutes'));
const SettingsPage = lazy(() => import('./pages/settings/SettingsPage'));

export function App() {
  const { data: session, isLoading, error, refetch } = useSession();
  if (isLoading) return <PageSpinner />;
  if (!session) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="text-sm text-muted">OpenInbox could not reach its API: {errorText(error)}</p>
        <Button onClick={() => refetch()}>Try again</Button>
      </div>
    );
  }
  if (!session.setupComplete) {
    return (
      <Routes>
        <Route path="*" element={<SetupPage />} />
      </Routes>
    );
  }
  const user = session.user;
  if (!user) {
    return (
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/recover" element={<RecoverPage />} />
        <Route path="*" element={<Navigate to={`/login${location.pathname !== '/' ? `?next=${encodeURIComponent(location.pathname + location.search)}` : ''}`} replace />} />
      </Routes>
    );
  }
  if (user.mfaPending) return <TwoFactorPage />;
  if (user.mustChangePassword) return <ChangePasswordPage forced />;
  const isAdmin = user.role === 'owner' || user.role === 'admin';
  return (
    <Suspense fallback={<PageSpinner />}>
      <Routes>
        <Route element={<AppShell />}>
          <Route path="/mail/*" element={<MailPage />} />
          {isAdmin && <Route path="/admin/*" element={<AdminRoutes />} />}
          <Route path="/settings/*" element={<SettingsPage />} />
          <Route path="/login" element={<Navigate to="/" replace />} />
          <Route path="*" element={<Navigate to={isAdmin ? '/admin' : '/mail'} replace />} />
        </Route>
      </Routes>
    </Suspense>
  );
}
