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
/** "2 days", "1 day", "12 hours" -- the grace period is configurable and may be short. */
function describeDays(days: number): string {
  if (days >= 1) {
    const whole = Math.round(days);
    return `${whole} day${whole === 1 ? '' : 's'}`;
  }
  const hours = Math.max(1, Math.round(days * 24));
  return `${hours} hour${hours === 1 ? '' : 's'}`;
}

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
      let overdue = 0;
      if (!config.duplication.alertOnUnderDuplication) {
        // Not tracking means not keeping half-aged state around to mislead whoever
        // turns the check back on: they get the balancer's full grace period again.
        catalog.pruneDuplicationShortfall([]);
      } else {
        catalog.pruneDuplicationShortfall(poolIds);
        const graceDays = config.duplication.underDuplicationGraceDays;
        for (const poolId of poolIds) {
          if (!ctx.shouldContinue()) return { state: 'paused' };
          const shortfall = await catalog.trackDuplicationShortfallYielding(poolId, graceDays);
          underDuplicated += shortfall.total;
          underDuplicatedBytes += shortfall.overdueBytes;
          overdue += shortfall.overdue;

          const dedupeKey = `duplication:${poolId}:under`;
          // Files short of copies but still inside the grace period are the balancer
          // doing its job, so they are counted and logged but never alerted on.
          if (shortfall.overdue === 0) {
            alerts.resolve(dedupeKey);
            continue;
          }
          const stuckDays = shortfall.oldestSince
            ? Math.floor((Date.now() - Date.parse(shortfall.oldestSince)) / 86_400_000)
            : graceDays;
          const plural = shortfall.overdue === 1 ? '' : 's';
          active.add(dedupeKey);
          alerts.raise({
            dedupeKey,
            category: 'duplication',
            severity: 'warning',
            title:
              graceDays > 0
                ? `${shortfall.overdue} file${plural} in pool ${poolId} ` +
                  `still ${shortfall.overdue === 1 ? 'has' : 'have'} fewer copies than configured ` +
                  `after ${describeDays(graceDays)}`
                : `${shortfall.overdue} file${plural} in pool ${poolId} ` +
                  `${shortfall.overdue === 1 ? 'has' : 'have'} fewer copies than configured`,
            detail:
              'These files exist on fewer physical disks than their duplication setting requires, so losing one disk would lose them. ' +
              (graceDays > 0
                ? `DrivePool has had ${describeDays(graceDays)} to re-balance and has not fixed ${shortfall.overdue === 1 ? 'it' : 'them'}` +
                  `${stuckDays > graceDays ? ` — the oldest has been short for ${describeDays(stuckDays)}` : ''}. `
                : 'DrivePool usually fixes this on its own once it has free space and time to re-balance. ') +
              'Check the balancer has run, and that the pool has the free space to place another copy.' +
              (shortfall.total > shortfall.overdue
                ? ` A further ${(shortfall.total - shortfall.overdue).toLocaleString()} file(s) are short of copies but still within the grace period; those are normal after a write.`
                : ''),
            context: {
              pool: poolId,
              files: shortfall.overdue,
              bytes: formatBytes(shortfall.overdueBytes),
              graceDays,
              shortfallTotal: shortfall.total,
              oldestSince: shortfall.oldestSince ?? '',
              example: shortfall.examples[0]?.relPath ?? '',
            },
          });
        }
      }
      alerts.reconcile('duplication', active);

      ctx.log(
        `Updated ${updated.toLocaleString()} duplication levels; ${underDuplicated} under-duplicated file(s)` +
          `, ${overdue} of them past the grace period` +
          (sharedDisks > 0 ? `; ${sharedDisks} pool disk(s) hosting more than one part` : ''),
      );
      return {
        state: 'completed',
        stats: {
          levelsUpdated: updated,
          underDuplicated,
          underDuplicatedOverdue: overdue,
          underDuplicatedBytes,
          sharedDisks,
        },
      };
    },
  };
}
