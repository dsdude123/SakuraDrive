import { beforeEach, describe, expect, it } from 'vitest';
import type { ScanRoot } from '@sakuradrive/shared';
import { openTestDatabase, nowIso, type Db } from '../db/index.js';
import {
  RootDetectionService,
  planRootDetection,
  rootIdForPart,
  rootNameForPart,
  type DetectedPart,
} from './root-detection.js';
import { SettingsService } from './settings-service.js';

const part = (over: Partial<DetectedPart> = {}): DetectedPart => ({
  poolId: 'd304fce8',
  volumeLabel: 'DRIVEPOOL16',
  driveLetter: null,
  path: '\\\\?\\Volume{9f3a}\\PoolPart.d304fce8',
  missing: 0,
  ...over,
});

describe('planning what to add', () => {
  it('makes a pool-part root out of a reported member disk', () => {
    const plan = planRootDetection([part()], []);
    expect(plan.added).toHaveLength(1);

    const root = plan.added[0]!;
    expect(root.kind).toBe('poolpart');
    expect(root.name).toBe('DRIVEPOOL16');
    expect(root.driveLabel).toBe('DRIVEPOOL16');
    expect(root.poolId).toBe('d304fce8');
    expect(root.hostPath).toBe('\\\\?\\Volume{9f3a}\\PoolPart.d304fce8');
    expect(root.enabled).toBe(true);
    expect(root.hashEnabled).toBe(true);
  });

  // Seventeen disks is seventeen roots; that is the whole point.
  it('adds one root per member disk', () => {
    const parts = Array.from({ length: 14 }, (_unused, index) =>
      part({ volumeLabel: `DRIVEPOOL${index}`, path: `\\\\?\\Volume{${index}}\\PoolPart.d304` }),
    );
    expect(planRootDetection(parts, []).added).toHaveLength(14);
  });

  it('groups every part of one pool under the same pool id', () => {
    const plan = planRootDetection(
      [
        part({ poolId: 'hdd', path: '\\\\?\\Volume{1}\\PoolPart.a' }),
        part({ poolId: 'hdd', path: '\\\\?\\Volume{2}\\PoolPart.a' }),
        part({ poolId: 'ssd', path: 'D:\\PoolPart.b', driveLetter: 'D' }),
      ],
      [],
    );
    expect(plan.added.map((root) => root.poolId)).toEqual(['hdd', 'hdd', 'ssd']);
  });

  // Running it twice must not double the catalog.
  it('leaves a disk that already has a root alone', () => {
    const first = planRootDetection([part()], []);
    const second = planRootDetection([part()], first.added);
    expect(second.added).toHaveLength(0);
    expect(second.alreadyConfigured).toBe(1);
  });

  it('matches an existing root regardless of path casing', () => {
    const existing = [{ ...planRootDetection([part()], [])!.added[0]!, hostPath: '\\\\?\\VOLUME{9F3A}\\POOLPART.D304FCE8' }];
    expect(planRootDetection([part()], existing as ScanRoot[]).added).toHaveLength(0);
  });

  /**
   * A root for a disk that is not there starts a scan that fails, and on an existing
   * root the sweep that follows would read every file on it as deleted.
   */
  it('will not adopt a disk DrivePool reports as missing', () => {
    const plan = planRootDetection([part({ missing: 1 })], []);
    expect(plan.added).toHaveLength(0);
    expect(plan.skippedMissing).toBe(1);
  });

  it('ignores a part with no path at all', () => {
    expect(planRootDetection([part({ path: null })], []).added).toHaveLength(0);
  });

  it('never adds two roots for one path', () => {
    expect(planRootDetection([part(), part()], []).added).toHaveLength(1);
  });
});

describe('naming and identity', () => {
  it('uses the label on the caddy', () => {
    expect(rootNameForPart(part())).toBe('DRIVEPOOL16');
  });

  it('falls back to the drive letter, then the path', () => {
    expect(rootNameForPart(part({ volumeLabel: null, driveLetter: 'D' }))).toBe('D:');
    expect(rootNameForPart(part({ volumeLabel: null, driveLetter: null, path: 'X:\\PoolPart.a' }))).toBe(
      'X:\\PoolPart.a',
    );
  });

  // The id keys the catalog, so it must not move when a disk is relabelled.
  it('derives a stable id from the path, not the label', () => {
    const path = '\\\\?\\Volume{9f3a}\\PoolPart.d304fce8';
    expect(rootIdForPart(path)).toBe(rootIdForPart(path));
    expect(rootIdForPart(path)).toBe(rootIdForPart(path.toUpperCase()));
    expect(rootIdForPart(path)).not.toBe(rootIdForPart('\\\\?\\Volume{other}\\PoolPart.d304fce8'));
  });
});

describe('against the database', () => {
  let db: Db;
  let settings: SettingsService;
  let detection: RootDetectionService;

  const recordPart = (label: string, path: string, missing = 0) => {
    db.prepare(
      `INSERT INTO pool_parts (pool_id, part_id, name, volume_label, drive_letter, path,
                               size_bytes, free_bytes, missing, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('hdd', path, label, label, null, path, 1000, 500, missing, nowIso());
  };

  beforeEach(() => {
    db = openTestDatabase();
    settings = new SettingsService(db);
    detection = new RootDetectionService(db, settings);
  });

  it('adopts the pool into an empty configuration', () => {
    recordPart('DRIVEPOOL4', '\\\\?\\Volume{1}\\PoolPart.a');
    recordPart('DRIVEPOOL9', '\\\\?\\Volume{2}\\PoolPart.a');

    const adopted = detection.adoptIfUnconfigured();
    expect(adopted?.added).toHaveLength(2);
    expect(settings.get().catalog.roots.map((root) => root.name).sort()).toEqual([
      'DRIVEPOOL4',
      'DRIVEPOOL9',
    ]);
  });

  /**
   * Once there is a single root the operator has made decisions -- which disks to
   * catalogue, what to exclude -- and adding to that silently is not something to do
   * behind their back. The settings page offers the same thing as a button.
   */
  it('will not touch a configuration that already has a root', () => {
    recordPart('DRIVEPOOL4', '\\\\?\\Volume{1}\\PoolPart.a');
    detection.adoptIfUnconfigured();
    recordPart('DRIVEPOOL9', '\\\\?\\Volume{2}\\PoolPart.a');

    expect(detection.adoptIfUnconfigured()).toBeNull();
    expect(settings.get().catalog.roots).toHaveLength(1);

    // But asking explicitly still works.
    expect(detection.apply().added).toHaveLength(1);
    expect(settings.get().catalog.roots).toHaveLength(2);
  });

  it('says there is nothing to adopt when no agent has reported', () => {
    expect(detection.adoptIfUnconfigured()).toBeNull();
    expect(settings.get().catalog.roots).toHaveLength(0);
  });

  it('previews without changing anything', () => {
    recordPart('DRIVEPOOL4', '\\\\?\\Volume{1}\\PoolPart.a');
    expect(detection.preview().added).toHaveLength(1);
    expect(settings.get().catalog.roots).toHaveLength(0);
  });

  it('reports the disks it declined to adopt', () => {
    recordPart('DRIVEPOOL4', '\\\\?\\Volume{1}\\PoolPart.a');
    recordPart('DEAD', '\\\\?\\Volume{2}\\PoolPart.a', 1);

    const plan = detection.apply();
    expect(plan.added).toHaveLength(1);
    expect(plan.skippedMissing).toBe(1);
  });

  it('is idempotent', () => {
    recordPart('DRIVEPOOL4', '\\\\?\\Volume{1}\\PoolPart.a');
    detection.apply();
    detection.apply();
    expect(settings.get().catalog.roots).toHaveLength(1);
  });
});
