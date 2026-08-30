import {
  formatBytes,
  type ScanRoot,
} from '@sakuradrive/shared';
import type { AgentJobService } from '../services/agent-job-service.js';
import type { AlertService } from '../services/alert-service.js';
import type { BitrotService } from '../services/bitrot-service.js';
import type { CatalogService } from '../services/catalog-service.js';
import type { SettingsService } from '../services/settings-service.js';
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

      // Opt-out is opt-out: "run now" must not hash a pool whose owner turned this off.
      if (!config.bitrot.enabled) {
        ctx.log('The bit-rot scan is switched off in settings.');
        return { state: 'completed' };
      }

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
        if (await hashViaAgent(ctx, { deps, root, algorithm, cursor, concurrency })) {
          ctx.setCursor(cursor);
          ctx.log(`Paused after hashing ${cursor.hashed.toLocaleString()} files`);
          return { state: 'paused' };
        }
      }

      bitrot.syncAlert();
      cursor.errors = hashableRoots().reduce(
        (total, root) => total + catalog.countHashErrors(root.id),
        0,
      );
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


/**
 * Hash a root by asking the agent to.
 *
 * The server decides which files are due a hash, in what order, and when the window is
 * open; the agent opens them. It has to be this way round for most of these volumes --
 * the container has no path to a disk without a drive letter -- and it is the better
 * arrangement regardless, since a native read beats the same bytes pulled through
 * drvfs. At 95 TB that difference is measured in days.
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
        maxBytesPerSecond: Math.round(config.schedule.maxHashMBps * 1024 * 1024),
        files: batch.map((file) => ({
          fileId: file.id,
          relPath: file.relPath,
          sizeBytes: file.sizeBytes,
          // What we hold. A different result means the agent re-reads before we
          // believe it: a controller glitch is not bit rot.
          expectedHash: file.hash,
        })),
      },
    });

    let cancelRequested = false;
    for (;;) {
      const current = agentJobs.byId(job.id);
      if (!current) return false;

      // Nobody has taken it. Waiting forever would leave the workflow looking busy while
      // nothing at all is happening, which is the worst kind of failure: it does not look
      // like one.
      if (current.state === 'queued') {
        const waited = (Date.now() - Date.parse(current.createdAt)) / 1000;
        if (waited > config.catalog.agentClaimTimeoutSeconds) {
          agentJobs.cancel(
            job.id,
            `No agent claimed this job within ${Math.round(waited)}s. Is the agent running on the host?`,
          );
        }
      }

      if (!ctx.shouldContinue() && !cancelRequested) {
        agentJobs.requestCancel(job.id);
        cancelRequested = true;
      }

      const stats = current.stats as {
        filesSeen?: number;
        dirsDone?: number;
        dirsRemaining?: number;
      };
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
