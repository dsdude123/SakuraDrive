/** Domain and API types shared between the server and the web UI. */

import type { Severity } from './smart-rules.js';

export type { Severity };

/* ------------------------------------------------------------------ alerts */

export type AlertState = 'open' | 'acknowledged' | 'resolved';

export const ALERT_CATEGORIES = [
  'smart',
  'volume',
  'performance',
  'pool',
  'duplication',
  'bitrot',
  'catalog',
  'backup',
  'export',
  'agent',
  'workflow',
  'system',
] as const;
export type AlertCategory = (typeof ALERT_CATEGORIES)[number];

export interface Alert {
  id: number;
  /** Stable identity for an ongoing condition; re-raising updates rather than duplicates. */
  dedupeKey: string;
  category: AlertCategory;
  severity: Severity;
  title: string;
  detail: string;
  /** Free-form context rendered on the alert page (drive serial, path, counts...). */
  context: Record<string, unknown>;
  state: AlertState;
  firstSeenAt: string;
  lastSeenAt: string;
  resolvedAt: string | null;
  acknowledgedAt: string | null;
  acknowledgedBy: string | null;
  notifiedAt: string | null;
  occurrences: number;
}

/* --------------------------------------------------------------- workflows */

export const WORKFLOW_IDS = [
  'catalog.scan',
  'catalog.hash',
  'catalog.duplication',
  'backup.verify',
  'export.backup',
  'maintenance.prune',
] as const;
export type WorkflowId = (typeof WORKFLOW_IDS)[number];

export type WorkflowRunState =
  | 'queued'
  | 'running'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled';

export const TERMINAL_RUN_STATES: readonly WorkflowRunState[] = [
  'completed',
  'failed',
  'cancelled',
];

export function isTerminalRunState(state: WorkflowRunState): boolean {
  return TERMINAL_RUN_STATES.includes(state);
}

export interface WorkflowProgress {
  /** Units completed. Units are workflow-specific (files, directories, snapshots...). */
  done: number;
  /** Best known total. Null while it is still being established. */
  total: number | null;
  unit: string;
  message: string;
  /** Bytes processed, used to show hashing throughput. */
  bytes?: number;
}

export interface WorkflowRun {
  id: number;
  workflowId: WorkflowId;
  state: WorkflowRunState;
  trigger: 'schedule' | 'manual' | 'startup' | 'chain';
  startedAt: string | null;
  finishedAt: string | null;
  updatedAt: string;
  progress: WorkflowProgress;
  /** Resume point, so a run paused at the end of a window continues where it stopped. */
  cursor: unknown;
  params: Record<string, unknown>;
  error: string | null;
  /** Counters the workflow chose to publish, e.g. created/modified/deleted. */
  stats: Record<string, number>;
  logTail: string[];
}

export interface WorkflowStatus {
  id: WorkflowId;
  name: string;
  description: string;
  respectsSchedule: boolean;
  enabled: boolean;
  concurrencyGroup: string | null;
  currentRun: WorkflowRun | null;
  lastRun: WorkflowRun | null;
  /** Null when the schedule is empty or the window is already open. */
  minutesUntilWindow: number | null;
  windowOpen: boolean;
}

/* ----------------------------------------------------------------- drives */

export interface DriveSummary {
  id: number;
  deviceKey: string;
  deviceId: string;
  serialNumber: string | null;
  model: string | null;
  firmware: string | null;
  sizeBytes: number | null;
  mediaType: string | null;
  busType: string | null;
  /** Volume label(s) — how the user physically identifies the drive in its slot. */
  labels: string[];
  driveLetters: string[];
  poolNames: string[];
  temperatureC: number | null;
  powerOnHours: number | null;
  healthStatus: string | null;
  overallHealthPassed: boolean | null;
  severity: Severity | null;
  openAlertCount: number;
  lastSeenAt: string | null;
  hostname: string | null;
  sizeUsedBytes: number | null;
  sizeFreeBytes: number | null;
}

export interface VolumeSummary {
  id: number;
  volumeId: string;
  label: string | null;
  driveLetter: string | null;
  fileSystem: string | null;
  sizeBytes: number | null;
  freeBytes: number | null;
  healthStatus: string | null;
  operationalStatus: string | null;
  dirty: boolean | null;
  deviceKeys: string[];
  lastSeenAt: string | null;
}

export interface PoolSummary {
  id: number;
  poolId: string;
  name: string | null;
  driveLetter: string | null;
  sizeBytes: number | null;
  freeBytes: number | null;
  duplicatedBytes: number | null;
  unduplicatedBytes: number | null;
  parts: PoolPartSummary[];
  lastSeenAt: string | null;
}

export interface PoolPartSummary {
  partId: string;
  name: string | null;
  volumeLabel: string | null;
  driveLetter: string | null;
  sizeBytes: number | null;
  freeBytes: number | null;
  usedBytes: number | null;
  deviceKey: string | null;
  missing: boolean;
}

/* ---------------------------------------------------------------- catalog */

export interface CatalogFile {
  id: number;
  rootId: string;
  relPath: string;
  sizeBytes: number;
  mtimeMs: number;
  hash: string | null;
  hashAlgorithm: string | null;
  hashedAt: string | null;
  duplicationLevel: number;
  firstSeenAt: string;
  lastSeenAt: string;
  deletedAt: string | null;
}

export type CatalogChangeKind = 'created' | 'modified' | 'deleted' | 'restored';

export interface CatalogChange {
  id: number;
  runId: number;
  rootId: string;
  relPath: string;
  kind: CatalogChangeKind;
  sizeBytes: number | null;
  previousSizeBytes: number | null;
  mtimeMs: number | null;
  previousMtimeMs: number | null;
  detectedAt: string;
}

export interface CatalogDiffSummary {
  fromRunId: number | null;
  toRunId: number;
  created: number;
  modified: number;
  deleted: number;
  restored: number;
  bytesAdded: number;
  bytesRemoved: number;
}

export interface DirectoryEntry {
  name: string;
  relPath: string;
  kind: 'directory' | 'file';
  /** Logical bytes, ignoring duplication. */
  sizeBytes: number;
  /** Bytes actually consumed on the pool once duplication is applied. */
  effectiveBytes: number;
  fileCount: number;
  duplicationLevel: number | null;
  mtimeMs: number | null;
  hash?: string | null;
}

/* ----------------------------------------------------------------- bitrot */

export type BitrotStatus = 'open' | 'confirmed' | 'dismissed' | 'resolved';

export interface BitrotFinding {
  id: number;
  rootId: string;
  relPath: string;
  sizeBytes: number;
  mtimeMs: number;
  expectedHash: string;
  actualHash: string;
  hashAlgorithm: string;
  detectedAt: string;
  /** Set when the file was re-read and the mismatch reproduced. */
  verifiedAt: string | null;
  status: BitrotStatus;
  note: string;
  resolvedAt: string | null;
  previousHashedAt: string | null;
}

/* ----------------------------------------------------------------- backup */

export type BackupIssueKind = 'missing' | 'stale' | 'size-mismatch';

export interface BackupIssue {
  id: number;
  runId: number;
  expectationId: string;
  rootId: string;
  relPath: string;
  kind: BackupIssueKind;
  sizeBytes: number | null;
  backupSizeBytes: number | null;
  catalogMtimeMs: number | null;
  backupMtimeMs: number | null;
  detectedAt: string;
  status: 'open' | 'dismissed' | 'resolved';
  note: string;
}

export interface BackupVerificationSummary {
  runId: number;
  startedAt: string;
  finishedAt: string | null;
  expectationId: string;
  expectationName: string;
  snapshotId: string | null;
  snapshotTime: string | null;
  expectedFiles: number;
  presentFiles: number;
  missingFiles: number;
  staleFiles: number;
  mismatchedFiles: number;
  /** Bytes of expected data that are not protected. */
  missingBytes: number;
  error: string | null;
}

/* ------------------------------------------------------------ disaster recovery */

export interface DiskLossImpact {
  deviceKey: string;
  label: string | null;
  poolId: string | null;
  /** Files that lived only on this disk and have no other copy in the pool. */
  unrecoverableFiles: number;
  unrecoverableBytes: number;
  /** Files that exist elsewhere in the pool and survive. */
  duplicatedFiles: number;
  duplicatedBytes: number;
  /** Of the unrecoverable files, how many are covered by a backup expectation. */
  backedUpFiles: number;
  backedUpBytes: number;
  generatedAt: string;
}

/* ------------------------------------------------------------------ agents */

export interface AgentSummary {
  id: number;
  hostname: string;
  agentVersion: string;
  protocolVersion: number;
  lastReportAt: string | null;
  lastReportAgeSeconds: number | null;
  online: boolean;
  reportCount: number;
  lastErrors: Array<{ collector: string; message: string }>;
}

export interface AgentToken {
  id: number;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
  /** Only returned once, at creation. */
  token?: string;
  prefix: string;
  revokedAt: string | null;
}

/* ---------------------------------------------------------------- exports */

export interface ExportRecord {
  id: number;
  createdAt: string;
  fileName: string;
  destinationId: string | null;
  destinationPath: string | null;
  sizeBytes: number;
  recordCount: number;
  checksum: string;
  trigger: 'manual' | 'schedule';
  verified: boolean;
  error: string | null;
}

export interface ExportManifest {
  format: 'sakuradrive-export';
  version: number;
  createdAt: string;
  appVersion: string;
  hostname: string;
  redactedSecrets: boolean;
  tables: Record<string, number>;
  recordCount: number;
}

/* -------------------------------------------------------------- dashboard */

export interface HealthSummary {
  generatedAt: string;
  severity: Severity | null;
  alerts: { open: number; critical: number; warning: number; info: number; acknowledged: number };
  drives: { total: number; healthy: number; warning: number; critical: number; offline: number };
  pools: Array<{
    name: string;
    sizeBytes: number | null;
    freeBytes: number | null;
    partCount: number;
    missingParts: number;
  }>;
  catalog: {
    files: number;
    bytes: number;
    effectiveBytes: number;
    hashedFiles: number;
    lastScanAt: string | null;
    lastHashAt: string | null;
  };
  bitrot: { open: number; confirmed: number; dismissed: number; lastDetectedAt: string | null };
  backup: {
    enabled: boolean;
    lastRunAt: string | null;
    missingFiles: number;
    missingBytes: number;
    expectations: number;
  };
  agents: { total: number; online: number; stale: number };
  lastExportAt: string | null;
  workflows: WorkflowStatus[];
}

export interface ApiError {
  error: string;
  message: string;
  details?: unknown;
}
