/**
 * SMART / health evaluation rules.
 *
 * Pure functions so the exact rules that fire an alert can be unit tested, and so the
 * UI can explain *why* a drive is flagged without asking the server.
 *
 * The design follows what actually predicts drive death in practice (and what
 * Backblaze's published failure data supports): the reallocated / pending / offline
 * uncorrectable counters matter most, and a counter that is *increasing* is far more
 * urgent than a counter that has been sitting at the same non-zero value for years.
 */

import type { NvmeHealth, SmartAttribute, SmartReport } from './agent-protocol.js';

export type Severity = 'info' | 'warning' | 'critical';

export const SEVERITY_ORDER: Record<Severity, number> = { info: 0, warning: 1, critical: 2 };

export function maxSeverity(a: Severity, b: Severity): Severity {
  return SEVERITY_ORDER[a] >= SEVERITY_ORDER[b] ? a : b;
}

export interface SmartFinding {
  /** Stable per-drive key used to deduplicate alerts across reports. */
  key: string;
  severity: Severity;
  title: string;
  detail: string;
  attributeId?: number;
  value?: number | null;
  previousValue?: number | null;
}

export interface SmartAttributeRule {
  id: number;
  name: string;
  /** Raw value above which the attribute is a warning. */
  warnAbove: number;
  /** Raw value above which the attribute is critical. */
  critAbove: number;
  /** Any increase since the previous reading escalates to this severity. */
  increaseSeverity: Severity | null;
  description: string;
}

/**
 * Defaults chosen to be actionable rather than noisy: a single pending sector is worth
 * a warning, a handful means the drive should be replaced.
 */
export const DEFAULT_ATTRIBUTE_RULES: SmartAttributeRule[] = [
  {
    id: 5,
    name: 'Reallocated Sectors',
    warnAbove: 0,
    critAbove: 32,
    increaseSeverity: 'critical',
    description: 'Sectors the drive has remapped after failing to read or write them.',
  },
  {
    id: 10,
    name: 'Spin Retry Count',
    warnAbove: 0,
    critAbove: 2,
    increaseSeverity: 'critical',
    description: 'The motor failed to spin up on the first attempt — usually imminent failure.',
  },
  {
    id: 184,
    name: 'End-to-End Error',
    warnAbove: 0,
    critAbove: 0,
    increaseSeverity: 'critical',
    description: 'Data corrupted between the drive cache and the host interface.',
  },
  {
    id: 187,
    name: 'Reported Uncorrectable Errors',
    warnAbove: 0,
    critAbove: 4,
    increaseSeverity: 'critical',
    description: 'Errors the drive could not correct with ECC — a direct bit-rot risk.',
  },
  {
    id: 188,
    name: 'Command Timeout',
    warnAbove: 100,
    critAbove: 1000,
    increaseSeverity: null,
    description: 'Commands that timed out. Large jumps often mean cabling or power problems.',
  },
  {
    id: 196,
    name: 'Reallocation Events',
    warnAbove: 0,
    critAbove: 32,
    increaseSeverity: 'warning',
    description: 'Attempts to remap sectors, successful or not.',
  },
  {
    id: 197,
    name: 'Current Pending Sectors',
    warnAbove: 0,
    critAbove: 8,
    increaseSeverity: 'critical',
    description: 'Unstable sectors waiting to be remapped. Files on them may already be unreadable.',
  },
  {
    id: 198,
    name: 'Offline Uncorrectable',
    warnAbove: 0,
    critAbove: 4,
    increaseSeverity: 'critical',
    description: 'Sectors that could not be read even offline. Data on them is gone.',
  },
  {
    id: 199,
    name: 'UDMA CRC Errors',
    warnAbove: 0,
    critAbove: 100,
    increaseSeverity: 'warning',
    description: 'Interface errors — nearly always a bad SATA cable or backplane, not the disk.',
  },
  {
    id: 201,
    name: 'Soft Read Error Rate',
    warnAbove: 0,
    critAbove: 16,
    increaseSeverity: 'warning',
    description: 'Uncorrected read errors reported to the operating system.',
  },
];

export interface SmartThresholds {
  /** Warn above this drive temperature in degrees Celsius. */
  temperatureWarnC: number;
  temperatureCritC: number;
  /** NVMe endurance: warn when the drive has consumed this share of its rated writes. */
  nvmeWearWarnPercent: number;
  nvmeWearCritPercent: number;
  /** Warn when an agent has not checked in for this long. */
  agentStaleMinutes: number;
  attributes: SmartAttributeRule[];
}

export const DEFAULT_SMART_THRESHOLDS: SmartThresholds = {
  temperatureWarnC: 50,
  temperatureCritC: 60,
  nvmeWearWarnPercent: 85,
  nvmeWearCritPercent: 95,
  agentStaleMinutes: 60,
  attributes: DEFAULT_ATTRIBUTE_RULES,
};

/** Raw value of an attribute, tolerating smartctl's composite raw strings. */
export function attributeRaw(attribute: SmartAttribute | undefined): number | null {
  if (!attribute) return null;
  if (typeof attribute.raw === 'number' && Number.isFinite(attribute.raw)) return attribute.raw;
  const rawString = attribute.rawString;
  if (!rawString) return null;
  // Temperature raw values look like "34 (Min/Max 20/45)"; take the leading number.
  const match = /-?\d+/.exec(rawString);
  return match ? Number(match[0]) : null;
}

export function findAttribute(
  report: Pick<SmartReport, 'attributes'>,
  id: number,
): SmartAttribute | undefined {
  return report.attributes.find((attribute) => attribute.id === id);
}

export interface EvaluateSmartInput {
  report: SmartReport;
  /** The previous accepted report for the same drive, when one exists. */
  previous?: Pick<SmartReport, 'attributes' | 'nvme'> | null;
  thresholds?: Partial<SmartThresholds>;
  /** Human-facing drive name, e.g. the volume label `DRIVEPOOL27`. */
  label?: string | null;
}

/** Evaluate one drive's SMART report into zero or more findings. */
export function evaluateSmart(input: EvaluateSmartInput): SmartFinding[] {
  const thresholds: SmartThresholds = { ...DEFAULT_SMART_THRESHOLDS, ...input.thresholds };
  const rules = thresholds.attributes ?? DEFAULT_ATTRIBUTE_RULES;
  const { report, previous, label } = input;
  const name = label || report.model || report.serialNumber || report.deviceId;
  const findings: SmartFinding[] = [];

  if (report.overallHealthPassed === false) {
    findings.push({
      key: 'smart.overall',
      severity: 'critical',
      title: `${name}: SMART overall health FAILED`,
      detail:
        'The drive itself reports that it has failed its own health assessment. Replace it now and verify pool duplication before doing anything else.',
    });
  }

  if (report.smartSupported === false) {
    findings.push({
      key: 'smart.unsupported',
      severity: 'info',
      title: `${name}: SMART not available`,
      detail:
        'The controller does not expose SMART data for this drive. A USB bridge or RAID controller usually needs an explicit smartctl device type.',
    });
  }

  for (const rule of rules) {
    const attribute = findAttribute(report, rule.id);
    if (!attribute) continue;
    const raw = attributeRaw(attribute);
    if (raw === null) continue;
    const previousRaw = previous ? attributeRaw(findAttribute(previous, rule.id)) : null;

    let severity: Severity | null = null;
    if (raw > rule.critAbove) severity = 'critical';
    else if (raw > rule.warnAbove) severity = 'warning';

    const increased = previousRaw !== null && raw > previousRaw;
    if (increased && rule.increaseSeverity) {
      severity = severity ? maxSeverity(severity, rule.increaseSeverity) : rule.increaseSeverity;
    }
    if (!severity) continue;

    const trend = increased ? ` (was ${previousRaw}, up ${raw - (previousRaw ?? 0)})` : '';
    findings.push({
      key: `smart.attr.${rule.id}`,
      severity,
      title: `${name}: ${rule.name} = ${raw}${increased ? ' and rising' : ''}`,
      detail: `${rule.description} Current raw value ${raw}${trend}.`,
      attributeId: rule.id,
      value: raw,
      previousValue: previousRaw,
    });
  }

  // A normalised value at or below the manufacturer threshold is a failure regardless
  // of which attribute it is.
  for (const attribute of report.attributes) {
    const value = attribute.value;
    const threshold = attribute.threshold;
    if (
      typeof value === 'number' &&
      typeof threshold === 'number' &&
      threshold > 0 &&
      value <= threshold
    ) {
      findings.push({
        key: `smart.threshold.${attribute.id}`,
        severity: 'critical',
        title: `${name}: attribute ${attribute.id} ${attribute.name || ''} below manufacturer threshold`.trim(),
        detail: `Normalised value ${value} has reached the failure threshold ${threshold}.`,
        attributeId: attribute.id,
        value,
      });
    }
  }

  const temperature = report.temperatureC ?? attributeRaw(findAttribute(report, 194));
  if (typeof temperature === 'number' && Number.isFinite(temperature)) {
    if (temperature >= thresholds.temperatureCritC) {
      findings.push({
        key: 'smart.temperature',
        severity: 'critical',
        title: `${name}: temperature ${temperature}°C`,
        detail: `Above the critical threshold of ${thresholds.temperatureCritC}°C. Sustained heat shortens drive life sharply — check airflow.`,
        value: temperature,
      });
    } else if (temperature >= thresholds.temperatureWarnC) {
      findings.push({
        key: 'smart.temperature',
        severity: 'warning',
        title: `${name}: temperature ${temperature}°C`,
        detail: `Above the warning threshold of ${thresholds.temperatureWarnC}°C.`,
        value: temperature,
      });
    }
  }

  findings.push(...evaluateNvme(report.nvme ?? null, name, thresholds));

  if (report.selfTest?.failed) {
    findings.push({
      key: 'smart.selftest',
      severity: 'critical',
      title: `${name}: last SMART self-test failed`,
      detail: report.selfTest.status
        ? `Self-test status: ${report.selfTest.status}`
        : 'The drive reported a failed self-test.',
    });
  }

  return findings;
}

function evaluateNvme(
  nvme: NvmeHealth | null | undefined,
  name: string,
  thresholds: SmartThresholds,
): SmartFinding[] {
  if (!nvme) return [];
  const findings: SmartFinding[] = [];

  if (typeof nvme.criticalWarning === 'number' && nvme.criticalWarning !== 0) {
    findings.push({
      key: 'nvme.critical-warning',
      severity: 'critical',
      title: `${name}: NVMe critical warning flags set (0x${nvme.criticalWarning.toString(16)})`,
      detail: describeNvmeCriticalWarning(nvme.criticalWarning),
      value: nvme.criticalWarning,
    });
  }

  if (
    typeof nvme.availableSpare === 'number' &&
    typeof nvme.availableSpareThreshold === 'number' &&
    nvme.availableSpare <= nvme.availableSpareThreshold
  ) {
    findings.push({
      key: 'nvme.spare',
      severity: 'critical',
      title: `${name}: NVMe available spare ${nvme.availableSpare}%`,
      detail: `At or below the drive's own spare threshold of ${nvme.availableSpareThreshold}%. The drive is running out of replacement blocks.`,
      value: nvme.availableSpare,
    });
  }

  if (typeof nvme.percentageUsed === 'number') {
    if (nvme.percentageUsed >= thresholds.nvmeWearCritPercent) {
      findings.push({
        key: 'nvme.wear',
        severity: 'critical',
        title: `${name}: NVMe endurance ${nvme.percentageUsed}% used`,
        detail: `Above the critical wear threshold of ${thresholds.nvmeWearCritPercent}%. Plan a replacement.`,
        value: nvme.percentageUsed,
      });
    } else if (nvme.percentageUsed >= thresholds.nvmeWearWarnPercent) {
      findings.push({
        key: 'nvme.wear',
        severity: 'warning',
        title: `${name}: NVMe endurance ${nvme.percentageUsed}% used`,
        detail: `Above the warning wear threshold of ${thresholds.nvmeWearWarnPercent}%.`,
        value: nvme.percentageUsed,
      });
    }
  }

  if (typeof nvme.mediaErrors === 'number' && nvme.mediaErrors > 0) {
    findings.push({
      key: 'nvme.media-errors',
      severity: 'warning',
      title: `${name}: ${nvme.mediaErrors} NVMe media errors`,
      detail: 'The controller detected unrecovered data integrity errors.',
      value: nvme.mediaErrors,
    });
  }

  return findings;
}

const NVME_WARNING_BITS: Array<[number, string]> = [
  [0x01, 'spare capacity below threshold'],
  [0x02, 'temperature outside safe range'],
  [0x04, 'reliability degraded'],
  [0x08, 'media placed in read-only mode'],
  [0x10, 'volatile memory backup failed'],
  [0x20, 'persistent memory region unreliable'],
];

export function describeNvmeCriticalWarning(flags: number): string {
  const reasons = NVME_WARNING_BITS.filter(([bit]) => (flags & bit) !== 0).map(([, text]) => text);
  return reasons.length > 0
    ? `The controller reports: ${reasons.join(', ')}.`
    : 'The controller set an unrecognised critical warning flag.';
}

export interface VolumeHealthInput {
  label?: string | null;
  driveLetter?: string | null;
  healthStatus?: string | null;
  operationalStatus?: string | null;
  dirty?: boolean | null;
  sizeBytes?: number | null;
  freeBytes?: number | null;
  /** Warn when free space drops below this fraction of capacity. */
  freeSpaceWarnFraction?: number;
  freeSpaceCritFraction?: number;
}

/** Filesystem-level checks: dirty bit, Windows health status and free space. */
export function evaluateVolume(input: VolumeHealthInput): SmartFinding[] {
  const name = input.label || input.driveLetter || 'volume';
  const findings: SmartFinding[] = [];
  const warnFraction = input.freeSpaceWarnFraction ?? 0.05;
  const critFraction = input.freeSpaceCritFraction ?? 0.01;

  if (input.dirty) {
    findings.push({
      key: 'volume.dirty',
      severity: 'critical',
      title: `${name}: NTFS dirty bit is set`,
      detail:
        'Windows flagged this volume as needing chkdsk. Until it runs, the filesystem may be inconsistent and further writes can worsen the damage.',
    });
  }

  const health = (input.healthStatus ?? '').toLowerCase();
  if (health && health !== 'healthy') {
    findings.push({
      key: 'volume.health',
      severity: health === 'unhealthy' ? 'critical' : 'warning',
      title: `${name}: volume health is ${input.healthStatus}`,
      detail: `Windows reports the volume as ${input.healthStatus}${
        input.operationalStatus ? ` (${input.operationalStatus})` : ''
      }.`,
    });
  }

  const size = input.sizeBytes ?? 0;
  const free = input.freeBytes ?? 0;
  if (size > 0) {
    const fraction = free / size;
    if (fraction <= critFraction) {
      findings.push({
        key: 'volume.free-space',
        severity: 'critical',
        title: `${name}: ${(fraction * 100).toFixed(1)}% free`,
        detail: 'Almost full. DrivePool balancing and duplication need free space to work.',
        value: fraction,
      });
    } else if (fraction <= warnFraction) {
      findings.push({
        key: 'volume.free-space',
        severity: 'warning',
        title: `${name}: ${(fraction * 100).toFixed(1)}% free`,
        detail: 'Running low on free space.',
        value: fraction,
      });
    }
  }

  return findings;
}

export interface PerformanceThresholds {
  /** Sustained read/write latency above this many milliseconds is a warning. */
  latencyWarnMs: number;
  latencyCritMs: number;
  queueWarn: number;
  queueCrit: number;
  /** Number of consecutive samples that must breach before alerting. */
  consecutiveSamples: number;
}

export const DEFAULT_PERFORMANCE_THRESHOLDS: PerformanceThresholds = {
  latencyWarnMs: 100,
  latencyCritMs: 500,
  queueWarn: 8,
  queueCrit: 32,
  consecutiveSamples: 3,
};

export interface PerformanceSampleInput {
  readLatencyMs?: number | null;
  writeLatencyMs?: number | null;
  queueLength?: number | null;
}

/**
 * Detect the "disk I/O goes so slow that clients lock up" condition. A single slow
 * sample is normal during a scrub, so a breach only counts when the most recent
 * `consecutiveSamples` readings are all bad.
 */
export function evaluatePerformance(
  samples: readonly PerformanceSampleInput[],
  name: string,
  thresholds: Partial<PerformanceThresholds> = {},
): SmartFinding[] {
  const config = { ...DEFAULT_PERFORMANCE_THRESHOLDS, ...thresholds };
  if (samples.length < config.consecutiveSamples) return [];
  const window = samples.slice(-config.consecutiveSamples);
  const findings: SmartFinding[] = [];

  const latencies = window.map((s) => Math.max(s.readLatencyMs ?? 0, s.writeLatencyMs ?? 0));
  const worstLatency = Math.min(...latencies);
  if (worstLatency >= config.latencyCritMs) {
    findings.push({
      key: 'perf.latency',
      severity: 'critical',
      title: `${name}: I/O latency ${worstLatency.toFixed(0)}ms sustained`,
      detail: `Every one of the last ${config.consecutiveSamples} samples exceeded ${config.latencyCritMs}ms. This is the pattern that locks up client systems.`,
      value: worstLatency,
    });
  } else if (worstLatency >= config.latencyWarnMs) {
    findings.push({
      key: 'perf.latency',
      severity: 'warning',
      title: `${name}: I/O latency ${worstLatency.toFixed(0)}ms sustained`,
      detail: `Every one of the last ${config.consecutiveSamples} samples exceeded ${config.latencyWarnMs}ms.`,
      value: worstLatency,
    });
  }

  const queues = window.map((s) => s.queueLength ?? 0);
  const worstQueue = Math.min(...queues);
  if (worstQueue >= config.queueCrit) {
    findings.push({
      key: 'perf.queue',
      severity: 'critical',
      title: `${name}: disk queue length ${worstQueue.toFixed(1)}`,
      detail: 'Requests are piling up faster than the drive can service them.',
      value: worstQueue,
    });
  } else if (worstQueue >= config.queueWarn) {
    findings.push({
      key: 'perf.queue',
      severity: 'warning',
      title: `${name}: disk queue length ${worstQueue.toFixed(1)}`,
      detail: 'Sustained queue depth above the warning threshold.',
      value: worstQueue,
    });
  }

  return findings;
}
