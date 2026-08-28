import { formatBytes, formatRelative, type PoolSummary } from '@sakuradrive/shared';
import { PageHeader } from '../components/Layout.js';
import { Badge, Banner, Card, EmptyState, Loading, Table } from '../components/ui.js';
import { useQuery } from '../hooks/useApi.js';

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
          return (
            <Card
              key={pool.poolId}
              flush
              title={pool.name ?? pool.poolId}
              description={`${pool.driveLetter ? `${pool.driveLetter}: · ` : ''}${formatBytes(
                size - free,
              )} used of ${formatBytes(size)} · reported ${formatRelative(pool.lastSeenAt)}`}
            >
              {missing.length > 0 && (
                <div style={{ padding: 16, paddingBottom: 0 }}>
                  <Banner tone="critical" title={`${missing.length} pool part missing`}>
                    {missing.map((part) => part.volumeLabel ?? part.partId).join(', ')} — DrivePool
                    cannot see {missing.length === 1 ? 'this disk' : 'these disks'}. Unduplicated
                    files stored there are unavailable right now.
                  </Banner>
                </div>
              )}
              <Table headers={['Part', 'Label', 'Letter', '#Size', '#Used', '#Free', 'Status']}>
                {pool.parts.map((part) => {
                  const partSize = part.sizeBytes ?? 0;
                  const partFree = part.freeBytes ?? 0;
                  return (
                    <tr key={part.partId}>
                      <td className="mono">{part.partId}</td>
                      <td>
                        <strong>{part.volumeLabel ?? part.name ?? '—'}</strong>
                      </td>
                      <td>{part.driveLetter ? `${part.driveLetter}:` : '—'}</td>
                      <td className="num">{formatBytes(part.sizeBytes)}</td>
                      <td className="num">
                        {formatBytes(part.usedBytes ?? (partSize > 0 ? partSize - partFree : null))}
                      </td>
                      <td className="num">{formatBytes(part.freeBytes)}</td>
                      <td>
                        {part.missing ? (
                          <Badge tone="critical" dot>
                            Missing
                          </Badge>
                        ) : (
                          <Badge tone="ok" dot>
                            Online
                          </Badge>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </Table>
            </Card>
          );
        })}
      </div>
    </>
  );
}
