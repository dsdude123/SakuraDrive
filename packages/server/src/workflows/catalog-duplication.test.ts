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

  it('reports a file whose second copy never landed', async () => {
    configurePoolRoots();
    setPartDisk('DRIVEPOOL27', 'disk-4');
    setPartDisk('DRIVEPOOL28', 'disk-9');
    addFile('part27', 'Media/needs-two.mkv', 400);

    const run = await runDuplicationCheck();
    expect(run.stats).toMatchObject({ underDuplicated: 1 });
    const alert = alerts.byKey('duplication:hdd:under');
    expect(alert?.severity).toBe('warning');
    expect(alert?.state).toBe('open');
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
