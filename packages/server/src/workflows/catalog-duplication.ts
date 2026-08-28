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
 *  - compare configured duplication against how many pool parts hold each file, which
 *    only DrivePool itself would otherwise tell you, and only if you went looking.
 */
export function createDuplicationWorkflow(deps: DuplicationDeps): WorkflowDefinition {
  const { db, settings, catalog, alerts } = deps;

  return {
    id: 'catalog.duplication',
    name: 'Duplication check',
    description:
      'Recomputes the duplication level of every catalogued file and reports files stored on fewer pool parts than their DrivePool duplication setting requires.',
    respectsSchedule: false,
    concurrencyGroup: null,
    autoStart: true,

    hasWork: () =>
      settings.enabledRoots().length > 0 &&
      hoursSince(lastCompletedAt(db, 'catalog.duplication')) >= 6,

    async run(ctx) {
      const config = settings.get();
      const roots = settings.enabledRoots();
      let updated = 0;

      for (const [index, root] of roots.entries()) {
        if (!ctx.shouldContinue()) return { state: 'paused' };
        ctx.setProgress({
          done: index,
          total: roots.length,
          unit: 'roots',
          message: `Recomputing duplication for ${root.name}`,
        });
        updated += catalog.refreshDuplicationLevels(
          root.id,
          config.duplication.rules.filter(
            (rule) => rule.poolId === null || root.poolId === null || rule.poolId === root.poolId,
          ),
          config.duplication.defaultLevel,
        );
        catalog.rebuildDirStats(root.id);
      }

      let underDuplicated = 0;
      let underDuplicatedBytes = 0;
      if (config.duplication.alertOnUnderDuplication) {
        const poolIds = [
          ...new Set(
            settings
              .get()
              .catalog.roots.filter((root) => root.kind === 'poolpart' && root.poolId)
              .map((root) => root.poolId as string),
          ),
        ];
        const active = new Set<string>();
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
              'These files are stored on fewer pool parts than their duplication setting requires, so losing one disk would lose them. ' +
              'DrivePool usually fixes this on its own once it has free space and time to re-balance — if the count is not falling, check the balancer.',
            context: {
              pool: poolId,
              files: mismatches.length,
              bytes: formatBytes(underDuplicatedBytes),
              example: mismatches[0]?.relPath ?? '',
            },
          });
        }
        alerts.reconcile('duplication', active);
      }

      ctx.log(
        `Updated ${updated.toLocaleString()} duplication levels; ${underDuplicated} under-duplicated file(s)`,
      );
      return {
        state: 'completed',
        stats: { levelsUpdated: updated, underDuplicated, underDuplicatedBytes },
      };
    },
  };
}
