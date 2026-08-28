import type { ReactNode } from 'react';
import { NavLink } from 'react-router-dom';
import { api } from '../api/client.js';
import { useQuery } from '../hooks/useApi.js';
import type { AuthStatus } from '../App.js';
import { Badge } from './ui.js';

interface AlertCounts {
  counts: { open: number; critical: number; warning: number };
}

interface NavEntry {
  to: string;
  label: string;
  badge?: ReactNode;
}

export function Layout({
  status,
  onSignedOut,
  children,
}: {
  status: AuthStatus;
  onSignedOut: () => void;
  children: ReactNode;
}): JSX.Element {
  // Poll the alert count so the sidebar badge reflects reality without a refresh.
  const { data } = useQuery<AlertCounts>('/api/alerts', { query: { limit: 1 }, pollMs: 20_000 });
  const open = data?.counts.open ?? 0;
  const critical = data?.counts.critical ?? 0;

  const monitoring: NavEntry[] = [
    { to: '/', label: 'Dashboard' },
    { to: '/drives', label: 'Drives' },
    { to: '/pools', label: 'Pools' },
    {
      to: '/alerts',
      label: 'Alerts',
      badge:
        open > 0 ? (
          <Badge tone={critical > 0 ? 'critical' : 'warning'}>{open}</Badge>
        ) : undefined,
    },
  ];

  const data_ = [
    { to: '/catalog', label: 'Catalog' },
    { to: '/storage', label: 'Storage map' },
    { to: '/bitrot', label: 'Bit rot' },
    { to: '/backup', label: 'Backup health' },
    { to: '/recovery', label: 'Disaster recovery' },
  ];

  const operations = [
    { to: '/workflows', label: 'Workflows' },
    { to: '/schedule', label: 'Schedule' },
    { to: '/settings', label: 'Settings' },
  ];

  return (
    <div className="app">
      <nav className="sidebar">
        <div className="brand">
          <span className="petal" aria-hidden="true">
            🌸
          </span>
          {status.siteName || 'SakuraDrive'}
        </div>

        <NavSection title="Monitoring" entries={monitoring} />
        <NavSection title="Data" entries={data_} />
        <NavSection title="Operations" entries={operations} />

        <div className="spacer" />
        <div className="faint" style={{ padding: '10px 10px 0', fontSize: 11 }}>
          v{status.version}
          {status.authDisabled && (
            <div style={{ marginTop: 6 }}>
              <Badge tone="warning">Auth disabled</Badge>
            </div>
          )}
          {status.user && (
            <div style={{ marginTop: 8 }}>
              <button
                className="ghost small"
                onClick={async () => {
                  await api('/api/auth/logout', { method: 'POST' });
                  onSignedOut();
                }}
              >
                Sign out ({status.user.username})
              </button>
            </div>
          )}
        </div>
      </nav>

      <main className="main">{children}</main>
    </div>
  );
}

function NavSection({ title, entries }: { title: string; entries: NavEntry[] }): JSX.Element {
  return (
    <>
      <div className="nav-group">{title}</div>
      {entries.map((entry) => (
        <NavLink
          key={entry.to}
          to={entry.to}
          end={entry.to === '/'}
          className={({ isActive }) => (isActive ? 'nav-item active' : 'nav-item')}
        >
          <span>{entry.label}</span>
          {entry.badge}
        </NavLink>
      ))}
    </>
  );
}

/** Standard page header used by every page. */
export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: ReactNode;
  actions?: ReactNode;
}): JSX.Element {
  return (
    <header className="topbar">
      <div className="topbar-title">
        <h1>{title}</h1>
        {subtitle && <span className="subtitle">{subtitle}</span>}
      </div>
      {actions && <div className="button-row">{actions}</div>}
    </header>
  );
}
