import path from 'node:path';
import {
  formatBytes,
  normalizeRootPath,
  type HashAlgorithm,
  type ScanRoot,
} from '@sakuradrive/shared';
import type { AgentJobService } from '../services/agent-job-service.js';
import type { AlertService } from '../services/alert-service.js';
import type { BitrotService } from '../services/bitrot-service.js';
import type { CatalogService, HashCandidate } from '../services/catalog-service.js';
import type { SettingsService } from '../services/settings-service.js';
import { HashAbortedError, hashFile, sleep } from '../util/hash.js';
import type { WorkflowContext, WorkflowDefinition, WorkflowResult } from './engine.js';

interface HashCursor {
  rootIndex: number;
  hashed: number;
  bytes: number;
  findings: number;
  errors: number;
  /** Established once at the start of the run so the progress bar has a real total. */
  total: number | null;
}

function emptyCursor(): HashCursor {
  return { rootIndex: 0, hashed: 0, bytes: 0, findings: 0, errors: 0, total: null };
}

export interface CatalogHashDeps {
  agentJobs: AgentJobService;
  settings: SettingsService;
  catalog: CatalogService;
  bitrot: BitrotService;
  alerts: AlertService;
}

/**
 * Hash catalogued files and compare against the previously stored hash.
 *
 * This is the bit-rot scanner. It is by far the most expensive thing the service does
 * — it reads every byte of the pool — so it is throttleable, pausable and only ever
 * runs inside a window.
 */
export function createCatalogHashWorkflow(deps: CatalogHashDeps): WorkflowDefinition {
  const { settings, catalog, bitrot, alerts } = deps;

  const hashableRoots = () =>
    settings.enabledRoots().filter((root) => root.hashEnabled);

  const queueDepth = (): number => {
    const config = settings.get();
    return hashableRoots().reduce(
      (total, root) =>
        total +
        catalog.countHashQueue(
          root.id,
          config.catalog.rehashIntervalDays,
          root.minHashSizeBytes,
          root.maxHashSizeBytes,
        ),
      0,
    );
  };

  return {
    id: 'catalog.hash',
    name: 'Bit-rot scan',
    description:
      'Reads and hashes catalogued files, comparing each result with the previously stored hash. A file whose content changed while its size and timestamp did not is reported as suspected bit rot.',
    respectsSchedule: true,
    concurrencyGroup: 'io',
    autoStart: true,

    hasWork: () => settings.get().bitrot.enabled && queueDepth() > 0,

    async run(ctx: WorkflowContext): Promise<WorkflowResult> {
      const cursor: HashCursor = { ...emptyCursor(), ...(ctx.getCursor<HashCursor>() ?? {}) };
      const config = settings.get();
      const roots = hashableRoots();

      if (roots.length === 0) {
        ctx.log('No roots have hashing enabled.');
        return { state: 'completed' };
      }

      // A solid total up front is what makes the progress bar meaningful; it is
      // recomputed at the start of each run rather than each resume.
      if (cursor.total === null) {
        cursor.total = queueDepth();
        ctx.log(`${cursor.total.toLocaleString()} files queued for hashing`);
        ctx.setCursor(cursor);
      }

      const algorithm = config.catalog.hashAlgorithm;
      const maxBytesPerSecond = Math.round(config.schedule.maxHashMBps * 1024 * 1024);
      const concurrency = Math.max(1, config.schedule.hashConcurrency);

      for (; cursor.rootIndex < roots.length; cursor.rootIndex += 1) {
        const root = roots[cursor.rootIndex]!;

        // A root the container cannot read cannot be hashed here either. The agent has
        // the file open natively anyway, which is faster than reading it back through
        // drvfs would have been even where that was possible.
        if (root.source === 'agent') {
          const paused = await hashViaAgent(ctx, { deps, root, algorithm, cursor, concurrency });
          if (paused) {
            ctx.setCursor(cursor);
            return { state: 'paused' };
          }
          continue;
        }

        const rootPath = normalizeRootPath(root.containerPath);

        for (;;) {
          if (!ctx.shouldContinue()) {
            ctx.setCursor(cursor);
            ctx.log(`Paused after hashing ${cursor.hashed.toLocaleString()} files`);
            return { state: 'paused' };
          }

          const batch = catalog.hashQueue(
            root.id,
            config.catalog.rehashIntervalDays,
            concurrency * 4,
            root.minHashSizeBytes,
            root.maxHashSizeBytes,
          );
          if (batch.length === 0) break;

          await processBatch(ctx, {
            batch,
            rootPath,
            rootId: root.id,
            rootName: root.name,
            algorithm,
            maxBytesPerSecond,
            concurrency,
            cursor,
            deps,
          });

          if (config.schedule.interFileDelayMs > 0) {
            await sleep(config.schedule.interFileDelayMs, ctx.signal).catch(() => {});
          }
        }
      }

      bitrot.syncAlert();
      if (cursor.errors > 0) {
        alerts.raise({
          dedupeKey: 'catalog:hash-errors',
          category: 'catalog',
          severity: 'warning',
          title: `${cursor.errors} file${cursor.errors === 1 ? '' : 's'} could not be read during the bit-rot scan`,
          detail:
            'Files that cannot be read are excluded from further hashing until the next catalog scan clears the error. Unreadable files on a pool disk are themselves a strong signal that the disk is failing.',
          context: { errors: cursor.errors },
        });
      } else {
        alerts.resolve('catalog:hash-errors');
      }

      ctx.log(
        `Hashed ${cursor.hashed.toLocaleString()} files (${formatBytes(cursor.bytes)}), ` +
          `${cursor.findings} suspected bit-rot finding(s)`,
      );

      return {
        state: 'completed',
        stats: {
          filesHashed: cursor.hashed,
          bytesHashed: cursor.bytes,
          bitrotFindings: cursor.findings,
          readErrors: cursor.errors,
        },
      };
    },
  };
}

interface BatchArgs {
  batch: HashCandidate[];
  rootPath: string;
  rootId: string;
  rootName: string;
  algorithm: HashAlgorithm;
  maxBytesPerSecond: number;
  concurrency: number;
  cursor: HashCursor;
  deps: CatalogHashDeps;
}

/**
 * Hash a root the container cannot read, by asking the agent to.
 *
 * Same queue as the scan: the server decides which files are due a hash and when the
 * window is open, the agent opens them. It also happens to be the faster arrangement --
 * a native read beats the same bytes pulled back through drvfs -- but the reason it
 * exists is that for a volume with no drive letter there is no drvfs path at all.
 *
 * Returns true if the window closed before the queue emptied.
 */
async function hashViaAgent(
  ctx: WorkflowContext,
  args: {
    deps: CatalogHashDeps;
    root: ScanRoot;
    algorithm: string;
    cursor: HashCursor;
    concurrency: number;
  },
): Promise<boolean> {
  const { deps, root, algorithm, cursor } = args;
  const { agentJobs, catalog, settings } = deps;
  const config = settings.get();

  for (;;) {
    if (!ctx.shouldContinue()) return true;

    const batch = catalog.hashQueue(
      root.id,
      config.catalog.rehashIntervalDays,
      Math.max(50, args.concurrency * 50),
      root.minHashSizeBytes,
      root.maxHashSizeBytes,
    );
    if (batch.length === 0) return false;

    const job = agentJobs.enqueue({
      type: 'catalog.hash',
      root,
      workflowRunId: ctx.runId,
      catalogRunId: null,
      payload: {
        hashAlgorithm: algorithm,
        files: batch.map((file) => ({
          fileId: file.id,
          relPath: file.relPath,
          sizeBytes: file.sizeBytes,
        })),
      },
    });

    let cancelRequested = false;
    for (;;) {
      const current = agentJobs.byId(job.id);
      if (!current) return false;

      if (!ctx.shouldContinue() && !cancelRequested) {
        agentJobs.requestCancel(job.id);
        cancelRequested = true;
      }

      const stats = current.stats as { filesSeen?: number; dirsDone?: number; dirsRemaining?: number };
      ctx.setProgress({
        done: cursor.hashed + (stats.dirsDone ?? 0),
        total: cursor.hashed + (stats.dirsDone ?? 0) + (stats.dirsRemaining ?? 0),
        unit: 'files',
        message: `${root.name}: hashing via the agent`,
      });

      if (current.state === 'completed') {
        cursor.hashed += stats.filesSeen ?? batch.length;
        break;
      }
      if (current.state === 'paused') {
        cursor.hashed += stats.filesSeen ?? 0;
        return true;
      }
      if (current.state === 'failed' || current.state === 'cancelled') {
        ctx.log(`Agent hashing of "${root.name}" stopped: ${current.error ?? 'no reason given'}`);
        return false;
      }

      await new Promise((resolve) => setTimeout(resolve, config.catalog.agentPollMs));
    }
  }
}

async function processBatch(ctx: WorkflowContext, args: BatchArgs): Promise<void> {
  const { batch, concurrency } = args;
  let index = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      if (!ctx.shouldContinue()) return;
      const candidate = batch[index];
      index += 1;
      if (!candidate) return;
      await hashOne(ctx, args, candidate);
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, batch.length) }, worker));
}

async function hashOne(ctx: WorkflowContext, args: BatchArgs, candidate: HashCandidate): Promise<void> {
  const { rootPath, algorithm, maxBytesPerSecond, cursor, deps } = args;
  const { catalog, bitrot, settings } = deps;
  const filePath = path.join(rootPath, candidate.relPath);

  let result: Awaited<ReturnType<typeof hashFile>>;
  try {
    result = await hashFile(filePath, {
      algorithm,
      maxBytesPerSecond,
      signal: ctx.signal,
    });
  } catch (error) {
    if (error instanceof HashAbortedError) return;
    cursor.errors += 1;
    catalog.recordHashError(candidate.id, error instanceof Error ? error.message : String(error));
    ctx.log(`Could not hash ${candidate.relPath}: ${error instanceof Error ? error.message : error}`);
    return;
  }

  const config = settings.get();
  const previousHash = candidate.hash;
  const contentShouldBeIdentical =
    previousHash !== null &&
    candidate.hashSizeBytes === candidate.sizeBytes &&
    candidate.hashMtimeMs !== null &&
    Math.abs(candidate.hashMtimeMs - candidate.mtimeMs) <= config.bitrot.mtimeToleranceMs &&
    candidate.hashAlgorithm === algorithm;

  if (contentShouldBeIdentical && previousHash !== result.hash) {
    // Re-read once before believing it: a transient controller glitch produces a
    // different hash without the bytes on disk having changed at all.
    let verified = false;
    if (config.bitrot.verifyOnDetect) {
      try {
        const second = await hashFile(filePath, { algorithm, maxBytesPerSecond, signal: ctx.signal });
        verified = second.hash === result.hash;
        if (!verified) {
          ctx.log(`${candidate.relPath}: two reads disagreed — treating as a read fault, not bit rot`);
        }
      } catch {
        verified = false;
      }
    }

    const { isNew } = bitrot.record({
      fileId: candidate.id,
      rootId: candidate.rootId,
      relPath: candidate.relPath,
      sizeBytes: candidate.sizeBytes,
      mtimeMs: candidate.mtimeMs,
      expectedHash: previousHash,
      actualHash: result.hash,
      hashAlgorithm: algorithm,
      previousHashedAt: candidate.hashedAt,
      verified,
    });
    if (isNew) cursor.findings += 1;
    ctx.log(
      `Suspected bit rot in ${args.rootName}:${candidate.relPath} ` +
        `(${previousHash.slice(0, 12)} → ${result.hash.slice(0, 12)})`,
    );
  }

  catalog.recordHash(candidate.id, result.hash, algorithm, candidate.sizeBytes, candidate.mtimeMs);
  cursor.hashed += 1;
  cursor.bytes += result.bytesRead;

  ctx.setProgress({
    done: cursor.hashed,
    total: cursor.total,
    unit: 'files',
    message: `${args.rootName}: ${candidate.relPath}`,
    bytes: cursor.bytes,
  });
}
