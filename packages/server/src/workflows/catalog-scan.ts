import path from 'node:path';
import {
  compileGlobList,
  createDuplicationResolver,
  formatBytes,
  normalizeRootPath,
  type ScanRoot,
} from '@sakuradrive/shared';
import type { AlertService } from '../services/alert-service.js';
import type { CatalogService } from '../services/catalog-service.js';
import type { SettingsService } from '../services/settings-service.js';
import { isReadableDirectory, readDirectory, type WalkedFile } from '../util/fs-walk.js';
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

      const globalExclude = compileGlobList(config.catalog.globalExcludeGlobs);

      for (; cursor.rootIndex < roots.length; cursor.rootIndex += 1) {
        const root = roots[cursor.rootIndex]!;
        const rootPath = normalizeRootPath(root.containerPath);

        if (!(await isReadableDirectory(rootPath))) {
          // A missing bind mount looks exactly like a wiped disk. Never guess: skip the
          // root so the catalog is left intact and tell the operator instead.
          alerts.raise({
            dedupeKey: `catalog:${root.id}:unreadable`,
            category: 'catalog',
            severity: 'critical',
            title: `Catalog root "${root.name}" is not readable`,
            detail: `${rootPath} could not be opened inside the container. The scan skipped this root so the existing catalog is preserved. Check that the bind mount still exists and that the drive is online.`,
            context: { root: root.name, containerPath: rootPath, hostPath: root.hostPath },
          });
          ctx.log(`Skipped "${root.name}": ${rootPath} is not readable`);
          continue;
        }
        alerts.resolve(`catalog:${root.id}:unreadable`);

        const runId = cursor.runId ?? catalog.activeRun(root.id) ?? catalog.beginRun(root.id, ctx.runId);
        cursor.runId = runId;
        if (cursor.worklist.length === 0 && cursor.dirsDone === 0) {
          cursor.worklist = [''];
          ctx.log(`Scanning "${root.name}" (${root.hostPath || rootPath})`);
        }

        const paused = await scanRoot(ctx, {
          root,
          rootPath,
          runId,
          cursor,
          settings,
          catalog,
          globalExclude,
        });

        if (paused) {
          ctx.setCursor(cursor);
          return { state: 'paused' };
        }

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
        catalog.finishRun(runId, 'completed');

        ctx.log(
          `Finished "${root.name}": ${cursor.filesSeen.toLocaleString()} files, ` +
            `${formatBytes(cursor.bytesSeen)}, +${cursor.created} ~${cursor.modified} -${deleted}`,
        );
        checkMassDeletion(deps, root, deleted, stats.files + deleted, config.catalog.massDeletionAlertPercent);

        cursor.finishedRoots.push(root.id);
        cursor.runId = null;
        cursor.worklist = [];
        cursor.dirsDone = 0;
        cursor.filesSeen = 0;
        cursor.bytesSeen = 0;
        cursor.created = 0;
        cursor.modified = 0;
        cursor.restored = 0;
        ctx.setCursor(cursor);
      }

      return {
        state: 'completed',
        stats: { rootsScanned: cursor.finishedRoots.length },
      };
    },
  };
}

interface ScanRootArgs {
  root: ScanRoot;
  rootPath: string;
  runId: number;
  cursor: ScanCursor;
  settings: SettingsService;
  catalog: CatalogService;
  globalExclude: (input: string) => boolean;
}

/** Returns true when the scan paused before finishing this root. */
async function scanRoot(ctx: WorkflowContext, args: ScanRootArgs): Promise<boolean> {
  const { root, rootPath, runId, cursor, settings, catalog, globalExclude } = args;
  const config = settings.get();
  const rootExclude = compileGlobList(root.excludeGlobs);
  const rootInclude = root.includeGlobs.length > 0 ? compileGlobList(root.includeGlobs) : null;
  const duplicationFor = createDuplicationResolver(
    config.duplication.rules.filter(
      (rule) => rule.poolId === null || rule.poolId === root.poolId || root.poolId === null,
    ),
    config.duplication.defaultLevel,
  );

  const batchSize = config.catalog.batchSize;
  let batch: WalkedFile[] = [];

  const flush = () => {
    if (batch.length === 0) return;
    const result = catalog.recordFiles(runId, root, batch, duplicationFor);
    cursor.created += result.created;
    cursor.modified += result.modified;
    cursor.restored += result.restored;
    cursor.bytesSeen += result.bytes;
    cursor.filesSeen += batch.length;
    batch = [];
    ctx.setProgress({
      done: cursor.dirsDone,
      total: cursor.dirsDone + cursor.worklist.length,
      unit: 'directories',
      message: `${root.name}: ${cursor.filesSeen.toLocaleString()} files (${formatBytes(cursor.bytesSeen)})`,
      bytes: cursor.bytesSeen,
    });
  };

  while (cursor.worklist.length > 0) {
    if (!ctx.shouldContinue()) {
      flush();
      catalog.updateRunStats(runId, {
        filesSeen: cursor.filesSeen,
        dirsSeen: cursor.dirsDone,
        bytesSeen: cursor.bytesSeen,
        created: cursor.created,
        modified: cursor.modified,
        restored: cursor.restored,
      });
      ctx.log(`Paused in "${root.name}" with ${cursor.worklist.length} directories remaining`);
      return true;
    }

    const relDir = cursor.worklist.pop()!;
    const listing = await readDirectory(rootPath, relDir, {
      followSymlinks: config.catalog.followSymlinks,
      excludeDirectory: (relPath) => globalExclude(relPath) || rootExclude(relPath),
      includeFile: (relPath) => {
        if (globalExclude(relPath) || rootExclude(relPath)) return false;
        if (rootInclude && !rootInclude(relPath)) return false;
        return true;
      },
    });

    cursor.dirsDone += 1;
    // Reverse so the stack yields directories in the order they were listed, which
    // keeps the progress message moving through the tree in a way that reads sensibly.
    for (let i = listing.directories.length - 1; i >= 0; i -= 1) {
      cursor.worklist.push(listing.directories[i]!);
    }
    batch.push(...listing.files);

    for (const error of listing.errors) {
      ctx.log(`Could not read ${path.posix.join(root.name, error.relPath)}: ${error.message}`);
    }

    if (batch.length >= batchSize) flush();

    if (config.schedule.interFileDelayMs > 0 && cursor.dirsDone % 20 === 0) {
      await new Promise((resolve) => setTimeout(resolve, config.schedule.interFileDelayMs));
    }
  }

  flush();
  return false;
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
