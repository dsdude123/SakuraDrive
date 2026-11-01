import {
  formatRelative,
  type PerfDiskRow,
  type PerfOverview,
  type PerfResult,
  type Settings,
} from '@sakuradrive/shared';
import { api } from '../api/client.js';
import { DataTable, sortTime } from '../components/DataTable.js';
import { PageHeader } from '../components/Layout.js';
import { Sparkline } from '../components/Sparkline.js';
import { Badge, Banner, Card, EmptyState, Loading } from '../components/ui.js';
import { useMutation, useQuery } from '../hooks/useApi.js';
import { useToast } from '../hooks/useToast.js';

const mb = (value: number | null) => (value === null ? '—' : `${value >= 100 ? Math.round(value) : value.toFixed(1)}`);
const ms = (value: number | null) => (value === null ? '—' : value >= 10 ? value.toFixed(0) : value.toFixed(value >= 1 ? 1 : 2));

/** A read figure that may be memory speed carries a marker, not a footnote. */
function Read({ result }: { result: PerfResult | null }): JSX.Element {
  if (!result || result.readMBps === null) return <>—</>;
  return result.readMayBeCached ? (
    <span title="The test could not bypass the cache, so this may be memory speed">~{mb(result.readMBps)}</span>
  ) : (
    <>{mb(result.readMBps)}</>
  );
}

function Status({ result, slowness }: { result: PerfResult | null; slowness?: PerfDiskRow['slowness'] }): JSX.Element {
  if (!result) return <span className="faint">not yet run</span>;
  if (result.error) return <span title={result.error}><Badge tone="critical">failed</Badge></span>;
  if (result.skipped) return <span title={result.skipped}><Badge>skipped</Badge></span>;
  if (slowness && slowness.length > 0) {
    return (
      <span title={slowness.map((finding) => finding.detail).join(' ')}>
        <Badge tone="warning">slow</Badge>
      </span>
    );
  }
  return <Badge tone="ok">ok</Badge>;
}

export function PerformancePage(): JSX.Element {
  const { data, loading, refresh } = useQuery<PerfOverview>('/api/perf', { pollMs: 30_000 });
  const mutation = useMutation();
  const toast = useToast();

  const runNow = async () => {
    const result = await mutation.run('/api/workflows/perf.benchmark/start', { body: { force: true } });
    if (result) {
      toast.push('Benchmark started', 'success');
    } else if (mutation.error) {
      toast.push(mutation.error, 'error');
    }
  };

  const setExcluded = async (volumeId: string, excluded: boolean) => {
    try {
      // Read the stored list rather than rebuilding it from this page, which would drop
      // an exclusion for a disk that is not currently reporting.
      const current = await api<{ settings: Settings }>('/api/settings');
      const list = new Set(current.settings.perfTest.excludedVolumeIds);
      if (excluded) list.add(volumeId);
      else list.delete(volumeId);
      await api('/api/settings', { method: 'PATCH', body: { perfTest: { excludedVolumeIds: [...list] } } });
      refresh();
    } catch (error) {
      toast.push(error instanceof Error ? error.message : String(error), 'error');
    }
  };

  const origin = typeof window === 'undefined' ? 'http://<server>' : window.location.origin;

  return (
    <>
      <PageHeader
        title="Performance"
        subtitle="Benchmarks of every disk, pool, share and the container’s own storage"
        actions={
          <button className="primary" disabled={mutation.busy || !data?.enabled} onClick={() => void runNow()}>
            Run benchmark now
          </button>
        }
      />
      <div className="content">
        {loading && !data && <Loading />}
        {data && !data.enabled && (
          <Banner tone="info" title="Scheduled benchmarks are off">
            Turn them on under Settings → Thresholds.
          </Banner>
        )}
        {data?.enabled && (
          <p className="faint" style={{ margin: 0 }}>
            {data.lastRunAt ? `Last run ${formatRelative(data.lastRunAt)}.` : 'Not run yet.'}
            {data.nextDueAt ? ` Next due ${formatRelative(data.nextDueAt)}, inside the I/O window.` : ' Runs in the next I/O window.'}
          </p>
        )}

        {data?.cacheCoverage.available && data.cacheCoverage.uncovered.length > 0 && (
          <Banner tone="warning" title="Pool members not fronted by PrimoCache">
            {data.cacheCoverage.uncovered.map((volume) => volume.label).join(', ')}
          </Banner>
        )}

        {data && (
          <Card flush title="Disks" description="Write and read 1 file per disk at the volume root, outside the pool folder">
            {data.disks.length === 0 ? (
              <EmptyState title="No disks reported">The agent reports them with every poll.</EmptyState>
            ) : (
              <DataTable
                rows={data.disks}
                rowKey={(disk) => disk.volumeId}
                initialSort={{ key: 'label' }}
                columns={[
                  {
                    key: 'label',
                    header: 'Disk',
                    sort: (disk) => disk.label ?? disk.volumeId,
                    cell: (disk) => (
                      <>
                        <strong>{disk.label ?? disk.volumeId}</strong>
                        <div className="faint" style={{ fontSize: 12 }}>
                          {[disk.poolName ?? 'not pooled', disk.mediaType !== 'unknown' ? disk.mediaType?.toUpperCase() : null]
                            .filter(Boolean)
                            .join(' · ')}
                        </div>
                      </>
                    ),
                  },
                  {
                    key: 'read',
                    header: 'Read MB/s',
                    numeric: true,
                    sort: (disk) => disk.latest?.readMBps,
                    cell: (disk) => <Read result={disk.latest} />,
                  },
                  {
                    key: 'write',
                    header: 'Write MB/s',
                    numeric: true,
                    sort: (disk) => disk.latest?.writeMBps,
                    cell: (disk) => mb(disk.latest?.writeMBps ?? null),
                  },
                  {
                    key: 'latency',
                    header: '4K read ms',
                    numeric: true,
                    sort: (disk) => disk.latest?.latencyMs,
                    cell: (disk) =>
                      disk.latest?.latencyMs == null ? (
                        '—'
                      ) : (
                        <span title={`95th percentile ${ms(disk.latest.latencyP95Ms)} ms`}>{ms(disk.latest.latencyMs)}</span>
                      ),
                  },
                  {
                    key: 'peers',
                    header: 'vs peers',
                    numeric: true,
                    // The column the slow-disk rule reads: this disk's read against the
                    // median of the same pool on the same media.
                    sort: (disk) =>
                      disk.peerMedianReadMBps && disk.latest?.readMBps != null
                        ? disk.latest.readMBps / disk.peerMedianReadMBps
                        : null,
                    cell: (disk) =>
                      disk.peerMedianReadMBps && disk.latest?.readMBps != null ? (
                        <span title={`Median of ${disk.peers} comparable disks: ${mb(disk.peerMedianReadMBps)} MB/s`}>
                          {Math.round((disk.latest.readMBps / disk.peerMedianReadMBps) * 100)}%
                        </span>
                      ) : (
                        '—'
                      ),
                  },
                  {
                    key: 'trend',
                    header: 'Read trend',
                    cell: (disk) =>
                      disk.history.length > 1 ? (
                        <Sparkline points={disk.history} width={90} height={24} fill={false} />
                      ) : (
                        <span className="faint">—</span>
                      ),
                  },
                  {
                    key: 'cache',
                    header: 'Cache',
                    sort: (disk) => disk.cached,
                    cell: (disk) =>
                      disk.cached === null ? (
                        <span className="faint">—</span>
                      ) : disk.cached ? (
                        <Badge tone="ok">PrimoCache</Badge>
                      ) : (
                        <Badge tone="warning">none</Badge>
                      ),
                  },
                  {
                    key: 'status',
                    header: 'Status',
                    defaultDirection: 'desc',
                    sort: (disk) =>
                      disk.excluded ? -1 : disk.latest?.error ? 3 : disk.slowness.length > 0 ? 2 : disk.latest?.skipped ? 1 : 0,
                    cell: (disk) =>
                      disk.excluded ? <span className="faint">excluded</span> : <Status result={disk.latest} slowness={disk.slowness} />,
                  },
                  {
                    key: 'measured',
                    header: 'Measured',
                    className: 'nowrap muted',
                    sort: (disk) => sortTime(disk.latest?.measuredAt),
                    cell: (disk) => (disk.latest ? formatRelative(disk.latest.measuredAt) : '—'),
                  },
                  {
                    key: 'include',
                    header: 'Benchmark',
                    controls: true,
                    sort: (disk) => !disk.excluded,
                    cell: (disk) => (
                      <label className="checkbox" title="Benchmark this disk and check its cache coverage">
                        <input
                          type="checkbox"
                          checked={!disk.excluded}
                          onChange={(event) => void setExcluded(disk.volumeId, !event.target.checked)}
                        />
                        <span>{disk.excluded ? 'off' : 'on'}</span>
                      </label>
                    ),
                  },
                ]}
              />
            )}
          </Card>
        )}

        {data && data.pools.length > 0 && (
          <Card flush title="Pools" description="Through the pool’s drive letter, DrivePool and cache included">
            <ResultTable rows={data.pools} />
          </Card>
        )}

        {data && (
          <Card flush title="Network" description="Reported by the client below, run on machines that use the shares">
            {data.network.length === 0 ? (
              <EmptyState title="No network results yet" />
            ) : (
              <DataTable
                rows={data.network}
                rowKey={(result) => result.id}
                initialSort={{ key: 'measured', direction: 'desc' }}
                columns={[
                  { key: 'client', header: 'Client', sort: (result) => result.host },
                  { key: 'share', header: 'Share', className: 'mono', sort: (result) => result.targetKey },
                  {
                    key: 'write',
                    header: 'Write MB/s',
                    numeric: true,
                    sort: (result) => result.writeMBps,
                    cell: (result) => mb(result.writeMBps),
                  },
                  { key: 'read', header: 'Read MB/s', numeric: true, sort: (result) => result.readMBps, cell: (result) => <Read result={result} /> },
                  {
                    key: 'latency',
                    header: 'Small file ms',
                    numeric: true,
                    sort: (result) => result.latencyMs,
                    cell: (result) => ms(result.latencyMs),
                  },
                  { key: 'status', header: 'Status', cell: (result) => <Status result={result} /> },
                  {
                    key: 'measured',
                    header: 'Measured',
                    className: 'nowrap muted',
                    sort: (result) => sortTime(result.measuredAt),
                    cell: (result) => formatRelative(result.measuredAt),
                  },
                ]}
              />
            )}
            <div style={{ padding: 16 }}>
              <p className="faint" style={{ marginTop: 0 }}>
                Needs Python 3 and an agent token from Settings → Agents.
              </p>
              <pre className="code">{`curl -o sakuradrive-netperf.py ${origin}/api/perf/netperf.py
python3 sakuradrive-netperf.py --server ${origin} --token <token> --share '\\\\<host>\\<share>'`}</pre>
            </div>
          </Card>
        )}

        {data && data.wsl.length > 0 && (
          <Card flush title="Container storage" description="The database and export paths, from inside WSL2">
            <DataTable
              rows={data.wsl}
              rowKey={(result) => result.id}
              columns={[
                { key: 'path', header: 'Path', sort: (result) => result.targetLabel },
                {
                  key: 'fs',
                  header: 'Filesystem',
                  sort: (result) => String(result.details.fsType ?? ''),
                  cell: (result) =>
                    result.details.windowsFilesystem ? (
                      <span title="A Windows drive reached through drvfs">
                        <Badge tone="warning">{String(result.details.fsType)} (Windows)</Badge>
                      </span>
                    ) : (
                      String(result.details.fsType ?? '—')
                    ),
                },
                { key: 'write', header: 'Write MB/s', numeric: true, sort: (result) => result.writeMBps, cell: (result) => mb(result.writeMBps) },
                { key: 'read', header: 'Read MB/s', numeric: true, sort: (result) => result.readMBps, cell: (result) => <Read result={result} /> },
                {
                  key: 'sync',
                  header: 'Synced 4K write ms',
                  numeric: true,
                  sort: (result) => result.latencyMs,
                  cell: (result) => (
                    <span title={`95th percentile ${ms(result.latencyP95Ms)} ms`}>{ms(result.latencyMs)}</span>
                  ),
                },
                { key: 'status', header: 'Status', cell: (result) => <Status result={result} /> },
                {
                  key: 'measured',
                  header: 'Measured',
                  className: 'nowrap muted',
                  sort: (result) => sortTime(result.measuredAt),
                  cell: (result) => formatRelative(result.measuredAt),
                },
              ]}
            />
          </Card>
        )}
      </div>
    </>
  );
}

function ResultTable({ rows }: { rows: PerfResult[] }): JSX.Element {
  return (
    <DataTable
      rows={rows}
      rowKey={(result) => result.id}
      initialSort={{ key: 'label' }}
      columns={[
        { key: 'label', header: 'Pool', sort: (result) => result.targetLabel },
        { key: 'write', header: 'Write MB/s', numeric: true, sort: (result) => result.writeMBps, cell: (result) => mb(result.writeMBps) },
        { key: 'read', header: 'Read MB/s', numeric: true, sort: (result) => result.readMBps, cell: (result) => <Read result={result} /> },
        { key: 'status', header: 'Status', cell: (result) => <Status result={result} /> },
        {
          key: 'measured',
          header: 'Measured',
          className: 'nowrap muted',
          sort: (result) => sortTime(result.measuredAt),
          cell: (result) => formatRelative(result.measuredAt),
        },
      ]}
    />
  );
}
