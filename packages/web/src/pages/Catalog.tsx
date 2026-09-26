import { useState } from 'react';
import {
  formatBytes,
  formatCount,
  formatRelative,
  type CatalogChange,
  type CatalogDiffSummary,
  type DirectoryEntry,
  type ScanRoot,
} from '@sakuradrive/shared';
import { DataTable, sortTime } from '../components/DataTable.js';
import { PageHeader } from '../components/Layout.js';
import { Badge, Card, EmptyState, Loading } from '../components/ui.js';
import { useQuery } from '../hooks/useApi.js';

interface RootWithStats extends ScanRoot {
  stats: {
    files: number;
    bytes: number;
    effectiveBytes: number;
    hashedFiles: number;
    deletedFiles: number;
    lastScanAt: string | null;
  };
}

interface CatalogRun {
  id: number;
  rootId: string;
  startedAt: string;
  finishedAt: string | null;
  state: string;
  filesSeen: number;
  created: number;
  modified: number;
  deleted: number;
  restored: number;
}

type Tab = 'browse' | 'changes' | 'search';

/** Deletions first, then restores, then edits, then plain new files. */
const CHANGE_ORDER: Record<string, number> = { deleted: 0, restored: 1, modified: 2, created: 3 };

export function CatalogPage(): JSX.Element {
  const roots = useQuery<{ roots: RootWithStats[] }>('/api/catalog/roots', { pollMs: 30_000 });
  const [rootId, setRootId] = useState<string>('');
  const [tab, setTab] = useState<Tab>('browse');

  const activeRoot = roots.data?.roots.find((root) => root.id === rootId) ?? roots.data?.roots[0];
  const currentRootId = activeRoot?.id ?? '';

  return (
    <>
      <PageHeader
        title="Catalog"
        subtitle="Every file on the pool, with a full created / modified / deleted history"
      />
      <div className="content">
        {roots.loading && !roots.data && <Loading />}
        {roots.data?.roots.length === 0 && (
          <EmptyState title="No catalog roots configured">
            Add the pool mounts under Settings → Catalog roots, then run a catalog scan.
          </EmptyState>
        )}

        {roots.data && roots.data.roots.length > 0 && (
          <>
            <div className="grid cols-4">
              {roots.data.roots.map((root) => (
                <button
                  key={root.id}
                  className={root.id === currentRootId ? 'stat accent' : 'stat'}
                  style={{ textAlign: 'left', cursor: 'pointer' }}
                  onClick={() => setRootId(root.id)}
                >
                  <span className="label">
                    {root.name} · {root.kind}
                  </span>
                  <span className="value">{formatCount(root.stats.files)}</span>
                  <span className="hint">
                    {formatBytes(root.stats.bytes)} logical · {formatBytes(root.stats.effectiveBytes)} on
                    pool
                    <br />
                    {root.stats.lastScanAt
                      ? `scanned ${formatRelative(root.stats.lastScanAt)}`
                      : 'never scanned'}
                  </span>
                </button>
              ))}
            </div>

            <Card flush>
              <div className="tabs">
                <button className={tab === 'browse' ? 'tab active' : 'tab'} onClick={() => setTab('browse')}>
                  Browse
                </button>
                <button className={tab === 'changes' ? 'tab active' : 'tab'} onClick={() => setTab('changes')}>
                  Differences
                </button>
                <button className={tab === 'search' ? 'tab active' : 'tab'} onClick={() => setTab('search')}>
                  Search
                </button>
              </div>
              <div className="card-body">
                {tab === 'browse' && <BrowseTab rootId={currentRootId} />}
                {tab === 'changes' && <ChangesTab rootId={currentRootId} />}
                {tab === 'search' && <SearchTab rootId={currentRootId} />}
              </div>
            </Card>
          </>
        )}
      </div>
    </>
  );
}

function BrowseTab({ rootId }: { rootId: string }): JSX.Element {
  const [path, setPath] = useState('');
  const { data, loading } = useQuery<{ entries: DirectoryEntry[]; total: number }>(
    rootId ? '/api/catalog/browse' : null,
    { query: { rootId, path, limit: 500 } },
  );

  return (
    <div className="stack">
      <Breadcrumbs path={path} onNavigate={setPath} />
      {loading && !data && <Loading />}
      {data && data.entries.length === 0 && <EmptyState title="This directory is empty" />}
      {data && data.entries.length > 0 && (
        <DataTable
          rows={data.entries}
          rowKey={(entry) => entry.relPath}
          rowProps={(entry) => ({ className: entry.kind === 'directory' ? 'clickable' : undefined })}
          onRowClick={(entry) => entry.kind === 'directory' && setPath(entry.relPath)}
          columns={[
            {
              key: 'name',
              header: 'Name',
              className: 'path',
              sort: (entry) => entry.name,
              cell: (entry) => `${entry.kind === 'directory' ? '📁 ' : '📄 '}${entry.name}`,
            },
            {
              key: 'size',
              header: 'Size',
              numeric: true,
              sort: (entry) => entry.sizeBytes,
              cell: (entry) => formatBytes(entry.sizeBytes),
            },
            {
              key: 'effective',
              header: 'On pool',
              numeric: true,
              sort: (entry) => entry.effectiveBytes,
              cell: (entry) => formatBytes(entry.effectiveBytes),
            },
            {
              key: 'files',
              header: 'Files',
              numeric: true,
              sort: (entry) => entry.fileCount,
              cell: (entry) => formatCount(entry.fileCount),
            },
            {
              key: 'duplication',
              header: 'Duplication',
              sort: (entry) => entry.duplicationLevel,
              cell: (entry) =>
                entry.duplicationLevel && entry.duplicationLevel > 1 ? (
                  <Badge tone="accent">{entry.duplicationLevel}×</Badge>
                ) : entry.kind === 'file' ? (
                  <span className="faint">1×</span>
                ) : (
                  ''
                ),
            },
            {
              key: 'modified',
              header: 'Modified',
              className: 'nowrap muted',
              sort: (entry) => entry.mtimeMs,
              cell: (entry) => (entry.mtimeMs ? formatRelative(new Date(entry.mtimeMs)) : ''),
            },
          ]}
        />
      )}
    </div>
  );
}

function ChangesTab({ rootId }: { rootId: string }): JSX.Element {
  const runs = useQuery<{ runs: CatalogRun[] }>(rootId ? '/api/catalog/runs' : null, {
    query: { rootId, limit: 50 },
  });
  const [runId, setRunId] = useState<number | null>(null);
  const [kind, setKind] = useState<'' | 'created' | 'modified' | 'deleted' | 'restored'>('');

  const selectedRun = runId ?? runs.data?.runs[0]?.id ?? null;
  const summary = useQuery<{ summary: CatalogDiffSummary }>(
    selectedRun ? `/api/catalog/runs/${selectedRun}/diff` : null,
  );
  const changes = useQuery<{ changes: CatalogChange[]; total: number }>(
    selectedRun ? '/api/catalog/changes' : null,
    { query: { runId: selectedRun ?? undefined, kind: kind || undefined, limit: 500 } },
  );

  return (
    <div className="stack">
      <div className="toolbar">
        <select
          value={selectedRun ?? ''}
          onChange={(event) => setRunId(Number(event.target.value))}
          style={{ width: 340 }}
        >
          {runs.data?.runs.map((run) => (
            <option key={run.id} value={run.id}>
              #{run.id} · {new Date(run.startedAt).toLocaleString()} · {run.state} · +{run.created} ~
              {run.modified} −{run.deleted}
            </option>
          ))}
        </select>
        <select value={kind} onChange={(event) => setKind(event.target.value as typeof kind)} style={{ width: 150 }}>
          <option value="">All changes</option>
          <option value="created">Created</option>
          <option value="modified">Modified</option>
          <option value="deleted">Deleted</option>
          <option value="restored">Restored</option>
        </select>
        <span className="spacer" />
        {selectedRun && (
          <a
            className="button"
            href={`/api/catalog/changes.csv?runId=${selectedRun}${kind ? `&kind=${kind}` : ''}`}
          >
            Export CSV
          </a>
        )}
      </div>

      {summary.data && (
        <div className="grid cols-4">
          <div className="stat">
            <span className="label">Created</span>
            <span className="value" style={{ color: 'var(--ok)' }}>
              {formatCount(summary.data.summary.created)}
            </span>
            <span className="hint">{formatBytes(summary.data.summary.bytesAdded)} added</span>
          </div>
          <div className="stat">
            <span className="label">Modified</span>
            <span className="value">{formatCount(summary.data.summary.modified)}</span>
          </div>
          <div className="stat">
            <span className="label">Deleted</span>
            <span className="value" style={{ color: 'var(--critical)' }}>
              {formatCount(summary.data.summary.deleted)}
            </span>
            <span className="hint">{formatBytes(summary.data.summary.bytesRemoved)} gone</span>
          </div>
          <div className="stat">
            <span className="label">Restored</span>
            <span className="value">{formatCount(summary.data.summary.restored)}</span>
            <span className="hint">files that came back</span>
          </div>
        </div>
      )}

      {changes.loading && !changes.data && <Loading />}
      {changes.data && changes.data.changes.length === 0 && (
        <EmptyState title="Nothing changed in this scan" />
      )}
      {changes.data && changes.data.changes.length > 0 && (
        <>
          <DataTable
            rows={changes.data.changes}
            rowKey={(change) => change.id}
            columns={[
              {
                key: 'kind',
                header: 'Change',
                // Deletions first: on a page about what a scan changed, they are the
                // ones that might mean a disk rather than an edit.
                sort: (change) => CHANGE_ORDER[change.kind] ?? 99,
                cell: (change) => (
                  <Badge
                    tone={
                      change.kind === 'deleted'
                        ? 'critical'
                        : change.kind === 'created'
                          ? 'ok'
                          : change.kind === 'restored'
                            ? 'info'
                            : 'warning'
                    }
                  >
                    {change.kind}
                  </Badge>
                ),
              },
              {
                key: 'path',
                header: 'Path',
                className: 'path',
                sort: (change) => change.relPath,
                cell: (change) => <span title={change.relPath}>{change.relPath}</span>,
              },
              {
                key: 'size',
                header: 'Size',
                numeric: true,
                sort: (change) => change.sizeBytes,
                cell: (change) => formatBytes(change.sizeBytes),
              },
              {
                key: 'was',
                header: 'Was',
                numeric: true,
                className: 'faint',
                sort: (change) => change.previousSizeBytes,
                cell: (change) => formatBytes(change.previousSizeBytes),
              },
              {
                key: 'detected',
                header: 'Detected',
                className: 'nowrap muted',
                sort: (change) => sortTime(change.detectedAt),
                cell: (change) => formatRelative(change.detectedAt),
              },
            ]}
          />
          {changes.data.total > changes.data.changes.length && (
            <div className="faint" style={{ fontSize: 12 }}>
              Showing {changes.data.changes.length} of {formatCount(changes.data.total)} changes —
              export the CSV for the full list.
            </div>
          )}
        </>
      )}
    </div>
  );
}

function SearchTab({ rootId }: { rootId: string }): JSX.Element {
  const [text, setText] = useState('');
  const [ext, setExt] = useState('');
  const [includeDeleted, setIncludeDeleted] = useState(false);
  const [minSize, setMinSize] = useState(0);

  const { data, loading } = useQuery<{
    files: Array<DirectoryEntry & { rootId: string; deletedAt: string | null }>;
    total: number;
  }>(text || ext || minSize ? '/api/catalog/search' : null, {
    query: { rootId, text, ext, minSizeBytes: minSize, includeDeleted, limit: 300 },
  });

  return (
    <div className="stack">
      <div className="toolbar">
        <input
          className="grow"
          type="search"
          placeholder="Search paths…"
          value={text}
          onChange={(event) => setText(event.target.value)}
        />
        <input
          type="text"
          placeholder="extension"
          style={{ width: 120 }}
          value={ext}
          onChange={(event) => setExt(event.target.value)}
        />
        <input
          type="number"
          placeholder="min bytes"
          style={{ width: 140 }}
          value={minSize || ''}
          onChange={(event) => setMinSize(Number(event.target.value) || 0)}
        />
        <label className="checkbox nowrap">
          <input
            type="checkbox"
            checked={includeDeleted}
            onChange={(event) => setIncludeDeleted(event.target.checked)}
          />
          <span>Include deleted</span>
        </label>
      </div>

      {loading && <Loading />}
      {!text && !ext && !minSize && (
        <EmptyState title="Search the catalog">
          Find a file by path fragment, extension or size — including files that have been deleted,
          which is what you need when working out what a failed disk took with it.
        </EmptyState>
      )}
      {data && data.files.length === 0 && <EmptyState title="No matching files" />}
      {data && data.files.length > 0 && (
        <>
          <DataTable
            rows={data.files}
            rowKey={(file) => `${file.rootId}:${file.relPath}`}
            initialSort={{ key: 'size' }}
            columns={[
              {
                key: 'path',
                header: 'Path',
                className: 'path',
                sort: (file) => file.relPath,
                cell: (file) => <span title={file.relPath}>{file.relPath}</span>,
              },
              {
                key: 'size',
                header: 'Size',
                numeric: true,
                sort: (file) => file.sizeBytes,
                cell: (file) => formatBytes(file.sizeBytes),
              },
              {
                key: 'effective',
                header: 'On pool',
                numeric: true,
                sort: (file) => file.effectiveBytes,
                cell: (file) => formatBytes(file.effectiveBytes),
              },
              {
                key: 'hash',
                header: 'Hash',
                className: 'mono faint',
                sort: (file) => file.hash,
                cell: (file) => (file.hash ? file.hash.slice(0, 12) : '—'),
              },
              {
                key: 'status',
                header: 'Status',
                sort: (file) => sortTime(file.deletedAt) ?? Number.POSITIVE_INFINITY,
                cell: (file) =>
                  file.deletedAt ? (
                    <Badge tone="critical">deleted {formatRelative(file.deletedAt)}</Badge>
                  ) : (
                    <Badge tone="ok">present</Badge>
                  ),
              },
            ]}
          />
          <div className="faint" style={{ fontSize: 12 }}>
            {formatCount(data.total)} match{data.total === 1 ? '' : 'es'}
          </div>
        </>
      )}
    </div>
  );
}

export function Breadcrumbs({
  path,
  onNavigate,
}: {
  path: string;
  onNavigate: (path: string) => void;
}): JSX.Element {
  const segments = path.split('/').filter(Boolean);
  return (
    <nav className="breadcrumbs" aria-label="Path">
      <button className="ghost small" onClick={() => onNavigate('')}>
        root
      </button>
      {segments.map((segment, index) => (
        <span key={index} className="row" style={{ gap: 6 }}>
          <span className="sep">/</span>
          <button
            className="ghost small"
            onClick={() => onNavigate(segments.slice(0, index + 1).join('/'))}
          >
            {segment}
          </button>
        </span>
      ))}
    </nav>
  );
}
