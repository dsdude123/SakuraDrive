import { useState } from 'react';
import {
  formatBytes,
  formatCount,
  formatRelative,
  type DiskLossImpact,
  type ScanRoot,
} from '@sakuradrive/shared';
import { PageHeader } from '../components/Layout.js';
import { Badge, Banner, Card, EmptyState, Loading, Table } from '../components/ui.js';
import { useQuery } from '../hooks/useApi.js';

interface RootWithStats extends ScanRoot {
  stats: { files: number; bytes: number };
}

interface ImpactResponse {
  impact: DiskLossImpact;
  precise: boolean;
  siblingRoots: Array<{ id: string; name: string }>;
  backupExpectations: Array<{ id: string; name: string }>;
  files: { files: Array<{ relPath: string; sizeBytes: number; mtimeMs: number }>; total: number };
}

/**
 * The page you open at 2am when a disk has died.
 *
 * Two questions matter: which files were only on that disk, and are any of them in the
 * backup? Both are answered from the catalog, which is why the catalog is exported
 * off-box automatically.
 */
export function RecoveryPage(): JSX.Element {
  const roots = useQuery<{ roots: RootWithStats[] }>('/api/catalog/roots');
  const [rootId, setRootId] = useState('');

  const candidates = roots.data?.roots.filter((root) => root.kind !== 'pool') ?? [];
  const active = candidates.find((root) => root.id === rootId) ?? candidates[0];
  const activeId = active?.id ?? '';

  const impact = useQuery<ImpactResponse>(activeId ? '/api/dr/impact' : null, {
    query: { rootId: activeId, limit: 500 },
  });

  return (
    <>
      <PageHeader
        title="Disaster recovery"
        subtitle="What is lost if a specific disk dies, and what the backup would save"
        actions={
          activeId && (
            <a className="button" href={`/api/dr/impact.csv?rootId=${encodeURIComponent(activeId)}`}>
              Export full list
            </a>
          )
        }
      />
      <div className="content">
        {roots.loading && !roots.data && <Loading />}

        {candidates.length === 0 && (
          <EmptyState title="No per-disk roots are configured">
            To answer this question precisely, each pool disk&apos;s <code>PoolPart.*</code> folder
            needs to be catalogued as its own root, with the same pool id as the pool root. Then a
            file is unrecoverable exactly when no other pool part holds the same path. Without that,
            the report falls back to the configured duplication levels.
          </EmptyState>
        )}

        {candidates.length > 0 && (
          <>
            <div className="toolbar">
              <label className="field" style={{ maxWidth: 340 }}>
                <span>Disk</span>
                <select value={activeId} onChange={(event) => setRootId(event.target.value)}>
                  {candidates.map((root) => (
                    <option key={root.id} value={root.id}>
                      {root.driveLabel || root.name} ({formatCount(root.stats.files)} files)
                    </option>
                  ))}
                </select>
              </label>
            </div>

            {impact.loading && !impact.data && <Loading />}

            {impact.data && (
              <>
                {!impact.data.precise && (
                  <Banner tone="warning" title="Estimated from duplication settings">
                    No sibling pool parts are catalogued for this pool, so the numbers below count
                    files whose configured duplication level is 1. Catalogue the other disks&apos;{' '}
                    <code>PoolPart.*</code> folders for an exact answer.
                  </Banner>
                )}

                <div className="grid cols-4">
                  <div className="stat critical">
                    <span className="label">Would be lost</span>
                    <span className="value">{formatCount(impact.data.impact.unrecoverableFiles)}</span>
                    <span className="hint">
                      {formatBytes(impact.data.impact.unrecoverableBytes)} with no other copy in the
                      pool
                    </span>
                  </div>
                  <div className="stat ok">
                    <span className="label">Survives in the pool</span>
                    <span className="value">{formatCount(impact.data.impact.duplicatedFiles)}</span>
                    <span className="hint">
                      {formatBytes(impact.data.impact.duplicatedBytes)} duplicated elsewhere
                    </span>
                  </div>
                  <div className="stat">
                    <span className="label">Backup rules covering this disk</span>
                    <span className="value">{impact.data.backupExpectations.length}</span>
                    <span className="hint">
                      {impact.data.backupExpectations.map((rule) => rule.name).join(', ') || 'none'}
                    </span>
                  </div>
                  <div className="stat">
                    <span className="label">Compared against</span>
                    <span className="value" style={{ fontSize: 18 }}>
                      {impact.data.siblingRoots.length} part{impact.data.siblingRoots.length === 1 ? '' : 's'}
                    </span>
                    <span className="hint">
                      {impact.data.siblingRoots.map((root) => root.name).join(', ') || 'no siblings catalogued'}
                    </span>
                  </div>
                </div>

                <Card
                  flush
                  title="Files with no second copy"
                  description={`${formatCount(impact.data.files.total)} file${
                    impact.data.files.total === 1 ? '' : 's'
                  } · generated ${formatRelative(impact.data.impact.generatedAt)}`}
                >
                  {impact.data.files.files.length === 0 ? (
                    <EmptyState title="Everything on this disk exists elsewhere">
                      Losing it would not lose any data.
                    </EmptyState>
                  ) : (
                    <Table headers={['Path', '#Size', 'Modified']}>
                      {impact.data.files.files.map((file) => (
                        <tr key={file.relPath}>
                          <td className="path" title={file.relPath}>
                            {file.relPath}
                          </td>
                          <td className="num">{formatBytes(file.sizeBytes)}</td>
                          <td className="nowrap muted">{formatRelative(new Date(file.mtimeMs))}</td>
                        </tr>
                      ))}
                    </Table>
                  )}
                </Card>
              </>
            )}
          </>
        )}

        <Card title="After a disk has actually failed">
          <ol className="stack" style={{ paddingLeft: 20, margin: 0 }}>
            <li>
              Run a catalog scan of the pool root. Everything that disappeared is recorded as a{' '}
              <strong>deleted</strong> change — that list, on the Catalog → Differences tab, is the
              definitive answer to “what is missing from the pool now”.
            </li>
            <li>Export that difference as CSV so you have it outside this container.</li>
            <li>
              Cross-check it against Backup health to see which of those files exist in Kopia and can
              simply be restored.
            </li>
            <li>
              If this container&apos;s own storage was lost too, install SakuraDrive somewhere else and
              import the most recent export bundle from Settings → Backup &amp; export.
            </li>
          </ol>
          <Banner tone="info" title="Catalog rows are never hard-deleted">
            A file that disappears is marked deleted and kept, so the history survives exactly the
            event you need it for.
          </Banner>
        </Card>
      </div>
    </>
  );
}
