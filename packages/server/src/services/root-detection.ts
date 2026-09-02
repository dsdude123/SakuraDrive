/**
 * Working out the catalog roots from what the agent already reported.
 *
 * The agent runs `dpcmd list-poolparts` every cycle and reports every pool and every
 * member disk: the pool GUID, the volume label, the drive letter if it has one, and the
 * volume GUID path. All of that is already in the database before anyone opens the
 * settings page. Asking an operator to then add seventeen roots by hand, picking each
 * one out of a dropdown of the same data, is work the machine can do.
 *
 * So it does. One `poolpart` root per reported member disk, named after the label on
 * the caddy.
 */

import { createHash } from 'node:crypto';
import type { ScanRoot } from '@sakuradrive/shared';
import type { Db } from '../db/index.js';
import type { SettingsService } from './settings-service.js';

export interface DetectedPart {
  poolId: string;
  volumeLabel: string | null;
  driveLetter: string | null;
  path: string | null;
  missing: number;
}

export interface DetectionResult {
  /** Roots that were added, or would be. */
  added: ScanRoot[];
  /** Member disks that already have a root, so nothing to do for them. */
  alreadyConfigured: number;
  /** Member disks DrivePool currently reports as missing; never adopted. */
  skippedMissing: number;
}

/**
 * A stable id for a member disk.
 *
 * Derived from the volume GUID path rather than generated, so running detection twice
 * cannot produce two roots for one disk -- and so a root keeps its identity, and its
 * catalog, when a disk is relabelled.
 */
export function rootIdForPart(hostPath: string): string {
  const digest = createHash('sha256').update(hostPath.toLowerCase()).digest('hex').slice(0, 10);
  return `part-${digest}`;
}

/** What to call a disk, in the order an operator would recognise it. */
export function rootNameForPart(part: DetectedPart): string {
  if (part.volumeLabel) return part.volumeLabel;
  if (part.driveLetter) return `${part.driveLetter}:`;
  return part.path ?? 'Unnamed disk';
}

/**
 * The roots that would be added for the pool parts the agent has reported.
 *
 * Pure with respect to the database: takes the rows, returns what should exist. A disk
 * DrivePool reports as missing is left alone -- adopting a root for a disk that is not
 * there would start a scan that immediately fails, and on an existing root would look
 * like every file on it had been deleted.
 */
export function planRootDetection(parts: DetectedPart[], existing: ScanRoot[]): DetectionResult {
  const configured = new Set(existing.map((root) => root.hostPath.toLowerCase()));
  const result: DetectionResult = { added: [], alreadyConfigured: 0, skippedMissing: 0 };

  for (const part of parts) {
    if (!part.path) continue;
    if (configured.has(part.path.toLowerCase())) {
      result.alreadyConfigured += 1;
      continue;
    }
    if (part.missing) {
      result.skippedMissing += 1;
      continue;
    }

    result.added.push({
      id: rootIdForPart(part.path),
      name: rootNameForPart(part),
      kind: 'poolpart',
      poolId: part.poolId,
      agentHostname: '',
      hostPath: part.path,
      driveLabel: part.volumeLabel ?? '',
      enabled: true,
      hashEnabled: true,
      includeGlobs: [],
      excludeGlobs: [],
      minHashSizeBytes: 0,
      maxHashSizeBytes: 0,
    });
    // Two pool parts on one path would be a DrivePool bug, but a duplicate root is
    // worse than a skipped one, so guard anyway.
    configured.add(part.path.toLowerCase());
  }

  return result;
}

export class RootDetectionService {
  constructor(
    private readonly db: Db,
    private readonly settings: SettingsService,
  ) {}

  private parts(): DetectedPart[] {
    return this.db
      .prepare<[], DetectedPart>(
        `SELECT pool_id AS poolId, volume_label AS volumeLabel, drive_letter AS driveLetter,
                path, missing
           FROM pool_parts ORDER BY volume_label, path`,
      )
      .all();
  }

  /** What detection would do, without doing it. */
  preview(): DetectionResult {
    return planRootDetection(this.parts(), this.settings.get().catalog.roots);
  }

  /** Add a root for every reported member disk that does not have one. */
  apply(): DetectionResult {
    const plan = this.preview();
    if (plan.added.length === 0) return plan;

    const roots = [...this.settings.get().catalog.roots, ...plan.added];
    this.settings.update({ catalog: { roots } });
    return plan;
  }

  /**
   * Adopt the pool automatically, but only into an empty configuration.
   *
   * The first agent report is the moment everything needed to configure the catalog
   * exists, and a fresh install has nothing to lose. Once there is a single root the
   * operator has made decisions -- which disks to catalogue, what to exclude -- and
   * silently adding to that is not something to do behind their back; the settings page
   * offers the same thing as a button from then on.
   */
  adoptIfUnconfigured(): DetectionResult | null {
    if (this.settings.get().catalog.roots.length > 0) return null;
    const plan = this.apply();
    return plan.added.length > 0 ? plan : null;
  }
}
