import { formatBytes } from '@sakuradrive/shared';
import type { AlertService } from '../services/alert-service.js';
import type { CatalogService } from '../services/catalog-service.js';
import type { SettingsService } from '../services/settings-service.js';
import type { Db } from '../db/index.js';
import type { WorkflowDefinition } from './engine.js';
import { hoursSince, lastCompletedAt } from './support.js';

export interface DuplicationDeps {
  db: Db;
  settings: SettingsService;
  catalog: CatalogService;
  alerts: AlertService;
}

/**
 * Re-apply duplication rules to the catalog and check the pool actually honours them.
 *
 * Two jobs in one pass, because both depend on the same rule set:
 *  - recompute every file's duplication level so the storage view reports the space a
 *    file really consumes (a 1 GB file at 2x duplication occupies 2 GB of pool);
 *  - compare configured duplication against how many *physical disks* hold each file,
 *    which is what DrivePool's duplication setting actually promises and what a disk
 *    failure actually tests.
 */
export function createDuplicationWorkflow(deps: DuplicationDeps): WorkflowDefinition {
  const { db, settings, catalog, alerts } = deps;

  return {
    id: 'catalog.duplication',
    name: 'Duplication check',
    description:
      'Recomputes the duplication level of every catalogued file and reports files whose copies are spread across fewer physical disks than their DrivePool duplication setting requires.',
    respectsSchedule: false,
    concurrencyGroup: null,
    autoStart: true,

    hasWork: () =>
      settings.enabledRoots().length > 0 &&
      hoursSince(lastCompletedAt(db, 'catalog.duplication')) >= 6,

    async run(ctx) {
      const config = settings.get();
      const roots = settings.enabledRoots();
      const dirtyPools = new Set<string>();
      let updated = 0;

      for (const [index, root] of roots.entries()) {
        if (!ctx.shouldContinue()) return { state: 'paused' };
        ctx.setProgress({
          done: index,
          total: roots.length,
          unit: 'roots',
          message: `Recomputing duplication for ${root.name}`,
        });
        // Yielding, both of them: fourteen roots of synchronous work is minutes on a
        // real pool, and this workflow does not respect the I/O window, so it can do
        // that at any hour. Nothing is served while it runs.
        updated += await catalog.refreshDuplicationLevelsYielding(
          root.id,
          config.duplication.rules.filter(
            (rule) => rule.poolId === null || root.poolId === null || rule.poolId === root.poolId,
          ),
          config.duplication.defaultLevel,
        );
        await catalog.rebuildDirStatsYielding(root.id);
        // Not the pool: rebuilding it groups every row on every member disk, so doing
        // it per root means one full pass over the whole pool per member. Once, below.
        if (root.kind === 'poolpart' && root.poolId) dirtyPools.add(root.poolId);
      }

      for (const poolId of dirtyPools) {
        const started = Date.now();
        await catalog.rebuildPoolDirStatsYielding(poolId);
        ctx.log(`Rebuilt the combined view of pool ${poolId} (${Date.now() - started} ms)`);
      }

      const poolIds = [
        ...new Set(
          settings
            .get()
            .catalog.roots.filter((root) => root.kind === 'poolpart' && root.poolId)
            .map((root) => root.poolId as string),
        ),
      ];
      const active = new Set<string>();

      // Two parts of one pool on one physical disk. DrivePool believes it has placed
      // the copies on separate disks; it has not, and no amount of re-balancing will
      // fix it, because the pool has nowhere else to put them. Always checked, since
      // this is a layout fault rather than the transient shortfall the flag is about.
      let sharedDisks = 0;
      for (const poolId of poolIds) {
        for (const collision of catalog.findPartsSharingADisk(poolId)) {
          sharedDisks += 1;
          const dedupeKey = `duplication:${poolId}:shared-disk:${collision.deviceKey}`;
          active.add(dedupeKey);
          alerts.raise({
            dedupeKey,
            category: 'duplication',
            severity: 'critical',
            title: `Pool ${poolId} has ${collision.rootIds.length} parts on one physical disk`,
            detail:
              `${collision.labels.join(', ')} are all on the same disk, so duplicated files whose copies ` +
              'landed there are lost together when it fails. Duplication only protects data when each part ' +
              'of the pool is on a disk of its own — remove one of these from the pool, or move it to another disk.',
            context: {
              pool: poolId,
              disk: collision.deviceKey,
              parts: collision.labels.join(', '),
            },
          });
        }
      }

      let underDuplicated = 0;
      let underDuplicatedBytes = 0;
      if (config.duplication.alertOnUnderDuplication) {
        for (const poolId of poolIds) {
          const mismatches = catalog.findUnderDuplicated(poolId, 500);
          if (mismatches.length === 0) {
            alerts.resolve(`duplication:${poolId}:under`);
            continue;
          }
          underDuplicated += mismatches.length;
          underDuplicatedBytes += mismatches.reduce((sum, item) => sum + item.sizeBytes, 0);
          const dedupeKey = `duplication:${poolId}:under`;
          active.add(dedupeKey);
          alerts.raise({
            dedupeKey,
            category: 'duplication',
            severity: 'warning',
            title: `${mismatches.length} file${mismatches.length === 1 ? '' : 's'} in pool ${poolId} have fewer copies than configured`,
            detail:
              'These files exist on fewer physical disks than their duplication setting requires, so losing one disk would lose them. ' +
              'DrivePool usually fixes this on its own once it has free space and time to re-balance — if the count is not falling, check the balancer.',
            context: {
              pool: poolId,
              files: mismatches.length,
              bytes: formatBytes(underDuplicatedBytes),
              example: mismatches[0]?.relPath ?? '',
            },
          });
        }
      }
      alerts.reconcile('duplication', active);

      ctx.log(
        `Updated ${updated.toLocaleString()} duplication levels; ${underDuplicated} under-duplicated file(s)` +
          (sharedDisks > 0 ? `; ${sharedDisks} pool disk(s) hosting more than one part` : ''),
      );
      return {
        state: 'completed',
        stats: { levelsUpdated: updated, underDuplicated, underDuplicatedBytes, sharedDisks },
      };
    },
  };
}
