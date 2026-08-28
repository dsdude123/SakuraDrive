import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openTestDatabase, type Db } from '../db/index.js';
import { AlertService } from './alert-service.js';
import { BackupService, parseManifestLine, stripPrefix } from './backup-service.js';
import { KopiaClient, type KopiaRunner } from './kopia-client.js';
import { SettingsService } from './settings-service.js';
import { createTempDir } from '../test/helpers.js';

let db: Db;
let settings: SettingsService;
let alerts: AlertService;
let temp: ReturnType<typeof createTempDir>;

const ROOT_ID = 'root_pool';
const EXPECTATION = {
  id: 'exp1',
  name: 'Media to Backblaze',
  enabled: true,
  rootId: ROOT_ID,
  includeGlobs: ['Media/**'],
  excludeGlobs: ['**/*.tmp'],
  kopiaSource: 'backup@NAS-01:P:\\',
  kopiaPathPrefix: '',
  minFileSizeBytes: 0,
  maxSnapshotAgeHours: 48,
};

/** Put files straight into the catalog; the scan workflow is tested elsewhere. */
function seedCatalog(files: Array<{ relPath: string; size: number; mtimeMs?: number }>): void {
  const insert = db.prepare(
    `INSERT INTO files (root_id, rel_path, path_key, dir_key, name, size_bytes, mtime_ms, first_seen_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'now', 'now')`,
  );
  for (const file of files) {
    const key = file.relPath.toLowerCase();
    insert.run(
      ROOT_ID,
      file.relPath,
      key,
      key.includes('/') ? key.slice(0, key.lastIndexOf('/')) : '',
      file.relPath.split('/').pop(),
      file.size,
      file.mtimeMs ?? 1_700_000_000_000,
    );
  }
}

function kopiaRunner(entries: Array<Record<string, unknown>>, snapshotTime = new Date().toISOString()): KopiaRunner {
  return {
    run: vi.fn(async () => ({
      code: 0,
      stdout: JSON.stringify([
        {
          id: 'snap1',
          source: { host: 'NAS-01', userName: 'backup', path: 'P:\\' },
          startTime: snapshotTime,
          endTime: snapshotTime,
          rootEntry: { obj: 'k1', summ: { size: 1, numFiles: entries.length } },
        },
      ]),
      stderr: '',
    })),
    stream: vi.fn(async function* () {
      yield JSON.stringify(entries);
    }),
  };
}

function makeService(runner: KopiaRunner | null): BackupService {
  return new BackupService({
    db,
    settings,
    alerts,
    kopia: runner ? new KopiaClient(runner) : null,
  });
}

beforeEach(() => {
  db = openTestDatabase();
  temp = createTempDir('sakuradrive-backup-');
  settings = new SettingsService(db);
  alerts = new AlertService(db);
  settings.update({
    backup: { enabled: true, mode: 'kopia', expectations: [EXPECTATION] },
    catalog: { roots: [{ id: ROOT_ID, name: 'Pool', containerPath: '/mnt/pool' }] },
  });
});

afterEach(() => {
  temp.dispose();
  db.close();
});

describe('verify', () => {
  it('reports a fully protected set as complete', async () => {
    seedCatalog([
      { relPath: 'Media/a.mkv', size: 100 },
      { relPath: 'Media/b.mkv', size: 200 },
    ]);
    const service = makeService(
      kopiaRunner([
        { name: 'Media/a.mkv', type: 'f', size: 100 },
        { name: 'Media/b.mkv', type: 'f', size: 200 },
      ]),
    );

    const summary = await service.verify({ expectation: EXPECTATION, workflowRunId: null });
    expect(summary.error).toBeNull();
    expect(summary.expectedFiles).toBe(2);
    expect(summary.presentFiles).toBe(2);
    expect(summary.missingFiles).toBe(0);
    expect(alerts.list().alerts.filter((a) => a.category === 'backup')).toHaveLength(0);
  });

  it('reports files that are not in the snapshot', async () => {
    seedCatalog([
      { relPath: 'Media/a.mkv', size: 100 },
      { relPath: 'Media/missing.mkv', size: 500 },
    ]);
    const service = makeService(kopiaRunner([{ name: 'Media/a.mkv', type: 'f', size: 100 }]));

    const summary = await service.verify({ expectation: EXPECTATION, workflowRunId: null });
    expect(summary.missingFiles).toBe(1);
    expect(summary.missingBytes).toBe(500);

    const { issues } = service.listIssues({ runId: summary.runId });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ relPath: 'Media/missing.mkv', kind: 'missing' });

    const alert = alerts.list().alerts.find((a) => a.category === 'backup');
    expect(alert!.severity).toBe('critical');
    expect(alert!.detail).toContain('not protected');
  });

  it('only expects files matching the include rules', async () => {
    seedCatalog([
      { relPath: 'Media/a.mkv', size: 100 },
      { relPath: 'Scratch/huge.iso', size: 999_999 },
      { relPath: 'Media/work.tmp', size: 1 },
    ]);
    const service = makeService(kopiaRunner([{ name: 'Media/a.mkv', type: 'f', size: 100 }]));

    const summary = await service.verify({ expectation: EXPECTATION, workflowRunId: null });
    // Scratch is outside the include glob; .tmp is excluded.
    expect(summary.expectedFiles).toBe(1);
    expect(summary.missingFiles).toBe(0);
  });

  it('honours the minimum file size', async () => {
    seedCatalog([
      { relPath: 'Media/tiny.nfo', size: 10 },
      { relPath: 'Media/big.mkv', size: 10_000 },
    ]);
    const service = makeService(kopiaRunner([{ name: 'Media/big.mkv', type: 'f', size: 10_000 }]));
    const summary = await service.verify({
      expectation: { ...EXPECTATION, minFileSizeBytes: 1000 },
      workflowRunId: null,
    });
    expect(summary.expectedFiles).toBe(1);
    expect(summary.missingFiles).toBe(0);
  });

  it('detects a size mismatch', async () => {
    seedCatalog([{ relPath: 'Media/a.mkv', size: 100 }]);
    const service = makeService(kopiaRunner([{ name: 'Media/a.mkv', type: 'f', size: 50 }]));
    const summary = await service.verify({ expectation: EXPECTATION, workflowRunId: null });
    expect(summary.mismatchedFiles).toBe(1);
    expect(service.listIssues({ runId: summary.runId }).issues[0]!.kind).toBe('size-mismatch');
  });

  it('detects a backup copy older than the file', async () => {
    const now = Date.now();
    seedCatalog([{ relPath: 'Media/a.mkv', size: 100, mtimeMs: now }]);
    const service = makeService(
      kopiaRunner([
        {
          name: 'Media/a.mkv',
          type: 'f',
          size: 100,
          mtime: new Date(now - 86_400_000).toISOString(),
        },
      ]),
    );
    const summary = await service.verify({ expectation: EXPECTATION, workflowRunId: null });
    expect(summary.staleFiles).toBe(1);
    expect(service.listIssues({ runId: summary.runId }).issues[0]!.kind).toBe('stale');
  });

  it('maps catalog paths through the snapshot prefix', async () => {
    seedCatalog([{ relPath: 'Media/Movies/a.mkv', size: 100 }]);
    const service = makeService(kopiaRunner([{ name: 'Movies/a.mkv', type: 'f', size: 100 }]));
    const summary = await service.verify({
      expectation: { ...EXPECTATION, kopiaPathPrefix: 'Media', includeGlobs: [] },
      workflowRunId: null,
    });
    expect(summary.expectedFiles).toBe(1);
    expect(summary.missingFiles).toBe(0);
  });

  it('refuses to report everything missing when the listing comes back empty', async () => {
    seedCatalog([{ relPath: 'Media/a.mkv', size: 100 }]);
    const service = makeService(kopiaRunner([]));
    const summary = await service.verify({ expectation: EXPECTATION, workflowRunId: null });
    expect(summary.error).toContain('empty');
    expect(summary.missingFiles).toBe(0);
  });

  it('reports a missing snapshot as an error, not as missing files', async () => {
    seedCatalog([{ relPath: 'Media/a.mkv', size: 100 }]);
    const runner: KopiaRunner = {
      run: vi.fn(async () => ({ code: 0, stdout: '[]', stderr: '' })),
      stream: vi.fn(async function* () {}),
    };
    const summary = await makeService(runner).verify({
      expectation: EXPECTATION,
      workflowRunId: null,
    });
    expect(summary.error).toContain('No Kopia snapshot');
    expect(alerts.list().alerts.some((a) => a.title.includes('verification failed'))).toBe(true);
  });

  it('warns when the newest snapshot is too old', async () => {
    seedCatalog([{ relPath: 'Media/a.mkv', size: 100 }]);
    const old = new Date(Date.now() - 10 * 86_400_000).toISOString();
    const service = makeService(
      kopiaRunner([{ name: 'Media/a.mkv', type: 'f', size: 100 }], old),
    );
    await service.verify({ expectation: EXPECTATION, workflowRunId: null });
    const alert = alerts.list().alerts.find((a) => a.title.includes('hours old'));
    expect(alert!.severity).toBe('warning');
    expect(alert!.detail).toContain('scheduled task');
  });

  it('clears the missing alert once the gap is filled', async () => {
    seedCatalog([{ relPath: 'Media/a.mkv', size: 100 }]);
    await makeService(kopiaRunner([{ name: 'Media/other.mkv', type: 'f', size: 1 }])).verify({
      expectation: EXPECTATION,
      workflowRunId: null,
    });
    expect(alerts.list().alerts.some((a) => a.category === 'backup')).toBe(true);

    await makeService(kopiaRunner([{ name: 'Media/a.mkv', type: 'f', size: 100 }])).verify({
      expectation: EXPECTATION,
      workflowRunId: null,
    });
    expect(alerts.list().alerts.filter((a) => a.dedupeKey.endsWith(':missing'))).toHaveLength(0);
  });

  it('reports an error when Kopia is not configured', async () => {
    seedCatalog([{ relPath: 'Media/a.mkv', size: 100 }]);
    const summary = await makeService(null).verify({ expectation: EXPECTATION, workflowRunId: null });
    expect(summary.error).toContain('not configured');
  });
});

describe('manifest mode', () => {
  it('verifies against a plain listing file', async () => {
    seedCatalog([
      { relPath: 'Media/a.mkv', size: 100 },
      { relPath: 'Media/gone.mkv', size: 100 },
    ]);
    const manifestPath = path.join(temp.path, 'listing.txt');
    fs.writeFileSync(manifestPath, 'Media/a.mkv\n');
    settings.update({ backup: { mode: 'manifest', manifestPath } });

    const summary = await makeService(null).verify({ expectation: EXPECTATION, workflowRunId: null });
    expect(summary.error).toBeNull();
    expect(summary.expectedFiles).toBe(2);
    expect(summary.missingFiles).toBe(1);
    // A bare path carries no size, so presence is all that can be checked.
    expect(summary.mismatchedFiles).toBe(0);
  });

  it('reads NDJSON with sizes', async () => {
    seedCatalog([{ relPath: 'Media/a.mkv', size: 100 }]);
    const manifestPath = path.join(temp.path, 'listing.ndjson');
    fs.writeFileSync(manifestPath, '{"name":"Media/a.mkv","size":42,"type":"f"}\n');
    settings.update({ backup: { mode: 'manifest', manifestPath } });

    const summary = await makeService(null).verify({ expectation: EXPECTATION, workflowRunId: null });
    expect(summary.mismatchedFiles).toBe(1);
  });

  it('errors when the manifest is missing', async () => {
    seedCatalog([{ relPath: 'Media/a.mkv', size: 100 }]);
    settings.update({ backup: { mode: 'manifest', manifestPath: '/no/such/file' } });
    const summary = await makeService(null).verify({ expectation: EXPECTATION, workflowRunId: null });
    expect(summary.error).toContain('not found');
  });
});

describe('issue management', () => {
  it('dismisses an issue so it stops being reported', async () => {
    seedCatalog([{ relPath: 'Media/missing.mkv', size: 1 }]);
    const service = makeService(kopiaRunner([{ name: 'Media/other.mkv', type: 'f', size: 1 }]));
    const summary = await service.verify({ expectation: EXPECTATION, workflowRunId: null });
    const issue = service.listIssues({ runId: summary.runId }).issues[0]!;

    expect(service.setIssueStatus([issue.id], 'dismissed', 'Deliberately excluded')).toBe(1);
    expect(service.listIssues({ runId: summary.runId }).issues).toHaveLength(0);
    expect(service.listIssues({ runId: summary.runId, status: 'dismissed' }).issues[0]!.note).toBe(
      'Deliberately excluded',
    );
  });

  it('defaults to the newest run per expectation', async () => {
    seedCatalog([{ relPath: 'Media/missing.mkv', size: 1 }]);
    const service = makeService(kopiaRunner([{ name: 'Media/other.mkv', type: 'f', size: 1 }]));
    await service.verify({ expectation: EXPECTATION, workflowRunId: null });
    await service.verify({ expectation: EXPECTATION, workflowRunId: null });
    expect(service.listIssues().issues).toHaveLength(1);
  });

  it('summarises the current state for the dashboard', async () => {
    seedCatalog([{ relPath: 'Media/missing.mkv', size: 700 }]);
    const service = makeService(kopiaRunner([{ name: 'Media/other.mkv', type: 'f', size: 1 }]));
    await service.verify({ expectation: EXPECTATION, workflowRunId: null });
    const summary = service.summary();
    expect(summary.enabled).toBe(true);
    expect(summary.missingFiles).toBe(1);
    expect(summary.missingBytes).toBe(700);
    expect(summary.expectations).toBe(1);
  });
});

describe('helpers', () => {
  it('strips a snapshot prefix from a catalog path', () => {
    expect(stripPrefix('Media/Movies/a.mkv', 'Media')).toBe('Movies/a.mkv');
    expect(stripPrefix('Media/Movies/a.mkv', '')).toBe('Media/Movies/a.mkv');
    expect(stripPrefix('Other/a.mkv', 'Media')).toBe('Other/a.mkv');
  });

  it('parses every manifest line format', () => {
    expect(parseManifestLine('  ')).toBeNull();
    expect(parseManifestLine('Media/a.mkv')).toMatchObject({ relPath: 'Media/a.mkv', sizeBytes: -1 });
    expect(parseManifestLine('100\t2024-03-05T00:00:00Z\tMedia/a.mkv')).toMatchObject({
      relPath: 'Media/a.mkv',
      sizeBytes: 100,
    });
    expect(parseManifestLine('{"name":"Media/a.mkv","size":5,"type":"f"}')).toMatchObject({
      sizeBytes: 5,
    });
    expect(parseManifestLine('{"name":"Media","type":"d"}')).toBeNull();
    expect(parseManifestLine('{broken')).toBeNull();
  });
});
