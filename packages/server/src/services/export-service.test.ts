import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openTestDatabase, type Db } from '../db/index.js';
import { createSilentLogger } from '../logger.js';
import { ExportService } from './export-service.js';
import { SettingsService } from './settings-service.js';
import { createTempDir } from '../test/helpers.js';

let db: Db;
let settings: SettingsService;
let exports: ExportService;
let temp: ReturnType<typeof createTempDir>;

function seed(fileCount = 3): void {
  const insert = db.prepare(
    `INSERT INTO files (root_id, rel_path, path_key, dir_key, name, size_bytes, mtime_ms, hash, first_seen_at, last_seen_at)
     VALUES ('r1', ?, ?, 'media', ?, ?, 1700000000000, ?, 'now', 'now')`,
  );
  for (let i = 0; i < fileCount; i += 1) {
    insert.run(`Media/file${i}.mkv`, `media/file${i}.mkv`, `file${i}.mkv`, 1000 + i, `hash${i}`);
  }
  db.prepare(
    `INSERT INTO drives (device_key, device_id, serial_number, model, labels, drive_letters, first_seen_at, last_seen_at)
     VALUES ('sn:ABC', 'dev', 'ABC', 'WD', '["DRIVEPOOL27"]', '["E"]', 'now', 'now')`,
  ).run();
  db.prepare(
    `INSERT INTO bitrot_findings (root_id, rel_path, path_key, expected_hash, actual_hash, hash_algorithm, detected_at)
     VALUES ('r1', 'Media/file0.mkv', 'media/file0.mkv', 'a', 'b', 'sha256', 'now')`,
  ).run();
}

beforeEach(() => {
  db = openTestDatabase();
  temp = createTempDir('sakuradrive-export-');
  settings = new SettingsService(db);
  exports = new ExportService({
    db,
    settings,
    logger: createSilentLogger(),
    dataDir: temp.path,
    appVersion: 'test',
    hostname: 'NAS-01',
  });
});

afterEach(() => {
  temp.dispose();
  db.close();
});

describe('export', () => {
  it('writes a gzipped bundle with a manifest and record count', async () => {
    seed();
    const result = await exports.export();
    expect(fs.existsSync(result.filePath)).toBe(true);
    expect(result.fileName).toMatch(/^sakuradrive-.*\.ndjson\.gz$/);
    expect(result.recordCount).toBe(5); // 3 files + 1 drive + 1 bit-rot finding
    expect(result.checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(result.manifest.tables.files).toBe(3);
  });

  it('can be verified by reading it back', async () => {
    seed();
    const result = await exports.export();
    const check = await exports.verifyBundle(result.filePath);
    expect(check.ok).toBe(true);
    expect(check.recordCount).toBe(result.recordCount);
  });

  it('reports a truncated bundle as unverifiable', async () => {
    seed();
    const result = await exports.export();
    fs.writeFileSync(result.filePath, Buffer.from('not gzip'));
    const check = await exports.verifyBundle(result.filePath);
    expect(check.ok).toBe(false);
  });

  it('redacts credentials by default', async () => {
    settings.update({ backup: { password: 'hunter2' } });
    const result = await exports.export();
    const manifest = await exports.inspect(result.filePath);
    expect(manifest!.redactedSecrets).toBe(true);

    const fresh = freshService();
    await fresh.service.import(result.filePath, { mode: 'merge', importSettings: true });
    expect(fresh.settings.get().backup.password).toBe('__REDACTED__');
    fresh.dispose();
  });

  it('can include credentials when explicitly asked', async () => {
    settings.update({ backup: { password: 'hunter2' } });
    const result = await exports.export(undefined, { redactSecrets: false });
    const fresh = freshService();
    await fresh.service.import(result.filePath, { mode: 'merge', importSettings: true });
    expect(fresh.settings.get().backup.password).toBe('hunter2');
    fresh.dispose();
  });

  it('can leave the catalog out for a small settings-only bundle', async () => {
    seed();
    const result = await exports.export(undefined, { includeCatalog: false });
    expect(result.manifest.tables.files).toBeUndefined();
    expect(result.manifest.tables.drives).toBe(1);
  });

  it('writes to an explicit path', async () => {
    seed();
    const target = path.join(temp.path, 'custom', 'bundle.ndjson.gz');
    const result = await exports.export(target);
    expect(result.filePath).toBe(target);
    expect(fs.existsSync(target)).toBe(true);
  });
});

describe('import', () => {
  it('restores a catalog into an empty install', async () => {
    seed();
    const result = await exports.export();

    const fresh = freshService();
    const imported = await fresh.service.import(result.filePath, { mode: 'merge' });
    expect(imported.manifest!.format).toBe('sakuradrive-export');
    expect(imported.imported.files).toBe(3);
    expect(imported.imported.drives).toBe(1);

    const count = fresh.db.prepare('SELECT COUNT(*) AS n FROM files').get() as { n: number };
    expect(count.n).toBe(3);
    const drive = fresh.db.prepare('SELECT labels FROM drives').get() as { labels: string };
    expect(drive.labels).toBe('["DRIVEPOOL27"]');
    fresh.dispose();
  });

  it('is idempotent — importing twice does not duplicate rows', async () => {
    seed();
    const result = await exports.export();
    const fresh = freshService();
    await fresh.service.import(result.filePath, { mode: 'merge' });
    await fresh.service.import(result.filePath, { mode: 'merge' });
    const count = fresh.db.prepare('SELECT COUNT(*) AS n FROM files').get() as { n: number };
    expect(count.n).toBe(3);
    fresh.dispose();
  });

  it('replaces existing rows in replace mode', async () => {
    seed(3);
    const result = await exports.export();

    const fresh = freshService();
    fresh.db
      .prepare(
        `INSERT INTO files (root_id, rel_path, path_key, dir_key, name, first_seen_at, last_seen_at)
         VALUES ('r1', 'Old/stale.mkv', 'old/stale.mkv', 'old', 'stale.mkv', 'now', 'now')`,
      )
      .run();
    await fresh.service.import(result.filePath, { mode: 'replace' });
    const rows = fresh.db.prepare('SELECT rel_path FROM files').all() as Array<{ rel_path: string }>;
    expect(rows).toHaveLength(3);
    expect(rows.some((row) => row.rel_path === 'Old/stale.mkv')).toBe(false);
    fresh.dispose();
  });

  it('only imports settings when asked', async () => {
    settings.update({ general: { siteName: 'Sakura NAS' } });
    const result = await exports.export();

    const fresh = freshService();
    await fresh.service.import(result.filePath, { mode: 'merge' });
    expect(fresh.settings.get().general.siteName).toBe('SakuraDrive');

    await fresh.service.import(result.filePath, { mode: 'merge', importSettings: true });
    expect(fresh.settings.get().general.siteName).toBe('Sakura NAS');
    fresh.dispose();
  });

  it('rejects a file that is not an export bundle', async () => {
    const bogus = path.join(temp.path, 'bogus.ndjson');
    fs.writeFileSync(bogus, '{"__manifest":{"format":"something-else","version":1}}\n');
    await expect(exports.import(bogus, { mode: 'merge' })).rejects.toThrow(/not a SakuraDrive/);
  });

  it('refuses a bundle from a newer format version', async () => {
    const future = path.join(temp.path, 'future.ndjson');
    fs.writeFileSync(future, '{"__manifest":{"format":"sakuradrive-export","version":99}}\n');
    await expect(exports.import(future, { mode: 'merge' })).rejects.toThrow(/newer than this build/);
  });

  it('skips rows for tables this build does not have', async () => {
    const bundle = path.join(temp.path, 'partial.ndjson');
    fs.writeFileSync(
      bundle,
      '{"__manifest":{"format":"sakuradrive-export","version":1,"tables":{},"recordCount":0}}\n' +
        '{"t":"table_from_the_future","r":{"a":1}}\n',
    );
    const result = await exports.import(bundle, { mode: 'merge' });
    expect(result.skipped).toEqual(['table_from_the_future']);
  });

  it('tolerates a corrupt line rather than failing the whole import', async () => {
    const bundle = path.join(temp.path, 'corrupt.ndjson');
    fs.writeFileSync(
      bundle,
      '{"__manifest":{"format":"sakuradrive-export","version":1,"tables":{},"recordCount":0}}\n' +
        'not json at all\n' +
        `{"t":"drives","r":{"device_key":"sn:X","first_seen_at":"now","last_seen_at":"now"}}\n`,
    );
    const result = await exports.import(bundle, { mode: 'merge' });
    expect(result.warnings.some((warning) => warning.includes('unparseable'))).toBe(true);
    expect(result.imported.drives).toBe(1);
  });

  it('round-trips a large catalog', async () => {
    const insert = db.prepare(
      `INSERT INTO files (root_id, rel_path, path_key, dir_key, name, size_bytes, mtime_ms, first_seen_at, last_seen_at)
       VALUES ('r1', ?, ?, 'd', 'f', ?, 1, 'now', 'now')`,
    );
    db.transaction(() => {
      for (let i = 0; i < 20_000; i += 1) insert.run(`d/f${i}`, `d/f${i}`, i);
    })();

    const result = await exports.export();
    expect(result.recordCount).toBe(20_000);

    const fresh = freshService();
    const imported = await fresh.service.import(result.filePath, { mode: 'merge' });
    expect(imported.imported.files).toBe(20_000);
    fresh.dispose();
  });
});

describe('retention', () => {
  it('keeps only the most recent bundles in a destination', async () => {
    const destination = path.join(temp.path, 'dest');
    fs.mkdirSync(destination, { recursive: true });
    for (let i = 0; i < 5; i += 1) {
      const file = path.join(destination, `sakuradrive-2024-0${i + 1}-01.ndjson.gz`);
      fs.writeFileSync(file, 'x');
      fs.utimesSync(file, i * 1000 + 1, i * 1000 + 1);
    }
    const removed = exports.pruneDestination(destination, 2);
    expect(removed).toHaveLength(3);
    expect(fs.readdirSync(destination)).toHaveLength(2);
  });

  it('ignores unrelated files', async () => {
    const destination = path.join(temp.path, 'dest2');
    fs.mkdirSync(destination, { recursive: true });
    fs.writeFileSync(path.join(destination, 'notes.txt'), 'x');
    expect(exports.pruneDestination(destination, 0)).toEqual([]);
    expect(fs.existsSync(path.join(destination, 'notes.txt'))).toBe(true);
  });

  it('does nothing for a destination that does not exist', () => {
    expect(exports.pruneDestination('/no/such/dir', 3)).toEqual([]);
  });
});

describe('records', () => {
  it('tracks export history and the last successful export', async () => {
    exports.recordExport({
      fileName: 'a.ndjson.gz',
      destinationId: 'd1',
      destinationPath: '/mnt/backup/a.ndjson.gz',
      sizeBytes: 10,
      recordCount: 5,
      checksum: 'abc',
      trigger: 'schedule',
      verified: true,
    });
    const list = exports.listExports();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ verified: true, trigger: 'schedule' });
    expect(exports.lastExportAt()).not.toBeNull();
  });

  it('does not count a failed export as the last export', () => {
    exports.recordExport({
      fileName: 'a.ndjson.gz',
      destinationId: 'd1',
      destinationPath: '/x',
      sizeBytes: 0,
      recordCount: 0,
      checksum: '',
      trigger: 'schedule',
      verified: false,
      error: 'disk full',
    });
    expect(exports.lastExportAt()).toBeNull();
  });
});

/** A second, empty install to import into. */
function freshService() {
  const freshDb = openTestDatabase();
  const freshSettings = new SettingsService(freshDb);
  const freshTemp = createTempDir('sakuradrive-import-');
  return {
    db: freshDb,
    settings: freshSettings,
    service: new ExportService({
      db: freshDb,
      settings: freshSettings,
      logger: createSilentLogger(),
      dataDir: freshTemp.path,
      appVersion: 'test',
      hostname: 'NAS-02',
    }),
    dispose() {
      freshDb.close();
      freshTemp.dispose();
    },
  };
}
