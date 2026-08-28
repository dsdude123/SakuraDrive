import { Link, useParams } from 'react-router-dom';
import {
  attributeRaw,
  DEFAULT_ATTRIBUTE_RULES,
  formatBytes,
  formatCount,
  formatRelative,
  type DriveSummary,
  type SmartReport,
  type VolumeSummary,
} from '@sakuradrive/shared';
import { PageHeader } from '../components/Layout.js';
import { Sparkline } from '../components/Sparkline.js';
import { Badge, Banner, Card, EmptyState, Loading, SeverityBadge, Table } from '../components/ui.js';
import { useQuery } from '../hooks/useApi.js';

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
            <Table
              headers={['Label', 'Model', 'Serial', '#Size', '#Temp', '#Power on', 'Pool', 'Health', 'Last seen']}
            >
              {drives.data!.drives.map((drive) => (
                <tr key={drive.id}>
                  <td>
                    <Link to={`/drives/${drive.id}`}>
                      <strong>{drive.labels.join(', ') || drive.deviceId || '—'}</strong>
                    </Link>
                    {drive.driveLetters.length > 0 && (
                      <div className="faint" style={{ fontSize: 12 }}>
                        {drive.driveLetters.map((letter) => `${letter}:`).join(' ')}
                      </div>
                    )}
                  </td>
                  <td>
                    {drive.model ?? '—'}
                    <div className="faint" style={{ fontSize: 12 }}>
                      {[drive.mediaType, drive.busType].filter(Boolean).join(' · ')}
                    </div>
                  </td>
                  <td className="mono">{drive.serialNumber ?? '—'}</td>
                  <td className="num">{formatBytes(drive.sizeBytes)}</td>
                  <td className="num">{drive.temperatureC !== null ? `${drive.temperatureC}°C` : '—'}</td>
                  <td className="num">
                    {drive.powerOnHours !== null ? `${formatCount(Math.round(drive.powerOnHours))} h` : '—'}
                  </td>
                  <td>{drive.poolNames.join(', ') || <span className="faint">—</span>}</td>
                  <td>
                    <SeverityBadge severity={drive.severity} />
                    {drive.overallHealthPassed === false && (
                      <div style={{ marginTop: 4 }}>
                        <Badge tone="critical">SMART FAILED</Badge>
                      </div>
                    )}
                  </td>
                  <td className="nowrap muted">{formatRelative(drive.lastSeenAt)}</td>
                </tr>
              ))}
            </Table>
          </Card>
        )}

        {(volumes.data?.volumes.length ?? 0) > 0 && (
          <Card flush title="Volumes" description="Filesystem status as Windows reports it">
            <Table headers={['Label', 'Letter', 'Filesystem', '#Size', '#Free', 'Health', 'chkdsk']}>
              {volumes.data!.volumes.map((volume) => {
                const size = volume.sizeBytes ?? 0;
                const free = volume.freeBytes ?? 0;
                const lowSpace = size > 0 && free / size < 0.05;
                return (
                  <tr key={volume.id}>
                    <td>
                      <strong>{volume.label ?? volume.volumeId}</strong>
                    </td>
                    <td>
                      {volume.driveLetter ? (
                        `${volume.driveLetter}:`
                      ) : volume.mountPoints.length > 0 ? (
                        <span className="mono" style={{ fontSize: 12 }} title={volume.mountPoints.join(', ')}>
                          {volume.mountPoints[0]}
                        </span>
                      ) : (
                        <span className="faint" title="No drive letter and no folder mount point — the container cannot reach this volume">
                          not mounted
                        </span>
                      )}
                    </td>
                    <td>{volume.fileSystem ?? '—'}</td>
                    <td className="num">{formatBytes(volume.sizeBytes)}</td>
                    <td className="num" style={lowSpace ? { color: 'var(--warning)' } : undefined}>
                      {formatBytes(volume.freeBytes)}
                    </td>
                    <td>
                      <Badge tone={volume.healthStatus === 'Healthy' ? 'ok' : 'warning'}>
                        {volume.healthStatus ?? 'unknown'}
                      </Badge>
                    </td>
                    <td>
                      {volume.dirty ? (
                        <Badge tone="critical">dirty bit set</Badge>
                      ) : (
                        <span className="faint">clean</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </Table>
          </Card>
        )}

        <PrimoCacheCard latest={primoCache.data?.latest ?? null} />
      </div>
    </>
  );
}

interface PrimoCacheData {
  available: boolean;
  version?: string | null;
  reason?: string | null;
  caches: Array<{
    name: string;
    level?: string | null;
    cacheSizeBytes?: number | null;
    usedBytes?: number | null;
    readHitRate?: number | null;
    writeHitRate?: number | null;
    deferredWriteBytes?: number | null;
  }>;
}

function PrimoCacheCard({
  latest,
}: {
  latest: { collectedAt: string; available: boolean; data: PrimoCacheData | null } | null;
}): JSX.Element {
  return (
    <Card
      title="PrimoCache"
      description={latest ? `Reported ${formatRelative(latest.collectedAt)}` : undefined}
      flush
    >
      {!latest || !latest.available ? (
        <EmptyState title="No PrimoCache statistics">
          {latest?.data?.reason ??
            'RomexSoftware PrimoCache does not expose a documented command-line interface, so the agent reports statistics only when it can find one. Everything else on this page works without it.'}
        </EmptyState>
      ) : (
        <Table headers={['Cache', 'Level', '#Size', '#Used', '#Read hits', '#Write hits', '#Deferred']}>
          {(latest.data?.caches ?? []).map((cache) => (
            <tr key={cache.name}>
              <td>
                <strong>{cache.name}</strong>
              </td>
              <td>{cache.level ?? '—'}</td>
              <td className="num">{formatBytes(cache.cacheSizeBytes)}</td>
              <td className="num">{formatBytes(cache.usedBytes)}</td>
              <td className="num">
                {cache.readHitRate !== null && cache.readHitRate !== undefined
                  ? `${Math.round(cache.readHitRate * 100)}%`
                  : '—'}
              </td>
              <td className="num">
                {cache.writeHitRate !== null && cache.writeHitRate !== undefined
                  ? `${Math.round(cache.writeHitRate * 100)}%`
                  : '—'}
              </td>
              <td className="num">{formatBytes(cache.deferredWriteBytes)}</td>
            </tr>
          ))}
        </Table>
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
            <Table headers={['ID', 'Attribute', '#Raw', '#Value', '#Worst', '#Threshold', 'Trend', '']}>
              {attributes.map((attribute) => {
                const rule = rulesById.get(attribute.id);
                const raw = attributeRaw(attribute);
                const history = data.history.find((entry) => entry.attributeId === attribute.id);
                const concerning =
                  rule !== undefined && raw !== null && raw > rule.warnAbove;
                return (
                  <tr key={attribute.id}>
                    <td className="mono">{attribute.id}</td>
                    <td>
                      {rule?.name ?? attribute.name ?? `Attribute ${attribute.id}`}
                      {rule && (
                        <div className="faint" style={{ fontSize: 12 }}>
                          {rule.description}
                        </div>
                      )}
                    </td>
                    <td className="num" style={concerning ? { color: 'var(--warning)' } : undefined}>
                      {attribute.rawString ?? raw ?? '—'}
                    </td>
                    <td className="num">{attribute.value ?? '—'}</td>
                    <td className="num">{attribute.worst ?? '—'}</td>
                    <td className="num">{attribute.threshold ?? '—'}</td>
                    <td>
                      <Sparkline
                        points={(history?.points ?? []).map((point) => point.raw)}
                        width={110}
                        height={26}
                        color={concerning ? 'var(--warning)' : 'var(--text-faint)'}
                        fill={false}
                      />
                    </td>
                    <td>{concerning && <Badge tone="warning">watch</Badge>}</td>
                  </tr>
                );
              })}
            </Table>
          )}
        </Card>
      </div>
    </>
  );
}
