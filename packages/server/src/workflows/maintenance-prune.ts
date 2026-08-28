import type { AgentService } from '../services/agent-service.js';
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
  const { db, settings, catalog, agents, alerts, auth } = deps;

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

      const timeSeries = agents.prune();
      const alertsPruned = alerts.prune(config.general.alertHistoryDays);
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
        smartRows: timeSeries.smart,
        performanceRows: timeSeries.performance,
        primoCacheRows: timeSeries.primoCache,
        alerts: alertsPruned,
        catalogChanges: changesPruned,
        workflowRuns: runsPruned,
        sessions: sessionsPruned,
        notifications: notificationsPruned,
      };
      ctx.log(
        `Pruned ${Object.values(stats).reduce((sum, value) => sum + value, 0).toLocaleString()} rows`,
      );
      return { state: 'completed', stats };
    },
  };
}
