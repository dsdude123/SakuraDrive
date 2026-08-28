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
        { id: 'pool', name: 'HDD Pool', kind: 'pool', poolId: 'hdd', containerPath: '/mnt/pool' },
        {
          id: 'part27',
          name: 'DRIVEPOOL27',
          kind: 'poolpart',
          poolId: 'hdd',
          containerPath: '/mnt/parts/27',
          driveLabel: 'DRIVEPOOL27',
        },
        {
          id: 'part28',
          name: 'DRIVEPOOL28',
          kind: 'poolpart',
          poolId: 'hdd',
          containerPath: '/mnt/parts/28',
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
            containerPath: '/mnt/parts/27',
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
