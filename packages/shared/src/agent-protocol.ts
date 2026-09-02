/**
 * Contract between the Windows agent and the SakuraDrive server.
 *
 * The agent runs on the Windows Server host (SMART, DrivePool and PrimoCache data are
 * simply not reachable from a Linux container) and POSTs a report to
 * `POST /api/agent/report` with a bearer token. Every section is optional so an agent
 * running without smartctl, without DrivePool or without PrimoCache still reports what
 * it can rather than failing the whole submission.
 *
 * Bump `AGENT_PROTOCOL_VERSION` when a field changes meaning; the server records the
 * version each agent reports and warns when an agent is older than the server expects.
 */

import { z } from 'zod';

export const AGENT_PROTOCOL_VERSION = 1;

const nonEmpty = z.string().min(1);
const optionalNumber = z.number().finite().nullish();

export const smartAttributeSchema = z.object({
  id: z.number().int().nonnegative(),
  name: z.string().default(''),
  value: optionalNumber,
  worst: optionalNumber,
  threshold: optionalNumber,
  /** Normalised numeric raw value; `rawString` keeps smartctl's original rendering. */
  raw: optionalNumber,
  rawString: z.string().nullish(),
  whenFailed: z.string().nullish(),
  flags: z.string().nullish(),
});
export type SmartAttribute = z.infer<typeof smartAttributeSchema>;

export const nvmeHealthSchema = z.object({
  availableSpare: optionalNumber,
  availableSpareThreshold: optionalNumber,
  percentageUsed: optionalNumber,
  mediaErrors: optionalNumber,
  errorLogEntries: optionalNumber,
  criticalWarning: optionalNumber,
  dataUnitsRead: optionalNumber,
  dataUnitsWritten: optionalNumber,
  unsafeShutdowns: optionalNumber,
});
export type NvmeHealth = z.infer<typeof nvmeHealthSchema>;

export const selfTestSchema = z.object({
  status: z.string().nullish(),
  /** True when the most recent completed self-test reported a failure. */
  failed: z.boolean().nullish(),
  lastHours: optionalNumber,
  remainingPercent: optionalNumber,
});

export const smartReportSchema = z.object({
  /** Stable identity of the physical disk; matches `physicalDisks[].deviceId`. */
  deviceId: nonEmpty,
  serialNumber: z.string().nullish(),
  model: z.string().nullish(),
  firmware: z.string().nullish(),
  /** Where the agent got the data: full smartctl, or a Windows fallback. */
  source: z.enum(['smartctl', 'storage-reliability', 'wmi', 'unknown']).default('unknown'),
  smartSupported: z.boolean().nullish(),
  smartEnabled: z.boolean().nullish(),
  overallHealthPassed: z.boolean().nullish(),
  temperatureC: optionalNumber,
  powerOnHours: optionalNumber,
  powerCycles: optionalNumber,
  rotationRate: optionalNumber,
  protocol: z.string().nullish(),
  attributes: z.array(smartAttributeSchema).default([]),
  nvme: nvmeHealthSchema.nullish(),
  selfTest: selfTestSchema.nullish(),
  /** Raw smartctl JSON, retained for the drive detail page. Truncated by the server. */
  rawJson: z.string().nullish(),
});
export type SmartReport = z.infer<typeof smartReportSchema>;

export const physicalDiskSchema = z.object({
  deviceId: nonEmpty,
  friendlyName: z.string().nullish(),
  model: z.string().nullish(),
  serialNumber: z.string().nullish(),
  firmwareVersion: z.string().nullish(),
  sizeBytes: optionalNumber,
  mediaType: z.string().nullish(),
  busType: z.string().nullish(),
  healthStatus: z.string().nullish(),
  operationalStatus: z.string().nullish(),
  /** Physical location string from Windows, e.g. an enclosure bay. */
  physicalLocation: z.string().nullish(),
  adapterSerialNumber: z.string().nullish(),
  temperatureC: optionalNumber,
});
export type PhysicalDisk = z.infer<typeof physicalDiskSchema>;

export const volumeSchema = z.object({
  volumeId: nonEmpty,
  /** The label the user writes on the drive caddy, e.g. `DRIVEPOOL27`. */
  label: z.string().nullish(),
  driveLetter: z.string().nullish(),
  path: z.string().nullish(),
  fileSystem: z.string().nullish(),
  fileSystemLabel: z.string().nullish(),
  sizeBytes: optionalNumber,
  freeBytes: optionalNumber,
  healthStatus: z.string().nullish(),
  operationalStatus: z.string().nullish(),
  /** NTFS dirty bit — set means chkdsk is pending. */
  dirty: z.boolean().nullish(),
  /** Device ids of the physical disks backing this volume. */
  physicalDiskIds: z.array(z.string()).default([]),
  /**
   * Folder mount points, e.g. `C:\PoolDisks\DRIVEPOOL4`. An array with more disks
   * than there are drive letters mounts its members into folders instead, and those
   * paths are what the container needs bind-mounted.
   */
  mountPoints: z.array(z.string()).default([]),
});
export type Volume = z.infer<typeof volumeSchema>;

export const poolPartSchema = z.object({
  partId: nonEmpty,
  /** DrivePool's own name for the part; usually the volume label. */
  name: z.string().nullish(),
  volumeId: z.string().nullish(),
  volumeLabel: z.string().nullish(),
  driveLetter: z.string().nullish(),
  path: z.string().nullish(),
  sizeBytes: optionalNumber,
  freeBytes: optionalNumber,
  usedBytes: optionalNumber,
  physicalDiskId: z.string().nullish(),
  missing: z.boolean().nullish(),
  readOnly: z.boolean().nullish(),
});
export type PoolPart = z.infer<typeof poolPartSchema>;

export const poolSchema = z.object({
  poolId: nonEmpty,
  name: z.string().nullish(),
  driveLetter: z.string().nullish(),
  sizeBytes: optionalNumber,
  freeBytes: optionalNumber,
  duplicatedBytes: optionalNumber,
  unduplicatedBytes: optionalNumber,
  parts: z.array(poolPartSchema).default([]),
});
export type Pool = z.infer<typeof poolSchema>;

export const duplicationEntrySchema = z.object({
  poolId: z.string().nullish(),
  /** Pool-relative folder path. Empty string means the pool root default. */
  path: z.string(),
  level: z.number().int().positive(),
});
export type DuplicationEntry = z.infer<typeof duplicationEntrySchema>;

export const performanceSampleSchema = z.object({
  /** Perf-counter instance name, e.g. `0 C: D:`. */
  instance: nonEmpty,
  deviceId: z.string().nullish(),
  readLatencyMs: optionalNumber,
  writeLatencyMs: optionalNumber,
  queueLength: optionalNumber,
  readBytesPerSec: optionalNumber,
  writeBytesPerSec: optionalNumber,
  readsPerSec: optionalNumber,
  writesPerSec: optionalNumber,
  idlePercent: optionalNumber,
  busyPercent: optionalNumber,
  sampleSeconds: optionalNumber,
});
export type PerformanceSample = z.infer<typeof performanceSampleSchema>;

export const primoCacheSchema = z.object({
  available: z.boolean().default(false),
  version: z.string().nullish(),
  /** Why stats are missing, when `available` is false. */
  reason: z.string().nullish(),
  caches: z
    .array(
      z.object({
        name: nonEmpty,
        /** `L1`, or `L1+L2` when a level-2 SSD cache is attached. */
        level: z.string().nullish(),
        /** Labels of the volumes this cache task fronts, e.g. `DRIVEPOOL4`. */
        targetVolumes: z.array(z.string()).default([]),
        cacheSizeBytes: optionalNumber,
        usedBytes: optionalNumber,
        /** PrimoCache's own task GUID, and the settings it reports for the task. */
        taskId: z.string().nullish(),
        status: z.string().nullish(),
        blockSize: z.string().nullish(),
        strategy: z.string().nullish(),
        deferWrite: z.boolean().nullish(),
        level1SizeBytes: optionalNumber,
        level2SizeBytes: optionalNumber,
        /**
         * PrimoCache counts bytes moved, not hits and misses, so the read hit rate is
         * the share of read bytes the cache served: `cachedReadBytes / readBytes`.
         */
        readHitRate: optionalNumber,
        readBytes: optionalNumber,
        cachedReadBytes: optionalNumber,
        writeBytes: optionalNumber,
        /**
         * How much of the requested write still reached the disk. Its complement,
         * `writeAbsorbedRate`, is what deferred write kept off the disk — the number
         * worth showing. There is deliberately no `writeHitRate`: PrimoCache reports
         * the disk share, and calling that a hit rate would invert its meaning.
         */
        writeToDiskBytes: optionalNumber,
        writeToDiskRate: optionalNumber,
        writeAbsorbedRate: optionalNumber,
        /** Every figure is cumulative since this moment, not a rate. */
        statsSince: z.string().nullish(),
        /** Per-volume detail, named by the label `rxpcc ls` gives each volume. */
        volumeStats: z
          .array(
            z.object({
              volume: z.number(),
              label: z.string().nullish(),
              readBytes: optionalNumber,
              cachedReadBytes: optionalNumber,
              readHitRate: optionalNumber,
              level2ReadBytes: optionalNumber,
              level2ReadRate: optionalNumber,
              level2WriteBytes: optionalNumber,
              writeBytes: optionalNumber,
              writeLevel1Bytes: optionalNumber,
              writeLevel2Bytes: optionalNumber,
              writeToDiskBytes: optionalNumber,
              writeToDiskRate: optionalNumber,
              writeAbsorbedRate: optionalNumber,
              deferredBlocks: optionalNumber,
              trimmedBlocks: optionalNumber,
              prefetchState: z.string().nullish(),
              prefetchLoadedBytes: optionalNumber,
              prefetchTotalBytes: optionalNumber,
              statsSince: z.string().nullish(),
            }),
          )
          .default([]),
        deferredWriteBytes: optionalNumber,
        pendingWriteBlocks: optionalNumber,
        freeDeferredBlocks: optionalNumber,
      }),
    )
    .default([]),
  /** Cache capacity not currently holding anything, for the whole cache. */
  unusedLevel1Bytes: optionalNumber,
  unusedLevel2Bytes: optionalNumber,
});
export type PrimoCacheReport = z.infer<typeof primoCacheSchema>;

export const collectorErrorSchema = z.object({
  collector: nonEmpty,
  message: z.string().default(''),
  detail: z.string().nullish(),
});

export const agentReportSchema = z.object({
  protocolVersion: z.number().int().positive().default(AGENT_PROTOCOL_VERSION),
  agentVersion: z.string().default('unknown'),
  /**
   * The distribution the host is running: the content hash the server handed out.
   * Absent when the agent was installed by copying files rather than from the server.
   */
  distributionVersion: z.string().default(''),
  hostname: nonEmpty,
  /** ISO-8601 timestamp from the host. The server also records its own receive time. */
  collectedAt: z.string(),
  intervalSeconds: z.number().int().positive().nullish(),
  physicalDisks: z.array(physicalDiskSchema).default([]),
  volumes: z.array(volumeSchema).default([]),
  smart: z.array(smartReportSchema).default([]),
  pools: z.array(poolSchema).default([]),
  duplication: z.array(duplicationEntrySchema).default([]),
  performance: z.array(performanceSampleSchema).default([]),
  primoCache: primoCacheSchema.nullish(),
  errors: z.array(collectorErrorSchema).default([]),
});
export type AgentReport = z.infer<typeof agentReportSchema>;

export const agentReportResponseSchema = z.object({
  accepted: z.boolean(),
  agentId: z.string(),
  serverTime: z.string(),
  /** Alerts raised or cleared by this report, so the agent can log them locally. */
  alertsRaised: z.number().int().nonnegative().default(0),
  warnings: z.array(z.string()).default([]),
});
export type AgentReportResponse = z.infer<typeof agentReportResponseSchema>;

/* ------------------------------------------------------------- agent jobs */

/**
 * Work the server hands to the agent.
 *
 * A disk with no drive letter cannot be bind-mounted into the container -- WSL2's drvfs
 * will not follow a folder mount point into another volume -- so on a pool with more
 * disks than spare letters the container simply cannot read the data. The agent can: it
 * runs on Windows with native access to every volume, including by volume GUID path.
 *
 * So for those roots the agent walks and hashes, and streams the results here. The
 * server still owns the schedule, the pause, the cursor and the catalog; the agent is
 * the pair of hands, not the brain. That keeps one implementation of "what a scan
 * means" and makes the container's view of the host irrelevant to the design.
 */
export const agentJobTypeSchema = z.enum(['catalog.scan', 'catalog.hash']);
export type AgentJobType = z.infer<typeof agentJobTypeSchema>;

/** One file the agent found, in the same shape the container-side walker produces. */
export const agentFileEntrySchema = z.object({
  /** Root-relative path, forward slashes, original casing. */
  relPath: nonEmpty,
  sizeBytes: z.number().nonnegative(),
  mtimeMs: z.number(),
  ctimeMs: z.number().default(0),
});
export type AgentFileEntry = z.infer<typeof agentFileEntrySchema>;

/** One file the agent hashed, or failed to. */
export const agentHashResultSchema = z.object({
  fileId: z.number().int(),
  hash: z.string().nullish(),
  /** Re-stated at hash time: a file that changed under us must not be recorded. */
  sizeBytes: z.number().nonnegative().nullish(),
  mtimeMs: z.number().nullish(),
  /**
   * Set when the agent was given an expected hash, got a different one, and read the
   * file a second time: true if both reads agreed. A controller glitch produces a
   * different hash without the bytes on disk having changed, so a single disagreeing
   * read is a read fault, not bit rot. The second read happens on the agent because
   * that is where the file is -- asking for it from here would be another round trip
   * over the very disk that just misbehaved.
   */
  verified: z.boolean().nullish(),
  error: z.string().nullish(),
});
export type AgentHashResult = z.infer<typeof agentHashResultSchema>;

export const agentJobSchema = z.object({
  jobId: z.number().int(),
  type: agentJobTypeSchema,
  rootId: nonEmpty,
  rootName: z.string().default(''),
  /** The Windows path to walk. A `\\?\Volume{guid}\...` path is valid and expected. */
  hostPath: nonEmpty,
  includeGlobs: z.array(z.string()).default([]),
  excludeGlobs: z.array(z.string()).default([]),
  followSymlinks: z.boolean().default(false),
  /** Entries per batch. Bounded so a pause is never more than one batch away. */
  batchSize: z.number().int().positive().default(2000),
  /** Opaque to the agent: handed back so a paused scan resumes where it stopped. */
  cursor: z.unknown().nullish(),
  /** `catalog.hash` only: exactly which files to hash, and how. */
  hashAlgorithm: z.string().default('sha256'),
  files: z
    .array(
      z.object({
        fileId: z.number().int(),
        relPath: nonEmpty,
        sizeBytes: z.number(),
        /** What we hold. A different result means a re-read before believing it. */
        expectedHash: z.string().nullish(),
      }),
    )
    .default([]),
  /** Bytes per second the agent should not exceed while hashing. 0 is unthrottled. */
  maxBytesPerSecond: z.number().nonnegative().default(0),
});
export type AgentJob = z.infer<typeof agentJobSchema>;

export const agentJobClaimSchema = z.object({
  hostname: nonEmpty,
  agentVersion: z.string().default(''),
});

/** A batch of results, plus where the agent has got to. */
export const agentJobBatchSchema = z.object({
  entries: z.array(agentFileEntrySchema).default([]),
  hashes: z.array(agentHashResultSchema).default([]),
  /** Directories the agent could not read. Reported, never silently skipped. */
  errors: z.array(z.object({ relPath: z.string(), message: z.string() })).default([]),
  cursor: z.unknown().nullish(),
  /** Progress hint for the interface; the server does not trust it for correctness. */
  dirsDone: z.number().int().nonnegative().default(0),
  dirsRemaining: z.number().int().nonnegative().default(0),
});
export type AgentJobBatch = z.infer<typeof agentJobBatchSchema>;

export const agentJobBatchResponseSchema = z.object({
  accepted: z.number().int().nonnegative(),
  /**
   * False when the I/O window has closed or the job was cancelled. The agent stops at
   * this batch boundary and posts `paused`, which is how the schedule reaches across
   * the process boundary without the agent knowing anything about schedules.
   */
  continue: z.boolean(),
});
export type AgentJobBatchResponse = z.infer<typeof agentJobBatchResponseSchema>;

export const agentJobFinishSchema = z.object({
  state: z.enum(['completed', 'paused', 'failed']),
  cursor: z.unknown().nullish(),
  error: z.string().nullish(),
  filesSeen: z.number().int().nonnegative().default(0),
  bytesSeen: z.number().nonnegative().default(0),
  dirsDone: z.number().int().nonnegative().default(0),
});
export type AgentJobFinish = z.infer<typeof agentJobFinishSchema>;

/**
 * Canonical device key. Serial numbers are the only identifier that survives a
 * controller change or a reboot re-ordering disks, so prefer them and fall back to the
 * Windows device id.
 */
export function deviceKey(input: {
  serialNumber?: string | null;
  deviceId?: string | null;
}): string {
  const serial = (input.serialNumber ?? '').trim();
  if (serial && serial.toLowerCase() !== 'unknown') return `sn:${serial.toUpperCase()}`;
  const deviceId = (input.deviceId ?? '').trim();
  return deviceId ? `dev:${deviceId.toUpperCase()}` : 'dev:unknown';
}

/* ------------------------------------------------------- agent distribution */

/**
 * One file the server will hand to an agent.
 *
 * The hash is the point: the agent verifies every downloaded byte before it puts the
 * file anywhere near an installation, so a truncated transfer or a proxy that decided
 * to be helpful shows up as a refused update rather than a broken host.
 */
export const agentDistFileSchema = z.object({
  path: z.string().min(1),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  bytes: z.number().int().nonnegative(),
});
export type AgentDistFile = z.infer<typeof agentDistFileSchema>;

export const agentDistManifestSchema = z.object({
  /** Derived from the file hashes. Compared for equality, never for order. */
  version: z.string().min(1),
  agentVersion: z.string().default('unknown'),
  protocolVersion: z.number().int().positive().default(AGENT_PROTOCOL_VERSION),
  generatedAt: z.string(),
  files: z.array(agentDistFileSchema),
});
export type AgentDistManifest = z.infer<typeof agentDistManifestSchema>;
