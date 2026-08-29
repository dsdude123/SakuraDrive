import { useState } from 'react';
import {
  formatBytes,
  formatCount,
  formatRelative,
  type BackupIssue,
  type BackupVerificationSummary,
} from '@sakuradrive/shared';
import { PageHeader } from '../components/Layout.js';
import { Badge, Banner, Card, EmptyState, Loading, Table } from '../components/ui.js';
import { useMutation, useQuery } from '../hooks/useApi.js';
import { useToast } from '../hooks/useToast.js';

interface CoverageRoot {
  rootId: string;
  rootName: string;
  expectations: string[];
  coveredFiles: number;
  coveredBytes: number;
  uncoveredFiles: number;
  uncoveredBytes: number;
  uncoveredFolders: Array<{ name: string; files: number; bytes: number }>;
}

interface BackupRunsResponse {
  runs: BackupVerificationSummary[];
  summary: { enabled: boolean; lastRunAt: string | null; missingFiles: number; missingBytes: number; expectations: number };
}

export function BackupPage(): JSX.Element {
  const runs = useQuery<BackupRunsResponse>('/api/backup/runs', { pollMs: 30_000 });
  const coverage = useQuery<{ roots: CoverageRoot[] }>('/api/backup/coverage', { pollMs: 300_000 });
  const [kind, setKind] = useState<'' | 'missing' | 'stale' | 'size-mismatch'>('');
  const [search, setSearch] = useState('');
  const issues = useQuery<{ issues: BackupIssue[]; total: number }>('/api/backup/issues', {
    query: { kind: kind || undefined, search: search || undefined, limit: 500 },
    pollMs: 60_000,
  });
  const mutation = useMutation();
  const toast = useToast();

  const verifyNow = async () => {
    const result = await mutation.run('/api/workflows/backup.verify/start', { body: { force: true } });
    if (result) {
      toast.push('Backup verification started', 'success');
    } else if (mutation.error) {
      toast.push(mutation.error, 'error');
    }
  };

  const dismiss = async (issue: BackupIssue) => {
    const result = await mutation.run('/api/backup/issues/status', {
      body: { ids: [issue.id], status: 'dismissed', note: 'Deliberately not backed up' },
    });
    if (result) {
      toast.push('Issue dismissed', 'success');
      issues.refresh();
    }
  };

  const summary = runs.data?.summary;

  return (
    <>
      <PageHeader
        title="Backup health"
        subtitle="Is everything that should be in Kopia actually there?"
        actions={
          <button className="primary" onClick={() => void verifyNow()} disabled={mutation.busy}>
            {mutation.busy && <span className="spinner" />}
            Verify now
          </button>
        }
      />
      <div className="content">
        {summary && !summary.enabled && (
          <Banner tone="warning" title="Backup verification is off">
            Turn it on under Settings → Backup, point it at your Kopia repository and define which
            paths you expect to be backed up. Not everything on the pool needs the Backblaze
            treatment, so nothing is expected until you say so.
          </Banner>
        )}

        {summary && summary.enabled && (
          <div className="grid cols-4">
            <div className="stat">
              <span className="label">Expectations</span>
              <span className="value">{summary.expectations}</span>
              <span className="hint">rule sets defining what must be backed up</span>
            </div>
            <div className={summary.missingFiles > 0 ? 'stat critical' : 'stat ok'}>
              <span className="label">Unprotected files</span>
              <span className="value">{formatCount(summary.missingFiles)}</span>
              <span className="hint">{formatBytes(summary.missingBytes)} not in the repository</span>
            </div>
            <div className="stat">
              <span className="label">Last verified</span>
              <span className="value" style={{ fontSize: 18 }}>
                {summary.lastRunAt ? formatRelative(summary.lastRunAt) : 'never'}
              </span>
            </div>
          </div>
        )}

        <Card
          flush
          title="What the rules cover"
          description="Not everything belongs in cloud storage. This is what you have decided to leave out, so the decision is visible before a disk dies rather than after."
        >
          {coverage.loading && !coverage.data && <Loading />}
          {(coverage.data?.roots.length ?? 0) === 0 && !coverage.loading && (
            <EmptyState title="No catalog roots">
              Add a root under Settings, then run a catalog scan.
            </EmptyState>
          )}
          {(coverage.data?.roots.length ?? 0) > 0 && (
            <Table headers={['Root', 'Rules', '#Covered', '#Not covered', 'Left out']}>
              {(coverage.data?.roots ?? []).map((root) => (
                <tr key={root.rootId}>
                  <td>
                    <strong>{root.rootName}</strong>
                  </td>
                  <td>
                    {root.expectations.length > 0 ? (
                      root.expectations.join(', ')
                    ) : (
                      <Badge tone="warning">none</Badge>
                    )}
                  </td>
                  <td className="num">
                    {formatBytes(root.coveredBytes)}
                    <div className="hint">{formatCount(root.coveredFiles)} files</div>
                  </td>
                  <td className="num">
                    {formatBytes(root.uncoveredBytes)}
                    <div className="hint">{formatCount(root.uncoveredFiles)} files</div>
                  </td>
                  <td>
                    {root.uncoveredFolders.length === 0
                      ? '—'
                      : root.uncoveredFolders
                          .slice(0, 6)
                          .map((folder) => `${folder.name} (${formatBytes(folder.bytes)})`)
                          .join(', ')}
                    {root.uncoveredFolders.length > 6 && ` and ${root.uncoveredFolders.length - 6} more`}
                  </td>
                </tr>
              ))}
            </Table>
          )}
        </Card>

        <Card flush title="Verification runs">
          {runs.loading && !runs.data && <Loading />}
          {runs.data?.runs.length === 0 && (
            <EmptyState title="No verification has run yet">
              Configure at least one expectation, then press “Verify now”.
            </EmptyState>
          )}
          {(runs.data?.runs.length ?? 0) > 0 && (
            <Table
              headers={['Expectation', 'Snapshot', '#Expected', '#Present', '#Missing', '#Stale', 'Started', 'Result']}
            >
              {runs.data!.runs.map((run) => (
                <tr key={run.runId}>
                  <td>
                    <strong>{run.expectationName}</strong>
                  </td>
                  <td className="mono faint" title={run.snapshotId ?? ''}>
                    {run.snapshotId ? run.snapshotId.slice(0, 16) : '—'}
                    {run.snapshotTime && (
                      <div style={{ fontSize: 11 }}>{formatRelative(run.snapshotTime)}</div>
                    )}
                  </td>
                  <td className="num">{formatCount(run.expectedFiles)}</td>
                  <td className="num">{formatCount(run.presentFiles)}</td>
                  <td className="num" style={run.missingFiles > 0 ? { color: 'var(--critical)' } : undefined}>
                    {formatCount(run.missingFiles)}
                  </td>
                  <td className="num">{formatCount(run.staleFiles)}</td>
                  <td className="nowrap muted">{formatRelative(run.startedAt)}</td>
                  <td>
                    {run.error ? (
                      <Badge tone="critical" dot>
                        {run.error.slice(0, 60)}
                      </Badge>
                    ) : run.missingFiles > 0 ? (
                      <Badge tone="critical">gaps found</Badge>
                    ) : (
                      <Badge tone="ok">complete</Badge>
                    )}
                  </td>
                </tr>
              ))}
            </Table>
          )}
        </Card>

        <Card flush title="Files that are not protected">
          <div className="card-header">
            <div className="toolbar" style={{ flex: 1 }}>
              <select value={kind} onChange={(event) => setKind(event.target.value as typeof kind)} style={{ width: 190 }}>
                <option value="">All problems</option>
                <option value="missing">Missing from backup</option>
                <option value="stale">Backup copy out of date</option>
                <option value="size-mismatch">Size mismatch</option>
              </select>
              <input
                className="grow"
                type="search"
                placeholder="Filter by path…"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </div>
          </div>
          {issues.loading && !issues.data && <Loading />}
          {issues.data?.issues.length === 0 && (
            <EmptyState title="Nothing is unprotected">
              Every file matching an enabled expectation is present in the latest snapshot.
            </EmptyState>
          )}
          {(issues.data?.issues.length ?? 0) > 0 && (
            <>
              <Table headers={['Problem', 'Path', '#Size', '#In backup', 'Detected', '']}>
                {issues.data!.issues.map((issue) => (
                  <tr key={issue.id}>
                    <td>
                      <Badge tone={issue.kind === 'missing' ? 'critical' : 'warning'}>{issue.kind}</Badge>
                    </td>
                    <td className="path" title={issue.relPath}>
                      {issue.relPath}
                    </td>
                    <td className="num">{formatBytes(issue.sizeBytes)}</td>
                    <td className="num faint">{formatBytes(issue.backupSizeBytes)}</td>
                    <td className="nowrap muted">{formatRelative(issue.detectedAt)}</td>
                    <td>
                      <button className="small ghost" onClick={() => void dismiss(issue)}>
                        Dismiss
                      </button>
                    </td>
                  </tr>
                ))}
              </Table>
              {issues.data!.total > issues.data!.issues.length && (
                <div className="faint" style={{ padding: '10px 16px', fontSize: 12 }}>
                  Showing {issues.data!.issues.length} of {formatCount(issues.data!.total)}.
                </div>
              )}
            </>
          )}
        </Card>
      </div>
    </>
  );
}
