import { beforeEach, describe, expect, it } from 'vitest';
import type { AgentReport } from '@sakuradrive/shared';
import { buildAgentReport, createTestContext, type TestContext } from '../test/helpers.js';
import { PerfService } from './perf-service.js';

let ctx: TestContext;
let perf: PerfService;

/**
 * A host with `count` pool disks of one media type, and optionally a standalone disk.
 * Volume GUIDs are `{v0}`, `{v1}`, ...; labels DRIVEPOOL0, DRIVEPOOL1, ...
 */
function hostWithDisks(count: number, options: { media?: string; standalone?: boolean; freeBytes?: number } = {}): AgentReport {
  const base = buildAgentReport();
  const disks = Array.from({ length: count }, (_, i) => i);
  const report: AgentReport = {
    ...base,
    physicalDisks: disks.map((i) => ({
      ...base.physicalDisks[0]!,
      deviceId: `\\\\.\\PHYSICALDRIVE${i}`,
      serialNumber: `SN-${i}`,
      mediaType: options.media ?? 'HDD',
    })),
    smart: [],
    volumes: disks.map((i) => ({
      ...base.volumes[0]!,
      volumeId: `\\\\?\\Volume{v${i}}\\`,
      label: `DRIVEPOOL${i}`,
      driveLetter: null,
      freeBytes: options.freeBytes ?? 4_000_000_000_000,
      physicalDiskIds: [`\\\\.\\PHYSICALDRIVE${i}`],
    })),
    pools: [
      {
        ...base.pools[0]!,
        parts: disks.map((i) => ({
          ...base.pools[0]!.parts[0]!,
          partId: `part-${i}`,
          volumeId: `\\\\?\\Volume{v${i}}\\`,
          volumeLabel: `DRIVEPOOL${i}`,
          physicalDiskId: `\\\\.\\PHYSICALDRIVE${i}`,
        })),
      },
    ],
  };
  if (options.standalone) {
    report.physicalDisks.push({ ...base.physicalDisks[0]!, deviceId: '\\\\.\\PHYSICALDRIVE9', serialNumber: 'SN-SSD', mediaType: 'SSD' });
    report.volumes.push({
      ...base.volumes[0]!,
      volumeId: '\\\\?\\Volume{ssd}\\',
      label: 'SSDCACHE',
      driveLetter: 'S',
      physicalDiskIds: ['\\\\.\\PHYSICALDRIVE9'],
    });
  }
  return report;
}

/** Record one disk result per volume in a run, read speeds as given. */
function runWithReads(runId: number, reads: number[], extra: { latencyMs?: number[] } = {}) {
  reads.forEach((readMBps, i) =>
    perf.record({
      workflowRunId: runId,
      kind: 'disk',
      targetKey: `\\\\?\\Volume{v${i}}\\`,
      targetLabel: `DRIVEPOOL${i}`,
      host: 'NAS-01',
      readMBps,
      writeMBps: 150,
      latencyMs: extra.latencyMs?.[i] ?? 8,
    }),
  );
}

beforeEach(() => {
  ctx = createTestContext();
  perf = new PerfService(ctx.db, ctx.settings, ctx.alerts);
});

const slowAlerts = () => ctx.alerts.list().alerts.filter((alert) => alert.dedupeKey.startsWith('bench:slow:'));

describe('which volumes are benchmarked', () => {
  it('lists disks with a physical disk behind them, with pool and media', () => {
    ctx.agents.ingest(hostWithDisks(3, { standalone: true }));
    const volumes = perf.volumes();
    expect(volumes.map((volume) => volume.label)).toEqual(['DRIVEPOOL0', 'DRIVEPOOL1', 'DRIVEPOOL2', 'SSDCACHE']);
    expect(volumes[0]).toMatchObject({ poolId: '{hdd-pool}', poolName: 'HDD Pool', mediaType: 'hdd' });
    expect(volumes[3]).toMatchObject({ poolId: null, mediaType: 'ssd' });
  });

  /**
   * DrivePool's own drive reports as an ordinary NTFS volume with a letter. Testing it
   * as a disk would test the pool twice and compare it with its own members.
   */
  it('leaves out the pool drive, which has no physical disk of its own', () => {
    const report = hostWithDisks(2);
    report.volumes.push({ ...report.volumes[0]!, volumeId: '\\\\?\\Volume{pool}\\', label: 'POOL', driveLetter: 'P', physicalDiskIds: [] });
    ctx.agents.ingest(report);
    expect(perf.volumes().map((volume) => volume.label)).not.toContain('POOL');
  });

  it('leaves out small system partitions', () => {
    const report = hostWithDisks(1);
    report.volumes.push({ ...report.volumes[0]!, volumeId: '\\\\?\\Volume{efi}\\', label: 'EFI', sizeBytes: 100_000_000 });
    ctx.agents.ingest(report);
    expect(perf.volumes().map((volume) => volume.label)).toEqual(['DRIVEPOOL0']);
  });

  it('marks excluded volumes and does not hand them to the agent', () => {
    ctx.agents.ingest(hostWithDisks(3));
    ctx.settings.update({ perfTest: { excludedVolumeIds: ['\\\\?\\Volume{v1}\\'] } });
    expect(perf.volumes().find((volume) => volume.label === 'DRIVEPOOL1')!.excluded).toBe(true);
    const { targets } = perf.buildTargets();
    expect(targets.filter((target) => target.kind === 'disk').map((target) => target.label)).toEqual(['DRIVEPOOL0', 'DRIVEPOOL2']);
  });

  it('tests the pool through its own drive letter', () => {
    ctx.agents.ingest(hostWithDisks(2));
    const pool = perf.buildTargets().targets.find((target) => target.kind === 'pool');
    expect(pool).toMatchObject({ key: '{hdd-pool}', label: 'HDD Pool', path: 'P:\\' });
  });

  it('can leave the pools out', () => {
    ctx.agents.ingest(hostWithDisks(2));
    ctx.settings.update({ perfTest: { includePools: false } });
    expect(perf.buildTargets().targets.some((target) => target.kind === 'pool')).toBe(false);
  });

  // A benchmark must never be what fills a disk, even for the seconds the file exists.
  it('skips a disk without room for twice the test file and a margin', () => {
    ctx.agents.ingest(hostWithDisks(2, { freeBytes: 2_000_000_000 }));
    const { targets, skipped } = perf.buildTargets();
    expect(targets.filter((target) => target.kind === 'disk')).toEqual([]);
    expect(skipped[0]!.reason).toMatch(/^Not enough free space: 2\.0 GB free, 3\.2 GB needed\.$/);
  });
});

describe('slow disks', () => {
  beforeEach(() => {
    ctx.agents.ingest(hostWithDisks(5));
  });

  it('raises an alert for a disk well below its peers, and only that disk', () => {
    runWithReads(1, [180, 190, 62, 185, 175]);
    expect(perf.evaluateRun(1)).toEqual({ slow: 1, failed: 0 });
    const alerts = slowAlerts();
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.title).toBe('DRIVEPOOL2: slow in the latest benchmark');
    expect(alerts[0]!.detail).toBe('Read 62 MB/s against a median of 183 MB/s across 4 comparable disks.');
  });

  // A read that may have come from the Windows cache measured memory, not the disk.
  it('does not judge a disk on a read that may have been cached', () => {
    runWithReads(1, [180, 190, 185, 175]);
    perf.record({
      workflowRunId: 1, kind: 'disk', targetKey: '\\\\?\\Volume{v4}\\', targetLabel: 'DRIVEPOOL4',
      host: 'NAS-01', readMBps: 40, writeMBps: 150, latencyMs: 8, readMayBeCached: true,
    });
    perf.evaluateRun(1);
    expect(slowAlerts()).toEqual([]);
  });

  it('clears the alert once the disk measures normally again', () => {
    runWithReads(1, [180, 190, 62, 185, 175]);
    perf.evaluateRun(1);
    runWithReads(2, [180, 190, 178, 185, 175]);
    perf.evaluateRun(2);
    expect(slowAlerts()).toEqual([]);
  });

  /**
   * An SSD next to spinning disks is fast, not a problem, and the spinning disks are
   * not slow next to it. Peers are the same pool on the same media only.
   */
  it('does not compare disks of different media', () => {
    // Three spinning disks and two SSDs in one pool. Mixed together, the SSDs drag the
    // median to ~1,100 MB/s and every spinning disk looks catastrophically slow.
    const report = hostWithDisks(5);
    report.physicalDisks[3] = { ...report.physicalDisks[3]!, mediaType: 'SSD' };
    report.physicalDisks[4] = { ...report.physicalDisks[4]!, mediaType: 'SSD' };
    ctx.agents.ingest(report);
    runWithReads(1, [180, 190, 185, 2_000, 2_100]);
    perf.evaluateRun(1);
    expect(slowAlerts()).toEqual([]);
  });

  it('compares a disk with its own history when it has no peers', () => {
    ctx.agents.ingest(hostWithDisks(5, { standalone: true }));
    const ssd = (runId: number, readMBps: number) =>
      perf.record({ workflowRunId: runId, kind: 'disk', targetKey: '\\\\?\\Volume{ssd}\\', targetLabel: 'SSDCACHE', host: 'NAS-01', readMBps, latencyMs: 0.2 });
    ssd(1, 520);
    ssd(2, 510);
    ssd(3, 200);
    perf.evaluateRun(3);
    expect(slowAlerts().map((alert) => alert.detail)).toEqual(['Read 200 MB/s against 515 MB/s over its last 2 benchmarks.']);
  });

  it('raises a failure alert for a target that errored, and clears it when it next succeeds', () => {
    perf.record({ workflowRunId: 1, kind: 'disk', targetKey: '\\\\?\\Volume{v0}\\', targetLabel: 'DRIVEPOOL0', host: 'NAS-01', error: 'Access is denied.' });
    expect(perf.evaluateRun(1).failed).toBe(1);
    const failure = ctx.alerts.byKey('bench:error:\\\\?\\Volume{v0}\\');
    expect(failure).toMatchObject({ title: 'DRIVEPOOL0: benchmark failed', detail: 'Access is denied.' });

    runWithReads(2, [180, 190, 178, 185, 175]);
    perf.evaluateRun(2);
    expect(ctx.alerts.byKey('bench:error:\\\\?\\Volume{v0}\\')!.state).toBe('resolved');
  });

  // A disk the run did not reach -- the window closed first -- is not declared fine.
  it('leaves a disk the run did not measure alone', () => {
    runWithReads(1, [180, 190, 62, 185, 175]);
    perf.evaluateRun(1);
    // Run 2 measured only the first two disks.
    runWithReads(2, [180, 190]);
    perf.evaluateRun(2);
    expect(slowAlerts()).toHaveLength(1);
  });

  it('shows the same verdict in the overview as the alert', () => {
    runWithReads(1, [180, 190, 62, 185, 175]);
    const overview = perf.overview(null);
    const row = overview.disks.find((disk) => disk.label === 'DRIVEPOOL2')!;
    expect(row.slowness.map((finding) => finding.detail)).toEqual([
      'Read 62 MB/s against a median of 183 MB/s across 4 comparable disks.',
    ]);
    expect(row.peerMedianReadMBps).toBe(182.5);
    expect(row.peers).toBe(4);
    expect(overview.disks.find((disk) => disk.label === 'DRIVEPOOL0')!.slowness).toEqual([]);
  });
});

describe('cache coverage', () => {
  const primo = (targetVolumes: string[]) => ({
    available: true,
    caches: [{ name: 'HDD cache', targetVolumes, volumeStats: [] }],
  });

  it('flags pool members no PrimoCache task fronts', () => {
    ctx.agents.ingest({ ...hostWithDisks(3), primoCache: primo(['DRIVEPOOL0', 'DRIVEPOOL2']) as AgentReport['primoCache'] });
    perf.syncCacheCoverage();
    const alerts = ctx.alerts.list().alerts.filter((alert) => alert.dedupeKey.startsWith('bench:uncached:'));
    expect(alerts.map((alert) => alert.title)).toEqual(['DRIVEPOOL1: not fronted by PrimoCache']);
    expect(perf.overview(null).disks.map((disk) => disk.cached)).toEqual([true, false, true]);
  });

  it('clears the alert once the volume is added to a cache task', () => {
    ctx.agents.ingest({ ...hostWithDisks(3), primoCache: primo(['DRIVEPOOL0']) as AgentReport['primoCache'] });
    perf.syncCacheCoverage();
    ctx.agents.ingest({ ...hostWithDisks(3), primoCache: primo(['DRIVEPOOL0', 'DRIVEPOOL1', 'DRIVEPOOL2']) as AgentReport['primoCache'] });
    perf.syncCacheCoverage();
    expect(ctx.alerts.list().alerts.filter((alert) => alert.dedupeKey.startsWith('bench:uncached:'))).toEqual([]);
  });

  // PrimoCache not reporting -- its window open stops rxpcc -- is blind, not fine.
  it('neither raises nor clears anything while PrimoCache is not reporting', () => {
    ctx.agents.ingest({ ...hostWithDisks(3), primoCache: primo(['DRIVEPOOL0']) as AgentReport['primoCache'] });
    perf.syncCacheCoverage();
    ctx.agents.ingest({ ...hostWithDisks(3), primoCache: { available: false, caches: [] } as unknown as AgentReport['primoCache'] });
    perf.syncCacheCoverage();
    expect(ctx.alerts.list().alerts.filter((alert) => alert.dedupeKey.startsWith('bench:uncached:'))).toHaveLength(2);
    expect(perf.cacheCoverage().available).toBe(false);
  });

  it('leaves excluded volumes out of the check', () => {
    ctx.agents.ingest({ ...hostWithDisks(3), primoCache: primo(['DRIVEPOOL0', 'DRIVEPOOL2']) as AgentReport['primoCache'] });
    ctx.settings.update({ perfTest: { excludedVolumeIds: ['\\\\?\\Volume{v1}\\'] } });
    perf.syncCacheCoverage();
    expect(ctx.alerts.list().alerts.filter((alert) => alert.dedupeKey.startsWith('bench:uncached:'))).toEqual([]);
  });

  it('can be switched off, which clears what it raised', () => {
    ctx.agents.ingest({ ...hostWithDisks(3), primoCache: primo(['DRIVEPOOL0']) as AgentReport['primoCache'] });
    perf.syncCacheCoverage();
    ctx.settings.update({ perfTest: { checkCacheCoverage: false } });
    perf.syncCacheCoverage();
    expect(ctx.alerts.list().alerts.filter((alert) => alert.dedupeKey.startsWith('bench:uncached:'))).toEqual([]);
  });
});

describe('network results', () => {
  it('keeps the latest result per client and share', () => {
    const submit = (client: string, readMBps: number) =>
      perf.recordNetwork({ client, platform: 'win32', share: '\\\\tokyo-3\\Tier1', bytesTested: 1, writeMBps: 100, readMBps, readMayBeCached: false, clientVersion: '1' });
    submit('laptop', 80);
    submit('laptop', 110);
    submit('desktop', 115);
    const latest = perf.latest('network');
    expect(latest.map((result) => [result.host, result.readMBps])).toEqual([
      ['desktop', 115],
      ['laptop', 110],
    ]);
  });
});
