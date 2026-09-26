import { Link, useParams } from 'react-router-dom';
import {
  attributeRaw,
  DEFAULT_ATTRIBUTE_RULES,
  SEVERITY_ORDER,
  formatBytes,
  formatCount,
  formatRelative,
  type DriveSummary,
  type SmartReport,
  type VolumeSummary,
} from '@sakuradrive/shared';
import { DataTable, sortTime } from '../components/DataTable.js';
import { PageHeader } from '../components/Layout.js';
import { Sparkline } from '../components/Sparkline.js';
import { Badge, Banner, Card, EmptyState, Loading, SeverityBadge, Table } from '../components/ui.js';
import { useMutation, useQuery } from '../hooks/useApi.js';
import { useToast } from '../hooks/useToast.js';

export function DrivesPage(): JSX.Element {
  const drives = useQuery<{ drives: DriveSummary[] }>('/api/drives', { pollMs: 30_000 });
  const volumes = useQuery<{ volumes: VolumeSummary[] }>('/api/volumes', { pollMs: 60_000 });
  const primoCache = useQuery<{ latest: { collectedAt: string; available: boolean; data: PrimoCacheData | null } | null }>(
    '/api/primocache',
    { pollMs: 60_000 },
  );

  return (
    <>
      <PageHeader
        title="Drives"
        subtitle="SMART health, temperature and filesystem status for every physical disk"
        actions={
          <a className="button" href="/api/drives.csv">
            Export CSV
          </a>
        }
      />
      <div className="content">
        {drives.loading && !drives.data && <Loading />}
        {drives.data?.drives.length === 0 && (
          <Banner tone="info" title="No drives reported yet">
            SMART data cannot be read from inside a Linux container, so it comes from the Windows
            agent. Create an agent token under <Link to="/settings">Settings → Agents</Link> and run
            the installer on the host.
          </Banner>
        )}

        {(drives.data?.drives.length ?? 0) > 0 && (
          <Card flush title="Physical disks">
            <DataTable
              rows={drives.data!.drives}
              rowKey={(drive) => drive.id}
              initialSort={{ key: 'label' }}
              columns={[
                {
                  key: 'label',
                  header: 'Label',
                  sort: (drive) => drive.labels.join(', ') || drive.deviceId,
                  cell: (drive) => (
                    <>
                      <Link to={`/drives/${drive.id}`}>
                        <strong>{drive.labels.join(', ') || drive.deviceId || '—'}</strong>
                      </Link>
                      {drive.driveLetters.length > 0 && (
                        <div className="faint" style={{ fontSize: 12 }}>
                          {drive.driveLetters.map((letter) => `${letter}:`).join(' ')}
                        </div>
                      )}
                    </>
                  ),
                },
                {
                  key: 'model',
                  header: 'Model',
                  sort: (drive) => drive.model,
                  cell: (drive) => (
                    <>
                      {drive.model ?? '—'}
                      <div className="faint" style={{ fontSize: 12 }}>
                        {[drive.mediaType, drive.busType].filter(Boolean).join(' · ')}
                      </div>
                    </>
                  ),
                },
                { key: 'serial', header: 'Serial', className: 'mono', sort: (drive) => drive.serialNumber },
                {
                  key: 'size',
                  header: 'Size',
                  numeric: true,
                  sort: (drive) => drive.sizeBytes,
                  cell: (drive) => formatBytes(drive.sizeBytes),
                },
                {
                  key: 'temp',
                  header: 'Temp',
                  numeric: true,
                  sort: (drive) => drive.temperatureC,
                  cell: (drive) => (drive.temperatureC !== null ? `${drive.temperatureC}°C` : '—'),
                },
                {
                  key: 'power',
                  header: 'Power on',
                  numeric: true,
                  sort: (drive) => drive.powerOnHours,
                  cell: (drive) =>
                    drive.powerOnHours !== null
                      ? `${formatCount(Math.round(drive.powerOnHours))} h`
                      : '—',
                },
                {
                  key: 'pool',
                  header: 'Pool',
                  sort: (drive) => drive.poolNames.join(', '),
                  cell: (drive) => drive.poolNames.join(', ') || <span className="faint">—</span>,
                },
                {
                  key: 'health',
                  header: 'Health',
                  // Worst first, and a failed SMART self-assessment outranks every
                  // severity: alphabetical order would bury `critical` under `info`.
                  defaultDirection: 'desc',
                  sort: (drive) =>
                    drive.overallHealthPassed === false
                      ? 99
                      : drive.severity
                        ? SEVERITY_ORDER[drive.severity] + 1
                        : 0,
                  cell: (drive) => (
                    <>
                      <SeverityBadge severity={drive.severity} />
                      {drive.overallHealthPassed === false && (
                        <div style={{ marginTop: 4 }}>
                          <Badge tone="critical">SMART FAILED</Badge>
                        </div>
                      )}
                    </>
                  ),
                },
                {
                  key: 'lastSeen',
                  header: 'Last seen',
                  sort: (drive) => sortTime(drive.lastSeenAt),
                  className: 'nowrap muted',
                  cell: (drive) => formatRelative(drive.lastSeenAt),
                },
              ]}
            />
          </Card>
        )}

        <VolumesCard volumes={volumes.data?.volumes ?? []} onChanged={volumes.refresh} />

        <PrimoCacheCard latest={primoCache.data?.latest ?? null} />
      </div>
    </>
  );
}

/**
 * Filesystem status, and the switch that decides whether a full disk is news.
 *
 * A DrivePool member runs low on space because DrivePool chose to put files there, and
 * DrivePool will move them again when it needs to; there is nothing for anyone to do,
 * so the alert is noise that buries the ones that matter. A volume holding data outside
 * the pool -- an SSD tier with its own files on it -- is the opposite: DrivePool has no
 * say in how full it gets, so nobody but the operator will notice.
 *
 * Muting is per volume and covers free space only. The dirty bit and Windows' own
 * volume health are separate conditions and keep alerting either way.
 */
function VolumesCard({
  volumes,
  onChanged,
}: {
  volumes: VolumeSummary[];
  onChanged: () => void;
}): JSX.Element | null {
  const mutation = useMutation();
  const toast = useToast();

  if (volumes.length === 0) return null;

  const setAlerts = async (ids: number[], enabled: boolean) => {
    if (ids.length === 0) return;
    const result = await mutation.run('/api/volumes/low-space-alerts', {
      method: 'PATCH',
      body: { ids, enabled },
    });
    if (result) {
      const what = ids.length === 1 ? 'Low-space alerts' : `Low-space alerts for ${ids.length} volumes`;
      toast.push(`${what} ${enabled ? 'enabled' : 'muted'}`, 'success');
      onChanged();
    } else if (mutation.error) {
      toast.push(mutation.error, 'error');
    }
  };

  // One button per pool: fourteen member disks is the normal case, and clicking
  // fourteen checkboxes to say one thing is not a design.
  const pools = new Map<string, { name: string; ids: number[]; muted: number }>();
  for (const volume of volumes) {
    if (!volume.poolId) continue;
    const entry = pools.get(volume.poolId) ?? {
      name: volume.poolName ?? volume.poolId,
      ids: [],
      muted: 0,
    };
    entry.ids.push(volume.id);
    if (!volume.lowSpaceAlerts) entry.muted += 1;
    pools.set(volume.poolId, entry);
  }

  return (
    <Card
      flush
      title="Volumes"
      description="Filesystem status as Windows reports it"
      actions={[...pools.entries()].map(([poolId, pool]) => {
        const allMuted = pool.muted === pool.ids.length;
        return (
          <button
            key={poolId}
            type="button"
            disabled={mutation.busy}
            onClick={() => setAlerts(pool.ids, allMuted)}
          >
            {allMuted ? 'Alert on low space in' : 'Mute low space for'} {pool.name} (
            {pool.ids.length} disks)
          </button>
        );
      })}
    >
      <DataTable
        rows={volumes}
        rowKey={(volume) => volume.id}
        initialSort={{ key: 'label' }}
        columns={[
          {
            key: 'label',
            header: 'Label',
            sort: (volume) => volume.label ?? volume.volumeId,
            cell: (volume) => (
              <>
                <strong>{volume.label ?? volume.volumeId}</strong>
                {volume.poolName && (
                  <div className="faint" style={{ fontSize: 12 }}>
                    in {volume.poolName}
                  </div>
                )}
              </>
            ),
          },
          {
            key: 'letter',
            header: 'Letter',
            sort: (volume) => volume.driveLetter ?? volume.mountPoints[0],
            cell: (volume) =>
              volume.driveLetter ? (
                `${volume.driveLetter}:`
              ) : volume.mountPoints.length > 0 ? (
                <span className="mono" style={{ fontSize: 12 }} title={volume.mountPoints.join(', ')}>
                  {volume.mountPoints[0]}
                </span>
              ) : (
                <span className="faint" title="No drive letter and no folder mount point — the container cannot reach this volume">
                  not mounted
                </span>
              ),
          },
          { key: 'fs', header: 'Filesystem', sort: (volume) => volume.fileSystem },
          {
            key: 'size',
            header: 'Size',
            numeric: true,
            sort: (volume) => volume.sizeBytes,
            cell: (volume) => formatBytes(volume.sizeBytes),
          },
          {
            key: 'free',
            header: 'Free',
            numeric: true,
            sort: (volume) => volume.freeBytes,
            cell: (volume) => (
              <span
                style={
                  volume.lowSpace && volume.lowSpaceAlerts ? { color: 'var(--warning)' } : undefined
                }
              >
                {formatBytes(volume.freeBytes)}
              </span>
            ),
          },
          {
            key: 'freePercent',
            header: 'Free %',
            numeric: true,
            // The column the free-space rule actually fires on. Sorting by bytes puts a
            // nearly-full 20 TB disk above a genuinely full 2 TB one.
            sort: (volume) =>
              (volume.sizeBytes ?? 0) > 0 ? (volume.freeBytes ?? 0) / volume.sizeBytes! : null,
            cell: (volume) =>
              (volume.sizeBytes ?? 0) > 0
                ? `${(((volume.freeBytes ?? 0) / volume.sizeBytes!) * 100).toFixed(1)}%`
                : '—',
          },
          {
            key: 'health',
            header: 'Health',
            defaultDirection: 'desc',
            sort: (volume) => (volume.healthStatus === 'Healthy' ? 0 : 1),
            cell: (volume) => (
              <Badge tone={volume.healthStatus === 'Healthy' ? 'ok' : 'warning'}>
                {volume.healthStatus ?? 'unknown'}
              </Badge>
            ),
          },
          {
            key: 'chkdsk',
            header: 'chkdsk',
            // A pending chkdsk is the only thing in this column worth reading.
            defaultDirection: 'desc',
            sort: (volume) => volume.dirty === true,
            cell: (volume) =>
              volume.dirty ? (
                <Badge tone="critical">dirty bit set</Badge>
              ) : (
                <span className="faint">clean</span>
              ),
          },
          {
            key: 'lowSpaceAlerts',
            header: 'Low space alert',
            sort: (volume) => volume.lowSpaceAlerts,
            cell: (volume) => (
              <label className="checkbox" title="Raise an alert when this volume runs low on free space">
                <input
                  type="checkbox"
                  checked={volume.lowSpaceAlerts}
                  disabled={mutation.busy}
                  onChange={(event) => setAlerts([volume.id], event.target.checked)}
                />
                <span>{volume.lowSpaceAlerts ? 'on' : 'muted'}</span>
              </label>
            ),
          },
        ]}
      />
    </Card>
  );
}

interface PrimoCacheVolumeStats {
  volume: number;
  label?: string | null;
  readBytes?: number | null;
  cachedReadBytes?: number | null;
  readHitRate?: number | null;
  level2ReadRate?: number | null;
  writeBytes?: number | null;
  writeAbsorbedRate?: number | null;
  deferredBlocks?: number | null;
  prefetchState?: string | null;
  prefetchLoadedBytes?: number | null;
  prefetchTotalBytes?: number | null;
}

interface PrimoCacheData {
  available: boolean;
  version?: string | null;
  reason?: string | null;
  unusedLevel1Bytes?: number | null;
  unusedLevel2Bytes?: number | null;
  caches: Array<{
    name: string;
    level?: string | null;
    cacheSizeBytes?: number | null;
    usedBytes?: number | null;
    readHitRate?: number | null;
    writeAbsorbedRate?: number | null;
    statsSince?: string | null;
    volumeStats?: PrimoCacheVolumeStats[];
    deferredWriteBytes?: number | null;
  }>;
}

function percent(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return `${Math.round(value * 100)}%`;
}

function PrimoCacheCard({
  latest,
}: {
  latest: { collectedAt: string; available: boolean; data: PrimoCacheData | null } | null;
}): JSX.Element {
  const data = latest?.data ?? null;
  // Every figure rxpcc reports is cumulative since the cache last started counting, so
  // saying since when is the difference between a hit rate and a number.
  const since = data?.caches.find((cache) => cache.statsSince)?.statsSince ?? null;

  return (
    <Card
      title="PrimoCache"
      description={latest ? `Reported ${formatRelative(latest.collectedAt)}` : undefined}
      flush
    >
      {!latest || !latest.available ? (
        <EmptyState title="No PrimoCache statistics">
          {data?.reason ??
            'The agent reports cache statistics when it can run rxpcc. It cannot while the PrimoCache window is open — the two share a single instance. Everything else on this page works without it.'}
        </EmptyState>
      ) : (
        <>
          <DataTable
            rows={data?.caches ?? []}
            rowKey={(cache) => cache.name}
            initialSort={{ key: 'name' }}
            columns={[
              {
                key: 'name',
                header: 'Cache',
                sort: (cache) => cache.name,
                cell: (cache) => (
                  <>
                    <strong>{cache.name}</strong>
                    {cache.volumeStats && cache.volumeStats.length > 0 && (
                      <div className="hint">
                        {cache.volumeStats.map((volume) => volume.label ?? `#${volume.volume}`).join(', ')}
                      </div>
                    )}
                  </>
                ),
              },
              { key: 'level', header: 'Level', sort: (cache) => cache.level },
              {
                key: 'size',
                header: 'Size',
                numeric: true,
                sort: (cache) => cache.cacheSizeBytes,
                cell: (cache) => formatBytes(cache.cacheSizeBytes),
              },
              {
                key: 'used',
                header: 'Used',
                numeric: true,
                sort: (cache) => cache.usedBytes,
                cell: (cache) => formatBytes(cache.usedBytes),
              },
              {
                key: 'reads',
                header: 'Reads served',
                numeric: true,
                sort: (cache) => cache.readHitRate,
                cell: (cache) => percent(cache.readHitRate),
              },
              {
                key: 'writes',
                header: 'Writes absorbed',
                numeric: true,
                sort: (cache) => cache.writeAbsorbedRate,
                cell: (cache) => percent(cache.writeAbsorbedRate),
              },
            ]}
          />

          {(data?.caches ?? []).some((cache) => (cache.volumeStats ?? []).length > 0) && (
            <DataTable
              rows={(data?.caches ?? []).flatMap((cache) =>
                (cache.volumeStats ?? []).map((volume) => ({ cache: cache.name, volume })),
              )}
              rowKey={(row) => `${row.cache}-${row.volume.volume}`}
              initialSort={{ key: 'label' }}
              columns={[
                {
                  key: 'label',
                  header: 'Volume',
                  sort: ({ volume }) => volume.label ?? `Volume #${volume.volume}`,
                },
                {
                  key: 'read',
                  header: 'Read',
                  numeric: true,
                  sort: ({ volume }) => volume.readBytes,
                  cell: ({ volume }) => formatBytes(volume.readBytes),
                },
                {
                  key: 'served',
                  header: 'Served',
                  numeric: true,
                  sort: ({ volume }) => volume.readHitRate,
                  cell: ({ volume }) => percent(volume.readHitRate),
                },
                {
                  key: 'written',
                  header: 'Written',
                  numeric: true,
                  sort: ({ volume }) => volume.writeBytes,
                  cell: ({ volume }) => formatBytes(volume.writeBytes),
                },
                {
                  key: 'absorbed',
                  header: 'Absorbed',
                  numeric: true,
                  sort: ({ volume }) => volume.writeAbsorbedRate,
                  cell: ({ volume }) => percent(volume.writeAbsorbedRate),
                },
                {
                  key: 'prefetch',
                  header: 'Prefetch',
                  sort: ({ volume }) => volume.prefetchState,
                  cell: ({ volume }) =>
                    volume.prefetchState === 'Done' && volume.prefetchTotalBytes
                      ? `${formatBytes(volume.prefetchLoadedBytes)} of ${formatBytes(volume.prefetchTotalBytes)}`
                      : (volume.prefetchState ?? '—'),
                },
              ]}
            />
          )}

          <p className="hint" style={{ padding: '8px 16px' }}>
            {'"Reads served" is the share of read bytes the cache answered; "writes absorbed" is the '}
            {'share of written bytes deferred write kept off the disk. Both are cumulative'}
            {since ? ` since ${new Date(since).toLocaleString()}` : ' since the cache last started counting'}
            {data?.unusedLevel1Bytes !== null && data?.unusedLevel1Bytes !== undefined
              ? `. ${formatBytes(data.unusedLevel1Bytes)} of level-1 and ${formatBytes(data.unusedLevel2Bytes)} of level-2 cache are still unused.`
              : '.'}
          </p>
        </>
      )}
    </Card>
  );
}

/* ------------------------------------------------------------ drive detail */

interface DriveDetail {
  drive: DriveSummary | null;
  latestSmart: SmartReport | null;
  history: Array<{ attributeId: number; points: Array<{ at: string; raw: number | null }> }>;
  performance: Array<{
    at: string;
    readLatencyMs: number | null;
    writeLatencyMs: number | null;
    queueLength: number | null;
  }>;
}

export function DriveDetailPage(): JSX.Element {
  const { id } = useParams<{ id: string }>();
  const { data, loading, error } = useQuery<DriveDetail>(`/api/drives/${id}`, { pollMs: 30_000 });

  if (loading && !data) return <Loading />;
  if (error || !data?.drive) {
    return (
      <>
        <PageHeader title="Drive" />
        <div className="content">
          <Banner tone="critical" title="Drive not found">
            {error?.message ?? 'This drive is no longer in the database.'}
          </Banner>
        </div>
      </>
    );
  }

  const drive = data.drive;
  const rulesById = new Map(DEFAULT_ATTRIBUTE_RULES.map((rule) => [rule.id, rule]));
  const attributes = data.latestSmart?.attributes ?? [];
  /** Past the rule's warning threshold: the reason to look at this row at all. */
  const isConcerning = (attribute: SmartReport['attributes'][number]) => {
    const rule = rulesById.get(attribute.id);
    const raw = attributeRaw(attribute);
    return rule !== undefined && raw !== null && raw > rule.warnAbove;
  };

  return (
    <>
      <PageHeader
        title={drive.labels.join(', ') || drive.model || 'Drive'}
        subtitle={`${drive.model ?? 'unknown model'} · ${drive.serialNumber ?? 'no serial'}`}
        actions={<Link className="button" to="/drives">Back to drives</Link>}
      />
      <div className="content">
        <div className="grid cols-2">
          <Card title="Identity">
            <dl className="kv">
              <dt>Label</dt>
              <dd>{drive.labels.join(', ') || '—'}</dd>
              <dt>Model</dt>
              <dd>{drive.model ?? '—'}</dd>
              <dt>Serial</dt>
              <dd className="mono">{drive.serialNumber ?? '—'}</dd>
              <dt>Firmware</dt>
              <dd className="mono">{drive.firmware ?? '—'}</dd>
              <dt>Capacity</dt>
              <dd>{formatBytes(drive.sizeBytes)}</dd>
              <dt>Interface</dt>
              <dd>{[drive.mediaType, drive.busType].filter(Boolean).join(' · ') || '—'}</dd>
              <dt>Device id</dt>
              <dd className="mono">{drive.deviceId}</dd>
              <dt>Pools</dt>
              <dd>{drive.poolNames.join(', ') || '—'}</dd>
              <dt>Host</dt>
              <dd>{drive.hostname ?? '—'}</dd>
              <dt>Last report</dt>
              <dd>{formatRelative(drive.lastSeenAt)}</dd>
            </dl>
          </Card>

          <Card title="Health">
            <dl className="kv">
              <dt>Assessment</dt>
              <dd>
                <SeverityBadge severity={drive.severity} />
              </dd>
              <dt>SMART overall</dt>
              <dd>
                {drive.overallHealthPassed === null ? (
                  <span className="faint">unknown</span>
                ) : drive.overallHealthPassed ? (
                  <Badge tone="ok">PASSED</Badge>
                ) : (
                  <Badge tone="critical">FAILED</Badge>
                )}
              </dd>
              <dt>Temperature</dt>
              <dd>{drive.temperatureC !== null ? `${drive.temperatureC}°C` : '—'}</dd>
              <dt>Power-on hours</dt>
              <dd>
                {drive.powerOnHours !== null
                  ? `${formatCount(Math.round(drive.powerOnHours))} h (${Math.round(
                      drive.powerOnHours / 24 / 365.25,
                    )} years)`
                  : '—'}
              </dd>
              <dt>Open alerts</dt>
              <dd>{drive.openAlertCount}</dd>
              <dt>Source</dt>
              <dd>{data.latestSmart?.source ?? 'unknown'}</dd>
            </dl>
          </Card>
        </div>

        {data.performance.length > 0 && (
          <Card
            title="I/O latency"
            description="Sustained high latency is what makes client systems lock up"
          >
            <div className="grid cols-3">
              <div>
                <div className="label faint" style={{ fontSize: 11 }}>
                  READ LATENCY (ms)
                </div>
                <Sparkline
                  points={data.performance.map((sample) => sample.readLatencyMs)}
                  color="var(--info)"
                  width={320}
                  height={54}
                />
              </div>
              <div>
                <div className="label faint" style={{ fontSize: 11 }}>
                  WRITE LATENCY (ms)
                </div>
                <Sparkline
                  points={data.performance.map((sample) => sample.writeLatencyMs)}
                  color="var(--accent)"
                  width={320}
                  height={54}
                />
              </div>
              <div>
                <div className="label faint" style={{ fontSize: 11 }}>
                  QUEUE LENGTH
                </div>
                <Sparkline
                  points={data.performance.map((sample) => sample.queueLength)}
                  color="var(--warning)"
                  width={320}
                  height={54}
                />
              </div>
            </div>
          </Card>
        )}

        <Card flush title="SMART attributes" description="Trend shows every recorded change">
          {attributes.length === 0 ? (
            <EmptyState title="No SMART attributes recorded">
              The agent could not read SMART data for this drive. Install smartmontools on the host,
              or check whether the controller hides SMART.
            </EmptyState>
          ) : (
            <DataTable
              rows={attributes}
              rowKey={(attribute) => attribute.id}
              initialSort={{ key: 'id', direction: 'asc' }}
              columns={[
                { key: 'id', header: 'ID', numeric: true, className: 'mono', sort: (a) => a.id },
                {
                  key: 'name',
                  header: 'Attribute',
                  sort: (attribute) =>
                    rulesById.get(attribute.id)?.name ?? attribute.name ?? `Attribute ${attribute.id}`,
                  cell: (attribute) => {
                    const rule = rulesById.get(attribute.id);
                    return (
                      <>
                        {rule?.name ?? attribute.name ?? `Attribute ${attribute.id}`}
                        {rule && (
                          <div className="faint" style={{ fontSize: 12 }}>
                            {rule.description}
                          </div>
                        )}
                      </>
                    );
                  },
                },
                {
                  key: 'raw',
                  header: 'Raw',
                  numeric: true,
                  sort: (attribute) => attributeRaw(attribute),
                  cell: (attribute) => {
                    const raw = attributeRaw(attribute);
                    return (
                      <span style={isConcerning(attribute) ? { color: 'var(--warning)' } : undefined}>
                        {attribute.rawString ?? raw ?? '—'}
                      </span>
                    );
                  },
                },
                { key: 'value', header: 'Value', numeric: true, sort: (a) => a.value },
                { key: 'worst', header: 'Worst', numeric: true, sort: (a) => a.worst },
                { key: 'threshold', header: 'Threshold', numeric: true, sort: (a) => a.threshold },
                {
                  key: 'trend',
                  header: 'Trend',
                  cell: (attribute) => (
                    <Sparkline
                      points={(
                        data.history.find((entry) => entry.attributeId === attribute.id)?.points ?? []
                      ).map((point) => point.raw)}
                      width={110}
                      height={26}
                      color={isConcerning(attribute) ? 'var(--warning)' : 'var(--text-faint)'}
                      fill={false}
                    />
                  ),
                },
                {
                  key: 'watch',
                  header: 'Watch',
                  // So the attributes worth looking at can be brought to the top of a
                  // list that is otherwise thirty rows of healthy counters.
                  defaultDirection: 'desc',
                  sort: (attribute) => isConcerning(attribute),
                  cell: (attribute) => isConcerning(attribute) && <Badge tone="warning">watch</Badge>,
                },
              ]}
            />
          )}
        </Card>
      </div>
    </>
  );
}
