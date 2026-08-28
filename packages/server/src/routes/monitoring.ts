import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  ALERT_CATEGORIES,
  maxSeverity,
  type HealthSummary,
  type Severity,
} from '@sakuradrive/shared';
import { nowIso } from '../db/index.js';
import type { Services } from '../services/container.js';
import { SESSION_COOKIE, intParam, parseBody, parseQuery, sendCsv, toCsv } from './helpers.js';

export function registerMonitoringRoutes(app: FastifyInstance, services: Services): void {
  const { agents, alerts, catalog, bitrot, backup, exports, workflows, auth } = services;

  app.get('/api/dashboard', async () => buildHealthSummary(services));

  app.get('/api/drives', async () => ({ drives: agents.listDrives() }));

  app.get<{ Params: { id: string } }>('/api/drives/:id', async (request, reply) => {
    const detail = agents.driveDetail(Number(request.params.id));
    if (!detail.drive) return reply.code(404).send({ error: 'not_found', message: 'Unknown drive' });
    return detail;
  });

  app.get('/api/drives.csv', async (_request, reply) => {
    const rows = agents.listDrives().map((drive) => [
      drive.labels.join(' / '),
      drive.model ?? '',
      drive.serialNumber ?? '',
      drive.sizeBytes ?? '',
      drive.mediaType ?? '',
      drive.busType ?? '',
      drive.poolNames.join(' / '),
      drive.temperatureC ?? '',
      drive.powerOnHours ?? '',
      drive.severity ?? 'ok',
      drive.lastSeenAt ?? '',
    ]);
    sendCsv(
      reply,
      'sakuradrive-drives.csv',
      toCsv(
        ['label', 'model', 'serial', 'size_bytes', 'media', 'bus', 'pools', 'temp_c', 'power_on_hours', 'severity', 'last_seen'],
        rows,
      ),
    );
  });

  app.get('/api/volumes', async () => ({ volumes: agents.listVolumes() }));
  app.get('/api/pools', async () => ({ pools: agents.listPools() }));
  app.get('/api/primocache', async () => ({ latest: agents.latestPrimoCache() }));

  /* ------------------------------------------------------------------ alerts */

  app.get('/api/alerts', async (request, reply) => {
    const query = parseQuery(
      z.object({
        state: z.enum(['open', 'acknowledged', 'resolved', 'any']).default('open'),
        category: z.enum(ALERT_CATEGORIES).optional(),
        severity: z.enum(['info', 'warning', 'critical']).optional(),
        search: z.string().optional(),
        limit: intParam(100, 500),
        offset: intParam(0),
      }),
      request,
      reply,
    );
    if (!query) return reply;
    return { ...alerts.list(query), counts: alerts.counts() };
  });

  app.get<{ Params: { id: string } }>('/api/alerts/:id', async (request, reply) => {
    const alert = alerts.byId(Number(request.params.id));
    if (!alert) return reply.code(404).send({ error: 'not_found', message: 'Unknown alert' });
    return { alert, events: alerts.events(alert.id) };
  });

  app.post<{ Params: { id: string } }>('/api/alerts/:id/acknowledge', async (request, reply) => {
    const user = auth.resolveSession(request.cookies[SESSION_COOKIE]);
    const alert = alerts.acknowledge(Number(request.params.id), user?.username ?? 'operator');
    if (!alert) return reply.code(404).send({ error: 'not_found', message: 'Unknown alert' });
    return { alert };
  });

  app.post<{ Params: { id: string } }>('/api/alerts/:id/unacknowledge', async (request, reply) => {
    const alert = alerts.unacknowledge(Number(request.params.id));
    if (!alert) return reply.code(404).send({ error: 'not_found', message: 'Unknown alert' });
    return { alert };
  });

  app.post<{ Params: { id: string } }>('/api/alerts/:id/resolve', async (request, reply) => {
    const alert = alerts.byId(Number(request.params.id));
    if (!alert) return reply.code(404).send({ error: 'not_found', message: 'Unknown alert' });
    // Resolving by hand is a statement about the world, not about the alert: if the
    // condition is still true the next collector run will raise it again.
    return { alert: alerts.resolve(alert.dedupeKey, 'Resolved by the operator') ?? alert };
  });

  /* --------------------------------------------------------------- workflows */

  app.get('/api/workflows', async () => ({
    workflows: workflows.status(),
    windowOpen: workflows.windowOpen(),
  }));

  app.get('/api/workflows/runs', async (request, reply) => {
    const query = parseQuery(
      z.object({ workflowId: z.string().optional(), limit: intParam(50, 200) }),
      request,
      reply,
    );
    if (!query) return reply;
    return { runs: workflows.runs(query.workflowId as never, query.limit) };
  });

  app.get<{ Params: { id: string } }>('/api/workflows/runs/:id', async (request, reply) => {
    const run = workflows.run(Number(request.params.id));
    if (!run) return reply.code(404).send({ error: 'not_found', message: 'Unknown run' });
    return { run };
  });

  app.post<{ Params: { id: string } }>('/api/workflows/:id/start', async (request, reply) => {
    const body = parseBody(
      z.object({ force: z.boolean().default(true), params: z.record(z.unknown()).default({}) }).partial(),
      request,
      reply,
    );
    if (!body) return reply;
    try {
      const run = await workflows.start(request.params.id as never, {
        trigger: 'manual',
        force: body.force ?? true,
        params: body.params ?? {},
      });
      return { run };
    } catch (error) {
      return reply.code(409).send({
        error: 'cannot_start',
        message: error instanceof Error ? error.message : 'Could not start the workflow',
      });
    }
  });

  app.post<{ Params: { id: string } }>('/api/workflows/:id/stop', async (request, reply) => {
    const stopped = workflows.stop(request.params.id as never, 'manual');
    if (!stopped) {
      return reply.code(409).send({ error: 'not_running', message: 'That workflow is not running' });
    }
    return { ok: true };
  });

  /* -------------------------------------------------------------- exports UI */

  app.get('/api/exports', async () => ({
    exports: exports.listExports(),
    lastExportAt: exports.lastExportAt(),
  }));

  void catalog;
  void bitrot;
  void backup;
}

/** Assemble the dashboard payload from every subsystem. */
export function buildHealthSummary(services: Services): HealthSummary {
  const { agents, alerts, catalog, bitrot, backup, exports, workflows } = services;

  const drives = agents.listDrives();
  const staleMinutes = services.settings.get().smart.agentStaleMinutes;
  const alertCounts = alerts.counts();
  const catalogTotals = catalog.totals();

  let severity: Severity | null = null;
  if (alertCounts.critical > 0) severity = 'critical';
  else if (alertCounts.warning > 0) severity = 'warning';
  else if (alertCounts.info > 0) severity = 'info';

  const driveSeverity = drives.reduce<Severity | null>(
    (worst, drive) => (drive.severity ? (worst ? maxSeverity(worst, drive.severity) : drive.severity) : worst),
    null,
  );
  if (driveSeverity) severity = severity ? maxSeverity(severity, driveSeverity) : driveSeverity;

  const agentList = agents.listAgents();
  const pools = agents.listPools();
  const lastScan = catalog.listRuns(undefined, 1)[0] ?? null;

  return {
    generatedAt: nowIso(),
    severity,
    alerts: alertCounts,
    drives: {
      total: drives.length,
      healthy: drives.filter((drive) => !drive.severity).length,
      warning: drives.filter((drive) => drive.severity === 'warning').length,
      critical: drives.filter((drive) => drive.severity === 'critical').length,
      offline: drives.filter(
        (drive) => !drive.lastSeenAt || Date.now() - Date.parse(drive.lastSeenAt) > staleMinutes * 60_000,
      ).length,
    },
    pools: pools.map((pool) => ({
      name: pool.name ?? pool.poolId,
      sizeBytes: pool.sizeBytes,
      freeBytes: pool.freeBytes,
      partCount: pool.parts.length,
      missingParts: pool.parts.filter((part) => part.missing).length,
    })),
    catalog: {
      files: catalogTotals.files,
      bytes: catalogTotals.bytes,
      effectiveBytes: catalogTotals.effectiveBytes,
      hashedFiles: catalogTotals.hashedFiles,
      lastScanAt: lastScan?.finishedAt ?? null,
      lastHashAt: workflows.runs('catalog.hash', 1)[0]?.finishedAt ?? null,
    },
    bitrot: bitrot.counts(),
    backup: backup.summary(),
    agents: {
      total: agentList.length,
      online: agentList.filter((agent) => agent.online).length,
      stale: agentList.filter((agent) => !agent.online).length,
    },
    lastExportAt: exports.lastExportAt(),
    workflows: workflows.status(),
  };
}
