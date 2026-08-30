import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fullSchedule } from '@sakuradrive/shared';
import { openTestDatabase, type Db } from '../db/index.js';
import { createSilentLogger } from '../logger.js';
import { AgentJobService } from '../services/agent-job-service.js';
import { AlertService } from '../services/alert-service.js';
import { BitrotService } from '../services/bitrot-service.js';
import { CatalogService } from '../services/catalog-service.js';
import { applyAgentHashes } from '../services/hash-ingest.js';
import { SettingsService } from '../services/settings-service.js';
import { createCatalogHashWorkflow } from './catalog-hash.js';
import { createCatalogScanWorkflow } from './catalog-scan.js';
import { WorkflowManager } from './engine.js';

/**
 * Every catalog root is read by the Windows agent.
 *
 * The container has no path to most of these volumes and never will: WSL2 only surfaces
 * lettered drives, and it will not follow a folder mount point into another volume. So
 * these tests drive the workflows through a stand-in agent, which is exactly how the
 * real thing works — and what is being tested here is the server's half: the catalog
 * run, the deletion rules, the duplication resolution, the pause, and the refusal to
 * conclude anything from a scan that did not finish.
 *
 * Walking a directory and computing a hash are the agent's half, and are tested in
 * agent/tests against a real tree.
 */
let db: Db;
let settings: SettingsService;
let alerts: AlertService;
let catalog: CatalogService;
let bitrot: BitrotService;
let agentJobs: AgentJobService;
let manager: WorkflowManager;

const ROOT_ID = 'root_hdd';
const HOST_PATH = '\\\\?\\Volume{9f3a}\\PoolPart.d304fce8';

/** What the stand-in agent would find on the disk: path -> content. */
let disk: Map<string, { content: string; mtimeMs: number }>;

function put(relPath: string, content: string, mtimeMs = 1_700_000_000_000): void {
  disk.set(relPath, { content, mtimeMs });
}

function configureRoot(overrides: Record<string, unknown> = {}) {
  settings.update({
    schedule: { heavyIo: fullSchedule() },
    catalog: {
      agentPollMs: 200,
      agentClaimTimeoutSeconds: 30,
      roots: [
        {
          id: ROOT_ID,
          name: 'HDD Pool',
          kind: 'pool',
          poolId: 'hdd',
          hostPath: HOST_PATH,
          enabled: true,
          hashEnabled: true,
          ...overrides,
        },
      ],
    },
  });
}

/** Wait for the server to queue work, the way a polling agent would. */
async function waitForJob(timeoutMs = 4000, abandoned: () => boolean = () => false) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const job = agentJobs.claim('tokyo-3');
    if (job) return job;
    if (abandoned() || Date.now() > deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/**
 * Act as the agent for one scan: hand over everything on the simulated disk, in
 * `batchesOf` chunks, then finish.
 */
async function serveScan(options: { finish?: 'completed' | 'paused' | 'failed'; batchesOf?: number } = {}) {
  const job = await waitForJob();
  if (!job) throw new Error('the server never queued a scan');

  const root = settings.get().catalog.roots.find((candidate) => candidate.id === job.rootId)!;
  const entries = [...disk.entries()].map(([relPath, file]) => ({
    relPath,
    sizeBytes: file.content.length,
    mtimeMs: file.mtimeMs,
  }));

  const size = options.batchesOf ?? Math.max(entries.length, 1);
  let filesSeen = 0;
  let bytesSeen = 0;
  for (let i = 0; i < entries.length; i += size) {
    const slice = entries.slice(i, i + size);
    catalog.recordAgentFiles(job.catalogRunId!, root, slice);
    filesSeen += slice.length;
    bytesSeen += slice.reduce((sum, entry) => sum + entry.sizeBytes, 0);
    if (!agentJobs.heartbeat(job.id, { cursor: null, dirsDone: 1, dirsRemaining: 0 })) break;
  }

  agentJobs.finish(job.id, {
    state: options.finish ?? 'completed',
    filesSeen,
    bytesSeen,
    dirsDone: 1,
  });
  return job;
}

/** Act as the agent for one hash job, hashing whatever the simulated disk holds. */
async function serveHash(
  options: { corrupt?: Set<string>; unreadable?: Set<string> } = {},
  abandoned: () => boolean = () => false,
) {
  const job = await waitForJob(4000, abandoned);
  if (!job) return null;

  const files = (job.payload.files ?? []) as Array<{
    fileId: number;
    relPath: string;
    expectedHash?: string | null;
  }>;
  const algorithm = (job.payload.hashAlgorithm as string) ?? 'sha256';

  const results = files.map((file) => {
    const entry = disk.get(file.relPath);
    if (!entry || options.unreadable?.has(file.relPath)) {
      return { fileId: file.fileId, error: 'The file could not be opened' };
    }
    const hash = createHash(algorithm).update(entry.content).digest('hex');
    return {
      fileId: file.fileId,
      hash,
      sizeBytes: entry.content.length,
      mtimeMs: entry.mtimeMs,
      // The agent re-reads on a mismatch; a real disagreement is confirmed, and the
      // test can say a read was flaky by leaving it out of `corrupt`.
      verified: file.expectedHash && file.expectedHash !== hash
        ? options.corrupt?.has(file.relPath) === true
        : undefined,
    };
  });

  applyAgentHashes({ db, catalog, bitrot, settings }, results, algorithm);
  agentJobs.heartbeat(job.id, { cursor: null, dirsDone: results.length, dirsRemaining: 0 });
  agentJobs.finish(job.id, {
    state: 'completed',
    filesSeen: results.length,
    bytesSeen: 0,
    dirsDone: results.length,
  });
  return job;
}

/** Run a workflow to completion with the stand-in agent serving whatever it asks for. */
async function runScan(options: Parameters<typeof serveScan>[0] = {}) {
  const run = manager.start('catalog.scan', { force: true });
  await Promise.all([run, serveScan(options)]);
  await manager.drain();
  return manager.run((await run).id)!;
}

async function runHash(options: Parameters<typeof serveHash>[0] = {}) {
  let finished = false;
  const run = manager.start('catalog.hash', { force: true }).finally(() => {
    finished = true;
  });
  // The workflow queues one job per batch until the queue empties, so serve until it
  // stops asking -- and stop the moment the workflow is done, or the helper would sit
  // out its timeout waiting for a job that is never coming.
  const agent = (async () => {
    while (!finished) {
      if (!(await serveHash(options, () => finished))) return;
    }
  })();
  await Promise.all([run, agent]);
  await manager.drain();
  return manager.run((await run).id)!;
}

beforeEach(() => {
  db = openTestDatabase();
  disk = new Map();
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
  db.close();
});

describe('catalog scan', () => {
  it('catalogues everything the agent reports', async () => {
    put('Media/Movies/a.mkv', 'aaaa');
    put('Media/Movies/4K/b.mkv', 'bbbbbb');
    put('Backups/db.bak', 'c');
    configureRoot();

    const run = await runScan();
    expect(run.state).toBe('completed');
    const stats = catalog.rootStats(ROOT_ID);
    expect(stats.files).toBe(3);
    expect(stats.bytes).toBe(11);
  });

  it('does nothing when no roots are configured', async () => {
    settings.update({ schedule: { heavyIo: fullSchedule() }, catalog: { roots: [] } });
    const run = await manager.start('catalog.scan', { force: true });
    await manager.drain();
    expect(manager.run(run.id)!.state).toBe('completed');
    expect(catalog.totals().files).toBe(0);
  });

  it('records created, modified and deleted differences between runs', async () => {
    put('a.txt', 'one');
    put('b.txt', 'two');
    configureRoot();
    await runScan();

    disk.delete('b.txt');
    put('a.txt', 'one changed', 1_700_000_999_000);
    put('c.txt', 'three');
    await runScan();

    const changes = catalog.listChanges({ rootId: ROOT_ID }).changes;
    const byKind = (kind: string) => changes.filter((change) => change.kind === kind).map((c) => c.relPath);
    expect(byKind('created')).toContain('c.txt');
    expect(byKind('modified')).toContain('a.txt');
    expect(byKind('deleted')).toContain('b.txt');
  });

  it('records nothing when nothing changed', async () => {
    put('a.txt', 'one');
    configureRoot();
    await runScan();
    const before = catalog.listChanges({ rootId: ROOT_ID }).total;
    await runScan();
    expect(catalog.listChanges({ rootId: ROOT_ID }).total).toBe(before);
  });

  it('soft-deletes, so a file that comes back is reported as restored', async () => {
    put('a.txt', 'one');
    configureRoot();
    await runScan();

    disk.delete('a.txt');
    await runScan();
    expect(catalog.rootStats(ROOT_ID).files).toBe(0);

    put('a.txt', 'one');
    await runScan();
    expect(
      catalog.listChanges({ rootId: ROOT_ID }).changes.some((change) => change.kind === 'restored'),
    ).toBe(true);
  });

  it('resolves the duplication level for each file', async () => {
    put('Media/Movies/a.mkv', 'aaaa');
    put('Loose.txt', 'bb');
    configureRoot();
    settings.update({
      duplication: {
        defaultLevel: 1,
        rules: [{ id: 'r1', poolId: 'hdd', path: 'Media', level: 3, source: 'manual', note: '' }],
      },
    });
    await runScan();

    const stats = catalog.rootStats(ROOT_ID);
    expect(stats.bytes).toBe(6);
    // 4 bytes x3 duplication + 2 bytes x1
    expect(stats.effectiveBytes).toBe(14);
  });

  // The guarantee the whole disaster-recovery report rests on.
  it('refuses to touch the catalog when the agent does not finish', async () => {
    put('a.txt', 'one');
    put('b.txt', 'two');
    configureRoot();
    await runScan();
    expect(catalog.rootStats(ROOT_ID).files).toBe(2);

    disk.delete('b.txt');
    await runScan({ finish: 'failed' });
    expect(catalog.rootStats(ROOT_ID).files).toBe(2);
  });

  it('raises a critical alert when the agent cannot do the scan', async () => {
    configureRoot();
    await runScan({ finish: 'failed' });
    const alert = alerts.byKey(`catalog:${ROOT_ID}:agent`);
    expect(alert?.severity).toBe('critical');
    expect(alert?.state).toBe('open');
  });

  it('clears that alert once a scan gets through', async () => {
    configureRoot();
    await runScan({ finish: 'failed' });
    put('a.txt', 'one');
    await runScan();
    expect(alerts.byKey(`catalog:${ROOT_ID}:agent`)?.state).toBe('resolved');
  });

  // Waiting forever would leave the workflow looking busy while nothing happens.
  it('gives up when no agent takes the job', async () => {
    configureRoot();
    settings.update({ catalog: { agentClaimTimeoutSeconds: 5 } });
    db.prepare("UPDATE agent_jobs SET created_at = '2000-01-01T00:00:00.000Z'").run();

    const run = await manager.start('catalog.scan', { force: true });
    // Age the job the moment it appears, so the timeout is reached immediately.
    const ager = (async () => {
      for (let i = 0; i < 100; i += 1) {
        db.prepare("UPDATE agent_jobs SET created_at = '2000-01-01T00:00:00.000Z' WHERE state = 'queued'").run();
        await new Promise((resolve) => setTimeout(resolve, 10));
        if (agentJobs.list().some((job) => job.state === 'cancelled')) return;
      }
    })();
    await ager;
    await manager.drain();

    expect(manager.run(run.id)!.state).toBe('completed');
    expect(alerts.byKey(`catalog:${ROOT_ID}:agent`)?.detail).toContain('agent');
  });

  it('raises a critical alert when a scan sees a mass deletion', async () => {
    for (let i = 0; i < 20; i += 1) put(`file${i}.txt`, 'x');
    configureRoot();
    await runScan();

    for (let i = 0; i < 10; i += 1) disk.delete(`file${i}.txt`);
    await runScan();

    const alert = alerts.byKey(`catalog:${ROOT_ID}:mass-deletion`);
    expect(alert?.severity).toBe('critical');
  });

  it('does not raise the mass-deletion alert for a small change', async () => {
    for (let i = 0; i < 100; i += 1) put(`file${i}.txt`, 'x');
    configureRoot();
    await runScan();

    disk.delete('file0.txt');
    await runScan();
    expect(alerts.byKey(`catalog:${ROOT_ID}:mass-deletion`)?.state).not.toBe('open');
  });

  it('builds directory rollups for the storage view', async () => {
    put('Media/Movies/a.mkv', 'aaaa');
    put('Media/Music/b.flac', 'bb');
    configureRoot();
    await runScan();

    const top = catalog.listDirectory(ROOT_ID, '');
    const media = top.entries.find((entry) => entry.name === 'Media')!;
    expect(media.fileCount).toBe(2);
    expect(media.sizeBytes).toBe(6);
  });

  it('scans several roots in one run', async () => {
    put('a.txt', 'one');
    settings.update({
      schedule: { heavyIo: fullSchedule() },
      catalog: {
        agentPollMs: 200,
        roots: [
          { id: 'r1', name: 'One', kind: 'pool', poolId: 'hdd', hostPath: 'J:\\' },
          { id: 'r2', name: 'Two', kind: 'disk', poolId: null, hostPath: 'G:\\' },
        ],
      },
    });

    const run = manager.start('catalog.scan', { force: true });
    await Promise.all([run, (async () => { await serveScan(); await serveScan(); })()]);
    await manager.drain();

    expect(catalog.rootStats('r1').files).toBe(1);
    expect(catalog.rootStats('r2').files).toBe(1);
  });

  it('strips the PoolPart prefix so the same file on two disks compares equal', async () => {
    put('PoolPart.d304fce8-5935-49cb/Media/a.mkv', 'aaaa');
    configureRoot({ kind: 'poolpart' });
    await runScan();
    expect(catalog.searchFiles({ rootId: ROOT_ID }).files[0]!.relPath).toBe('Media/a.mkv');
  });

  it('sends the agent the host path and every glob it must apply', async () => {
    configureRoot({ excludeGlobs: ['Temp/**'], includeGlobs: ['**/*.mkv'] });
    const run = manager.start('catalog.scan', { force: true });

    const job = await waitForJob();
    const root = settings.get().catalog.roots[0]!;
    const wire = agentJobs.toWireJob(job!, root);
    expect(wire.hostPath).toBe(HOST_PATH);
    expect(wire.excludeGlobs).toContain('Temp/**');
    // The global excludes go too: the agent applies them, so it has to be told.
    expect(wire.excludeGlobs.length).toBeGreaterThan(1);
    expect(wire.includeGlobs).toEqual(['**/*.mkv']);

    agentJobs.finish(job!.id, { state: 'completed', filesSeen: 0, bytesSeen: 0, dirsDone: 0 });
    await run;
    await manager.drain();
  });

  it('normalises the backslashes the agent speaks in', async () => {
    put('Media\\Movies\\a.mkv', 'x');
    configureRoot();
    await runScan();
    expect(catalog.searchFiles({ rootId: ROOT_ID }).files[0]!.relPath).toBe('Media/Movies/a.mkv');
  });
});

describe('bit-rot scan', () => {
  const seed = async () => {
    put('a.txt', 'one');
    put('b.txt', 'two');
    configureRoot();
    await runScan();
  };

  it('hashes every catalogued file', async () => {
    await seed();
    const run = await runHash();
    expect(run.state).toBe('completed');
    expect(run.stats.filesHashed).toBeGreaterThanOrEqual(2);
  });

  it('does not re-hash unchanged files on the next run', async () => {
    await seed();
    await runHash();
    const second = await runHash();
    expect(second.stats.filesHashed ?? 0).toBe(0);
  });

  it('re-hashes a file whose content legitimately changed, without crying bit rot', async () => {
    await seed();
    await runHash();

    put('a.txt', 'one changed', 1_700_000_999_000);
    await runScan();
    await runHash();

    expect(bitrot.list({}).findings).toHaveLength(0);
  });

  // The definition of rot: the content changed while size and mtime did not.
  it('detects content that changed while size and mtime stayed identical', async () => {
    await seed();
    await runHash();

    // Same length, same mtime, different bytes.
    disk.set('a.txt', { content: 'ONE', mtimeMs: disk.get('a.txt')!.mtimeMs });
    db.prepare("UPDATE files SET hashed_at = '2000-01-01T00:00:00.000Z'").run();
    await runHash({ corrupt: new Set(['a.txt']) });

    const findings = bitrot.list({}).findings;
    expect(findings).toHaveLength(1);
    expect(findings[0]!.relPath).toBe('a.txt');
    // Two reads agreed, so it is confirmed rather than merely suspected.
    expect(findings[0]!.status).toBe('confirmed');
    expect(findings[0]!.verifiedAt).not.toBeNull();
  });

  // A controller glitch produces a different hash without the bytes having changed.
  it('records an unconfirmed disagreement as unverified rather than as rot', async () => {
    await seed();
    await runHash();

    disk.set('a.txt', { content: 'ONE', mtimeMs: disk.get('a.txt')!.mtimeMs });
    db.prepare("UPDATE files SET hashed_at = '2000-01-01T00:00:00.000Z'").run();
    await runHash();

    const findings = bitrot.list({}).findings;
    expect(findings).toHaveLength(1);
    expect(findings[0]!.status).toBe('open');
    expect(findings[0]!.verifiedAt).toBeNull();
  });

  it('records a read error and moves on instead of failing the run', async () => {
    await seed();
    const run = await runHash({ unreadable: new Set(['a.txt']) });
    expect(run.state).toBe('completed');
    expect(alerts.byKey('catalog:hash-errors')).toBeTruthy();
  });

  it('skips roots with hashing disabled', async () => {
    await seed();
    settings.update({ catalog: { roots: [{ ...settings.get().catalog.roots[0]!, hashEnabled: false }] } });
    const run = await runHash();
    expect(run.stats.filesHashed ?? 0).toBe(0);
  });

  it('can be turned off entirely', async () => {
    await seed();
    settings.update({ bitrot: { enabled: false } });
    const run = await runHash();
    expect(run.stats.filesHashed ?? 0).toBe(0);
  });

  it('honours the per-root minimum hash size', async () => {
    put('small.txt', 'x');
    put('big.txt', 'xxxxxxxxxx');
    configureRoot({ minHashSizeBytes: 5 });
    await runScan();
    await runHash();

    const rows = db
      .prepare<[], { rel_path: string; hash: string | null }>('SELECT rel_path, hash FROM files')
      .all();
    expect(rows.find((row) => row.rel_path === 'small.txt')!.hash).toBeNull();
    expect(rows.find((row) => row.rel_path === 'big.txt')!.hash).not.toBeNull();
  });

  it('respects the configured hash algorithm', async () => {
    await seed();
    settings.update({ catalog: { hashAlgorithm: 'sha1' } });
    await runHash();
    const row = db
      .prepare<[], { hash_algorithm: string | null; hash: string | null }>(
        "SELECT hash_algorithm, hash FROM files WHERE rel_path = 'a.txt'",
      )
      .get();
    expect(row!.hash_algorithm).toBe('sha1');
    expect(row!.hash).toBe(createHash('sha1').update('one').digest('hex'));
  });
});
