/**
 * Application settings.
 *
 * Everything the operator can tune lives here and is edited from the UI — the Docker
 * container itself only needs a data volume, the bind mounts for the pools and a port.
 * The schema is the single source of truth: the server validates writes against it,
 * the UI builds forms from it and the export/import bundle carries it verbatim.
 */

import { z } from 'zod';
import { defaultSchedule, normalizeSchedule } from './schedule.js';

export const HASH_ALGORITHMS = ['sha256', 'sha1', 'md5', 'blake2b512'] as const;
export type HashAlgorithm = (typeof HASH_ALGORITHMS)[number];

export const scanRootSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  /**
   * `pool`     — the DrivePool virtual drive; the logical view of the data.
   * `poolpart` — one underlying disk's `PoolPart.*` folder; tells us which physical
   *              disk holds each file, which is what makes the DR report possible.
   * `disk`     — any other volume, e.g. the standalone PrimoCache SSD.
   */
  kind: z.enum(['pool', 'poolpart', 'disk']).default('pool'),
  /** Groups `poolpart` roots with their `pool` root. */
  poolId: z.string().nullable().default(null),
  /**
   * Which agent reads this root. Blank means the only agent reporting.
   *
   * Every root is read by the agent. The container has no path to most of these
   * volumes and never will: WSL2 only surfaces lettered drives, and it will not follow
   * a folder mount point into another volume. Rather than let that decide how the host
   * may be laid out -- or spend drive letters on it -- the reading happens on the
   * Windows side, where every volume is addressable by GUID path whether or not it has
   * a letter, and where the reads are native rather than through drvfs.
   */
  agentHostname: z.string().default(''),
  /**
   * The Windows path the agent walks.
   *
   * A volume GUID path is the normal case and the whole point:
   * `\\?\Volume{9f3a...}\PoolPart.{d304fce8...}` needs no drive letter, no mount
   * point and no bind mount. `dpcmd list-poolparts` prints exactly these, and the agent
   * reports them with every poll, so the interface can offer them rather than ask
   * anyone to type a GUID.
   */
  hostPath: z.string().min(1),
  /** Volume label of the underlying disk, e.g. `DRIVEPOOL27`. */
  driveLabel: z.string().default(''),
  enabled: z.boolean().default(true),
  /** When false the root is catalogued but never hashed (e.g. a scratch disk). */
  hashEnabled: z.boolean().default(true),
  includeGlobs: z.array(z.string()).default([]),
  excludeGlobs: z.array(z.string()).default([]),
  /** Skip files smaller/larger than these when hashing. 0 disables the bound. */
  minHashSizeBytes: z.number().int().nonnegative().default(0),
  maxHashSizeBytes: z.number().int().nonnegative().default(0),
});
export type ScanRoot = z.infer<typeof scanRootSchema>;

export const duplicationRuleSchema = z.object({
  id: z.string().min(1),
  poolId: z.string().nullable().default(null),
  /** Pool-relative folder path; empty string sets the pool default. */
  path: z.string().default(''),
  level: z.number().int().min(1).max(10).default(1),
  source: z.enum(['drivepool', 'manual']).default('manual'),
  note: z.string().default(''),
});
export type DuplicationRuleSetting = z.infer<typeof duplicationRuleSchema>;

export const backupExpectationSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  enabled: z.boolean().default(true),
  /** Catalog root whose files this rule covers. */
  rootId: z.string().min(1),
  /** Only files matching these globs are expected in the backup. Empty = everything. */
  includeGlobs: z.array(z.string()).default([]),
  excludeGlobs: z.array(z.string()).default([]),
  /** Kopia source path this root maps to, e.g. `SERVER\\user:P:\\Media`. */
  kopiaSource: z.string().default(''),
  /**
   * Leading folder of *our* paths that is not in the snapshot, because the Kopia source
   * starts deeper than the catalog root: source `J:\Tier1` against a root catalogued
   * from `J:\` needs `Tier1` here. Files outside it are not expected in this snapshot.
   */
  kopiaPathPrefix: z.string().default(''),
  /**
   * The mirror image: a leading folder present in the *snapshot* but not in our paths,
   * because the Kopia source starts higher than the catalog root. Snapshotting a whole
   * pool member disk (`D:`) needs `PoolPart.*` here, since the catalog strips that
   * folder from a pool part's paths. A trailing `*` is resolved against the snapshot,
   * so the pool GUID does not have to be copied into the configuration.
   */
  kopiaSnapshotPrefix: z.string().default(''),
  /** Files smaller than this are not expected to be backed up. */
  minFileSizeBytes: z.number().int().nonnegative().default(0),
  /** Flag a backed-up file as stale when the snapshot copy is older than this. */
  maxSnapshotAgeHours: z.number().int().nonnegative().default(24 * 8),
});
export type BackupExpectation = z.infer<typeof backupExpectationSchema>;

export const exportDestinationSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  /** Directory inside the container, normally a bind mount that is itself backed up. */
  path: z.string().min(1),
  enabled: z.boolean().default(true),
  /** Keep this many bundles here; older ones are pruned after a successful write. */
  retain: z.number().int().min(1).max(365).default(14),
});
export type ExportDestination = z.infer<typeof exportDestinationSchema>;

export const smartThresholdSettingsSchema = z.object({
  temperatureWarnC: z.number().default(50),
  temperatureCritC: z.number().default(60),
  nvmeWearWarnPercent: z.number().default(85),
  nvmeWearCritPercent: z.number().default(95),
  agentStaleMinutes: z.number().int().min(5).default(60),
  /** Per-attribute overrides, keyed by SMART attribute id. */
  attributeOverrides: z
    .array(
      z.object({
        id: z.number().int(),
        warnAbove: z.number(),
        critAbove: z.number(),
        increaseSeverity: z.enum(['info', 'warning', 'critical']).nullable().default(null),
        enabled: z.boolean().default(true),
      }),
    )
    .default([]),
});

export const settingsSchema = z.object({
  general: z
    .object({
      siteName: z.string().default('SakuraDrive'),
      /** IANA timezone used for every schedule decision and timestamp in the UI. */
      timezone: z.string().default('UTC'),
      /** Retention for time-series data that would otherwise grow without bound. */
      smartHistoryDays: z.number().int().min(1).default(365),
      performanceHistoryDays: z.number().int().min(1).default(30),
      alertHistoryDays: z.number().int().min(1).default(365),
      /**
       * How long a revoked agent token stays listed before it is deleted. Kept for a
       * while so "was this host still reporting after I revoked it?" is answerable;
       * deleted eventually so the list does not accumulate forever.
       */
      revokedTokenDays: z.number().int().min(1).default(30),
      workflowRunHistory: z.number().int().min(10).default(500),
    })
    .default({}),

  schedule: z
    .object({
      /** 7x24 grid of hours during which heavy I/O workflows may run. */
      heavyIo: z.array(z.string()).default(defaultSchedule()),
      /** Pause a running workflow when its window closes instead of letting it finish. */
      pauseOutsideWindow: z.boolean().default(true),
      /** Resume paused work automatically when the next window opens. */
      autoResume: z.boolean().default(true),
      /** Cap hashing throughput. 0 = unthrottled. */
      maxHashMBps: z.number().min(0).default(0),
      /** Sleep between files, a cheap way to leave headroom for clients. */
      interFileDelayMs: z.number().int().min(0).max(5000).default(0),
      /** Parallel hashing workers. 1 is gentlest on spinning rust. */
      hashConcurrency: z.number().int().min(1).max(16).default(2),
      /** Parallel directory walkers during cataloguing. */
      scanConcurrency: z.number().int().min(1).max(16).default(2),
    })
    .default({}),

  catalog: z
    .object({
      roots: z.array(scanRootSchema).default([]),
      hashAlgorithm: z.enum(HASH_ALGORITHMS).default('sha256'),
      /** Re-hash a file this many days after its last hash to detect silent corruption. */
      rehashIntervalDays: z.number().int().min(0).default(90),
      /** Globs applied to every root in addition to the root's own excludes. */
      globalExcludeGlobs: z
        .array(z.string())
        .default([
          '**/$RECYCLE.BIN/**',
          '**/System Volume Information/**',
          '**/.covefs/**',
          '**/Thumbs.db',
          '**/desktop.ini',
        ]),
      followSymlinks: z.boolean().default(false),
      /** Keep this many catalog scan runs' change records. */
      changeHistoryRuns: z.number().int().min(2).default(50),
      /**
       * Raise a critical alert when a single scan marks more than this share of a
       * root's files as deleted. Catalog rows are only ever soft-deleted, so nothing
       * is lost either way — but a missing bind mount and a dead disk look identical
       * from inside the container and the operator should be told which one it was.
       */
      massDeletionAlertPercent: z.number().min(0).max(100).default(10),
      /** Files written to the catalog per transaction while walking. */
      batchSize: z.number().int().min(50).max(10_000).default(500),
      /**
       * How often the scan workflow checks on a job it handed to the agent. Short
       * enough that a closing I/O window is acted on promptly, long enough not to spin.
       */
      agentPollMs: z.number().int().min(200).max(60_000).default(2_000),
      /**
       * How long a job may sit unclaimed before the scan gives up on it.
       *
       * Without this a scan waits forever for an agent that is not running, and the
       * workflow looks busy while nothing whatsoever is happening -- the worst kind of
       * failure, because it does not look like one. Comfortably longer than the agent's
       * own poll interval.
       */
      agentClaimTimeoutSeconds: z.number().int().min(5).max(86_400).default(1_800),
    })
    .default({}),

  duplication: z
    .object({
      defaultLevel: z.number().int().min(1).max(10).default(1),
      rules: z.array(duplicationRuleSchema).default([]),
      /** Let agent-reported `dpcmd` values create/refresh rules automatically. */
      acceptAgentRules: z.boolean().default(true),
      /** Alert when a file is stored on fewer parts than its rule requires. */
      alertOnUnderDuplication: z.boolean().default(true),
    })
    .default({}),

  smart: smartThresholdSettingsSchema.default({}),

  performance: z
    .object({
      enabled: z.boolean().default(true),
      latencyWarnMs: z.number().default(100),
      latencyCritMs: z.number().default(500),
      queueWarn: z.number().default(8),
      queueCrit: z.number().default(32),
      consecutiveSamples: z.number().int().min(1).max(20).default(3),
    })
    .default({}),

  bitrot: z
    .object({
      enabled: z.boolean().default(true),
      /**
       * A file whose content hash changed while size and mtime stayed identical is the
       * classic bit-rot signature. Some applications rewrite files while preserving
       * mtime, so the tolerance below lets you require an exact mtime match.
       */
      mtimeToleranceMs: z.number().int().min(0).default(0),
      /** Re-read a suspected file immediately to rule out a transient read error. */
      verifyOnDetect: z.boolean().default(true),
      /** Raise one alert per finding rather than a single grouped alert per run. */
      alertPerFile: z.boolean().default(false),
    })
    .default({}),

  backup: z
    .object({
      enabled: z.boolean().default(false),
      /** `kopia` shells out to the bundled CLI; `manifest` imports a file listing. */
      mode: z.enum(['kopia', 'manifest', 'disabled']).default('disabled'),
      kopiaBinary: z.string().default('kopia'),
      /** Repository connection. Only what `kopia repository connect b2` needs. */
      repository: z
        .object({
          type: z.enum(['b2', 'filesystem', 's3', 'existing']).default('b2'),
          bucket: z.string().default(''),
          prefix: z.string().default(''),
          keyId: z.string().default(''),
          key: z.string().default(''),
          endpoint: z.string().default(''),
          path: z.string().default(''),
        })
        .default({}),
      password: z.string().default(''),
      configFile: z.string().default(''),
      /**
       * `manifest` mode reads a plain listing instead of talking to the repository —
       * useful when the container cannot reach Backblaze, or to verify against a
       * listing produced elsewhere (`kopia ls -lr <snapshot> > /data/backup-list.txt`).
       * Accepts NDJSON objects, `size<TAB>mtime<TAB>path` rows, or bare paths.
       */
      manifestPath: z.string().default(''),
      cacheDirectory: z.string().default('/data/kopia-cache'),
      extraArgs: z.array(z.string()).default([]),
      expectations: z.array(backupExpectationSchema).default([]),
      /** How often the backup verification workflow runs itself. */
      verifyIntervalHours: z.number().int().min(1).default(24),
      /** Stop listing after this many entries to bound memory on huge repositories. */
      maxEntriesPerSnapshot: z.number().int().min(1000).default(5_000_000),
    })
    .default({}),

  notifications: z
    .object({
      discord: z
        .object({
          enabled: z.boolean().default(false),
          webhookUrl: z.string().default(''),
          username: z.string().default('SakuraDrive'),
          minSeverity: z.enum(['info', 'warning', 'critical']).default('warning'),
          /** Role/user mention prepended to critical alerts, e.g. `<@&123>`. */
          mentionOnCritical: z.string().default(''),
          /** Batch alerts raised within this many seconds into one message. 0 = never batch. */
          batchWindowSeconds: z.number().int().min(0).max(3600).default(30),
          notifyOnResolved: z.boolean().default(true),
          notifyOnWorkflowFailure: z.boolean().default(true),
          /** Suppress repeat notifications for an alert already sent within this window. */
          renotifyAfterHours: z.number().int().min(0).default(24),
        })
        .default({}),
    })
    .default({}),

  autoExport: z
    .object({
      enabled: z.boolean().default(true),
      destinations: z.array(exportDestinationSchema).default([]),
      /** Local time of day to run, `HH:MM`. */
      timeOfDay: z.string().default('04:30'),
      daysOfWeek: z.array(z.number().int().min(0).max(6)).default([0, 1, 2, 3, 4, 5, 6]),
      includeCatalog: z.boolean().default(true),
      includeSmartHistory: z.boolean().default(true),
      includePerformanceHistory: z.boolean().default(false),
      /**
       * Replace credentials with placeholders in the bundle. The export is meant to
       * survive a drive failure by living off-box, so secrets are excluded by default.
       */
      redactSecrets: z.boolean().default(true),
      /** Verify each bundle by re-reading it and comparing the record count. */
      verifyAfterWrite: z.boolean().default(true),
    })
    .default({}),

  security: z
    .object({
      /** When false the UI is open to anyone who can reach the port (LAN-only setups). */
      requireLogin: z.boolean().default(true),
      sessionDays: z.number().int().min(1).max(365).default(30),
    })
    .default({}),
});

export type Settings = z.infer<typeof settingsSchema>;

/** Fully-populated defaults; also what a fresh install starts from. */
export function defaultSettings(): Settings {
  return settingsSchema.parse({});
}

/**
 * Parse persisted/imported settings, filling in anything missing so a bundle written by
 * an older version still loads.
 */
export function parseSettings(input: unknown): Settings {
  const parsed = settingsSchema.parse(input ?? {});
  parsed.schedule.heavyIo = normalizeSchedule(parsed.schedule.heavyIo);
  return parsed;
}

/** Dotted paths of every field that holds a credential. */
export const SECRET_SETTING_PATHS = [
  'backup.password',
  'backup.repository.key',
  'backup.repository.keyId',
  'notifications.discord.webhookUrl',
] as const;

export const SECRET_PLACEHOLDER = '__REDACTED__';

function getPath(target: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, key) => {
    if (acc && typeof acc === 'object') return (acc as Record<string, unknown>)[key];
    return undefined;
  }, target);
}

function setPath(target: unknown, path: string, value: unknown): void {
  const keys = path.split('.');
  const last = keys.pop();
  if (!last) return;
  const parent = keys.reduce<unknown>((acc, key) => {
    if (acc && typeof acc === 'object') return (acc as Record<string, unknown>)[key];
    return undefined;
  }, target);
  if (parent && typeof parent === 'object') {
    (parent as Record<string, unknown>)[last] = value;
  }
}

/** Copy of `settings` with every credential replaced by a placeholder. */
export function redactSettings(settings: Settings): Settings {
  const copy = structuredClone(settings) as Settings;
  for (const path of SECRET_SETTING_PATHS) {
    const current = getPath(copy, path);
    if (typeof current === 'string' && current.length > 0) {
      setPath(copy, path, SECRET_PLACEHOLDER);
    }
  }
  return copy;
}

/**
 * Merge an incoming settings patch, treating the redaction placeholder as "keep the
 * value already stored" so the UI can render a masked field without wiping the secret.
 */
export function mergeSettings(current: Settings, patch: unknown): Settings {
  const merged = deepMerge(structuredClone(current), patch);
  for (const path of SECRET_SETTING_PATHS) {
    if (getPath(merged, path) === SECRET_PLACEHOLDER) {
      setPath(merged, path, getPath(current, path));
    }
  }
  return parseSettings(merged);
}

function deepMerge(target: unknown, source: unknown): unknown {
  if (Array.isArray(source)) return source;
  if (source === null || typeof source !== 'object') return source === undefined ? target : source;
  const base: Record<string, unknown> =
    target && typeof target === 'object' && !Array.isArray(target)
      ? (target as Record<string, unknown>)
      : {};
  for (const [key, value] of Object.entries(source as Record<string, unknown>)) {
    base[key] = deepMerge(base[key], value);
  }
  return base;
}
