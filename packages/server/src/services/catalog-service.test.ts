import { beforeEach, describe, expect, it } from 'vitest';
import { openTestDatabase, type Db } from '../db/index.js';
import { CatalogService } from './catalog-service.js';
import { SettingsService } from './settings-service.js';

let db: Db;
let settings: SettingsService;
let catalog: CatalogService;

/** Two pool parts of one pool, plus the pool's own logical root. */
function configurePoolRoots(): void {
  settings.update({
    catalog: {
      roots: [
        { id: 'pool', name: 'HDD Pool', kind: 'pool', poolId: 'hdd', hostPath: 'J:\\' },
        {
          id: 'part27',
          name: 'DRIVEPOOL27',
          kind: 'poolpart',
          poolId: 'hdd',
          hostPath: 'E:\\',
          driveLabel: 'DRIVEPOOL27',
        },
        {
          id: 'part28',
          name: 'DRIVEPOOL28',
          kind: 'poolpart',
          poolId: 'hdd',
          hostPath: 'F:\\',
          driveLabel: 'DRIVEPOOL28',
        },
      ],
    },
  });
}

function addFile(rootId: string, relPath: string, size: number, duplication = 1): void {
  const key = relPath.toLowerCase();
  const name = relPath.split('/').pop()!;
  const dot = name.lastIndexOf('.');
  db.prepare(
    `INSERT INTO files (root_id, rel_path, path_key, dir_key, name, ext, size_bytes, mtime_ms,
                        duplication_level, first_seen_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, 'now', 'now')`,
  ).run(
    rootId,
    relPath,
    key,
    key.includes('/') ? key.slice(0, key.lastIndexOf('/')) : '',
    name,
    dot > 0 ? name.slice(dot + 1).toLowerCase() : '',
    size,
    duplication,
  );
}

/**
 * Record which physical disk a pool part sits on, the way the agent's pool report does.
 * DrivePool's duplication promise is about disks, so the catalog resolves every part to
 * one before it counts copies.
 */
function setPartDisk(volumeLabel: string, deviceKey: string, poolId = 'hdd'): void {
  db.prepare(
    `INSERT INTO pool_parts (pool_id, part_id, name, volume_label, device_key, last_seen_at)
     VALUES (?, ?, ?, ?, ?, 'now')`,
  ).run(poolId, `${poolId}:${volumeLabel}`, volumeLabel, volumeLabel, deviceKey);
}

beforeEach(() => {
  db = openTestDatabase();
  settings = new SettingsService(db);
  catalog = new CatalogService(db, settings);
});

describe('directory rollups', () => {
  beforeEach(() => {
    addFile('pool', 'Media/Movies/a.mkv', 100, 2);
    addFile('pool', 'Media/Movies/4K/b.mkv', 200, 2);
    addFile('pool', 'Media/Music/c.flac', 50, 1);
    addFile('pool', 'readme.txt', 10, 1);
    catalog.rebuildDirStats('pool');
  });

  it('rolls subtree sizes into every ancestor', () => {
    const top = catalog.listDirectory('pool', '');
    const media = top.entries.find((entry) => entry.name === 'Media')!;
    expect(media.sizeBytes).toBe(350);
    expect(media.fileCount).toBe(3);
    // 100x2 + 200x2 + 50x1
    expect(media.effectiveBytes).toBe(650);
  });

  it('lists files alongside subdirectories, largest first', () => {
    const movies = catalog.listDirectory('pool', 'Media/Movies');
    expect(movies.entries.map((entry) => entry.name)).toEqual(['4K', 'a.mkv']);
    expect(movies.entries[0]!.kind).toBe('directory');
    expect(movies.entries[1]!.duplicationLevel).toBe(2);
  });

  it('can sort by name', () => {
    const media = catalog.listDirectory('pool', 'Media', { sort: 'name' });
    expect(media.entries.map((entry) => entry.name)).toEqual(['Movies', 'Music']);
  });

  it('creates rollups for directories that hold only subdirectories', () => {
    const rows = db.prepare('SELECT dir_key FROM dir_stats WHERE root_id = ?').all('pool');
    expect((rows as Array<{ dir_key: string }>).map((row) => row.dir_key)).toContain('media');
  });

  it('excludes deleted files from the rollups', () => {
    db.prepare(`UPDATE files SET deleted_at = 'now' WHERE rel_path = 'Media/Movies/a.mkv'`).run();
    catalog.rebuildDirStats('pool');
    const media = catalog.listDirectory('pool', '').entries.find((entry) => entry.name === 'Media')!;
    expect(media.sizeBytes).toBe(250);
  });

  it('preserves the on-disk casing of directory names', () => {
    const top = catalog.listDirectory('pool', '');
    expect(top.entries.map((entry) => entry.name)).toContain('Media');
  });
});

describe('search', () => {
  beforeEach(() => {
    addFile('pool', 'Media/Movies/Big Buck Bunny.mkv', 5000);
    addFile('pool', 'Media/Music/song.flac', 50);
    addFile('pool', 'Docs/notes.txt', 10);
  });

  it('matches case-insensitively on any part of the path', () => {
    expect(catalog.searchFiles({ text: 'bunny' }).total).toBe(1);
    expect(catalog.searchFiles({ text: 'media/' }).total).toBe(2);
  });

  it('filters by extension and minimum size', () => {
    expect(catalog.searchFiles({ ext: 'flac' }).total).toBe(1);
    expect(catalog.searchFiles({ ext: '.flac' }).total).toBe(1);
    expect(catalog.searchFiles({ minSizeBytes: 100 }).total).toBe(1);
  });

  it('hides deleted files unless asked for them', () => {
    db.prepare(`UPDATE files SET deleted_at = 'now' WHERE name = 'notes.txt'`).run();
    expect(catalog.searchFiles({}).total).toBe(2);
    expect(catalog.searchFiles({ includeDeleted: true }).total).toBe(3);
  });

  it('returns the largest files first', () => {
    expect(catalog.searchFiles({}).files[0]!.name).toBe('Big Buck Bunny.mkv');
  });
});

describe('disaster recovery', () => {
  it('reports exactly which files a dead disk takes with it', () => {
    configurePoolRoots();
    // Duplicated: on both parts. Unduplicated: only on part27.
    addFile('part27', 'Media/dup.mkv', 100);
    addFile('part28', 'Media/dup.mkv', 100);
    addFile('part27', 'Media/only-here.mkv', 500);
    addFile('part28', 'Media/elsewhere.mkv', 700);

    const impact = catalog.diskLossImpact('part27');
    expect(impact.label).toBe('DRIVEPOOL27');
    expect(impact.unrecoverableFiles).toBe(1);
    expect(impact.unrecoverableBytes).toBe(500);
    expect(impact.duplicatedFiles).toBe(1);
    expect(impact.duplicatedBytes).toBe(100);

    const { files, total } = catalog.listUnrecoverableFiles('part27');
    expect(total).toBe(1);
    expect(files[0]!.relPath).toBe('Media/only-here.mkv');
  });

  it('matches paths case-insensitively across pool parts', () => {
    configurePoolRoots();
    addFile('part27', 'Media/Dup.mkv', 100);
    addFile('part28', 'media/dup.MKV', 100);
    expect(catalog.diskLossImpact('part27').unrecoverableFiles).toBe(0);
  });

  it('falls back to duplication rules when no sibling parts are catalogued', () => {
    settings.update({
      catalog: {
        roots: [
          {
            id: 'part27',
            name: 'DRIVEPOOL27',
            kind: 'poolpart',
            poolId: 'hdd',
            hostPath: 'E:\\',
            driveLabel: 'DRIVEPOOL27',
          },
        ],
      },
    });
    addFile('part27', 'Media/unduplicated.mkv', 500, 1);
    addFile('part27', 'Media/duplicated.mkv', 100, 2);

    const impact = catalog.diskLossImpact('part27');
    expect(impact.unrecoverableFiles).toBe(1);
    expect(impact.unrecoverableBytes).toBe(500);
    expect(impact.duplicatedFiles).toBe(1);
  });

  it('returns an empty impact for an unknown root', () => {
    expect(catalog.diskLossImpact('nope').unrecoverableFiles).toBe(0);
  });

  it('finds files stored on fewer parts than configured', () => {
    configurePoolRoots();
    addFile('part27', 'Media/needs-two.mkv', 400, 2);
    addFile('part27', 'Media/has-two.mkv', 100, 2);
    addFile('part28', 'Media/has-two.mkv', 100, 2);

    const under = catalog.findUnderDuplicated('hdd');
    expect(under).toHaveLength(1);
    expect(under[0]).toMatchObject({
      relPath: 'Media/needs-two.mkv',
      expectedLevel: 2,
      observedLevel: 1,
    });
  });

  it('reports nothing when no pool parts are catalogued', () => {
    expect(catalog.findUnderDuplicated('hdd')).toEqual([]);
  });

  // DrivePool's duplication setting is a promise about *physical disks*: two copies are
  // only two copies if they are on two drives. If both pool parts happen to be on one
  // disk, that disk's death takes both, and the tool has to say so.
  describe('when two pool parts share a physical disk', () => {
    beforeEach(() => {
      configurePoolRoots();
      setPartDisk('DRIVEPOOL27', 'disk-4');
      setPartDisk('DRIVEPOOL28', 'disk-4');
    });

    it('counts one copy, not two, for a file written to both parts', () => {
      addFile('part27', 'Media/dup.mkv', 100, 2);
      addFile('part28', 'Media/dup.mkv', 100, 2);

      const under = catalog.findUnderDuplicated('hdd');
      expect(under).toHaveLength(1);
      expect(under[0]).toMatchObject({ relPath: 'Media/dup.mkv', observedLevel: 1, expectedLevel: 2 });
    });

    it('loses both copies with the disk', () => {
      addFile('part27', 'Media/dup.mkv', 100, 2);
      addFile('part28', 'Media/dup.mkv', 100, 2);
      addFile('part27', 'Media/only-here.mkv', 500);

      const impact = catalog.diskLossImpact('part27');
      expect(impact.deviceKey).toBe('disk-4');
      expect(impact.sharedDiskRootIds).toEqual(['part28']);
      // Two distinct paths, counted once each despite dup.mkv having two rows.
      expect(impact.unrecoverableFiles).toBe(2);
      expect(impact.unrecoverableBytes).toBe(600);
      expect(impact.duplicatedFiles).toBe(0);

      const { files, total } = catalog.listUnrecoverableFiles('part27');
      expect(total).toBe(2);
      expect(files.map((file) => file.relPath)).toEqual(['Media/only-here.mkv', 'Media/dup.mkv']);
    });

    it('reports the parts sharing the disk so the layout can be fixed', () => {
      const collisions = catalog.findPartsSharingADisk('hdd');
      expect(collisions).toHaveLength(1);
      expect(collisions[0]!.deviceKey).toBe('disk-4');
      expect(collisions[0]!.rootIds.sort()).toEqual(['part27', 'part28']);
      expect(collisions[0]!.labels.sort()).toEqual(['DRIVEPOOL27', 'DRIVEPOOL28']);
    });

    it('shows the pool view a duplicated file occupying only one disk', () => {
      addFile('part27', 'Media/dup.mkv', 100, 2);
      addFile('part28', 'Media/dup.mkv', 100, 2);
      catalog.rebuildPoolDirStats('hdd');
      const entry = catalog
        .listDirectory('pool:hdd', 'Media')
        .entries.find((candidate) => candidate.name === 'dup.mkv')!;
      // Observed copies, which is what the pool view shows as the duplication level.
      expect(entry.duplicationLevel).toBe(1);
    });
  });

  it('keeps parts on different disks as separate failure domains', () => {
    configurePoolRoots();
    setPartDisk('DRIVEPOOL27', 'disk-4');
    setPartDisk('DRIVEPOOL28', 'disk-9');
    addFile('part27', 'Media/dup.mkv', 100, 2);
    addFile('part28', 'Media/dup.mkv', 100, 2);

    expect(catalog.findPartsSharingADisk('hdd')).toEqual([]);
    expect(catalog.findUnderDuplicated('hdd')).toEqual([]);
    const impact = catalog.diskLossImpact('part27');
    expect(impact.sharedDiskRootIds).toEqual([]);
    expect(impact.unrecoverableFiles).toBe(0);
    expect(impact.duplicatedFiles).toBe(1);
  });

  it('treats a part whose disk is unknown as a failure domain of its own', () => {
    // Two unknowns must not be assumed to be the same disk: that would report data as
    // lost when it is fine. The conservative reading of missing data is "separate".
    configurePoolRoots();
    addFile('part27', 'Media/dup.mkv', 100, 2);
    addFile('part28', 'Media/dup.mkv', 100, 2);

    expect(catalog.findPartsSharingADisk('hdd')).toEqual([]);
    expect(catalog.diskLossImpact('part27').unrecoverableFiles).toBe(0);
  });
});

describe('virtual pool view', () => {
  // The pool is derived from its member disks rather than scanned itself, so a file
  // duplicated across two disks must appear once, sized once, but counted as 2 copies.
  beforeEach(() => {
    configurePoolRoots();
    addFile('part27', 'Media/Movies/dup.mkv', 100);
    addFile('part28', 'Media/Movies/dup.mkv', 100);
    addFile('part27', 'Media/Movies/only27.mkv', 500);
    addFile('part28', 'Media/Music/only28.flac', 50);
    catalog.rebuildPoolDirStats('hdd');
  });

  it('lists a pool for every set of catalogued member disks', () => {
    const pools = catalog.virtualPools();
    expect(pools).toHaveLength(1);
    expect(pools[0]).toMatchObject({ poolId: 'hdd', rootId: 'pool:hdd', name: 'HDD Pool' });
    expect(pools[0]!.partRootIds.sort()).toEqual(['part27', 'part28']);
  });

  it('counts a duplicated file once, at its real size', () => {
    const stats = catalog.rootStats('pool:hdd');
    expect(stats.files).toBe(3);
    expect(stats.bytes).toBe(650);
  });

  it('reports what the pool actually spends, using copies present', () => {
    // dup.mkv is on both disks (100 x 2), the other two are on one each.
    expect(catalog.rootStats('pool:hdd').effectiveBytes).toBe(200 + 500 + 50);
  });

  it('browses the pool as one tree', () => {
    const top = catalog.listDirectory('pool:hdd', '');
    expect(top.entries.map((entry) => entry.name)).toEqual(['Media']);
    expect(top.entries[0]!.fileCount).toBe(3);

    const movies = catalog.listDirectory('pool:hdd', 'Media/Movies');
    expect(movies.entries.map((entry) => entry.name).sort()).toEqual(['dup.mkv', 'only27.mkv']);
  });

  it('reports observed copies as the duplication level in the pool view', () => {
    const movies = catalog.listDirectory('pool:hdd', 'Media/Movies');
    const dup = movies.entries.find((entry) => entry.name === 'dup.mkv')!;
    const single = movies.entries.find((entry) => entry.name === 'only27.mkv')!;
    expect(dup.duplicationLevel).toBe(2);
    expect(dup.effectiveBytes).toBe(200);
    expect(single.duplicationLevel).toBe(1);
  });

  it('collapses duplicates when searching the pool', () => {
    expect(catalog.searchFiles({ rootId: 'pool:hdd', text: 'dup.mkv' }).total).toBe(1);
    // Searching one member disk still shows only that disk's copy.
    expect(catalog.searchFiles({ rootId: 'part27', text: 'dup.mkv' }).total).toBe(1);
    expect(catalog.searchFiles({ text: 'dup.mkv' }).total).toBe(2);
  });

  it('returns nothing for a pool with no catalogued members', () => {
    expect(catalog.rootStats('pool:nope').files).toBe(0);
    expect(catalog.searchFiles({ rootId: 'pool:nope' }).total).toBe(0);
  });

  it('rebuilds only the pool the changed disk belongs to', () => {
    addFile('part27', 'Media/new.mkv', 7);
    catalog.rebuildPoolsContaining('part27');
    expect(catalog.rootStats('pool:hdd').files).toBe(4);
  });

  it('ignores a root that is not part of a pool', () => {
    expect(() => catalog.rebuildPoolsContaining('pool')).not.toThrow();
  });
});

describe('what the pool has lost', () => {
  beforeEach(() => {
    configurePoolRoots();
    addFile('part27', 'Media/dup.mkv', 100);
    addFile('part28', 'Media/dup.mkv', 100);
    addFile('part27', 'Media/only27.mkv', 500);
  });

  it('does not count a file that survives on another disk', () => {
    // DRIVEPOOL27 died: its copy of dup.mkv is gone, but DRIVEPOOL28 still has it.
    db.prepare(`UPDATE files SET deleted_at = 'now' WHERE root_id = 'part27'`).run();
    const missing = catalog.poolMissingFiles('hdd');
    expect(missing.total).toBe(1);
    expect(missing.files[0]!.relPath).toBe('Media/only27.mkv');
    expect(missing.files[0]!.sizeBytes).toBe(500);
  });

  it('reports nothing while every path still has a copy', () => {
    expect(catalog.poolMissingFiles('hdd').total).toBe(0);
  });

  it('counts a path only once when it is gone from every disk', () => {
    db.prepare(`UPDATE files SET deleted_at = 'now' WHERE path_key = 'media/dup.mkv'`).run();
    const missing = catalog.poolMissingFiles('hdd');
    expect(missing.total).toBe(1);
    expect(missing.files[0]!.relPath).toBe('Media/dup.mkv');
  });

  it('returns nothing for an unknown pool', () => {
    expect(catalog.poolMissingFiles('nope').total).toBe(0);
  });
});

describe('duplication refresh', () => {
  it('recomputes levels from the current rules', () => {
    addFile('pool', 'Media/a.mkv', 100, 1);
    addFile('pool', 'Other/b.mkv', 100, 1);
    const changed = catalog.refreshDuplicationLevels(
      'pool',
      [{ path: 'Media', level: 3, source: 'manual' }],
      1,
    );
    expect(changed).toBe(1);
    const stats = catalog.rootStats('pool');
    expect(stats.bytes).toBe(200);
    expect(stats.effectiveBytes).toBe(400);
  });
});

describe('hash queue', () => {
  beforeEach(() => {
    addFile('pool', 'a.mkv', 100);
    addFile('pool', 'b.mkv', 200);
  });

  it('queues never-hashed files first', () => {
    const queue = catalog.hashQueue('pool', 90, 10);
    expect(queue).toHaveLength(2);
    expect(catalog.countHashQueue('pool', 90)).toBe(2);
  });

  it('drops a file once it is hashed', () => {
    const [first] = catalog.hashQueue('pool', 90, 10);
    catalog.recordHash(first!.id, 'abc', 'sha256', first!.sizeBytes, first!.mtimeMs);
    expect(catalog.countHashQueue('pool', 90)).toBe(1);
  });

  it('re-queues a file whose size or timestamp changed', () => {
    const [first] = catalog.hashQueue('pool', 90, 10);
    catalog.recordHash(first!.id, 'abc', 'sha256', first!.sizeBytes, first!.mtimeMs);
    db.prepare('UPDATE files SET size_bytes = 999 WHERE id = ?').run(first!.id);
    expect(catalog.countHashQueue('pool', 90)).toBe(2);
  });

  it('honours the size bounds', () => {
    expect(catalog.hashQueue('pool', 90, 10, 150)).toHaveLength(1);
    expect(catalog.hashQueue('pool', 90, 10, 0, 150)).toHaveLength(1);
  });

  it('skips files with a recorded read error until it is cleared', () => {
    const [first] = catalog.hashQueue('pool', 90, 10);
    catalog.recordHashError(first!.id, 'permission denied');
    expect(catalog.countHashQueue('pool', 90)).toBe(1);
    expect(catalog.clearHashErrors('pool')).toBe(1);
    expect(catalog.countHashQueue('pool', 90)).toBe(2);
  });
});

describe('change retention', () => {
  it('keeps changes for the most recent runs only', () => {
    for (let run = 1; run <= 5; run += 1) {
      db.prepare('INSERT INTO catalog_runs (id, root_id, started_at) VALUES (?, ?, ?)').run(
        run,
        'pool',
        'now',
      );
      db.prepare(
        `INSERT INTO catalog_changes (run_id, root_id, rel_path, kind, detected_at)
         VALUES (?, 'pool', 'a.txt', 'created', 'now')`,
      ).run(run);
    }
    expect(catalog.pruneChanges(2)).toBe(3);
    expect(catalog.listChanges({}).total).toBe(2);
  });
});

describe('purgeRoot', () => {
  it('removes every trace of a root that was deleted from settings', () => {
    addFile('pool', 'a.mkv', 100);
    catalog.rebuildDirStats('pool');
    db.prepare(
      `INSERT INTO bitrot_findings (root_id, rel_path, path_key, expected_hash, actual_hash, hash_algorithm, detected_at)
       VALUES ('pool', 'a.mkv', 'a.mkv', 'x', 'y', 'sha256', 'now')`,
    ).run();

    expect(catalog.purgeRoot('pool')).toBe(1);
    expect(catalog.rootStats('pool').files).toBe(0);
    expect(
      (db.prepare('SELECT COUNT(*) AS n FROM dir_stats').get() as { n: number }).n,
    ).toBe(0);
    expect(
      (db.prepare('SELECT COUNT(*) AS n FROM bitrot_findings').get() as { n: number }).n,
    ).toBe(0);
  });
});

/**
 * What the interface costs the server to draw.
 *
 * better-sqlite3 is synchronous, so every query here is time the process spends serving
 * nobody -- not other pages, not the health check, and not the agent posting batches.
 * A catalog that had just been populated made the whole thing nearly unusable, and the
 * cause was two aggregates over every row on every member disk, run per page load.
 */
describe('the cost of root statistics', () => {
  const part = (id: string) => ({
    id,
    name: id.toUpperCase(),
    kind: 'poolpart' as const,
    poolId: 'hdd',
    agentHostname: '',
    hostPath: `\\\\?\\Volume{${id}}\\PoolPart.hdd`,
    driveLabel: id.toUpperCase(),
    enabled: true,
    hashEnabled: true,
    includeGlobs: [],
    excludeGlobs: [],
    minHashSizeBytes: 0,
    maxHashSizeBytes: 0,
  });

  const seed = (service: CatalogService, settings: SettingsService, disks: string[]) => {
    settings.update({ catalog: { roots: disks.map(part) } });
    for (const id of disks) {
      const root = settings.get().catalog.roots.find((r) => r.id === id)!;
      const runId = service.beginRun(id, 1);
      service.recordAgentFiles(runId, root, [
        { relPath: 'Media/a.mkv', sizeBytes: 10, mtimeMs: 1, ctimeMs: 1 },
        { relPath: 'Media/b.mkv', sizeBytes: 20, mtimeMs: 1, ctimeMs: 1 },
      ]);
      service.finishRun(runId, 'completed');
      service.rebuildDirStats(id);
    }
    service.rebuildPoolDirStats('hdd');
  };

  it('counts what the pool has lost every copy of', () => {
    const database = openTestDatabase();
    const config = new SettingsService(database);
    const service = new CatalogService(database, config);
    seed(service, config, ['d1', 'd2']);

    expect(service.rootStats('pool:hdd').deletedFiles).toBe(0);

    // Gone from one disk only: the pool still serves it.
    const d1 = config.get().catalog.roots.find((r) => r.id === 'd1')!;
    const runId = service.beginRun('d1', 1);
    service.recordAgentFiles(runId, d1, [
      { relPath: 'Media/a.mkv', sizeBytes: 10, mtimeMs: 1, ctimeMs: 1 },
    ]);
    service.markMissingAsDeleted(runId, 'd1');
    service.finishRun(runId, 'completed');
    service.rebuildPoolDirStats('hdd');
    service.invalidateStats();
    expect(service.rootStats('pool:hdd').deletedFiles).toBe(0);

    // Gone from the second disk too: now the pool has lost it.
    const d2 = config.get().catalog.roots.find((r) => r.id === 'd2')!;
    const runId2 = service.beginRun('d2', 1);
    service.recordAgentFiles(runId2, d2, [
      { relPath: 'Media/a.mkv', sizeBytes: 10, mtimeMs: 1, ctimeMs: 1 },
    ]);
    service.markMissingAsDeleted(runId2, 'd2');
    service.finishRun(runId2, 'completed');
    service.rebuildPoolDirStats('hdd');
    service.invalidateStats();
    expect(service.rootStats('pool:hdd').deletedFiles).toBe(1);
    database.close();
  });

  // Two copies of one file are one hashed file as far as the pool is concerned.
  it('counts a hashed file once, not once per disk holding it', () => {
    const database = openTestDatabase();
    const config = new SettingsService(database);
    const service = new CatalogService(database, config);
    seed(service, config, ['d1', 'd2']);

    for (const id of ['d1', 'd2']) {
      const row = database
        .prepare<[string], { id: number }>(
          "SELECT id FROM files WHERE root_id = ? AND rel_path = 'Media/a.mkv'",
        )
        .get(id)!;
      database.prepare('UPDATE files SET hash = ? WHERE id = ?').run('abc', row.id);
    }
    service.rebuildPoolDirStats('hdd');
    service.invalidateStats();

    expect(service.rootStats('pool:hdd').hashedFiles).toBe(1);
    database.close();
  });

  it('reports the pool as only as current as its stalest member', () => {
    const database = openTestDatabase();
    const config = new SettingsService(database);
    const service = new CatalogService(database, config);
    seed(service, config, ['d1', 'd2']);

    const stats = service.rootStats('pool:hdd');
    const members = ['d1', 'd2'].map((id) => service.rootStats(id).lastScanAt);
    expect(stats.lastScanAt).toBe(members.slice().sort()[0]);
    database.close();
  });

  // The interface polls, so a repeated call must not repeat the work.
  it('serves a repeated call from memory', () => {
    const database = openTestDatabase();
    const config = new SettingsService(database);
    const service = new CatalogService(database, config, () => 1_000_000);
    seed(service, config, ['d1']);

    expect(service.rootStats('d1').files).toBe(2);

    // Behind the memo, so this is invisible until something invalidates it.
    database.prepare("DELETE FROM files WHERE root_id = 'd1'").run();
    expect(service.rootStats('d1').files).toBe(2);

    service.invalidateStats();
    expect(service.rootStats('d1').files).toBe(0);
    database.close();
  });

  /**
   * The memo is an optimisation, never a source of wrong answers: a scan that has just
   * finished must not report the numbers from before it ran.
   */
  it('shows a write immediately, without waiting for the window', () => {
    const database = openTestDatabase();
    const config = new SettingsService(database);
    // A clock that never advances, so only invalidation can refresh the answer.
    const service = new CatalogService(database, config, () => 1_000_000);
    seed(service, config, ['d1']);
    expect(service.rootStats('d1').files).toBe(2);

    const root = config.get().catalog.roots[0]!;
    const runId = service.beginRun('d1', 1);
    service.recordAgentFiles(runId, root, [
      { relPath: 'Media/c.mkv', sizeBytes: 30, mtimeMs: 1, ctimeMs: 1 },
    ]);
    expect(service.rootStats('d1').files).toBe(3);

    service.finishRun(runId, 'completed');
    expect(service.rootStats('d1').files).toBe(3);
    database.close();
  });

  // The window is the backstop for anything that reaches the database another way.
  it('refreshes on its own once the window passes', () => {
    const database = openTestDatabase();
    const config = new SettingsService(database);
    let now = 1_000_000;
    const service = new CatalogService(database, config, () => now);
    seed(service, config, ['d1']);
    expect(service.rootStats('d1').files).toBe(2);

    database.prepare("DELETE FROM files WHERE root_id = 'd1'").run();
    expect(service.rootStats('d1').files).toBe(2);

    now += 6_000;
    expect(service.rootStats('d1').files).toBe(0);
    database.close();
  });

  // Asking for the count should not also run the query that finds the rows.
  it('does not fetch rows when none were asked for', () => {
    const database = openTestDatabase();
    const config = new SettingsService(database);
    const service = new CatalogService(database, config);
    seed(service, config, ['d1', 'd2']);

    const result = service.poolMissingFiles('hdd', 0, 0);
    expect(result.files).toEqual([]);
    expect(result.total).toBe(0);
    database.close();
  });
});
