import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { openTestDatabase, type Db } from '../db/index.js';
import { createSilentLogger } from '../logger.js';
import { AlertService } from '../services/alert-service.js';
import { CatalogService } from '../services/catalog-service.js';
import { SettingsService } from '../services/settings-service.js';
import { createDuplicationWorkflow } from './catalog-duplication.js';
import { WorkflowManager } from './engine.js';

let db: Db;
let settings: SettingsService;
let alerts: AlertService;
let catalog: CatalogService;
let manager: WorkflowManager;

/**
 * Two pool parts of one pool, as the catalog sees them after a scan, with DrivePool's
 * own rule saying everything under Media is kept twice.
 */
function configurePoolRoots(): void {
  settings.update({
    duplication: {
      defaultLevel: 1,
      rules: [{ id: 'r1', poolId: 'hdd', path: 'Media', level: 2, source: 'drivepool', note: '' }],
    },
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

/** The physical disk behind a pool part, as reported by the agent's pool inventory. */
function setPartDisk(volumeLabel: string, deviceKey: string): void {
  db.prepare(
    `INSERT INTO pool_parts (pool_id, part_id, name, volume_label, device_key, last_seen_at)
     VALUES ('hdd', ?, ?, ?, ?, 'now')`,
  ).run(`hdd:${volumeLabel}`, volumeLabel, volumeLabel, deviceKey);
}

function addFile(rootId: string, relPath: string, size: number, duplication = 2): void {
  const key = relPath.toLowerCase();
  const name = relPath.split('/').pop()!;
  db.prepare(
    `INSERT INTO files (root_id, rel_path, path_key, dir_key, name, ext, size_bytes, mtime_ms,
                        duplication_level, first_seen_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, '', ?, 1, ?, 'now', 'now')`,
  ).run(
    rootId,
    relPath,
    key,
    key.includes('/') ? key.slice(0, key.lastIndexOf('/')) : '',
    name,
    size,
    duplication,
  );
}

/**
 * Pretend the recorded shortfall started `days` ago.
 *
 * The workflow stamps `since` with the clock, so ageing the row is the only way to
 * test the grace period without sleeping through it.
 */
function ageShortfall(days: number): void {
  db.prepare('UPDATE duplication_shortfall SET since = ?').run(
    new Date(Date.now() - days * 86_400_000).toISOString(),
  );
}

async function runDuplicationCheck() {
  const run = await manager.start('catalog.duplication', { force: true });
  await manager.drain();
  return manager.run(run.id)!;
}

beforeEach(() => {
  db = openTestDatabase();
  settings = new SettingsService(db);
  alerts = new AlertService(db);
  catalog = new CatalogService(db, settings);
  manager = new WorkflowManager({ db, settings, logger: createSilentLogger() });
  manager.register(createDuplicationWorkflow({ db, settings, catalog, alerts }));
});

afterEach(() => {
  db.close();
});

describe('duplication check', () => {
  it('raises nothing when every file has copies on the disks it should', async () => {
    configurePoolRoots();
    setPartDisk('DRIVEPOOL27', 'disk-4');
    setPartDisk('DRIVEPOOL28', 'disk-9');
    addFile('part27', 'Media/dup.mkv', 100);
    addFile('part28', 'Media/dup.mkv', 100);

    const run = await runDuplicationCheck();
    expect(run.state).toBe('completed');
    expect(run.stats).toMatchObject({ underDuplicated: 0, sharedDisks: 0 });
    expect(alerts.list({ category: 'duplication' }).total).toBe(0);
  });

  /**
   * A file is short of copies from the moment it is written until the balancer next
   * runs, so alerting on the snapshot means alerting on ordinary writes. The count is
   * still reported -- it is just not worth waking anyone for yet.
   */
  it('counts a freshly written file as short of copies without alerting', async () => {
    configurePoolRoots();
    setPartDisk('DRIVEPOOL27', 'disk-4');
    setPartDisk('DRIVEPOOL28', 'disk-9');
    addFile('part27', 'Media/needs-two.mkv', 400);

    const run = await runDuplicationCheck();
    expect(run.stats).toMatchObject({ underDuplicated: 1, underDuplicatedOverdue: 0 });
    expect(alerts.byKey('duplication:hdd:under')).toBeNull();
  });

  it('reports a file whose second copy never landed, once the balancer has had its chance', async () => {
    configurePoolRoots();
    setPartDisk('DRIVEPOOL27', 'disk-4');
    setPartDisk('DRIVEPOOL28', 'disk-9');
    addFile('part27', 'Media/needs-two.mkv', 400);

    await runDuplicationCheck();
    ageShortfall(3);
    const run = await runDuplicationCheck();

    expect(run.stats).toMatchObject({ underDuplicated: 1, underDuplicatedOverdue: 1 });
    const alert = alerts.byKey('duplication:hdd:under');
    expect(alert?.severity).toBe('warning');
    expect(alert?.state).toBe('open');
    expect(alert?.title).toContain('after 2 days');
    expect(alert?.context.example).toBe('Media/needs-two.mkv');
  });

  it('honours a configured grace period', async () => {
    configurePoolRoots();
    setPartDisk('DRIVEPOOL27', 'disk-4');
    setPartDisk('DRIVEPOOL28', 'disk-9');
    addFile('part27', 'Media/needs-two.mkv', 400);
    settings.update({ duplication: { underDuplicationGraceDays: 10 } });

    await runDuplicationCheck();
    ageShortfall(3);
    expect((await runDuplicationCheck()).stats.underDuplicatedOverdue).toBe(0);

    ageShortfall(11);
    expect((await runDuplicationCheck()).stats.underDuplicatedOverdue).toBe(1);
  });

  it('alerts on the snapshot when the grace period is zero', async () => {
    configurePoolRoots();
    setPartDisk('DRIVEPOOL27', 'disk-4');
    setPartDisk('DRIVEPOOL28', 'disk-9');
    addFile('part27', 'Media/needs-two.mkv', 400);
    settings.update({ duplication: { underDuplicationGraceDays: 0 } });

    const run = await runDuplicationCheck();
    expect(run.stats).toMatchObject({ underDuplicatedOverdue: 1 });
    const alert = alerts.byKey('duplication:hdd:under');
    expect(alert?.state).toBe('open');
    // No "after 0 days" nonsense in the one place the operator actually reads.
    expect(alert?.title).not.toContain('after');
  });

  it('resolves once the missing copy lands', async () => {
    configurePoolRoots();
    setPartDisk('DRIVEPOOL27', 'disk-4');
    setPartDisk('DRIVEPOOL28', 'disk-9');
    addFile('part27', 'Media/needs-two.mkv', 400);
    await runDuplicationCheck();
    ageShortfall(3);
    await runDuplicationCheck();
    expect(alerts.byKey('duplication:hdd:under')?.state).toBe('open');

    addFile('part28', 'Media/needs-two.mkv', 400);
    const run = await runDuplicationCheck();
    expect(run.stats).toMatchObject({ underDuplicated: 0, underDuplicatedOverdue: 0 });
    expect(alerts.byKey('duplication:hdd:under')?.state).toBe('resolved');
  });

  /**
   * The shortfall clock measures one continuous run of being short, not the total over
   * a file's life. A file that was fixed and later falls behind again is a new event
   * and gets the balancer's full grace period before anyone is told.
   */
  it('starts a fresh grace period when a file falls behind again', async () => {
    configurePoolRoots();
    setPartDisk('DRIVEPOOL27', 'disk-4');
    setPartDisk('DRIVEPOOL28', 'disk-9');
    addFile('part27', 'Media/needs-two.mkv', 400);
    await runDuplicationCheck();
    ageShortfall(30);

    // The copy lands: the shortfall row is dropped along with its 30-day-old clock.
    addFile('part28', 'Media/needs-two.mkv', 400);
    await runDuplicationCheck();
    expect(db.prepare('SELECT COUNT(*) AS n FROM duplication_shortfall').get()).toEqual({ n: 0 });

    // And is lost again. Short once more, but only just.
    db.prepare(`UPDATE files SET deleted_at = 'now' WHERE root_id = 'part28'`).run();
    const run = await runDuplicationCheck();
    expect(run.stats).toMatchObject({ underDuplicated: 1, underDuplicatedOverdue: 0 });
    // Nothing was ever raised: the first shortfall was inside its grace period too.
    expect(alerts.byKey('duplication:hdd:under')).toBeNull();
  });

  it('separates the stuck files from the ones still within their grace period', async () => {
    configurePoolRoots();
    setPartDisk('DRIVEPOOL27', 'disk-4');
    setPartDisk('DRIVEPOOL28', 'disk-9');
    addFile('part27', 'Media/stuck.mkv', 400);
    await runDuplicationCheck();
    ageShortfall(3);

    addFile('part27', 'Media/just-written.mkv', 100);
    const run = await runDuplicationCheck();

    expect(run.stats).toMatchObject({ underDuplicated: 2, underDuplicatedOverdue: 1 });
    const alert = alerts.byKey('duplication:hdd:under');
    expect(alert?.title).toContain('1 file');
    expect(alert?.detail).toContain('A further 1 file(s)');
    expect(alert?.context.example).toBe('Media/stuck.mkv');
  });

  /**
   * The pool roll-up had a chunk-boundary bug that undercounted copies, because it
   * grouped in JS and a group could straddle two chunks. This sweep lets SQLite do the
   * grouping, so LIMIT counts finished groups -- but that is a claim worth testing at
   * every awkward chunk size rather than asserting in a comment.
   */
  it('sweeps the same set whatever the chunk size', async () => {
    configurePoolRoots();
    setPartDisk('DRIVEPOOL27', 'disk-4');
    setPartDisk('DRIVEPOOL28', 'disk-9');
    // Nine short files and one properly duplicated, so a boundary can land anywhere.
    for (let i = 0; i < 9; i += 1) addFile('part27', `Media/short-${i}.mkv`, 100 + i);
    addFile('part27', 'Media/fine.mkv', 50);
    addFile('part28', 'Media/fine.mkv', 50);

    for (const chunkSize of [1, 2, 3, 7, 9, 10, 100]) {
      db.prepare('DELETE FROM duplication_shortfall').run();
      const result = await catalog.trackDuplicationShortfallYielding('hdd', 0, chunkSize);
      expect({ chunkSize, total: result.total, overdue: result.overdue }).toEqual({
        chunkSize,
        total: 9,
        overdue: 9,
      });
      const stored = db
        .prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM duplication_shortfall')
        .get()!;
      expect({ chunkSize, stored: stored.n }).toEqual({ chunkSize, stored: 9 });
    }
  });

  it('keeps the original start time as a file stays short across sweeps', async () => {
    configurePoolRoots();
    setPartDisk('DRIVEPOOL27', 'disk-4');
    setPartDisk('DRIVEPOOL28', 'disk-9');
    addFile('part27', 'Media/needs-two.mkv', 400);

    await runDuplicationCheck();
    ageShortfall(5);
    const since = db
      .prepare<[], { since: string }>('SELECT since FROM duplication_shortfall')
      .get()!.since;

    await runDuplicationCheck();
    await runDuplicationCheck();
    // Re-stamped on every sweep, the clock would restart and the alert never fire.
    expect(
      db.prepare<[], { since: string }>('SELECT since FROM duplication_shortfall').get()!.since,
    ).toBe(since);
  });

  // The condition that makes duplication a fiction: DrivePool thinks it wrote the two
  // copies to two disks, but both parts are on one drive, so one failure takes both.
  it('raises a critical alert when two pool parts share a physical disk', async () => {
    configurePoolRoots();
    setPartDisk('DRIVEPOOL27', 'disk-4');
    setPartDisk('DRIVEPOOL28', 'disk-4');
    addFile('part27', 'Media/dup.mkv', 100);
    addFile('part28', 'Media/dup.mkv', 100);

    const run = await runDuplicationCheck();
    expect(run.stats).toMatchObject({ sharedDisks: 1 });

    const alert = alerts.byKey('duplication:hdd:shared-disk:disk-4');
    expect(alert?.severity).toBe('critical');
    expect(alert?.title).toContain('2 parts on one physical disk');
    expect(alert?.context.parts).toContain('DRIVEPOOL27');

    // And the file itself is under-duplicated, because it only exists on one disk.
    expect(run.stats.underDuplicated).toBe(1);
  });

  it('clears the shared-disk alert once a part moves to its own disk', async () => {
    configurePoolRoots();
    setPartDisk('DRIVEPOOL27', 'disk-4');
    setPartDisk('DRIVEPOOL28', 'disk-4');
    addFile('part27', 'Media/dup.mkv', 100);
    addFile('part28', 'Media/dup.mkv', 100);
    await runDuplicationCheck();
    expect(alerts.byKey('duplication:hdd:shared-disk:disk-4')?.state).toBe('open');

    db.prepare(`UPDATE pool_parts SET device_key = 'disk-9' WHERE volume_label = 'DRIVEPOOL28'`).run();
    await runDuplicationCheck();
    expect(alerts.byKey('duplication:hdd:shared-disk:disk-4')?.state).toBe('resolved');
  });

  it('forgets the shortfall clock when the pool is no longer configured', async () => {
    configurePoolRoots();
    setPartDisk('DRIVEPOOL27', 'disk-4');
    setPartDisk('DRIVEPOOL28', 'disk-9');
    addFile('part27', 'Media/needs-two.mkv', 400);
    await runDuplicationCheck();
    expect(db.prepare('SELECT COUNT(*) AS n FROM duplication_shortfall').get()).toEqual({ n: 1 });

    // Without the prune these rows outlive the pool, and a pool of the same id coming
    // back later would inherit an aged clock and alert on its first sweep.
    settings.update({ catalog: { roots: [] } });
    await runDuplicationCheck();
    expect(db.prepare('SELECT COUNT(*) AS n FROM duplication_shortfall').get()).toEqual({ n: 0 });
  });

  it('drops the shortfall clock when under-duplication alerts are switched off', async () => {
    configurePoolRoots();
    setPartDisk('DRIVEPOOL27', 'disk-4');
    setPartDisk('DRIVEPOOL28', 'disk-9');
    addFile('part27', 'Media/needs-two.mkv', 400);
    await runDuplicationCheck();
    ageShortfall(30);

    settings.update({ duplication: { alertOnUnderDuplication: false } });
    await runDuplicationCheck();
    expect(db.prepare('SELECT COUNT(*) AS n FROM duplication_shortfall').get()).toEqual({ n: 0 });

    // Turning it back on starts the grace period again rather than firing at once on a
    // month-old clock nobody was watching.
    settings.update({ duplication: { alertOnUnderDuplication: true } });
    const run = await runDuplicationCheck();
    expect(run.stats).toMatchObject({ underDuplicated: 1, underDuplicatedOverdue: 0 });
    expect(alerts.byKey('duplication:hdd:under')).toBeNull();
  });

  it('checks the disk layout even when under-duplication alerts are switched off', async () => {
    configurePoolRoots();
    setPartDisk('DRIVEPOOL27', 'disk-4');
    setPartDisk('DRIVEPOOL28', 'disk-4');
    settings.update({ duplication: { alertOnUnderDuplication: false } });

    const run = await runDuplicationCheck();
    expect(run.stats).toMatchObject({ sharedDisks: 1, underDuplicated: 0 });
    expect(alerts.byKey('duplication:hdd:shared-disk:disk-4')?.state).toBe('open');
  });

  it('recomputes the space a duplicated file really occupies', async () => {
    settings.update({
      catalog: {
        roots: [
          { id: 'pool', name: 'HDD Pool', kind: 'pool', poolId: 'hdd', hostPath: 'J:\\' },
        ],
      },
      duplication: {
        defaultLevel: 1,
        rules: [{ id: 'r1', poolId: 'hdd', path: 'Media', level: 3, source: 'manual', note: '' }],
      },
    });
    addFile('pool', 'Media/a.mkv', 100, 1);
    addFile('pool', 'loose.txt', 10, 1);

    const run = await runDuplicationCheck();
    expect(run.stats.levelsUpdated).toBe(1);
    expect(catalog.rootStats('pool').effectiveBytes).toBe(310);
  });
});
