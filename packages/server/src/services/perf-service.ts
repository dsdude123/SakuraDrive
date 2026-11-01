import {
  type NetworkPerfSubmission,
  type PerfDiskRow,
  type PerfKind,
  type PerfMeasurement,
  type PerfOverview,
  type PerfResult,
  type PerfSlowness,
  type PerfTarget,
} from '@sakuradrive/shared';
import type { Db } from '../db/index.js';
import type { AlertService } from './alert-service.js';
import { assessDisk, median, uncoveredVolumes, type DiskFigures } from './perf-analysis.js';
import type { SettingsService } from './settings-service.js';


/**
 * Active benchmarks: where the results live, what gets tested, and what counts as slow.
 *
 * The agent and the network client measure; the container measures its own storage.
 * Everything that turns those numbers into an opinion -- which disks to compare, what
 * counts as slow, whether every pool member goes through the cache -- is here, once.
 */

const GiB = 1024 ** 3;
/** Smaller than this is a system or recovery partition, not a disk worth benchmarking. */
const MIN_VOLUME_BYTES = 8 * GiB;
/** A volume not reported for this long is gone, or its disk is; nothing to test. */
const STALE_VOLUME_MS = 2 * 86_400_000;
/** Earlier results a disk is compared with. */
const HISTORY_DEPTH = 5;
/** Read figures shown as a trend per disk. */
const TREND_DEPTH = 8;

interface ResultRow {
  id: number;
  workflow_run_id: number | null;
  kind: string;
  target_key: string;
  target_label: string;
  host: string;
  bytes_tested: number;
  write_mbps: number | null;
  read_mbps: number | null;
  latency_ms: number | null;
  latency_p95_ms: number | null;
  read_may_be_cached: number;
  skipped: string | null;
  error: string | null;
  details_json: string;
  measured_at: string;
}

function toResult(row: ResultRow): PerfResult {
  let details: Record<string, unknown> = {};
  try {
    details = JSON.parse(row.details_json) as Record<string, unknown>;
  } catch {
    // A row written by hand or by an older version; the figures still stand.
  }
  return {
    id: row.id,
    kind: row.kind as PerfKind,
    targetKey: row.target_key,
    targetLabel: row.target_label,
    host: row.host,
    bytesTested: row.bytes_tested,
    writeMBps: row.write_mbps,
    readMBps: row.read_mbps,
    latencyMs: row.latency_ms,
    latencyP95Ms: row.latency_p95_ms,
    readMayBeCached: row.read_may_be_cached !== 0,
    skipped: row.skipped,
    error: row.error,
    details,
    measuredAt: row.measured_at,
  };
}

export interface RecordInput {
  workflowRunId?: number | null;
  kind: PerfKind;
  targetKey: string;
  targetLabel: string;
  host: string;
  bytesTested?: number;
  writeMBps?: number | null;
  readMBps?: number | null;
  latencyMs?: number | null;
  latencyP95Ms?: number | null;
  readMayBeCached?: boolean;
  skipped?: string | null;
  error?: string | null;
  details?: Record<string, unknown>;
  measuredAt?: string;
}

/** A volume as far as benchmarking is concerned. */
export interface PerfVolume {
  volumeId: string;
  label: string | null;
  driveLetter: string | null;
  sizeBytes: number | null;
  freeBytes: number | null;
  poolId: string | null;
  poolName: string | null;
  mediaType: string | null;
  excluded: boolean;
}

/**
 * The figures a comparison may use.
 *
 * A read the agent could not take past the Windows cache measured memory, not the disk,
 * and two of those compared say nothing; so it is left out rather than trusted.
 */
const figures = (result: Pick<PerfResult, 'readMBps' | 'writeMBps' | 'latencyMs' | 'readMayBeCached'>): DiskFigures => ({
  readMBps: result.readMayBeCached ? null : result.readMBps,
  writeMBps: result.writeMBps,
  latencyMs: result.readMayBeCached ? null : result.latencyMs,
});

const usable = (result: PerfResult) => !result.error && !result.skipped;

export class PerfService {
  constructor(
    private readonly db: Db,
    private readonly settings: SettingsService,
    private readonly alerts: AlertService,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /* --------------------------------------------------------------- storage */

  record(input: RecordInput): PerfResult {
    const id = this.db
      .prepare(
        `INSERT INTO perf_results
           (workflow_run_id, kind, target_key, target_label, host, bytes_tested, write_mbps,
            read_mbps, latency_ms, latency_p95_ms, read_may_be_cached, skipped, error,
            details_json, measured_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.workflowRunId ?? null,
        input.kind,
        input.targetKey,
        input.targetLabel,
        input.host,
        Math.round(input.bytesTested ?? 0),
        input.writeMBps ?? null,
        input.readMBps ?? null,
        input.latencyMs ?? null,
        input.latencyP95Ms ?? null,
        input.readMayBeCached ? 1 : 0,
        input.skipped ?? null,
        input.error ?? null,
        JSON.stringify(input.details ?? {}),
        input.measuredAt ?? this.now().toISOString(),
      ).lastInsertRowid;
    return this.byId(Number(id))!;
  }

  byId(id: number): PerfResult | null {
    const row = this.db.prepare<[number], ResultRow>('SELECT * FROM perf_results WHERE id = ?').get(id);
    return row ? toResult(row) : null;
  }

  /** What the agent measured, labelled with the targets it was handed. */
  recordAgentMeasurements(
    workflowRunId: number | null,
    host: string,
    targets: readonly PerfTarget[],
    measurements: readonly PerfMeasurement[],
  ): number {
    const labels = new Map(targets.map((target) => [target.key, target.label]));
    for (const measurement of measurements) {
      this.record({
        workflowRunId,
        kind: measurement.kind,
        targetKey: measurement.key,
        targetLabel: labels.get(measurement.key) ?? measurement.key,
        host,
        bytesTested: measurement.bytesTested,
        writeMBps: measurement.writeMBps ?? null,
        readMBps: measurement.readMBps ?? null,
        latencyMs: measurement.latencyMs ?? null,
        latencyP95Ms: measurement.latencyP95Ms ?? null,
        readMayBeCached: measurement.readMayBeCached,
        skipped: measurement.skipped ?? null,
        error: measurement.error ?? null,
      });
    }
    return measurements.length;
  }

  recordNetwork(submission: NetworkPerfSubmission): PerfResult {
    return this.record({
      kind: 'network',
      targetKey: submission.share,
      targetLabel: submission.share,
      host: submission.client,
      bytesTested: submission.bytesTested,
      writeMBps: submission.writeMBps ?? null,
      readMBps: submission.readMBps ?? null,
      latencyMs: submission.latencyMs ?? null,
      latencyP95Ms: submission.latencyP95Ms ?? null,
      readMayBeCached: submission.readMayBeCached,
      error: submission.error ?? null,
      details: { platform: submission.platform, clientVersion: submission.clientVersion },
    });
  }

  /** Results recorded by one workflow run. */
  forRun(workflowRunId: number, kind?: PerfKind): PerfResult[] {
    return this.db
      .prepare<[number], ResultRow>('SELECT * FROM perf_results WHERE workflow_run_id = ? ORDER BY id')
      .all(workflowRunId)
      .map(toResult)
      .filter((result) => !kind || result.kind === kind);
  }

  /** The newest result for each target of a kind; per client too, for network tests. */
  latest(kind: PerfKind): PerfResult[] {
    const groupBy = kind === 'network' ? 'host, target_key' : 'target_key';
    return this.db
      .prepare<[string, string], ResultRow>(
        `SELECT * FROM perf_results WHERE id IN (
           SELECT MAX(id) FROM perf_results WHERE kind = ? GROUP BY ${groupBy}
         ) AND kind = ? ORDER BY target_label, host`,
      )
      .all(kind, kind)
      .map(toResult);
  }

  /** A target's earlier usable results, newest first. */
  private history(kind: PerfKind, key: string, beforeId: number, limit: number): PerfResult[] {
    return this.db
      .prepare<[string, string, number, number], ResultRow>(
        `SELECT * FROM perf_results
          WHERE kind = ? AND target_key = ? AND id < ? AND error IS NULL AND skipped IS NULL
          ORDER BY id DESC LIMIT ?`,
      )
      .all(kind, key, beforeId, limit)
      .map(toResult);
  }

  /* ------------------------------------------------------------- inventory */

  /**
   * Every volume backed by a physical disk, with what the comparisons need.
   *
   * The pool's own drive reports as an ordinary NTFS volume with a letter, so it is told
   * apart by having no physical disk behind it and by carrying a pool's letter. It is
   * tested as a pool, through that letter, not as a disk.
   */
  volumes(): PerfVolume[] {
    const excluded = new Set(this.settings.get().perfTest.excludedVolumeIds);
    const poolLetters = new Set(
      this.db
        .prepare<[], { drive_letter: string | null }>('SELECT drive_letter FROM pools')
        .all()
        .map((row) => row.drive_letter?.toUpperCase())
        .filter(Boolean),
    );
    const membership = new Map<string, { poolId: string; poolName: string | null }>();
    for (const row of this.db
      .prepare<[], { volume_id: string | null; pool_id: string; name: string | null }>(
        `SELECT p.volume_id, p.pool_id, pools.name
           FROM pool_parts p LEFT JOIN pools ON pools.pool_id = p.pool_id
          WHERE p.volume_id IS NOT NULL AND p.volume_id != ''`,
      )
      .all()) {
      membership.set(row.volume_id!, { poolId: row.pool_id, poolName: row.name });
    }
    const media = new Map(
      this.db
        .prepare<[], { device_key: string; media_type: string | null }>(
          'SELECT device_key, media_type FROM drives WHERE retired_at IS NULL',
        )
        .all()
        .map((row) => [row.device_key, row.media_type]),
    );

    const cutoff = this.now().getTime() - STALE_VOLUME_MS;
    return this.db
      .prepare<[], {
        volume_id: string; label: string | null; drive_letter: string | null; file_system: string | null;
        size_bytes: number | null; free_bytes: number | null; device_keys: string; last_seen_at: string;
      }>(
        `SELECT volume_id, label, drive_letter, file_system, size_bytes, free_bytes, device_keys, last_seen_at
           FROM volumes ORDER BY label, drive_letter`,
      )
      .all()
      .filter((row) => {
        let keys: string[] = [];
        try {
          keys = JSON.parse(row.device_keys) as string[];
        } catch {
          keys = [];
        }
        if (keys.length === 0) return false;
        if (row.drive_letter && poolLetters.has(row.drive_letter.toUpperCase())) return false;
        if (!row.file_system) return false;
        if ((row.size_bytes ?? 0) < MIN_VOLUME_BYTES) return false;
        return Date.parse(row.last_seen_at) >= cutoff;
      })
      .map((row) => {
        const keys = JSON.parse(row.device_keys) as string[];
        const pool = membership.get(row.volume_id);
        return {
          volumeId: row.volume_id,
          label: row.label,
          driveLetter: row.drive_letter,
          sizeBytes: row.size_bytes,
          freeBytes: row.free_bytes,
          poolId: pool?.poolId ?? null,
          poolName: pool?.poolName ?? null,
          mediaType: normalizeMedia(keys.map((key) => media.get(key)).find(Boolean) ?? null),
          excluded: excluded.has(row.volume_id),
        };
      });
  }

  /**
   * What the agent should test this run, and what it should not and why.
   *
   * A target needs twice the test file free plus a margin: a benchmark must never be the
   * thing that fills a disk, even for the seconds the file exists.
   */
  buildTargets(): { targets: PerfTarget[]; skipped: Array<PerfTarget & { reason: string }> } {
    const config = this.settings.get().perfTest;
    const testBytes = config.diskTestSizeMB * 1024 * 1024;
    const needed = testBytes * 2 + GiB;
    const targets: PerfTarget[] = [];
    const skipped: Array<PerfTarget & { reason: string }> = [];

    const consider = (target: PerfTarget, free: number | null) => {
      if (free !== null && free < needed) {
        skipped.push({
          ...target,
          reason: `Not enough free space: ${formatGB(free)} free, ${formatGB(needed)} needed.`,
        });
      } else {
        targets.push(target);
      }
    };

    for (const volume of this.volumes()) {
      if (volume.excluded) continue;
      consider(
        {
          key: volume.volumeId,
          label: volume.label ?? (volume.driveLetter ? `${volume.driveLetter}:` : volume.volumeId),
          kind: 'disk',
          path: volume.volumeId,
        },
        volume.freeBytes,
      );
    }

    if (config.includePools) {
      for (const pool of this.db
        .prepare<[], { pool_id: string; name: string | null; drive_letter: string | null; free_bytes: number | null }>(
          'SELECT pool_id, name, drive_letter, free_bytes FROM pools ORDER BY name',
        )
        .all()) {
        if (!pool.drive_letter) continue;
        const letter = pool.drive_letter.replace(/[:\\]/g, '').toUpperCase();
        consider(
          { key: pool.pool_id, label: pool.name ?? `${letter}:`, kind: 'pool', path: `${letter}:\\` },
          pool.free_bytes,
        );
      }
    }

    return { targets, skipped };
  }

  /* -------------------------------------------------------------- analysis */

  /** Why a disk result counts as slow, judged against its run and its own past. */
  private slownessOf(
    result: PerfResult,
    runResults: readonly PerfResult[],
    volumesById: ReadonlyMap<string, PerfVolume>,
  ): { slowness: PerfSlowness[]; peerMedianReadMBps: number | null; peers: number } {
    const slowFraction = this.settings.get().perfTest.slowFraction;
    const self = volumesById.get(result.targetKey);
    // Peers only within a pool: the disks in it are bought to match and do the same job.
    // Standalone disks are too unlike each other to compare, so they get history only.
    const peers =
      self?.poolId
        ? runResults.filter((other) => {
            if (other.id === result.id || other.kind !== 'disk' || !usable(other)) return false;
            const volume = volumesById.get(other.targetKey);
            return volume?.poolId === self.poolId && volume.mediaType === self.mediaType;
          })
        : [];
    const history = this.history('disk', result.targetKey, result.id, HISTORY_DEPTH);
    const slowness = usable(result)
      ? assessDisk({
          current: figures(result),
          peers: peers.map(figures),
          history: history.map(figures),
          slowFraction,
        })
      : [];
    const reads = peers.map((peer) => figures(peer).readMBps).filter((value): value is number => value !== null);
    return {
      slowness,
      peerMedianReadMBps: reads.length >= 2 ? median(reads) : null,
      peers: peers.length,
    };
  }

  /**
   * Raise or clear the slow-disk and failed-test alerts for one run.
   *
   * Only targets this run actually measured are touched. One the run did not reach --
   * the window closed first -- keeps whatever it had, rather than being declared fine
   * for want of a measurement.
   */
  evaluateRun(workflowRunId: number): { slow: number; failed: number } {
    const results = this.forRun(workflowRunId).filter((result) => result.kind === 'disk' || result.kind === 'pool');
    const volumesById = new Map(this.volumes().map((volume) => [volume.volumeId, volume]));
    let slow = 0;
    let failed = 0;

    for (const result of results) {
      const errorKey = `bench:error:${result.targetKey}`;
      if (result.error) {
        failed += 1;
        this.alerts.raise({
          dedupeKey: errorKey,
          category: 'performance',
          severity: 'warning',
          title: `${result.targetLabel}: benchmark failed`,
          detail: result.error,
          context: { target: result.targetLabel, kind: result.kind },
        });
        continue;
      }
      this.alerts.resolve(errorKey);

      if (result.kind !== 'disk' || result.skipped) continue;
      const slowKey = `bench:slow:${result.targetKey}`;
      const { slowness } = this.slownessOf(result, results, volumesById);
      if (slowness.length === 0) {
        this.alerts.resolve(slowKey);
        continue;
      }
      slow += 1;
      this.alerts.raise({
        dedupeKey: slowKey,
        category: 'performance',
        severity: 'warning',
        title: `${result.targetLabel}: slow in the latest benchmark`,
        detail: slowness.map((finding) => finding.detail).join(' '),
        context: {
          disk: result.targetLabel,
          readMBps: round1(result.readMBps),
          writeMBps: round1(result.writeMBps),
          latencyMs: round1(result.latencyMs),
        },
      });
    }
    return { slow, failed };
  }

  /* --------------------------------------------------------- cache coverage */

  /**
   * Pool members that no PrimoCache task fronts.
   *
   * "Available" is false when PrimoCache is not reporting -- not installed, or its
   * window open, which stops `rxpcc` -- and then nothing is claimed either way.
   */
  cacheCoverage(): PerfOverview['cacheCoverage'] {
    const row = this.db
      .prepare<[], { available: number; json: string }>(
        'SELECT available, json FROM primocache_samples ORDER BY id DESC LIMIT 1',
      )
      .get();
    if (!row || row.available === 0) return { available: false, uncovered: [] };
    let caches: Array<{ targetVolumes?: string[]; volumeStats?: Array<{ label?: string | null }> }> = [];
    try {
      caches = (JSON.parse(row.json) as { caches?: typeof caches }).caches ?? [];
    } catch {
      caches = [];
    }
    if (caches.length === 0) return { available: false, uncovered: [] };

    const members = this.volumes().filter((volume) => volume.poolId && !volume.excluded);
    return {
      available: true,
      uncovered: uncoveredVolumes(members, caches).map((volume) => ({
        volumeId: volume.volumeId,
        label: volume.label ?? volume.volumeId,
      })),
    };
  }

  /** Raise an alert per uncovered pool member; clear the rest. Called on every report. */
  syncCacheCoverage(): void {
    if (!this.settings.get().perfTest.checkCacheCoverage) {
      this.alerts.reconcile('performance', [], 'bench:uncached:');
      return;
    }
    const coverage = this.cacheCoverage();
    // Blind is not the same as fine: with PrimoCache not reporting, leave alerts as they are.
    if (!coverage.available) return;
    const active: string[] = [];
    for (const volume of coverage.uncovered) {
      const dedupeKey = `bench:uncached:${volume.volumeId}`;
      active.push(dedupeKey);
      this.alerts.raise({
        dedupeKey,
        category: 'performance',
        severity: 'warning',
        title: `${volume.label}: not fronted by PrimoCache`,
        detail: 'No PrimoCache task lists this pool member as a target volume.',
        context: { volume: volume.label },
      });
    }
    this.alerts.reconcile('performance', active, 'bench:uncached:');
  }

  /* -------------------------------------------------------------- overview */

  overview(lastRunAt: string | null): PerfOverview {
    const config = this.settings.get().perfTest;
    const volumes = this.volumes();
    const volumesById = new Map(volumes.map((volume) => [volume.volumeId, volume]));
    const latestDisk = new Map(this.latest('disk').map((result) => [result.targetKey, result]));
    const coverage = this.cacheCoverage();
    const uncovered = new Set(coverage.uncovered.map((volume) => volume.volumeId));
    const runCache = new Map<number, PerfResult[]>();

    const disks: PerfDiskRow[] = volumes.map((volume) => {
      const latest = latestDisk.get(volume.volumeId) ?? null;
      let assessment = { slowness: [] as PerfSlowness[], peerMedianReadMBps: null as number | null, peers: 0 };
      if (latest) {
        const runId = this.runOf(latest.id);
        let runResults: PerfResult[] = [latest];
        if (runId) {
          if (!runCache.has(runId)) runCache.set(runId, this.forRun(runId, 'disk'));
          runResults = runCache.get(runId)!;
        }
        assessment = this.slownessOf(latest, runResults, volumesById);
      }
      const trend = this.db
        .prepare<[string], { read_mbps: number | null }>(
          `SELECT read_mbps FROM perf_results WHERE kind = 'disk' AND target_key = ?
             AND error IS NULL AND skipped IS NULL ORDER BY id DESC LIMIT ${TREND_DEPTH}`,
        )
        .all(volume.volumeId)
        .map((row) => row.read_mbps)
        .reverse();
      return {
        volumeId: volume.volumeId,
        label: volume.label,
        driveLetter: volume.driveLetter,
        poolId: volume.poolId,
        poolName: volume.poolName,
        mediaType: volume.mediaType,
        excluded: volume.excluded,
        cached: coverage.available && volume.poolId ? !uncovered.has(volume.volumeId) : null,
        latest,
        history: trend,
        peerMedianReadMBps: assessment.peerMedianReadMBps,
        peers: assessment.peers,
        slowness: assessment.slowness,
      };
    });

    const nextDueAt =
      config.enabled && lastRunAt
        ? new Date(Date.parse(lastRunAt) + config.intervalDays * 86_400_000).toISOString()
        : null;

    return {
      enabled: config.enabled,
      lastRunAt,
      nextDueAt,
      disks,
      pools: this.latest('pool'),
      network: this.latest('network'),
      wsl: this.latest('wsl'),
      cacheCoverage: coverage,
    };
  }

  private runOf(resultId: number): number | null {
    return (
      this.db
        .prepare<[number], { workflow_run_id: number | null }>('SELECT workflow_run_id FROM perf_results WHERE id = ?')
        .get(resultId)?.workflow_run_id ?? null
    );
  }
}

function normalizeMedia(value: string | null): string {
  const text = (value ?? '').trim().toLowerCase();
  if (text.includes('ssd') || text === '4') return 'ssd';
  if (text.includes('hdd') || text === '3') return 'hdd';
  return 'unknown';
}

const round1 = (value: number | null) => (value === null ? '' : Math.round(value * 10) / 10);

function formatGB(bytes: number): string {
  return `${(bytes / 1e9).toFixed(1)} GB`;
}

