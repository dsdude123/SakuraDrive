import { isReadableDirectory } from '../util/fs-walk.js';
import { normalizeRootPath } from '@sakuradrive/shared';
import type { AgentService } from '../services/agent-service.js';
import type { AgentJobService } from '../services/agent-job-service.js';
import type { AlertService } from '../services/alert-service.js';
import type { CatalogService } from '../services/catalog-service.js';
import type { AuthService } from '../services/auth-service.js';
import type { SettingsService } from '../services/settings-service.js';
import type { Db } from '../db/index.js';
import type { WorkflowManager } from './engine.js';
import type { WorkflowDefinition } from './engine.js';
import { hoursSince, lastCompletedAt } from './support.js';

export interface MaintenanceDeps {
  db: Db;
  settings: SettingsService;
  catalog: CatalogService;
  agents: AgentService;
  agentJobs: AgentJobService;
  alerts: AlertService;
  auth: AuthService;
  manager: () => WorkflowManager;
}

/**
 * Housekeeping: retention, expired sessions and the agent-freshness check.
 *
 * Cheap, and deliberately not tied to the I/O window — a database that grows without
 * bound is its own kind of outage.
 */
export function createMaintenanceWorkflow(deps: MaintenanceDeps): WorkflowDefinition {
  const { db, settings, catalog, agents, agentJobs, alerts, auth } = deps;

  return {
    id: 'maintenance.prune',
    name: 'Maintenance',
    description:
      'Applies retention to SMART, performance, alert and workflow history, expires sessions and checks that every agent is still reporting.',
    respectsSchedule: false,
    concurrencyGroup: null,
    autoStart: true,

    hasWork: () => hoursSince(lastCompletedAt(db, 'maintenance.prune')) >= 12,

    async run(ctx) {
      const config = settings.get();

      agents.checkAgentFreshness();
      const unreadable = await checkRootsReadable(deps);

      const timeSeries = agents.prune();
      const alertsPruned = alerts.prune(config.general.alertHistoryDays);
      // Also put back any agent job whose agent went quiet, so a rebooting host does
      // not leave a root stuck behind a job nobody is working on.
      agentJobs.reclaimAbandoned();
      const agentJobsPruned = agentJobs.prune(config.general.alertHistoryDays);
      const changesPruned = catalog.pruneChanges(config.catalog.changeHistoryRuns);
      const runsPruned = deps.manager().pruneRuns(config.general.workflowRunHistory);
      const sessionsPruned = auth.pruneSessions();
      const notificationsPruned = db
        .prepare(
          `DELETE FROM notifications WHERE status IN ('sent','failed') AND created_at < ?`,
        )
        .run(new Date(Date.now() - 30 * 86_400_000).toISOString()).changes;

      // Reclaim the space the deletes freed; harmless and keeps the file from
      // drifting ever larger after a big catalog change.
      db.pragma('incremental_vacuum');

      const stats = {
        unreadableRoots: unreadable,
        smartRows: timeSeries.smart,
        performanceRows: timeSeries.performance,
        primoCacheRows: timeSeries.primoCache,
        alerts: alertsPruned,
        catalogChanges: changesPruned,
        workflowRuns: runsPruned,
        sessions: sessionsPruned,
        notifications: notificationsPruned,
        agentJobs: agentJobsPruned,
      };
      ctx.log(
        `Pruned ${Object.values(stats).reduce((sum, value) => sum + value, 0).toLocaleString()} rows` +
          (unreadable > 0 ? `; ${unreadable} configured root(s) unreadable` : ''),
      );
      return { state: 'completed', stats };
    },
  };
}

/**
 * Check that every configured root is still visible inside the container.
 *
 * The catalog scan already refuses to touch a root it cannot read, but that only
 * happens when a scan runs — which, on a tight schedule, could be a week away. A
 * vanished bind mount or an offline disk is worth knowing about immediately: it is
 * either a serious hardware failure or a misconfiguration, and in both cases
 * monitoring is silently blind until it is fixed.
 */
async function checkRootsReadable(deps: MaintenanceDeps): Promise<number> {
  const roots = deps.settings.get().catalog.roots.filter((root) => root.enabled);
  let unreadable = 0;

  for (const root of roots) {
    const path = normalizeRootPath(root.containerPath);
    const dedupeKey = `catalog:${root.id}:unreadable`;
    if (await isReadableDirectory(path)) {
      deps.alerts.resolve(dedupeKey);
      continue;
    }
    unreadable += 1;
    deps.alerts.raise({
      dedupeKey,
      category: 'catalog',
      severity: 'critical',
      title: `Catalog root "${root.name}" is not readable`,
      detail:
        `${path} cannot be opened inside the container, so this root is not being catalogued, hashed or checked. ` +
        'Either the bind mount has gone or the underlying disk is offline — both are worth looking at now. ' +
        'The existing catalog for this root is left untouched in the meantime.',
      context: { root: root.name, containerPath: path, hostPath: root.hostPath },
    });
  }
  return unreadable;
}
