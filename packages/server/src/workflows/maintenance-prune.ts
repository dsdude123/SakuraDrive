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
      const unreachable = checkRootsReachable(deps);

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
        unreachableRoots: unreachable,
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
          (unreachable > 0 ? `; ${unreachable} configured root(s) unreachable` : ''),
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
function checkRootsReachable(deps: MaintenanceDeps): number {
  const roots = deps.settings.get().catalog.roots.filter((root) => root.enabled);
  if (roots.length === 0) return 0;

  // Nothing has reported yet, so nothing is known to be wrong. The agent-freshness
  // alert covers a host that never checks in; this one must not double up on it.
  const anyAgent =
    (deps.db.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM agents').get()?.n ?? 0) > 0;
  if (!anyAgent) return 0;

  const parts = deps.db
    .prepare<[], { path: string | null; volume_label: string | null; missing: number }>(
      'SELECT path, volume_label, missing FROM pool_parts',
    )
    .all();
  const volumes = deps.db
    .prepare<[], { label: string | null }>('SELECT label FROM volumes')
    .all();

  const normalise = (value: string | null | undefined) => (value ?? '').trim().toLowerCase();
  let unreachable = 0;

  for (const root of roots) {
    const dedupeKey = `catalog:${root.id}:unreadable`;
    const wantedPath = normalise(root.hostPath);
    const wantedLabel = normalise(root.driveLabel);

    const part = parts.find(
      (candidate) =>
        (wantedPath !== '' && normalise(candidate.path) === wantedPath) ||
        (wantedLabel !== '' && normalise(candidate.volume_label) === wantedLabel),
    );
    const volumeSeen =
      wantedLabel !== '' && volumes.some((volume) => normalise(volume.label) === wantedLabel);

    if (part && part.missing === 0) {
      deps.alerts.resolve(dedupeKey);
      continue;
    }
    if (!part && volumeSeen) {
      // Not a pool member, but the agent can see the volume. Fine.
      deps.alerts.resolve(dedupeKey);
      continue;
    }

    unreachable += 1;
    const reason = part
      ? 'DrivePool reports this pool part as missing, which means the disk has dropped out of the pool.'
      : 'The agent did not report a volume or pool part matching this root, so either the disk is offline or the path is wrong.';
    deps.alerts.raise({
      dedupeKey,
      category: 'catalog',
      severity: 'critical',
      title: `Catalog root "${root.name}" is not reachable`,
      detail:
        `${reason} This root is not being catalogued, hashed or checked, and monitoring of it is ` +
        'silently blind until it is fixed. The existing catalog for this root is left untouched.',
      context: { root: root.name, hostPath: root.hostPath, driveLabel: root.driveLabel },
    });
  }
  return unreachable;
}

