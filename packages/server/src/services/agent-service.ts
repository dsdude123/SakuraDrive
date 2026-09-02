import {
  DEFAULT_ATTRIBUTE_RULES,
  attributeRaw,
  deviceKey,
  evaluatePerformance,
  evaluateSmart,
  evaluateVolume,
  maxSeverity,
  normalizeRelPath,
  type AgentReport,
  type AgentSummary,
  type DriveSummary,
  type PerformanceSample,
  type PoolSummary,
  type Severity,
  type SmartAttributeRule,
  type SmartFinding,
  type SmartReport,
  type VolumeSummary,
} from '@sakuradrive/shared';
import { fromDbBool, fromJson, nowIso, toDbBool, toJson, type Db } from '../db/index.js';
import type { Logger } from '../logger.js';
import type { AlertService } from './alert-service.js';
import type { RootDetectionService } from './root-detection.js';
import type { SettingsService } from './settings-service.js';

/** A health finding plus the alert bookkeeping the ingest path needs. */
interface AgentFinding {
  finding: SmartFinding;
  dedupeKey: string;
  category: 'smart' | 'volume' | 'performance';
  context: Record<string, unknown>;
}

export interface AgentServiceOptions {
  db: Db;
  settings: SettingsService;
  alerts: AlertService;
  logger: Logger;
  detection?: RootDetectionService;
}

interface DriveRow {
  id: number;
  device_key: string;
  device_id: string | null;
  serial_number: string | null;
  model: string | null;
  firmware: string | null;
  size_bytes: number | null;
  media_type: string | null;
  bus_type: string | null;
  hostname: string | null;
  labels: string;
  drive_letters: string;
  health_status: string | null;
  operational_status: string | null;
  overall_health_passed: number | null;
  temperature_c: number | null;
  power_on_hours: number | null;
  severity: string | null;
  last_seen_at: string;
}

/**
 * Ingests reports from the Windows agent.
 *
 * Everything the container cannot see for itself arrives here: SMART data, volume
 * labels (which is how a failed disk is identified as `DRIVEPOOL27` rather than
 * `\\.\PHYSICALDRIVE7`), DrivePool pool membership and duplication settings, disk
 * performance counters and PrimoCache statistics.
 */
export class AgentService {
  private readonly db: Db;
  private readonly settings: SettingsService;
  private readonly alerts: AlertService;
  private readonly logger: Logger;
  /** Adopts the pool as catalog roots on a fresh install. Absent in tests that do not care. */
  private readonly detection: RootDetectionService | null;

  constructor(options: AgentServiceOptions) {
    this.db = options.db;
    this.settings = options.settings;
    this.alerts = options.alerts;
    this.logger = options.logger;
    this.detection = options.detection ?? null;
  }

  /** Store a report and evaluate every health rule it makes possible. */
  ingest(report: AgentReport): { agentId: number; alertsRaised: number; warnings: string[] } {
    const receivedAt = nowIso();
    const warnings: string[] = [];

    const agentId = this.upsertAgent(report, receivedAt);
    const driveIds = this.upsertDrives(report, receivedAt);
    this.upsertVolumes(report, receivedAt, driveIds);
    this.upsertPools(report, receivedAt, driveIds);
    const smartFindings = this.storeSmart(report, receivedAt, driveIds);
    // Performance samples must land before they are evaluated: the sustained-latency
    // rule looks at the last N stored samples, including the one just reported.
    this.storePerformance(report, receivedAt, driveIds);
    if (this.settings.get().performance.enabled) {
      smartFindings.push(...this.evaluatePerformanceHistory(report, driveIds));
    }
    this.storePrimoCache(report, receivedAt);
    if (this.settings.get().duplication.acceptAgentRules) {
      this.syncDuplicationRules(report);
    }

    // The first report is the moment everything needed to configure the catalog exists:
    // the agent has just said which pools there are and which disks are in them. On a
    // fresh install there is nothing to lose by acting on that, and the alternative is
    // an operator adding a root per disk by hand from exactly this data.
    const adopted = this.detection?.adoptIfUnconfigured();
    if (adopted) {
      this.logger.info(
        { roots: adopted.added.length },
        'adopted catalog roots from the pool the agent reported',
      );
      warnings.push(
        `Configured ${adopted.added.length} catalog root${adopted.added.length === 1 ? '' : 's'} ` +
          'from the pool members you reported. Review them under Settings then Catalog roots.',
      );
    }

    const activeKeys = new Set<string>();
    let raised = 0;
    for (const { finding, dedupeKey, context, category } of smartFindings) {
      activeKeys.add(dedupeKey);
      const result = this.alerts.raise({
        dedupeKey,
        category,
        severity: finding.severity,
        title: finding.title,
        detail: finding.detail,
        context,
      });
      if (result.isNew || result.escalated) raised += 1;
    }

    // Anything previously reported for an entity *this report covered* and no longer
    // present has cleared — a replaced cable, a cooled-down drive, a chkdsk that ran.
    //
    // Reconciliation is scoped per entity on purpose. Clearing the whole category
    // would mean that a poll where smartctl failed to read one drive silently resolved
    // that drive's real alerts, which is the worst thing a monitor can do: report a
    // failing disk as healthy because it could not see it.
    for (const [category, prefix] of this.reconcileScopes(report)) {
      this.alerts.reconcile(category, activeKeys, prefix);
    }

    this.checkPoolParts(report);
    for (const error of report.errors) {
      warnings.push(`${error.collector}: ${error.message}`);
    }

    return { agentId, alertsRaised: raised, warnings };
  }

  private upsertAgent(report: AgentReport, receivedAt: string): number {
    this.db
      .prepare(
        `INSERT INTO agents (hostname, agent_version, distribution_version, protocol_version, first_seen_at, last_report_at, report_count, last_errors)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?)
         ON CONFLICT(hostname) DO UPDATE SET
           agent_version = excluded.agent_version,
           distribution_version = excluded.distribution_version,
           protocol_version = excluded.protocol_version,
           last_report_at = excluded.last_report_at,
           report_count = agents.report_count + 1,
           last_errors = excluded.last_errors`,
      )
      .run(
        report.hostname,
        report.agentVersion,
        // Absent from an agent older than the distribution endpoints, and from any
        // caller that skipped the schema. Neither is a reason to drop a report.
        report.distributionVersion ?? '',
        report.protocolVersion,
        receivedAt,
        receivedAt,
        toJson(report.errors),
      );
    const row = this.db
      .prepare<[string], { id: number }>('SELECT id FROM agents WHERE hostname = ?')
      .get(report.hostname);
    return row?.id ?? 0;
  }

  /** Returns a map of `deviceKey` -> drives.id for the disks in this report. */
  private upsertDrives(report: AgentReport, receivedAt: string): Map<string, number> {
    const ids = new Map<string, number>();
    // Volume labels are the operator-facing identity of a disk, so attach them here.
    const labelsByDevice = new Map<string, Set<string>>();
    const lettersByDevice = new Map<string, Set<string>>();
    for (const volume of report.volumes) {
      for (const deviceId of volume.physicalDiskIds) {
        if (volume.label) {
          const set = labelsByDevice.get(deviceId) ?? new Set<string>();
          set.add(volume.label);
          labelsByDevice.set(deviceId, set);
        }
        if (volume.driveLetter) {
          const set = lettersByDevice.get(deviceId) ?? new Set<string>();
          set.add(volume.driveLetter);
          lettersByDevice.set(deviceId, set);
        }
      }
    }

    const upsert = this.db.prepare(
      `INSERT INTO drives
         (device_key, device_id, serial_number, model, firmware, size_bytes, media_type, bus_type,
          physical_location, hostname, labels, drive_letters, health_status, operational_status,
          temperature_c, first_seen_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(device_key) DO UPDATE SET
         device_id = excluded.device_id,
         serial_number = COALESCE(excluded.serial_number, drives.serial_number),
         model = COALESCE(excluded.model, drives.model),
         firmware = COALESCE(excluded.firmware, drives.firmware),
         size_bytes = COALESCE(excluded.size_bytes, drives.size_bytes),
         media_type = COALESCE(excluded.media_type, drives.media_type),
         bus_type = COALESCE(excluded.bus_type, drives.bus_type),
         physical_location = COALESCE(excluded.physical_location, drives.physical_location),
         hostname = excluded.hostname,
         labels = excluded.labels,
         drive_letters = excluded.drive_letters,
         health_status = excluded.health_status,
         operational_status = excluded.operational_status,
         temperature_c = COALESCE(excluded.temperature_c, drives.temperature_c),
         last_seen_at = excluded.last_seen_at,
         retired_at = NULL`,
    );

    this.db.transaction(() => {
      for (const disk of report.physicalDisks) {
        const key = deviceKey(disk);
        upsert.run(
          key,
          disk.deviceId,
          disk.serialNumber ?? null,
          disk.model ?? disk.friendlyName ?? null,
          disk.firmwareVersion ?? null,
          disk.sizeBytes ?? null,
          disk.mediaType ?? null,
          disk.busType ?? null,
          disk.physicalLocation ?? null,
          report.hostname,
          toJson([...(labelsByDevice.get(disk.deviceId) ?? [])]),
          toJson([...(lettersByDevice.get(disk.deviceId) ?? [])]),
          disk.healthStatus ?? null,
          disk.operationalStatus ?? null,
          disk.temperatureC ?? null,
          receivedAt,
          receivedAt,
        );
      }
    })();

    for (const disk of report.physicalDisks) {
      const key = deviceKey(disk);
      const row = this.db
        .prepare<[string], { id: number }>('SELECT id FROM drives WHERE device_key = ?')
        .get(key);
      if (row) ids.set(key, row.id);
    }
    return ids;
  }

  private upsertVolumes(
    report: AgentReport,
    receivedAt: string,
    driveIds: Map<string, number>,
  ): void {
    const deviceKeyById = new Map<string, string>();
    for (const disk of report.physicalDisks) deviceKeyById.set(disk.deviceId, deviceKey(disk));

    const upsert = this.db.prepare(
      `INSERT INTO volumes
         (volume_id, label, drive_letter, path, file_system, size_bytes, free_bytes,
          health_status, operational_status, dirty, device_keys, mount_points, hostname, first_seen_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(volume_id) DO UPDATE SET
         label = excluded.label,
         drive_letter = excluded.drive_letter,
         path = excluded.path,
         file_system = excluded.file_system,
         size_bytes = excluded.size_bytes,
         free_bytes = excluded.free_bytes,
         health_status = excluded.health_status,
         operational_status = excluded.operational_status,
         dirty = excluded.dirty,
         device_keys = excluded.device_keys,
         mount_points = excluded.mount_points,
         hostname = excluded.hostname,
         last_seen_at = excluded.last_seen_at`,
    );

    this.db.transaction(() => {
      for (const volume of report.volumes) {
        const keys = volume.physicalDiskIds
          .map((id) => deviceKeyById.get(id))
          .filter((key): key is string => !!key && driveIds.has(key));
        upsert.run(
          volume.volumeId,
          volume.label ?? null,
          volume.driveLetter ?? null,
          volume.path ?? null,
          volume.fileSystem ?? null,
          volume.sizeBytes ?? null,
          volume.freeBytes ?? null,
          volume.healthStatus ?? null,
          volume.operationalStatus ?? null,
          toDbBool(volume.dirty ?? null),
          toJson(keys),
          toJson(volume.mountPoints),
          report.hostname,
          receivedAt,
          receivedAt,
        );
      }
    })();
  }

  private upsertPools(report: AgentReport, receivedAt: string, driveIds: Map<string, number>): void {
    const deviceKeyById = new Map<string, string>();
    for (const disk of report.physicalDisks) deviceKeyById.set(disk.deviceId, deviceKey(disk));

    const upsertPool = this.db.prepare(
      `INSERT INTO pools (pool_id, name, drive_letter, size_bytes, free_bytes, duplicated_bytes, unduplicated_bytes, first_seen_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(pool_id) DO UPDATE SET
         name = excluded.name, drive_letter = excluded.drive_letter,
         size_bytes = excluded.size_bytes, free_bytes = excluded.free_bytes,
         duplicated_bytes = excluded.duplicated_bytes,
         unduplicated_bytes = excluded.unduplicated_bytes,
         last_seen_at = excluded.last_seen_at`,
    );
    const upsertPart = this.db.prepare(
      `INSERT INTO pool_parts (pool_id, part_id, name, volume_id, volume_label, drive_letter, path,
                               size_bytes, free_bytes, used_bytes, device_key, missing, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(pool_id, part_id) DO UPDATE SET
         name = excluded.name, volume_id = excluded.volume_id, volume_label = excluded.volume_label,
         drive_letter = excluded.drive_letter, path = excluded.path,
         size_bytes = excluded.size_bytes, free_bytes = excluded.free_bytes,
         used_bytes = excluded.used_bytes, device_key = excluded.device_key,
         missing = excluded.missing, last_seen_at = excluded.last_seen_at`,
    );

    this.db.transaction(() => {
      for (const pool of report.pools) {
        upsertPool.run(
          pool.poolId,
          pool.name ?? null,
          pool.driveLetter ?? null,
          pool.sizeBytes ?? null,
          pool.freeBytes ?? null,
          pool.duplicatedBytes ?? null,
          pool.unduplicatedBytes ?? null,
          receivedAt,
          receivedAt,
        );
        for (const part of pool.parts) {
          const key = part.physicalDiskId ? deviceKeyById.get(part.physicalDiskId) : null;
          upsertPart.run(
            pool.poolId,
            part.partId,
            part.name ?? null,
            part.volumeId ?? null,
            part.volumeLabel ?? null,
            part.driveLetter ?? null,
            part.path ?? null,
            part.sizeBytes ?? null,
            part.freeBytes ?? null,
            part.usedBytes ?? null,
            key && driveIds.has(key) ? key : (key ?? null),
            toDbBool(part.missing ?? false) ?? 0,
            receivedAt,
          );
        }
      }
    })();
  }

  /** Store SMART snapshots and return the findings they produce. */
  private storeSmart(
    report: AgentReport,
    receivedAt: string,
    driveIds: Map<string, number>,
  ): AgentFinding[] {
    const settings = this.settings.get();
    const rules = mergeAttributeRules(settings.smart.attributeOverrides);
    const out: AgentFinding[] = [];

    const insertSnapshot = this.db.prepare(
      `INSERT INTO smart_snapshots
         (drive_id, collected_at, received_at, source, overall_health_passed, temperature_c,
          power_on_hours, power_cycles, attributes_json, nvme_json, self_test_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertHistory = this.db.prepare(
      'INSERT INTO smart_attribute_history (drive_id, attribute_id, collected_at, raw, value) VALUES (?, ?, ?, ?, ?)',
    );

    for (const smart of report.smart) {
      const key = deviceKey(smart);
      const driveId = driveIds.get(key) ?? this.findDriveIdByAnyKey(smart);
      if (!driveId) {
        this.logger.debug({ key }, 'SMART report for an unknown drive');
        continue;
      }

      const previous = this.latestSmart(driveId);

      this.db.transaction(() => {
        insertSnapshot.run(
          driveId,
          smart.rawJson ? report.collectedAt : report.collectedAt,
          receivedAt,
          smart.source,
          toDbBool(smart.overallHealthPassed ?? null),
          smart.temperatureC ?? null,
          smart.powerOnHours ?? null,
          smart.powerCycles ?? null,
          toJson(smart.attributes),
          smart.nvme ? toJson(smart.nvme) : null,
          smart.selfTest ? toJson(smart.selfTest) : null,
        );
        // Only record attributes whose raw value actually moved.
        for (const attribute of smart.attributes) {
          const raw = attributeRaw(attribute);
          if (raw === null) continue;
          const previousRaw = previous ? attributeRaw(findAttr(previous.attributes, attribute.id)) : null;
          if (previousRaw !== null && previousRaw === raw) continue;
          insertHistory.run(driveId, attribute.id, report.collectedAt, raw, attribute.value ?? null);
        }
        this.db
          .prepare(
            `UPDATE drives SET overall_health_passed = ?, temperature_c = COALESCE(?, temperature_c),
                               power_on_hours = COALESCE(?, power_on_hours),
                               power_cycles = COALESCE(?, power_cycles)
              WHERE id = ?`,
          )
          .run(
            toDbBool(smart.overallHealthPassed ?? null),
            smart.temperatureC ?? null,
            smart.powerOnHours ?? null,
            smart.powerCycles ?? null,
            driveId,
          );
      })();

      const label = this.driveLabel(driveId);
      const findings = evaluateSmart({
        report: smart,
        previous,
        label,
        thresholds: {
          temperatureWarnC: settings.smart.temperatureWarnC,
          temperatureCritC: settings.smart.temperatureCritC,
          nvmeWearWarnPercent: settings.smart.nvmeWearWarnPercent,
          nvmeWearCritPercent: settings.smart.nvmeWearCritPercent,
          attributes: rules,
        },
      });

      let worst: Severity | null = null;
      for (const finding of findings) {
        worst = worst ? maxSeverity(worst, finding.severity) : finding.severity;
        out.push({
          finding,
          dedupeKey: `smart:${key}:${finding.key}`,
          category: 'smart',
          context: {
            drive: label ?? key,
            serial: smart.serialNumber ?? '',
            model: smart.model ?? '',
            deviceId: smart.deviceId,
            attribute: finding.attributeId ?? '',
            value: finding.value ?? '',
          },
        });
      }
      this.db.prepare('UPDATE drives SET severity = ? WHERE id = ?').run(worst, driveId);
    }

    // Volume-level checks (dirty bit, health, free space).
    for (const volume of report.volumes) {
      const findings = evaluateVolume({
        label: volume.label,
        driveLetter: volume.driveLetter,
        healthStatus: volume.healthStatus,
        operationalStatus: volume.operationalStatus,
        dirty: volume.dirty,
        sizeBytes: volume.sizeBytes,
        freeBytes: volume.freeBytes,
      });
      for (const finding of findings) {
        out.push({
          finding,
          dedupeKey: `volume:${volume.volumeId}:${finding.key}`,
          category: 'volume',
          context: {
            volume: volume.label ?? volume.volumeId,
            driveLetter: volume.driveLetter ?? '',
            fileSystem: volume.fileSystem ?? '',
          },
        });
      }
    }

    return out;
  }

  private evaluatePerformanceHistory(report: AgentReport, driveIds: Map<string, number>) {
    const settings = this.settings.get().performance;
    const deviceKeyById = new Map<string, string>();
    for (const disk of report.physicalDisks) deviceKeyById.set(disk.deviceId, deviceKey(disk));

    const out: AgentFinding[] = [];

    const seen = new Set<number>();
    for (const sample of report.performance) {
      const key = sample.deviceId ? deviceKeyById.get(sample.deviceId) : undefined;
      const driveId = key ? driveIds.get(key) : undefined;
      if (!driveId || seen.has(driveId)) continue;
      seen.add(driveId);

      const history = this.db
        .prepare<[number, number], { read_latency_ms: number | null; write_latency_ms: number | null; queue_length: number | null }>(
          `SELECT read_latency_ms, write_latency_ms, queue_length FROM performance_samples
            WHERE drive_id = ? ORDER BY id DESC LIMIT ?`,
        )
        .all(driveId, settings.consecutiveSamples)
        .reverse();

      const label = this.driveLabel(driveId) ?? key ?? String(driveId);
      const findings = evaluatePerformance(
        history.map((row) => ({
          readLatencyMs: row.read_latency_ms,
          writeLatencyMs: row.write_latency_ms,
          queueLength: row.queue_length,
        })),
        label,
        settings,
      );
      for (const finding of findings) {
        out.push({
          finding,
          dedupeKey: `perf:${key}:${finding.key}`,
          category: 'performance',
          context: { drive: label, instance: sample.instance },
        });
      }
    }
    return out;
  }

  private storePerformance(
    report: AgentReport,
    receivedAt: string,
    driveIds: Map<string, number>,
  ): void {
    if (report.performance.length === 0) return;
    const deviceKeyById = new Map<string, string>();
    for (const disk of report.physicalDisks) deviceKeyById.set(disk.deviceId, deviceKey(disk));

    const insert = this.db.prepare(
      `INSERT INTO performance_samples
         (drive_id, instance, collected_at, read_latency_ms, write_latency_ms, queue_length, read_bps, write_bps, busy_percent)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.db.transaction(() => {
      for (const sample of report.performance) {
        const key = sample.deviceId ? deviceKeyById.get(sample.deviceId) : undefined;
        insert.run(
          key ? (driveIds.get(key) ?? null) : null,
          sample.instance,
          report.collectedAt || receivedAt,
          sample.readLatencyMs ?? null,
          sample.writeLatencyMs ?? null,
          sample.queueLength ?? null,
          sample.readBytesPerSec ?? null,
          sample.writeBytesPerSec ?? null,
          sample.busyPercent ?? (sample.idlePercent !== null && sample.idlePercent !== undefined
            ? 100 - sample.idlePercent
            : null),
        );
      }
    })();
  }

  private storePrimoCache(report: AgentReport, receivedAt: string): void {
    if (!report.primoCache) return;
    this.db
      .prepare(
        'INSERT INTO primocache_samples (hostname, collected_at, available, json) VALUES (?, ?, ?, ?)',
      )
      .run(
        report.hostname,
        report.collectedAt || receivedAt,
        toDbBool(report.primoCache.available) ?? 0,
        toJson(report.primoCache),
      );
  }

  /**
   * Mirror DrivePool's own duplication settings into the rule list so the storage view
   * and the DR report use the real configuration rather than a guess.
   */
  private syncDuplicationRules(report: AgentReport): void {
    if (report.duplication.length === 0) return;
    const settings = this.settings.get();
    const manual = settings.duplication.rules.filter((rule) => rule.source === 'manual');
    const fromAgent = report.duplication.map((entry, index) => ({
      id: `dp_${entry.poolId ?? 'pool'}_${index}_${normalizeRelPath(entry.path).replace(/[^a-z0-9]+/gi, '_').slice(0, 40)}`,
      poolId: entry.poolId ?? null,
      path: normalizeRelPath(entry.path),
      level: entry.level,
      source: 'drivepool' as const,
      note: 'Reported by dpcmd',
    }));
    this.settings.update({ duplication: { rules: [...manual, ...fromAgent] } });
  }

  /**
   * Which alert keys this report is entitled to clear.
   *
   * One scope per drive that produced a SMART reading, per volume that was reported,
   * and per drive that produced a performance sample. An entity missing from the
   * report keeps whatever alerts it already had.
   */
  private reconcileScopes(report: AgentReport): Array<['smart' | 'volume' | 'performance', string]> {
    const scopes: Array<['smart' | 'volume' | 'performance', string]> = [];
    const deviceKeyById = new Map<string, string>();
    for (const disk of report.physicalDisks) deviceKeyById.set(disk.deviceId, deviceKey(disk));

    for (const smart of report.smart) {
      scopes.push(['smart', `smart:${deviceKey(smart)}:`]);
    }
    for (const volume of report.volumes) {
      scopes.push(['volume', `volume:${volume.volumeId}:`]);
    }
    if (this.settings.get().performance.enabled) {
      for (const sample of report.performance) {
        const key = sample.deviceId ? deviceKeyById.get(sample.deviceId) : undefined;
        if (key) scopes.push(['performance', `perf:${key}:`]);
      }
    }
    return scopes;
  }

  /** A pool part DrivePool reports as missing means a disk has dropped out. */
  private checkPoolParts(report: AgentReport): void {
    const active = new Set<string>();
    for (const pool of report.pools) {
      for (const part of pool.parts) {
        const dedupeKey = `pool:${pool.poolId}:${part.partId}:missing`;
        if (part.missing) {
          active.add(dedupeKey);
          this.alerts.raise({
            dedupeKey,
            category: 'pool',
            severity: 'critical',
            title: `${pool.name ?? pool.poolId}: pool part ${part.volumeLabel ?? part.partId} is missing`,
            detail:
              'StableBit DrivePool cannot see this disk. Unduplicated files that lived on it are unavailable — check the Disaster Recovery report for exactly which ones.',
            context: {
              pool: pool.name ?? pool.poolId,
              part: part.volumeLabel ?? part.partId,
              driveLetter: part.driveLetter ?? '',
            },
          });
        }
      }
    }
    // Same reasoning: only clear missing-part alerts for pools this report described.
    for (const pool of report.pools) {
      this.alerts.reconcile('pool', active, `pool:${pool.poolId}:`);
    }
  }

  /** Raise an alert for any agent that has stopped reporting. */
  checkAgentFreshness(): void {
    const staleMinutes = this.settings.get().smart.agentStaleMinutes;
    const rows = this.db
      .prepare<[], { hostname: string; last_report_at: string | null }>(
        'SELECT hostname, last_report_at FROM agents',
      )
      .all();
    const active = new Set<string>();
    for (const row of rows) {
      const dedupeKey = `agent:${row.hostname}:stale`;
      const ageMinutes = row.last_report_at
        ? (Date.now() - Date.parse(row.last_report_at)) / 60_000
        : Number.POSITIVE_INFINITY;
      if (ageMinutes > staleMinutes) {
        active.add(dedupeKey);
        this.alerts.raise({
          dedupeKey,
          category: 'agent',
          severity: 'warning',
          title: `Agent on ${row.hostname} has stopped reporting`,
          detail: `No report received for ${
            Number.isFinite(ageMinutes) ? `${Math.round(ageMinutes)} minutes` : 'a long time'
          }. SMART monitoring is blind until it comes back — check the scheduled task on the host.`,
          context: { hostname: row.hostname, lastReportAt: row.last_report_at ?? 'never' },
        });
      }
    }
    this.alerts.reconcile('agent', active);
  }

  /* ------------------------------------------------------------- queries */

  listDrives(): DriveSummary[] {
    const rows = this.db
      .prepare<[], DriveRow & { size_used_bytes: number | null; size_free_bytes: number | null }>(
        `SELECT d.*,
                (SELECT SUM(v.size_bytes) FROM volumes v WHERE v.device_keys LIKE '%' || d.device_key || '%') AS size_used_bytes,
                (SELECT SUM(v.free_bytes) FROM volumes v WHERE v.device_keys LIKE '%' || d.device_key || '%') AS size_free_bytes
           FROM drives d
          WHERE d.retired_at IS NULL
          ORDER BY d.media_type, d.model, d.serial_number`,
      )
      .all();

    const alertCounts = new Map<string, number>();
    for (const row of this.db
      .prepare<[], { dedupe_key: string }>(
        `SELECT dedupe_key FROM alerts WHERE state != 'resolved' AND category IN ('smart','performance')`,
      )
      .all()) {
      const key = row.dedupe_key.split(':').slice(1, 3).join(':');
      alertCounts.set(key, (alertCounts.get(key) ?? 0) + 1);
    }

    const poolsByDevice = new Map<string, string[]>();
    for (const row of this.db
      .prepare<[], { device_key: string | null; name: string | null; pool_id: string }>(
        'SELECT pp.device_key, p.name, pp.pool_id FROM pool_parts pp LEFT JOIN pools p ON p.pool_id = pp.pool_id',
      )
      .all()) {
      if (!row.device_key) continue;
      const list = poolsByDevice.get(row.device_key) ?? [];
      list.push(row.name ?? row.pool_id);
      poolsByDevice.set(row.device_key, list);
    }

    return rows.map((row) => ({
      id: row.id,
      deviceKey: row.device_key,
      deviceId: row.device_id ?? '',
      serialNumber: row.serial_number,
      model: row.model,
      firmware: row.firmware,
      sizeBytes: row.size_bytes,
      mediaType: row.media_type,
      busType: row.bus_type,
      labels: fromJson<string[]>(row.labels, []),
      driveLetters: fromJson<string[]>(row.drive_letters, []),
      poolNames: poolsByDevice.get(row.device_key) ?? [],
      temperatureC: row.temperature_c,
      powerOnHours: row.power_on_hours,
      healthStatus: row.health_status,
      overallHealthPassed: fromDbBool(row.overall_health_passed),
      severity: (row.severity as Severity | null) ?? null,
      openAlertCount: alertCounts.get(row.device_key) ?? 0,
      lastSeenAt: row.last_seen_at,
      hostname: row.hostname,
      sizeUsedBytes:
        row.size_used_bytes !== null && row.size_free_bytes !== null
          ? row.size_used_bytes - row.size_free_bytes
          : null,
      sizeFreeBytes: row.size_free_bytes,
    }));
  }

  driveDetail(id: number): {
    drive: DriveSummary | null;
    latestSmart: SmartReport | null;
    history: Array<{ attributeId: number; points: Array<{ at: string; raw: number | null }> }>;
    performance: Array<{ at: string; readLatencyMs: number | null; writeLatencyMs: number | null; queueLength: number | null }>;
  } {
    const drive = this.listDrives().find((candidate) => candidate.id === id) ?? null;
    const latest = this.latestSmart(id);
    const history = this.db
      .prepare<[number], { attribute_id: number; collected_at: string; raw: number | null }>(
        `SELECT attribute_id, collected_at, raw FROM smart_attribute_history
          WHERE drive_id = ? ORDER BY attribute_id, collected_at`,
      )
      .all(id);
    const grouped = new Map<number, Array<{ at: string; raw: number | null }>>();
    for (const row of history) {
      const list = grouped.get(row.attribute_id) ?? [];
      list.push({ at: row.collected_at, raw: row.raw });
      grouped.set(row.attribute_id, list);
    }
    const performance = this.db
      .prepare<[number], { collected_at: string; read_latency_ms: number | null; write_latency_ms: number | null; queue_length: number | null }>(
        `SELECT collected_at, read_latency_ms, write_latency_ms, queue_length
           FROM performance_samples WHERE drive_id = ? ORDER BY collected_at DESC LIMIT 500`,
      )
      .all(id)
      .reverse();

    return {
      drive,
      latestSmart: latest,
      history: [...grouped.entries()].map(([attributeId, points]) => ({ attributeId, points })),
      performance: performance.map((row) => ({
        at: row.collected_at,
        readLatencyMs: row.read_latency_ms,
        writeLatencyMs: row.write_latency_ms,
        queueLength: row.queue_length,
      })),
    };
  }

  listVolumes(): VolumeSummary[] {
    return this.db
      .prepare<[], {
        id: number; volume_id: string; label: string | null; drive_letter: string | null;
        file_system: string | null; size_bytes: number | null; free_bytes: number | null;
        health_status: string | null; operational_status: string | null; dirty: number | null;
        device_keys: string; mount_points: string; last_seen_at: string;
      }>('SELECT * FROM volumes ORDER BY drive_letter, label')
      .all()
      .map((row) => ({
        id: row.id,
        volumeId: row.volume_id,
        label: row.label,
        driveLetter: row.drive_letter,
        fileSystem: row.file_system,
        sizeBytes: row.size_bytes,
        freeBytes: row.free_bytes,
        healthStatus: row.health_status,
        operationalStatus: row.operational_status,
        dirty: fromDbBool(row.dirty),
        deviceKeys: fromJson<string[]>(row.device_keys, []),
        mountPoints: fromJson<string[]>(row.mount_points, []),
        lastSeenAt: row.last_seen_at,
      }));
  }

  listPools(): PoolSummary[] {
    const pools = this.db
      .prepare<[], {
        id: number; pool_id: string; name: string | null; drive_letter: string | null;
        size_bytes: number | null; free_bytes: number | null; duplicated_bytes: number | null;
        unduplicated_bytes: number | null; last_seen_at: string;
      }>('SELECT * FROM pools ORDER BY name')
      .all();
    const parts = this.db
      .prepare<[], {
        pool_id: string; part_id: string; name: string | null; volume_label: string | null;
        drive_letter: string | null; size_bytes: number | null; free_bytes: number | null;
        used_bytes: number | null; device_key: string | null; missing: number;
      }>('SELECT * FROM pool_parts ORDER BY volume_label')
      .all();

    return pools.map((pool) => ({
      id: pool.id,
      poolId: pool.pool_id,
      name: pool.name,
      driveLetter: pool.drive_letter,
      sizeBytes: pool.size_bytes,
      freeBytes: pool.free_bytes,
      duplicatedBytes: pool.duplicated_bytes,
      unduplicatedBytes: pool.unduplicated_bytes,
      lastSeenAt: pool.last_seen_at,
      parts: parts
        .filter((part) => part.pool_id === pool.pool_id)
        .map((part) => ({
          partId: part.part_id,
          name: part.name,
          volumeLabel: part.volume_label,
          driveLetter: part.drive_letter,
          sizeBytes: part.size_bytes,
          freeBytes: part.free_bytes,
          usedBytes: part.used_bytes,
          deviceKey: part.device_key,
          missing: part.missing !== 0,
        })),
    }));
  }

  listAgents(): AgentSummary[] {
    const staleMinutes = this.settings.get().smart.agentStaleMinutes;
    return this.db
      .prepare<[], {
        id: number; hostname: string; agent_version: string; distribution_version: string;
        protocol_version: number;
        last_report_at: string | null; report_count: number; last_errors: string;
      }>('SELECT * FROM agents ORDER BY hostname')
      .all()
      .map((row) => {
        const ageSeconds = row.last_report_at
          ? Math.round((Date.now() - Date.parse(row.last_report_at)) / 1000)
          : null;
        return {
          id: row.id,
          hostname: row.hostname,
          agentVersion: row.agent_version,
          distributionVersion: row.distribution_version,
          protocolVersion: row.protocol_version,
          lastReportAt: row.last_report_at,
          lastReportAgeSeconds: ageSeconds,
          online: ageSeconds !== null && ageSeconds < staleMinutes * 60,
          reportCount: row.report_count,
          lastErrors: fromJson<Array<{ collector: string; message: string }>>(row.last_errors, []),
        };
      });
  }

  latestPrimoCache(): { collectedAt: string; available: boolean; data: unknown } | null {
    const row = this.db
      .prepare<[], { collected_at: string; available: number; json: string }>(
        'SELECT collected_at, available, json FROM primocache_samples ORDER BY id DESC LIMIT 1',
      )
      .get();
    if (!row) return null;
    return {
      collectedAt: row.collected_at,
      available: row.available !== 0,
      data: fromJson<unknown>(row.json, null),
    };
  }

  /** Drop time-series rows past their retention window. */
  prune(): { smart: number; performance: number; primoCache: number } {
    const general = this.settings.get().general;
    const smartCutoff = new Date(Date.now() - general.smartHistoryDays * 86_400_000).toISOString();
    const perfCutoff = new Date(
      Date.now() - general.performanceHistoryDays * 86_400_000,
    ).toISOString();
    return {
      smart:
        this.db.prepare('DELETE FROM smart_snapshots WHERE collected_at < ?').run(smartCutoff)
          .changes +
        this.db
          .prepare('DELETE FROM smart_attribute_history WHERE collected_at < ?')
          .run(smartCutoff).changes,
      performance: this.db
        .prepare('DELETE FROM performance_samples WHERE collected_at < ?')
        .run(perfCutoff).changes,
      primoCache: this.db
        .prepare('DELETE FROM primocache_samples WHERE collected_at < ?')
        .run(perfCutoff).changes,
    };
  }

  /* ------------------------------------------------------------ internals */

  private latestSmart(driveId: number): SmartReport | null {
    const row = this.db
      .prepare<[number], {
        source: string; overall_health_passed: number | null; temperature_c: number | null;
        power_on_hours: number | null; power_cycles: number | null;
        attributes_json: string; nvme_json: string | null; self_test_json: string | null;
        collected_at: string;
      }>('SELECT * FROM smart_snapshots WHERE drive_id = ? ORDER BY id DESC LIMIT 1')
      .get(driveId);
    if (!row) return null;
    return {
      deviceId: '',
      serialNumber: null,
      model: null,
      firmware: null,
      source: row.source as SmartReport['source'],
      smartSupported: null,
      smartEnabled: null,
      overallHealthPassed: fromDbBool(row.overall_health_passed),
      temperatureC: row.temperature_c,
      powerOnHours: row.power_on_hours,
      powerCycles: row.power_cycles,
      rotationRate: null,
      protocol: null,
      attributes: fromJson<SmartReport['attributes']>(row.attributes_json, []),
      nvme: fromJson<SmartReport['nvme']>(row.nvme_json, null),
      selfTest: fromJson<SmartReport['selfTest']>(row.self_test_json, null),
      rawJson: null,
    };
  }

  private findDriveIdByAnyKey(smart: { serialNumber?: string | null; deviceId?: string | null }): number | null {
    const row = this.db
      .prepare<[string, string], { id: number }>(
        'SELECT id FROM drives WHERE device_key = ? OR device_id = ? LIMIT 1',
      )
      .get(deviceKey(smart), smart.deviceId ?? '');
    return row?.id ?? null;
  }

  /** The label an operator would read off the caddy, falling back to model/serial. */
  private driveLabel(driveId: number): string | null {
    const row = this.db
      .prepare<[number], { labels: string; model: string | null; serial_number: string | null }>(
        'SELECT labels, model, serial_number FROM drives WHERE id = ?',
      )
      .get(driveId);
    if (!row) return null;
    const labels = fromJson<string[]>(row.labels, []);
    if (labels.length > 0) return labels.join(', ');
    return row.model ?? row.serial_number ?? null;
  }
}

function findAttr(attributes: SmartReport['attributes'], id: number) {
  return attributes.find((attribute) => attribute.id === id);
}

/** Apply the operator's per-attribute overrides on top of the built-in rules. */
export function mergeAttributeRules(
  overrides: Array<{
    id: number;
    warnAbove: number;
    critAbove: number;
    increaseSeverity: Severity | null;
    enabled: boolean;
  }>,
): SmartAttributeRule[] {
  const byId = new Map(DEFAULT_ATTRIBUTE_RULES.map((rule) => [rule.id, { ...rule }]));
  for (const override of overrides) {
    if (!override.enabled) {
      byId.delete(override.id);
      continue;
    }
    const base = byId.get(override.id) ?? {
      id: override.id,
      name: `Attribute ${override.id}`,
      warnAbove: override.warnAbove,
      critAbove: override.critAbove,
      increaseSeverity: override.increaseSeverity,
      description: 'Custom threshold.',
    };
    byId.set(override.id, {
      ...base,
      warnAbove: override.warnAbove,
      critAbove: override.critAbove,
      increaseSeverity: override.increaseSeverity,
    });
  }
  return [...byId.values()];
}

export type { PerformanceSample };
