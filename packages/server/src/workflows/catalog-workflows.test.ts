import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fullSchedule } from '@sakuradrive/shared';
import { openTestDatabase, type Db } from '../db/index.js';
import { createSilentLogger } from '../logger.js';
import { AgentJobService } from '../services/agent-job-service.js';
import { AlertService } from '../services/alert-service.js';
import { BitrotService } from '../services/bitrot-service.js';
import { CatalogService } from '../services/catalog-service.js';
import { SettingsService } from '../services/settings-service.js';
import { createTempDir, writeFile } from '../test/helpers.js';
import { createCatalogHashWorkflow } from './catalog-hash.js';
import { createCatalogScanWorkflow } from './catalog-scan.js';
import { WorkflowManager } from './engine.js';

let db: Db;
let settings: SettingsService;
let alerts: AlertService;
let catalog: CatalogService;
let bitrot: BitrotService;
let agentJobs: AgentJobService;
let manager: WorkflowManager;
let temp: ReturnType<typeof createTempDir>;

const ROOT_ID = 'root_hdd';

function configureRoot(overrides: Record<string, unknown> = {}) {
  settings.update({
    schedule: { heavyIo: fullSchedule() },
    catalog: {
      roots: [
        {
          id: ROOT_ID,
          name: 'HDD Pool',
          kind: 'pool',
          poolId: 'hdd',
          containerPath: temp.path,
          hostPath: 'P:\\',
          enabled: true,
          hashEnabled: true,
          ...overrides,
        },
      ],
    },
  });
}

async function runWorkflow(id: 'catalog.scan' | 'catalog.hash') {
  const run = await manager.start(id, { force: true });
  await manager.drain();
  return manager.run(run.id)!;
}

beforeEach(() => {
  db = openTestDatabase();
  temp = createTempDir();
  settings = new SettingsService(db);
  alerts = new AlertService(db);
  catalog = new CatalogService(db, settings);
  bitrot = new BitrotService(db, alerts);
  agentJobs = new AgentJobService(db);
  manager = new WorkflowManager({ db, settings, logger: createSilentLogger() });
  manager.register(createCatalogScanWorkflow({ settings, catalog, alerts, agentJobs }));
  manager.register(createCatalogHashWorkflow({ settings, catalog, bitrot, alerts, agentJobs }));
});

afterEach(() => {
  temp.dispose();
  db.close();
});

describe('catalog scan', () => {
  it('catalogues every file in the tree', async () => {
    writeFile(temp.path, 'Media/Movies/a.mkv', 'aaaa');
    writeFile(temp.path, 'Media/Movies/4K/b.mkv', 'bbbbbb');
    writeFile(temp.path, 'Backups/db.bak', 'c');
    configureRoot();

    const run = await runWorkflow('catalog.scan');
    expect(run.state).toBe('completed');

    const stats = catalog.rootStats(ROOT_ID);
    expect(stats.files).toBe(3);
    expect(stats.bytes).toBe(11);
  });

  it('does nothing when no roots are configured', async () => {
    const run = await runWorkflow('catalog.scan');
    expect(run.state).toBe('completed');
    expect(catalog.totals().files).toBe(0);
  });

  it('records created, modified and deleted differences between runs', async () => {
    writeFile(temp.path, 'a.txt', 'one');
    writeFile(temp.path, 'b.txt', 'two');
    configureRoot();
    await runWorkflow('catalog.scan');

    const firstRun = catalog.listRuns(ROOT_ID)[0]!;
    expect(catalog.diffSummary(firstRun.id).created).toBe(2);

    fs.rmSync(path.join(temp.path, 'b.txt'));
    writeFile(temp.path, 'a.txt', 'one plus more', Date.now() + 60_000);
    writeFile(temp.path, 'c.txt', 'three');
    await runWorkflow('catalog.scan');

    const secondRun = catalog.listRuns(ROOT_ID)[0]!;
    const diff = catalog.diffSummary(secondRun.id);
    expect(diff.created).toBe(1);
    expect(diff.modified).toBe(1);
    expect(diff.deleted).toBe(1);
    expect(diff.fromRunId).toBe(firstRun.id);

    const deleted = catalog.listChanges({ runId: secondRun.id, kind: 'deleted' });
    expect(deleted.changes[0]!.relPath).toBe('b.txt');
    expect(deleted.changes[0]!.previousSizeBytes).toBe(3);
  });

  it('records nothing when nothing changed', async () => {
    writeFile(temp.path, 'a.txt', 'one');
    configureRoot();
    await runWorkflow('catalog.scan');
    await runWorkflow('catalog.scan');
    const latest = catalog.listRuns(ROOT_ID)[0]!;
    const diff = catalog.diffSummary(latest.id);
    expect([diff.created, diff.modified, diff.deleted]).toEqual([0, 0, 0]);
  });

  it('soft-deletes so a file that comes back is reported as restored', async () => {
    writeFile(temp.path, 'a.txt', 'one');
    configureRoot();
    await runWorkflow('catalog.scan');
    fs.rmSync(path.join(temp.path, 'a.txt'));
    await runWorkflow('catalog.scan');
    writeFile(temp.path, 'a.txt', 'one');
    await runWorkflow('catalog.scan');

    const latest = catalog.listRuns(ROOT_ID)[0]!;
    expect(catalog.diffSummary(latest.id).restored).toBe(1);
    // The row was never removed, so the DR history survives.
    expect(catalog.searchFiles({ includeDeleted: true }).total).toBe(1);
  });

  it('skips Windows and DrivePool system directories', async () => {
    writeFile(temp.path, '$RECYCLE.BIN/junk.bin', 'x');
    writeFile(temp.path, 'System Volume Information/tracking.log', 'x');
    writeFile(temp.path, '.covefs/meta', 'x');
    writeFile(temp.path, 'Media/keep.mkv', 'x');
    configureRoot();
    await runWorkflow('catalog.scan');
    expect(catalog.rootStats(ROOT_ID).files).toBe(1);
  });

  it('applies the root exclude globs', async () => {
    writeFile(temp.path, 'Media/keep.mkv', 'x');
    writeFile(temp.path, 'Temp/scratch.tmp', 'x');
    writeFile(temp.path, 'Media/thumbs/Thumbs.db', 'x');
    configureRoot({ excludeGlobs: ['Temp/**'] });
    await runWorkflow('catalog.scan');
    const files = catalog.searchFiles({}).files.map((file) => file.relPath);
    expect(files).toEqual(['Media/keep.mkv']);
  });

  it('applies include globs when set', async () => {
    writeFile(temp.path, 'Media/a.mkv', 'x');
    writeFile(temp.path, 'Media/a.nfo', 'x');
    configureRoot({ includeGlobs: ['**/*.mkv'] });
    await runWorkflow('catalog.scan');
    expect(catalog.searchFiles({}).files.map((f) => f.relPath)).toEqual(['Media/a.mkv']);
  });

  it('resolves the duplication level for each file', async () => {
    writeFile(temp.path, 'Media/Movies/a.mkv', 'aaaa');
    writeFile(temp.path, 'Loose.txt', 'bb');
    configureRoot();
    settings.update({
      duplication: {
        defaultLevel: 1,
        rules: [
          { id: 'r1', poolId: 'hdd', path: 'Media', level: 3, source: 'manual', note: '' },
        ],
      },
    });
    await runWorkflow('catalog.scan');

    const stats = catalog.rootStats(ROOT_ID);
    expect(stats.bytes).toBe(6);
    // 4 bytes x3 duplication + 2 bytes x1
    expect(stats.effectiveBytes).toBe(14);
  });

  it('refuses to touch the catalog when the root is unreadable', async () => {
    writeFile(temp.path, 'a.txt', 'one');
    configureRoot();
    await runWorkflow('catalog.scan');
    expect(catalog.rootStats(ROOT_ID).files).toBe(1);

    // Simulate the bind mount disappearing.
    settings.update({
      catalog: {
        roots: [{ ...settings.get().catalog.roots[0]!, containerPath: path.join(temp.path, 'gone') }],
      },
    });
    const run = await runWorkflow('catalog.scan');

    expect(run.state).toBe('completed');
    expect(catalog.rootStats(ROOT_ID).files).toBe(1);
    expect(catalog.rootStats(ROOT_ID).deletedFiles).toBe(0);
    const alert = alerts.list().alerts.find((a) => a.category === 'catalog');
    expect(alert!.severity).toBe('critical');
    expect(alert!.title).toContain('not readable');
  });

  it('raises a critical alert when a scan sees a mass deletion', async () => {
    for (let i = 0; i < 10; i += 1) writeFile(temp.path, `file${i}.txt`, 'x');
    configureRoot();
    await runWorkflow('catalog.scan');

    for (let i = 0; i < 5; i += 1) fs.rmSync(path.join(temp.path, `file${i}.txt`));
    await runWorkflow('catalog.scan');

    const alert = alerts.list().alerts.find((a) => a.title.includes('disappeared'));
    expect(alert).toBeDefined();
    expect(alert!.severity).toBe('critical');
    expect(alert!.context.deleted).toBe(5);
  });

  it('does not raise the mass-deletion alert for a small change', async () => {
    for (let i = 0; i < 100; i += 1) writeFile(temp.path, `file${i}.txt`, 'x');
    configureRoot();
    await runWorkflow('catalog.scan');
    fs.rmSync(path.join(temp.path, 'file0.txt'));
    await runWorkflow('catalog.scan');
    expect(alerts.list().alerts.find((a) => a.title.includes('disappeared'))).toBeUndefined();
  });

  it('builds directory rollups for the storage view', async () => {
    writeFile(temp.path, 'Media/Movies/a.mkv', 'a'.repeat(100));
    writeFile(temp.path, 'Media/Movies/4K/b.mkv', 'b'.repeat(200));
    writeFile(temp.path, 'Media/Music/c.flac', 'c'.repeat(50));
    configureRoot();
    await runWorkflow('catalog.scan');

    const top = catalog.listDirectory(ROOT_ID, '');
    expect(top.entries).toHaveLength(1);
    expect(top.entries[0]!.name).toBe('Media');
    expect(top.entries[0]!.sizeBytes).toBe(350);
    expect(top.entries[0]!.fileCount).toBe(3);

    const media = catalog.listDirectory(ROOT_ID, 'Media');
    expect(media.entries.map((e) => e.name)).toEqual(['Movies', 'Music']);
    expect(media.entries[0]!.sizeBytes).toBe(300);

    const movies = catalog.listDirectory(ROOT_ID, 'Media/Movies');
    expect(movies.entries.map((e) => e.name)).toEqual(['4K', 'a.mkv']);
  });

  it('reports progress while scanning', async () => {
    for (let i = 0; i < 30; i += 1) writeFile(temp.path, `dir${i}/file.txt`, 'x');
    configureRoot();
    const run = await runWorkflow('catalog.scan');
    expect(run.progress.unit).toBe('directories');
    expect(run.stats.rootsScanned).toBe(1);
  });

  it('pauses at a directory boundary and resumes where it left off', async () => {
    for (let i = 0; i < 40; i += 1) writeFile(temp.path, `dir${i}/file.txt`, 'x');
    configureRoot();

    const started = await manager.start('catalog.scan', { force: true });
    // Stop almost immediately: the walk is well under way but nowhere near done.
    manager.stop('catalog.scan');
    await manager.drain();

    const paused = manager.run(started.id)!;
    expect(paused.state).toBe('paused');
    const partial = catalog.rootStats(ROOT_ID).files;
    expect(partial).toBeLessThanOrEqual(40);
    // Crucially, a paused scan must not have marked the unseen files as deleted.
    expect(catalog.rootStats(ROOT_ID).deletedFiles).toBe(0);

    const resumed = await manager.start('catalog.scan', { force: true });
    await manager.drain();
    expect(resumed.id).toBe(started.id);
    expect(manager.run(started.id)!.state).toBe('completed');
    expect(catalog.rootStats(ROOT_ID).files).toBe(40);
    expect(catalog.rootStats(ROOT_ID).deletedFiles).toBe(0);
  });

  it('strips the PoolPart prefix so the same file on two disks compares equal', async () => {
    // A pool-part root is mounted at the disk root, so its paths begin with the
    // PoolPart folder DrivePool created. Two disks in the same pool must produce the
    // same catalog path for the same file, or the recovery query cannot match them.
    const second = createTempDir();
    try {
      writeFile(temp.path, 'PoolPart.6a41b3c0-1f2e-4d5a-9b8c-0d1e2f3a4b5c/Media/dup.mkv', 'x'.repeat(10));
      writeFile(temp.path, 'PoolPart.6a41b3c0-1f2e-4d5a-9b8c-0d1e2f3a4b5c/Media/only-here.mkv', 'y'.repeat(20));
      // A different guid on the second disk must not prevent the match.
      writeFile(second.path, 'PoolPart.7b52c4d1-2e3f-4a5b-8c9d-1e2f3a4b5c6d/Media/dup.mkv', 'x'.repeat(10));

      settings.update({
        schedule: { heavyIo: fullSchedule() },
        catalog: {
          roots: [
            {
              id: 'part27',
              name: 'DRIVEPOOL27',
              kind: 'poolpart',
              poolId: 'hdd',
              containerPath: temp.path,
              driveLabel: 'DRIVEPOOL27',
            },
            {
              id: 'part28',
              name: 'DRIVEPOOL28',
              kind: 'poolpart',
              poolId: 'hdd',
              containerPath: second.path,
              driveLabel: 'DRIVEPOOL28',
            },
          ],
        },
      });
      await runWorkflow('catalog.scan');

      const paths = catalog.searchFiles({ rootId: 'part27' }).files.map((file) => file.relPath).sort();
      expect(paths).toEqual(['Media/dup.mkv', 'Media/only-here.mkv']);

      const impact = catalog.diskLossImpact('part27');
      expect(impact.label).toBe('DRIVEPOOL27');
      expect(impact.unrecoverableFiles).toBe(1);
      expect(impact.unrecoverableBytes).toBe(20);
      expect(impact.duplicatedFiles).toBe(1);
      expect(catalog.listUnrecoverableFiles('part27').files[0]!.relPath).toBe('Media/only-here.mkv');
    } finally {
      second.dispose();
    }
  });

  it('leaves paths alone for a pool root', async () => {
    writeFile(temp.path, 'Media/a.mkv', 'x');
    configureRoot({ kind: 'pool' });
    await runWorkflow('catalog.scan');
    expect(catalog.searchFiles({}).files[0]!.relPath).toBe('Media/a.mkv');
  });

  it('scans several roots in one run', async () => {
    const second = createTempDir();
    try {
      writeFile(temp.path, 'a.txt', 'x');
      writeFile(second.path, 'b.txt', 'yy');
      settings.update({
        schedule: { heavyIo: fullSchedule() },
        catalog: {
          roots: [
            { id: 'r1', name: 'One', containerPath: temp.path, kind: 'pool', poolId: 'hdd' },
            { id: 'r2', name: 'Two', containerPath: second.path, kind: 'disk', poolId: null },
          ],
        },
      });
      const run = await runWorkflow('catalog.scan');
      expect(run.stats.rootsScanned).toBe(2);
      expect(catalog.rootStats('r1').files).toBe(1);
      expect(catalog.rootStats('r2').files).toBe(1);
    } finally {
      second.dispose();
    }
  });
});

describe('bit-rot scan', () => {
  it('hashes every catalogued file', async () => {
    writeFile(temp.path, 'a.txt', 'hello');
    writeFile(temp.path, 'b/c.txt', 'world');
    configureRoot();
    await runWorkflow('catalog.scan');

    const run = await runWorkflow('catalog.hash');
    expect(run.error).toBeNull();
    expect(run.state).toBe('completed');
    expect(run.stats.filesHashed).toBe(2);
    expect(run.stats.bytesHashed).toBe(10);
    expect(catalog.rootStats(ROOT_ID).hashedFiles).toBe(2);
  });

  it('does not re-hash unchanged files on the next run', async () => {
    writeFile(temp.path, 'a.txt', 'hello');
    configureRoot();
    await runWorkflow('catalog.scan');
    await runWorkflow('catalog.hash');
    const second = await runWorkflow('catalog.hash');
    expect(second.stats.filesHashed ?? 0).toBe(0);
  });

  it('re-hashes a file whose content legitimately changed, without crying bit rot', async () => {
    writeFile(temp.path, 'a.txt', 'hello');
    configureRoot();
    await runWorkflow('catalog.scan');
    await runWorkflow('catalog.hash');

    writeFile(temp.path, 'a.txt', 'hello there', Date.now() + 120_000);
    await runWorkflow('catalog.scan');
    const run = await runWorkflow('catalog.hash');

    expect(run.stats.filesHashed).toBe(1);
    expect(bitrot.list().total).toBe(0);
  });

  it('detects content that changed while size and mtime stayed identical', async () => {
    const mtime = Date.now() - 86_400_000;
    writeFile(temp.path, 'a.txt', 'hello', mtime);
    configureRoot();
    await runWorkflow('catalog.scan');
    await runWorkflow('catalog.hash');

    // Rewrite the same number of bytes and restore the timestamp: the signature of rot.
    writeFile(temp.path, 'a.txt', 'hellO', mtime);
    // Nothing in the file's metadata changed, so only the periodic re-verification
    // will look at it again. Age the stored hash to simulate that interval elapsing.
    db.prepare(`UPDATE files SET hashed_at = '2000-01-01T00:00:00.000Z'`).run();
    const run = await runWorkflow('catalog.hash');

    expect(run.stats.bitrotFindings).toBe(1);
    const findings = bitrot.list();
    expect(findings.total).toBe(1);
    expect(findings.findings[0]!.relPath).toBe('a.txt');
    expect(findings.findings[0]!.status).toBe('confirmed');
    expect(findings.findings[0]!.expectedHash).not.toBe(findings.findings[0]!.actualHash);
  });

  it('raises a single rolled-up alert rather than one per file', async () => {
    const mtime = Date.now() - 86_400_000;
    for (let i = 0; i < 3; i += 1) writeFile(temp.path, `f${i}.txt`, 'aaaa', mtime);
    configureRoot();
    await runWorkflow('catalog.scan');
    await runWorkflow('catalog.hash');
    for (let i = 0; i < 3; i += 1) writeFile(temp.path, `f${i}.txt`, 'bbbb', mtime);
    db.prepare(`UPDATE files SET hashed_at = '2000-01-01T00:00:00.000Z'`).run();
    await runWorkflow('catalog.hash');

    const bitrotAlerts = alerts.list().alerts.filter((a) => a.category === 'bitrot');
    expect(bitrotAlerts).toHaveLength(1);
    expect(bitrotAlerts[0]!.title).toContain('3 files');
    expect(bitrotAlerts[0]!.severity).toBe('critical');
  });

  it('clears the alert once every finding is dealt with', async () => {
    const mtime = Date.now() - 86_400_000;
    writeFile(temp.path, 'a.txt', 'aaaa', mtime);
    configureRoot();
    await runWorkflow('catalog.scan');
    await runWorkflow('catalog.hash');
    writeFile(temp.path, 'a.txt', 'bbbb', mtime);
    db.prepare(`UPDATE files SET hashed_at = '2000-01-01T00:00:00.000Z'`).run();
    await runWorkflow('catalog.hash');

    const finding = bitrot.list().findings[0]!;
    bitrot.setStatus(finding.id, 'resolved', 'Restored from Kopia');
    expect(alerts.list().alerts.filter((a) => a.category === 'bitrot')).toHaveLength(0);
    expect(bitrot.byId(finding.id)!.note).toBe('Restored from Kopia');
  });

  it('only revisits an unchanged file once the re-verification interval elapses', async () => {
    // This is the whole reason `rehashIntervalDays` exists: rot leaves size and mtime
    // untouched, so nothing else would ever schedule the file to be read again.
    const mtime = Date.now() - 86_400_000;
    writeFile(temp.path, 'a.txt', 'aaaa', mtime);
    configureRoot();
    await runWorkflow('catalog.scan');
    await runWorkflow('catalog.hash');

    writeFile(temp.path, 'a.txt', 'bbbb', mtime);
    expect((await runWorkflow('catalog.hash')).stats.filesHashed ?? 0).toBe(0);
    expect(bitrot.list().total).toBe(0);

    db.prepare(`UPDATE files SET hashed_at = '2000-01-01T00:00:00.000Z'`).run();
    await runWorkflow('catalog.hash');
    expect(bitrot.list().total).toBe(1);
  });

  it('re-hashes after the rehash interval expires', async () => {
    writeFile(temp.path, 'a.txt', 'hello');
    configureRoot();
    settings.update({ catalog: { rehashIntervalDays: 30 } });
    await runWorkflow('catalog.scan');
    await runWorkflow('catalog.hash');

    db.prepare(`UPDATE files SET hashed_at = '2000-01-01T00:00:00.000Z'`).run();
    const run = await runWorkflow('catalog.hash');
    expect(run.stats.filesHashed).toBe(1);
  });

  it('never re-hashes when the interval is zero', async () => {
    writeFile(temp.path, 'a.txt', 'hello');
    configureRoot();
    settings.update({ catalog: { rehashIntervalDays: 0 } });
    await runWorkflow('catalog.scan');
    await runWorkflow('catalog.hash');
    db.prepare(`UPDATE files SET hashed_at = '2000-01-01T00:00:00.000Z'`).run();
    expect((await runWorkflow('catalog.hash')).stats.filesHashed ?? 0).toBe(0);
  });

  it('records a read error and moves on instead of failing the run', async () => {
    writeFile(temp.path, 'a.txt', 'hello');
    writeFile(temp.path, 'b.txt', 'world');
    configureRoot();
    await runWorkflow('catalog.scan');
    // Delete one file after cataloguing so hashing it fails.
    fs.rmSync(path.join(temp.path, 'a.txt'));

    const run = await runWorkflow('catalog.hash');
    expect(run.state).toBe('completed');
    expect(run.stats.readErrors).toBe(1);
    expect(run.stats.filesHashed).toBe(1);
    expect(alerts.list().alerts.some((a) => a.title.includes('could not be read'))).toBe(true);
  });

  it('honours the per-root minimum and maximum hash size', async () => {
    writeFile(temp.path, 'small.txt', 'a');
    writeFile(temp.path, 'big.txt', 'a'.repeat(5000));
    configureRoot({ minHashSizeBytes: 10, maxHashSizeBytes: 1000 });
    await runWorkflow('catalog.scan');
    expect((await runWorkflow('catalog.hash')).stats.filesHashed ?? 0).toBe(0);
  });

  it('skips roots with hashing disabled', async () => {
    writeFile(temp.path, 'a.txt', 'hello');
    configureRoot({ hashEnabled: false });
    await runWorkflow('catalog.scan');
    const run = await runWorkflow('catalog.hash');
    expect(run.stats.filesHashed ?? 0).toBe(0);
  });

  it('can be turned off entirely', async () => {
    writeFile(temp.path, 'a.txt', 'hello');
    configureRoot();
    settings.update({ bitrot: { enabled: false } });
    await runWorkflow('catalog.scan');
    const definition = manager.definition('catalog.hash')!;
    expect(await definition.hasWork()).toBe(false);
  });

  it('pauses and resumes, keeping already-hashed files', async () => {
    for (let i = 0; i < 30; i += 1) writeFile(temp.path, `f${i}.txt`, 'x'.repeat(1000));
    configureRoot();
    await runWorkflow('catalog.scan');

    const started = await manager.start('catalog.hash', { force: true });
    manager.stop('catalog.hash');
    await manager.drain();
    expect(manager.run(started.id)!.state).toBe('paused');

    const resumed = await manager.start('catalog.hash', { force: true });
    await manager.drain();
    expect(resumed.id).toBe(started.id);
    expect(catalog.rootStats(ROOT_ID).hashedFiles).toBe(30);
  });

  it('reports a solid total for the progress bar', async () => {
    for (let i = 0; i < 5; i += 1) writeFile(temp.path, `f${i}.txt`, 'x');
    configureRoot();
    await runWorkflow('catalog.scan');
    const run = await runWorkflow('catalog.hash');
    expect(run.progress.unit).toBe('files');
    expect(run.progress.total).toBe(5);
    expect(run.progress.done).toBe(5);
  });

  it('respects the configured hash algorithm', async () => {
    writeFile(temp.path, 'a.txt', 'hello');
    configureRoot();
    settings.update({ catalog: { hashAlgorithm: 'md5' } });
    await runWorkflow('catalog.scan');
    await runWorkflow('catalog.hash');
    const file = catalog.searchFiles({}).files[0]!;
    // md5("hello")
    expect(file.hash).toBe('5d41402abc4b2a76b9719d911017c592');
  });
});

/**
 * Roots the container cannot read at all.
 *
 * A pool member with no drive letter is invisible here: WSL2 only surfaces lettered
 * drives, and drvfs will not follow a folder mount point into another volume. Those
 * roots are walked by the Windows agent, which has native access to every volume. The
 * catalog, the run, the cursor and the deletion rules stay on this side; only the
 * reading moves.
 */
describe('an agent-sourced root', () => {
  const AGENT_ROOT = {
    id: 'dp16',
    name: 'DRIVEPOOL16',
    kind: 'poolpart' as const,
    poolId: 'hdd',
    source: 'agent' as const,
    containerPath: '',
    hostPath: '\\\\?\\Volume{9f3a}\\PoolPart.d304fce8',
    driveLabel: 'DRIVEPOOL16',
  };

  function configureAgentRoot(overrides: Record<string, unknown> = {}) {
    settings.update({
      schedule: { heavyIo: fullSchedule() },
      catalog: { agentPollMs: 200, roots: [{ ...AGENT_ROOT, ...overrides }] },
    });
  }

  /** Stand in for the agent: claim the job, post batches, finish. */
  async function actAsAgent(
    batches: Array<Array<{ relPath: string; sizeBytes: number; mtimeMs: number }>>,
    finish: 'completed' | 'paused' | 'failed' = 'completed',
  ) {
    let job = agentJobs.claim('tokyo-3');
    for (let attempt = 0; attempt < 50 && !job; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      job = agentJobs.claim('tokyo-3');
    }
    if (!job) throw new Error('the server never queued a job');

    let filesSeen = 0;
    let bytesSeen = 0;
    for (const entries of batches) {
      const root = settings.get().catalog.roots.find((candidate) => candidate.id === job!.rootId)!;
      catalog.recordAgentFiles(job.catalogRunId!, root, entries);
      filesSeen += entries.length;
      bytesSeen += entries.reduce((sum, entry) => sum + entry.sizeBytes, 0);
      const keepGoing = agentJobs.heartbeat(job.id, { cursor: null, dirsDone: 1, dirsRemaining: 0 });
      if (!keepGoing) break;
    }
    agentJobs.finish(job.id, { state: finish, filesSeen, bytesSeen, dirsDone: batches.length });
    return job;
  }

  it('catalogues what the agent reports, with no bind mount anywhere', async () => {
    configureAgentRoot();
    const run = manager.start('catalog.scan', { force: true });
    const agent = actAsAgent([
      [
        { relPath: 'Tier1/Movies/a.mkv', sizeBytes: 100, mtimeMs: 1 },
        { relPath: 'Tier1/Music/b.flac', sizeBytes: 50, mtimeMs: 2 },
      ],
    ]);
    await Promise.all([run, agent]);
    await manager.drain();

    const stats = catalog.rootStats('dp16');
    expect(stats.files).toBe(2);
    expect(stats.bytes).toBe(150);
    expect(catalog.searchFiles({ rootId: 'dp16' }).files.map((file) => file.relPath).sort()).toEqual([
      'Tier1/Movies/a.mkv',
      'Tier1/Music/b.flac',
    ]);
  });

  it('applies deletions only when the agent finished the whole tree', async () => {
    configureAgentRoot();
    let run = manager.start('catalog.scan', { force: true });
    await Promise.all([
      run,
      actAsAgent([
        [
          { relPath: 'Tier1/a.mkv', sizeBytes: 100, mtimeMs: 1 },
          { relPath: 'Tier1/b.mkv', sizeBytes: 100, mtimeMs: 1 },
        ],
      ]),
    ]);
    await manager.drain();
    expect(catalog.rootStats('dp16').files).toBe(2);

    // A second pass that only saw one of them, and did not finish.
    run = manager.start('catalog.scan', { force: true });
    await Promise.all([
      run,
      actAsAgent([[{ relPath: 'Tier1/a.mkv', sizeBytes: 100, mtimeMs: 1 }]], 'failed'),
    ]);
    await manager.drain();

    // Still two: an unfinished scan is not evidence that anything was deleted.
    expect(catalog.rootStats('dp16').files).toBe(2);
  });

  it('raises a critical alert when the agent cannot do the scan', async () => {
    configureAgentRoot();
    const run = manager.start('catalog.scan', { force: true });
    await Promise.all([run, actAsAgent([], 'failed')]);
    await manager.drain();

    const alert = alerts.byKey('catalog:dp16:agent');
    expect(alert?.severity).toBe('critical');
    expect(alert?.state).toBe('open');
  });

  it('clears that alert once a scan gets through', async () => {
    configureAgentRoot();
    let run = manager.start('catalog.scan', { force: true });
    await Promise.all([run, actAsAgent([], 'failed')]);
    await manager.drain();
    expect(alerts.byKey('catalog:dp16:agent')?.state).toBe('open');

    run = manager.start('catalog.scan', { force: true });
    await Promise.all([
      run,
      actAsAgent([[{ relPath: 'Tier1/a.mkv', sizeBytes: 1, mtimeMs: 1 }]]),
    ]);
    await manager.drain();
    expect(alerts.byKey('catalog:dp16:agent')?.state).toBe('resolved');
  });

  it('hands the agent the host path and the globs, not a container path', async () => {
    configureAgentRoot({ excludeGlobs: ['Temp/**'] });
    const run = manager.start('catalog.scan', { force: true });

    let job = agentJobs.claim('tokyo-3');
    for (let attempt = 0; attempt < 50 && !job; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      job = agentJobs.claim('tokyo-3');
    }
    const root = settings.get().catalog.roots[0]!;
    const wire = agentJobs.toWireJob(job!, root);
    expect(wire.hostPath).toBe('\\\\?\\Volume{9f3a}\\PoolPart.d304fce8');
    expect(wire.excludeGlobs).toContain('Temp/**');

    agentJobs.finish(job!.id, { state: 'completed', filesSeen: 0, bytesSeen: 0, dirsDone: 0 });
    await run;
    await manager.drain();
  });

  it('normalises the backslashes the agent speaks in', async () => {
    configureAgentRoot();
    const run = manager.start('catalog.scan', { force: true });
    await Promise.all([
      run,
      actAsAgent([[{ relPath: 'Tier1\\Movies\\a.mkv', sizeBytes: 10, mtimeMs: 1 }]]),
    ]);
    await manager.drain();
    expect(catalog.searchFiles({ rootId: 'dp16' }).files[0]!.relPath).toBe('Tier1/Movies/a.mkv');
  });

  it('leaves container roots walking locally, so both can coexist', async () => {
    writeFile(temp.path, 'Media/local.mkv', 'x');
    settings.update({
      schedule: { heavyIo: fullSchedule() },
      catalog: {
        agentPollMs: 200,
        roots: [
          { id: 'local', name: 'SSD', kind: 'disk', containerPath: temp.path, source: 'container' },
          AGENT_ROOT,
        ],
      },
    });

    const run = manager.start('catalog.scan', { force: true });
    await Promise.all([
      run,
      actAsAgent([[{ relPath: 'Tier1/remote.mkv', sizeBytes: 5, mtimeMs: 1 }]]),
    ]);
    await manager.drain();

    expect(catalog.rootStats('local').files).toBe(1);
    expect(catalog.rootStats('dp16').files).toBe(1);
  });
});
