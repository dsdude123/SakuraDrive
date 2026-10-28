import { useCallback, useEffect, useState } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { api } from './api/client.js';
import { Layout } from './components/Layout.js';
import { Loading } from './components/ui.js';
import { AlertsPage } from './pages/Alerts.js';
import { BackupPage } from './pages/Backup.js';
import { BitrotPage } from './pages/Bitrot.js';
import { CatalogPage } from './pages/Catalog.js';
import { DashboardPage } from './pages/Dashboard.js';
import { DriveDetailPage, DrivesPage } from './pages/Drives.js';
import { LoginPage } from './pages/Login.js';
import { PoolsPage } from './pages/Pools.js';
import { RecoveryPage } from './pages/Recovery.js';
import { SchedulePage } from './pages/Schedule.js';
import { SettingsPage } from './pages/Settings.js';
import { StoragePage } from './pages/Storage.js';
import { AgentJobsPage } from './pages/AgentJobs.js';
import { WorkflowsPage } from './pages/Workflows.js';

export interface AuthStatus {
  needsSetup: boolean;
  authRequired: boolean;
  authDisabled: boolean;
  user: { id: number; username: string } | null;
  version: string;
  siteName: string;
}

/**
 * Whether to show the sign-in screen instead of the application.
 *
 * `authRequired` is already the server's combined answer: the `requireLogin` setting
 * and the `SAKURADRIVE_DISABLE_AUTH` environment variable. When it is false there is
 * nothing to sign in to, so `needsSetup` is not a reason to stop anyone -- it used to
 * be, which meant an install with authentication switched off still demanded an
 * account on first run, and then never used it.
 */
export function needsSignIn(status: AuthStatus): boolean {
  if (!status.authRequired) return false;
  return status.user === null || status.needsSetup;
}

export function App(): JSX.Element {
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [failed, setFailed] = useState(false);

  const refreshStatus = useCallback(async () => {
    try {
      setStatus(await api<AuthStatus>('/api/auth/status'));
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  if (failed) {
    return (
      <div className="centre-screen">
        <div className="card auth-card">
          <div className="card-body stack">
            <h1>🌸 SakuraDrive</h1>
            <p className="muted">
              Could not reach the API. The container may still be starting — this page retries
              automatically.
            </p>
            <button className="primary" onClick={() => void refreshStatus()}>
              Retry now
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (!status) return <Loading label="Connecting…" />;

  if (needsSignIn(status)) {
    return <LoginPage status={status} onSignedIn={() => void refreshStatus()} />;
  }

  return (
    <Layout status={status} onSignedOut={() => void refreshStatus()}>
      <Routes>
        <Route path="/" element={<DashboardPage />} />
        <Route path="/drives" element={<DrivesPage />} />
        <Route path="/drives/:id" element={<DriveDetailPage />} />
        <Route path="/pools" element={<PoolsPage />} />
        <Route path="/catalog" element={<CatalogPage />} />
        <Route path="/storage" element={<StoragePage />} />
        <Route path="/bitrot" element={<BitrotPage />} />
        <Route path="/backup" element={<BackupPage />} />
        <Route path="/recovery" element={<RecoveryPage />} />
        <Route path="/alerts" element={<AlertsPage />} />
        <Route path="/workflows" element={<WorkflowsPage />} />
        <Route path="/agent-jobs" element={<AgentJobsPage />} />
        <Route path="/schedule" element={<SchedulePage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Layout>
  );
}
