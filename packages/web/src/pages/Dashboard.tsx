import { Link } from 'react-router-dom';
import {
  formatBytes,
  formatCount,
  formatRelative,
  type HealthSummary,
} from '@sakuradrive/shared';
import { useQuery } from '../hooks/useApi.js';
import { PageHeader } from '../components/Layout.js';
import { ProgressBar } from '../components/ProgressBar.js';
import { Badge, Banner, Card, EmptyState, Loading, SeverityBadge, Stat, Table } from '../components/ui.js';
import type { Alert } from '@sakuradrive/shared';

export function DashboardPage(): JSX.Element {
  const { data, error, loading } = useQuery<HealthSummary>('/api/dashboard', { pollMs: 10_000 });
  const alerts = useQuery<{ alerts: Alert[] }>('/api/alerts', { query: { limit: 8 }, pollMs: 15_000 });

  return (
    <>
      <PageHeader
        title="Dashboard"
        subtitle={data ? `Updated ${formatRelative(data.generatedAt)}` : 'Loading…'}
      />
      <div className="content">
        {error && <Banner tone="critical" title="Could not load the dashboard">{error.message}</Banner>}
        {loading && !data && <Loading />}

        {data && (
          <>
            {data.severity === 'critical' && (
              <Banner tone="critical" title="Something needs attention now">
                {data.alerts.critical} critical alert{data.alerts.critical === 1 ? '' : 's'} —{' '}
                <Link to="/alerts">open the alert list</Link>.
              </Banner>
            )}
            {data.pools.some((pool) => pool.missingParts > 0) && (
              <Banner tone="critical" title="A pool part is missing">
                DrivePool cannot see one of the disks in a pool. The{' '}
                <Link to="/recovery">disaster recovery report</Link> lists exactly which files are
                affected.
              </Banner>
            )}

            <div className="grid cols-4">
              <Stat
                label="Drives"
                value={data.drives.total}
                hint={
                  data.drives.critical > 0
                    ? `${data.drives.critical} critical`
                    : data.drives.warning > 0
                      ? `${data.drives.warning} warning`
                      : 'All healthy'
                }
                tone={data.drives.critical > 0 ? 'critical' : data.drives.warning > 0 ? 'warning' : 'ok'}
              />
              <Stat
                label="Open alerts"
                value={data.alerts.open}
                hint={`${data.alerts.critical} critical · ${data.alerts.warning} warning`}
                tone={data.alerts.critical > 0 ? 'critical' : data.alerts.open > 0 ? 'warning' : 'ok'}
              />
              <Stat
                label="Catalogued files"
                value={formatCount(data.catalog.files)}
                hint={`${formatBytes(data.catalog.bytes)} logical · ${formatBytes(
                  data.catalog.effectiveBytes,
                )} on pool`}
              />
              <Stat
                label="Hashed"
                value={
                  data.catalog.files > 0
                    ? `${Math.round((data.catalog.hashedFiles / data.catalog.files) * 100)}%`
                    : '—'
                }
                hint={`${formatCount(data.catalog.hashedFiles)} files verified`}
                tone="accent"
              />
              <Stat
                label="Bit-rot findings"
                value={data.bitrot.open + data.bitrot.confirmed}
                hint={
                  data.bitrot.lastDetectedAt
                    ? `last ${formatRelative(data.bitrot.lastDetectedAt)}`
                    : 'none detected'
                }
                tone={data.bitrot.confirmed > 0 ? 'critical' : undefined}
              />
              <Stat
                label="Unprotected files"
                value={data.backup.enabled ? formatCount(data.backup.missingFiles) : 'Off'}
                hint={
                  data.backup.enabled
                    ? `${formatBytes(data.backup.missingBytes)} not in backup`
                    : 'Backup verification disabled'
                }
                tone={data.backup.missingFiles > 0 ? 'critical' : undefined}
              />
              <Stat
                label="Agents"
                value={`${data.agents.online}/${data.agents.total}`}
                hint={data.agents.stale > 0 ? `${data.agents.stale} not reporting` : 'reporting'}
                tone={data.agents.stale > 0 ? 'warning' : 'ok'}
              />
              <Stat
                label="Last export"
                value={data.lastExportAt ? formatRelative(data.lastExportAt) : 'Never'}
                hint="off-box copy of the catalog"
                tone={data.lastExportAt ? undefined : 'warning'}
              />
            </div>

            <div className="grid cols-2">
              <Card title="Pools" description="Capacity reported by StableBit DrivePool">
                {data.pools.length === 0 ? (
                  <EmptyState title="No pools reported yet">
                    Install the Windows agent and it will report your DrivePool pools here.
                  </EmptyState>
                ) : (
                  <div className="stack">
                    {data.pools.map((pool) => {
                      const size = pool.sizeBytes ?? 0;
                      const free = pool.freeBytes ?? 0;
                      const usedPercent = size > 0 ? Math.round(((size - free) / size) * 100) : 0;
                      return (
                        <div key={pool.name}>
                          <div className="row" style={{ justifyContent: 'space-between' }}>
                            <strong>{pool.name}</strong>
                            <span className="muted nowrap">
                              {formatBytes(size - free)} of {formatBytes(size)} · {usedPercent}%
                            </span>
                          </div>
                          <div className="progress" style={{ marginTop: 6 }}>
                            <span style={{ width: `${usedPercent}%` }} />
                          </div>
                          <div className="progress-meta">
                            <span>
                              {pool.partCount} part{pool.partCount === 1 ? '' : 's'}
                              {pool.missingParts > 0 && (
                                <>
                                  {' '}
                                  <Badge tone="critical">{pool.missingParts} missing</Badge>
                                </>
                              )}
                            </span>
                            <span>{formatBytes(free)} free</span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </Card>

              <Card
                title="Workflows"
                description="Cataloguing and hashing only run inside the painted schedule"
                actions={<Link className="button" to="/workflows">Manage</Link>}
              >
                <div className="stack">
                  {data.workflows.map((workflow) => (
                    <div key={workflow.id}>
                      <div className="row" style={{ justifyContent: 'space-between' }}>
                        <strong>{workflow.name}</strong>
                        <WorkflowStateBadge workflow={workflow} />
                      </div>
                      {workflow.currentRun && workflow.currentRun.state === 'running' ? (
                        <ProgressBar
                          progress={workflow.currentRun.progress}
                          indeterminate={workflow.currentRun.progress.total === null}
                        />
                      ) : (
                        <div className="progress-meta" style={{ marginTop: 2 }}>
                          <span>
                            {workflow.lastRun?.finishedAt
                              ? `Last run ${formatRelative(workflow.lastRun.finishedAt)}`
                              : 'Never run'}
                          </span>
                          <span>
                            {workflow.respectsSchedule && workflow.minutesUntilWindow !== null
                              ? workflow.windowOpen
                                ? `window closes in ${formatMinutes(workflow.minutesUntilWindow)}`
                                : `window opens in ${formatMinutes(workflow.minutesUntilWindow)}`
                              : ''}
                          </span>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </Card>
            </div>

            <Card
              title="Recent alerts"
              actions={<Link className="button" to="/alerts">All alerts</Link>}
              flush
            >
              {(alerts.data?.alerts.length ?? 0) === 0 ? (
                <EmptyState title="Nothing is wrong">
                  No open alerts. SMART data, pool health, bit rot and backup coverage are all clear.
                </EmptyState>
              ) : (
                <Table headers={['Severity', 'Alert', 'Category', 'Seen']}>
                  {alerts.data!.alerts.map((alert) => (
                    <tr key={alert.id}>
                      <td>
                        <SeverityBadge severity={alert.severity} />
                      </td>
                      <td>
                        <div>{alert.title}</div>
                        <div className="faint" style={{ fontSize: 12 }}>
                          {alert.detail.slice(0, 140)}
                        </div>
                      </td>
                      <td>
                        <Badge>{alert.category}</Badge>
                      </td>
                      <td className="nowrap muted">{formatRelative(alert.lastSeenAt)}</td>
                    </tr>
                  ))}
                </Table>
              )}
            </Card>
          </>
        )}
      </div>
    </>
  );
}

export function WorkflowStateBadge({
  workflow,
}: {
  workflow: HealthSummary['workflows'][number];
}): JSX.Element {
  const state = workflow.currentRun?.state;
  if (state === 'running') return <Badge tone="accent" dot>Running</Badge>;
  if (state === 'paused') return <Badge tone="warning" dot>Paused</Badge>;
  if (workflow.lastRun?.state === 'failed') return <Badge tone="critical" dot>Failed</Badge>;
  if (workflow.respectsSchedule && !workflow.windowOpen) return <Badge>Waiting for window</Badge>;
  return <Badge tone="ok">Idle</Badge>;
}

export function formatMinutes(minutes: number): string {
  if (minutes < 60) return `${Math.round(minutes)}m`;
  const hours = Math.floor(minutes / 60);
  const rest = Math.round(minutes % 60);
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}
