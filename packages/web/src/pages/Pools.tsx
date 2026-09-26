import { formatBytes, formatRelative, type PoolSummary } from '@sakuradrive/shared';
import { DataTable } from '../components/DataTable.js';
import { PageHeader } from '../components/Layout.js';
import { Badge, Banner, Card, EmptyState, Loading } from '../components/ui.js';
import { useQuery } from '../hooks/useApi.js';

/** DrivePool reports used bytes, but falls back to the difference when it does not. */
function usedBytes(part: PoolSummary['parts'][number]): number | null {
  if (part.usedBytes !== null && part.usedBytes !== undefined) return part.usedBytes;
  const size = part.sizeBytes ?? 0;
  return size > 0 ? size - (part.freeBytes ?? 0) : null;
}

export function PoolsPage(): JSX.Element {
  const { data, loading } = useQuery<{ pools: PoolSummary[] }>('/api/pools', { pollMs: 30_000 });

  return (
    <>
      <PageHeader
        title="Pools"
        subtitle="StableBit DrivePool pools and the disks that back them"
      />
      <div className="content">
        {loading && !data && <Loading />}
        {data?.pools.length === 0 && (
          <EmptyState title="No pools reported">
            The Windows agent reports pools using DrivePool's own <code>dpcmd</code>. Once it checks
            in, each pool and its parts appear here.
          </EmptyState>
        )}

        {data?.pools.map((pool) => {
          const missing = pool.parts.filter((part) => part.missing);
          const size = pool.sizeBytes ?? 0;
          const free = pool.freeBytes ?? 0;
          const freePercent = size > 0 ? `${((free / size) * 100).toFixed(1)}% free` : null;
          return (
            <Card
              key={pool.poolId}
              flush
              title={pool.name ?? pool.poolId}
              description={`${pool.driveLetter ? `${pool.driveLetter}: · ` : ''}${formatBytes(
                size - free,
              )} used of ${formatBytes(size)}${
                freePercent ? ` · ${freePercent}` : ''
              } · reported ${formatRelative(pool.lastSeenAt)}`}
            >
              {pool.spaceSeverity && (
                <div style={{ padding: 16, paddingBottom: 0 }}>
                  <Banner
                    tone={pool.spaceSeverity}
                    title={`${formatBytes(pool.freeBytes)} free across the pool${
                      freePercent ? ` (${freePercent})` : ''
                    }`}
                  >
                    {pool.spaceSeverity === 'critical'
                      ? 'DrivePool needs free space to balance and to place the second copy of a duplicated file. Once the pool runs out it can do neither, and new writes start failing.'
                      : 'Unlike one member disk filling up, this is not something DrivePool can rebalance its way out of — the pool needs another disk.'}
                  </Banner>
                </div>
              )}
              {missing.length > 0 && (
                <div style={{ padding: 16, paddingBottom: 0 }}>
                  <Banner tone="critical" title={`${missing.length} pool part missing`}>
                    {missing.map((part) => part.volumeLabel ?? part.partId).join(', ')} — DrivePool
                    cannot see {missing.length === 1 ? 'this disk' : 'these disks'}. Unduplicated
                    files stored there are unavailable right now.
                  </Banner>
                </div>
              )}
              <DataTable
                rows={pool.parts}
                rowKey={(part) => part.partId}
                initialSort={{ key: 'label' }}
                columns={[
                  { key: 'part', header: 'Part', className: 'mono', sort: (part) => part.partId },
                  {
                    key: 'label',
                    header: 'Label',
                    sort: (part) => part.volumeLabel ?? part.name,
                    cell: (part) => <strong>{part.volumeLabel ?? part.name ?? '—'}</strong>,
                  },
                  {
                    key: 'letter',
                    header: 'Letter',
                    sort: (part) => part.driveLetter,
                    cell: (part) => (part.driveLetter ? `${part.driveLetter}:` : '—'),
                  },
                  {
                    key: 'size',
                    header: 'Size',
                    numeric: true,
                    sort: (part) => part.sizeBytes,
                    cell: (part) => formatBytes(part.sizeBytes),
                  },
                  {
                    key: 'used',
                    header: 'Used',
                    numeric: true,
                    sort: (part) => usedBytes(part),
                    cell: (part) => formatBytes(usedBytes(part)),
                  },
                  {
                    key: 'free',
                    header: 'Free',
                    numeric: true,
                    sort: (part) => part.freeBytes,
                    cell: (part) => formatBytes(part.freeBytes),
                  },
                  {
                    key: 'freePercent',
                    header: 'Free %',
                    numeric: true,
                    // Which member is actually tight, rather than which is smallest.
                    sort: (part) =>
                      (part.sizeBytes ?? 0) > 0 ? (part.freeBytes ?? 0) / part.sizeBytes! : null,
                    cell: (part) =>
                      (part.sizeBytes ?? 0) > 0
                        ? `${(((part.freeBytes ?? 0) / part.sizeBytes!) * 100).toFixed(1)}%`
                        : '—',
                  },
                  {
                    key: 'status',
                    header: 'Status',
                    // Missing parts first: the one row here anybody needs to act on.
                    defaultDirection: 'desc',
                    sort: (part) => part.missing,
                    cell: (part) =>
                      part.missing ? (
                        <Badge tone="critical" dot>
                          Missing
                        </Badge>
                      ) : (
                        <Badge tone="ok" dot>
                          Online
                        </Badge>
                      ),
                  },
                ]}
              />
            </Card>
          );
        })}
      </div>
    </>
  );
}
