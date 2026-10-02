import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openTestDatabase, type Db } from '../db/index.js';
import { createSilentLogger } from '../logger.js';
import { ExportService } from './export-service.js';
import { SettingsService } from './settings-service.js';
import { createTempDir } from '../test/helpers.js';
import zlib from 'node:zlib';

/** The bundle's records, decompressed, one parsed object per line. */
function readBundle(filePath: string): Array<{ t?: string; r?: unknown }> {
  return zlib
    .gunzipSync(fs.readFileSync(filePath))
    .toString('utf8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as { t?: string; r?: unknown });
}

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

/**
 * Enough files to cross the export's 10,000-record progress callback.
 *
 * That threshold is the whole reason the bug survived: below it `onProgress` only runs
 * between tables, when the cursor is already closed.
 */
function seedManyFiles(count: number): void {
  const insert = db.prepare(
    `INSERT INTO files (root_id, rel_path, path_key, dir_key, name, size_bytes, mtime_ms, first_seen_at, last_seen_at)
     VALUES ('r1', ?, ?, 'media', ?, ?, 1700000000000, 'now', 'now')`,
  );
  db.transaction(() => {
    for (let i = 0; i < count; i += 1) {
      insert.run(`Media/bulk${i}.mkv`, `media/bulk${i}.mkv`, `bulk${i}.mkv`, i);
    }
  })();
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

/**
 * The bug that made automatic exports fail on a real catalog: the bundle was streamed
 * from one long `.iterate()`, and better-sqlite3 refuses to run a write while a
 * statement is iterating. The first write the export ran into was the workflow's own
 * progress update, so the run died with "This database connection is busy executing a
 * query" -- every night, on a catalog big enough to report progress at all.
 *
 * These stayed green through all of it, because three seeded rows never reach the
 * 10,000-record progress callback.
 */
describe('writing while the bundle streams', () => {
  it('lets the caller write to the database from onProgress', async () => {
    seedManyFiles(10_500);
    const progressWrites: number[] = [];
    const update = db.prepare('UPDATE workflow_runs SET progress_json = ? WHERE id = ?');
    db.prepare(
      `INSERT INTO workflow_runs (id, workflow_id, state, trigger, started_at, updated_at)
       VALUES (1, 'export.backup', 'running', 'manual', 'now', 'now')`,
    ).run();

    const result = await exports.export(undefined, {
      onProgress: (records) => {
        // Exactly what the export workflow does, and what used to throw.
        update.run(JSON.stringify({ done: records }), 1);
        progressWrites.push(records);
      },
    });

    // Fired from inside the read, which is where it used to throw.
    expect(progressWrites.some((records) => records < 10_500)).toBe(true);
    expect(result.recordCount).toBe(10_500);
  });

  it('lets anything else in the process write while an export is in flight', async () => {
    seedManyFiles(10_500);
    const raise = db.prepare(
      `INSERT INTO alerts (dedupe_key, category, severity, title, detail, context_json, state,
                           first_seen_at, last_seen_at, occurrences)
       VALUES (?, 'volume', 'warning', 't', 'd', '{}', 'open', 'now', 'now', 1)`,
    );
    let raised = 0;
    await exports.export(undefined, {
      onProgress: () => {
        // An agent report landing mid-export, in effect: a different part of the app
        // writing on the same connection while the bundle is being read.
        raise.run(`mid-export-${raised}`);
        raised += 1;
      },
    });
    expect(raised).toBeGreaterThan(0);
  });

  it('pages a table whose primary key is not an integer id', async () => {
    // dir_stats is keyed on (root_id, dir_key). It is still a rowid table, so the
    // cursor works -- but it is the one exported table where that is worth proving
    // rather than assuming, because getting it wrong exports nothing at all.
    const insert = db.prepare(
      `INSERT INTO dir_stats (root_id, dir_key, rel_path, depth, updated_at)
       VALUES ('r1', ?, ?, 1, 'now')`,
    );
    db.transaction(() => {
      for (let i = 0; i < 2_500; i += 1) insert.run(`d${i}`, `D${i}`);
    })();

    const result = await exports.export();
    expect(result.manifest.tables.dir_stats).toBe(2_500);
    const rows = readBundle(result.filePath).filter((line) => line.t === 'dir_stats');
    expect(new Set(rows.map((row) => (row.r as { dir_key: string }).dir_key)).size).toBe(2_500);
  });

  it('still exports every row, and no cursor column leaks into the bundle', async () => {
    seedManyFiles(2_500);
    const result = await exports.export();
    const lines = readBundle(result.filePath);
    const fileRows = lines.filter((line) => line.t === 'files');
    // Crosses several page boundaries, so a paging slip would show up as a short count.
    expect(fileRows).toHaveLength(2_500);
    // `rowid AS __cursor` is how the pages are walked; it must not reach the bundle,
    // or every import would carry a column the table does not have.
    for (const row of fileRows) {
      expect(row.r).not.toHaveProperty('__cursor');
    }
    expect(Object.keys(fileRows[0]!.r as object)).toContain('rel_path');
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
