import {
  formatBytes,
  type ScanRoot,
} from '@sakuradrive/shared';
import type { AgentJobService } from '../services/agent-job-service.js';
import type { AlertService } from '../services/alert-service.js';
import type { CatalogService } from '../services/catalog-service.js';
import type { SettingsService } from '../services/settings-service.js';
import type { WorkflowContext, WorkflowDefinition, WorkflowResult } from './engine.js';

/**
 * Cursor shape persisted on pause.
 *
 * `worklist` is a LIFO stack of directories still to visit, so resuming picks up at the
 * exact directory the previous window ended on rather than re-walking the tree.
 */
interface ScanCursor {
  rootIndex: number;
  runId: number | null;
  worklist: string[];
  dirsDone: number;
  filesSeen: number;
  bytesSeen: number;
  created: number;
  modified: number;
  restored: number;
  /** Roots fully walked in this run; used so deletions are only applied to those. */
  finishedRoots: string[];
}

/** Fresh cursor. A factory, not a constant: the arrays must not be shared between runs. */
function emptyCursor(): ScanCursor {
  return {
    rootIndex: 0,
    runId: null,
    worklist: [],
    dirsDone: 0,
    filesSeen: 0,
    bytesSeen: 0,
    created: 0,
    modified: 0,
    restored: 0,
    finishedRoots: [],
  };
}

export interface CatalogScanDeps {
  settings: SettingsService;
  catalog: CatalogService;
  alerts: AlertService;
  agentJobs: AgentJobService;
}

/**
 * Walk every enabled root and bring the catalog up to date.
 *
 * This is the workflow the whole scheduling feature exists for: it is pure metadata
 * I/O, but on a pool of millions of files it is still enough to make clients stutter,
 * so it only runs inside a painted window and pauses cleanly at a directory boundary.
 */
export function createCatalogScanWorkflow(deps: CatalogScanDeps): WorkflowDefinition {
  const { settings, catalog, alerts } = deps;

  return {
    id: 'catalog.scan',
    name: 'Catalog scan',
    description:
      'Walks every configured root and records which files exist, their size and their modification time. Produces the created/modified/deleted difference used for disaster recovery.',
    respectsSchedule: true,
    concurrencyGroup: 'io',
    autoStart: true,

    hasWork: () => settings.enabledRoots().length > 0,

    async run(ctx: WorkflowContext): Promise<WorkflowResult> {
      const cursor: ScanCursor = { ...emptyCursor(), ...(ctx.getCursor<ScanCursor>() ?? {}) };
      const config = settings.get();
      const roots = settings.enabledRoots();

      if (roots.length === 0) {
        ctx.log('No catalog roots are configured — nothing to scan.');
        return { state: 'completed' };
      }

      for (; cursor.rootIndex < roots.length; cursor.rootIndex += 1) {
        const root = roots[cursor.rootIndex]!;
        const runId = cursor.runId ?? catalog.activeRun(root.id) ?? catalog.beginRun(root.id, ctx.runId);
        cursor.runId = runId;

        const outcome = await runAgentScan(ctx, { deps, root, runId, cursor });
        if (outcome === 'paused') {
          ctx.setCursor(cursor);
          return { state: 'paused' };
        }
        if (outcome === 'completed') {
          finishRoot(ctx, deps, root, runId, cursor, config);
        } else {
          // Failed or abandoned. Leave the catalog exactly as it was: a half-walked
          // tree read as deletions would be far worse than a scan that did not happen.
          catalog.finishRun(runId, 'failed', 'The agent did not finish the scan.');
        }
        resetRootCursor(cursor);
        ctx.setCursor(cursor);
      }

      return {
        state: 'completed',
        stats: { rootsScanned: cursor.finishedRoots.length },
      };
    },
  };
}

/** Everything a finished root needs, whoever walked it. */
function finishRoot(
  ctx: WorkflowContext,
  deps: CatalogScanDeps,
  root: ScanRoot,
  runId: number,
  cursor: ScanCursor,
  config: ReturnType<SettingsService['get']>,
): void {
  const { catalog } = deps;
  // The root was walked in full, so anything not seen really is gone.
  const deleted = catalog.markMissingAsDeleted(runId, root.id);
  const stats = catalog.rootStats(root.id);
  catalog.updateRunStats(runId, {
    filesSeen: cursor.filesSeen,
    dirsSeen: cursor.dirsDone,
    bytesSeen: cursor.bytesSeen,
    created: cursor.created,
    modified: cursor.modified,
    deleted,
    restored: cursor.restored,
  });
  catalog.rebuildDirStats(root.id);
  // A member disk changed, so the pool view built from it is now stale.
  catalog.rebuildPoolsContaining(root.id);
  catalog.finishRun(runId, 'completed');

  ctx.log(
    `Finished "${root.name}": ${cursor.filesSeen.toLocaleString()} files, ` +
      `${formatBytes(cursor.bytesSeen)}, +${cursor.created} ~${cursor.modified} -${deleted}`,
  );
  checkMassDeletion(deps, root, deleted, stats.files + deleted, config.catalog.massDeletionAlertPercent);
  cursor.finishedRoots.push(root.id);
}

function resetRootCursor(cursor: ScanCursor): void {
  cursor.runId = null;
  cursor.worklist = [];
  cursor.dirsDone = 0;
  cursor.filesSeen = 0;
  cursor.bytesSeen = 0;
  cursor.created = 0;
  cursor.modified = 0;
  cursor.restored = 0;
}

/**
 * Hand a root to the agent and wait for it.
 *
 * The workflow stays in charge: it owns the catalog run, decides when the window has
 * closed, and applies the deletion sweep only on a clean finish. What it delegates is
 * reading the disk -- which is the one thing this container physically cannot do for a
 * volume with no drive letter.
 *
 * Waiting rather than polling from the agent's side keeps the schedule authoritative:
 * when `shouldContinue()` turns false the job is marked for cancellation and the agent
 * is told to stop in the reply to its next batch, so it stops at a batch boundary with
 * a cursor rather than being killed mid-tree.
 */
async function runAgentScan(
  ctx: WorkflowContext,
  args: { deps: CatalogScanDeps; root: ScanRoot; runId: number; cursor: ScanCursor },
): Promise<'completed' | 'paused' | 'failed'> {
  const { deps, root, runId, cursor } = args;
  const { agentJobs, settings, catalog, alerts } = deps;
  const config = settings.get();

  const job = agentJobs.enqueue({
    type: 'catalog.scan',
    root,
    workflowRunId: ctx.runId,
    catalogRunId: runId,
    payload: {
      batchSize: config.catalog.batchSize,
      includeGlobs: root.includeGlobs,
      excludeGlobs: [...config.catalog.globalExcludeGlobs, ...root.excludeGlobs],
      followSymlinks: config.catalog.followSymlinks,
    },
    ...(cursor.worklist.length > 0 ? { cursor: { worklist: cursor.worklist } } : {}),
  });

  ctx.log(`Queued "${root.name}" for the agent (${root.hostPath})`);

  let cancelRequested = false;
  for (;;) {
    const current = agentJobs.byId(job.id);
    if (!current) return 'failed';

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
      ctx.log(`Asked the agent to stop "${root.name}" at the next batch`);
    }

    const stats = current.stats as { filesSeen?: number; bytesSeen?: number; dirsDone?: number; dirsRemaining?: number };
    cursor.filesSeen = stats.filesSeen ?? cursor.filesSeen;
    cursor.bytesSeen = stats.bytesSeen ?? cursor.bytesSeen;
    cursor.dirsDone = stats.dirsDone ?? cursor.dirsDone;
    ctx.setProgress({
      done: cursor.dirsDone,
      total: cursor.dirsDone + (stats.dirsRemaining ?? 0),
      unit: 'directories',
      message: `${root.name}: ${cursor.filesSeen.toLocaleString()} files via the agent`,
      bytes: cursor.bytesSeen,
    });

    if (current.state === 'completed') {
      alerts.resolve(`catalog:${root.id}:agent`);
      return 'completed';
    }
    if (current.state === 'paused') {
      const paused = current.cursor as { worklist?: string[] } | null;
      cursor.worklist = paused?.worklist ?? [];
      return 'paused';
    }
    if (current.state === 'failed' || current.state === 'cancelled') {
      // Same posture as an unreadable bind mount: say so, change nothing. A half-walked
      // tree read as deletions would be far worse than a scan that did not happen.
      alerts.raise({
        dedupeKey: `catalog:${root.id}:agent`,
        category: 'catalog',
        severity: 'critical',
        title: `The agent could not scan "${root.name}"`,
        detail:
          `${current.error ?? 'The agent stopped without finishing.'} The catalog for this root ` +
          'was left untouched. Check that the agent is running and that the volume is online.',
        context: { root: root.name, hostPath: root.hostPath, job: current.id },
      });
      ctx.log(`Agent scan of "${root.name}" failed: ${current.error ?? 'no reason given'}`);
      return 'failed';
    }

    // Nothing to do but wait for the agent. Short enough that a closing window is acted
    // on promptly, long enough not to spin.
    await new Promise((resolve) => setTimeout(resolve, config.catalog.agentPollMs));
    void catalog;
  }
}

function checkMassDeletion(
  deps: CatalogScanDeps,
  root: ScanRoot,
  deleted: number,
  previousTotal: number,
  thresholdPercent: number,
): void {
  const dedupeKey = `catalog:${root.id}:mass-deletion`;
  if (thresholdPercent <= 0 || previousTotal === 0 || deleted === 0) {
    deps.alerts.resolve(dedupeKey);
    return;
  }
  const percent = (deleted / previousTotal) * 100;
  if (percent < thresholdPercent) {
    deps.alerts.resolve(dedupeKey);
    return;
  }
  deps.alerts.raise({
    dedupeKey,
    category: 'catalog',
    severity: 'critical',
    title: `${deleted.toLocaleString()} files disappeared from "${root.name}"`,
    detail:
      `That is ${percent.toFixed(1)}% of everything previously catalogued in this root. ` +
      'If a pool disk has failed this is expected — open the catalog difference for the exact list. ' +
      'If not, check the bind mount and the drive before doing anything else. The catalog rows are only marked deleted, never removed, so the list survives either way.',
    context: {
      root: root.name,
      deleted,
      previousTotal,
      percent: `${percent.toFixed(1)}%`,
    },
  });
}
