import fs from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  describeSchedule,
  formatSchedule,
  enabledHoursPerWeek,
  isScheduleEmpty,
  normalizeSchedule,
  settingsSchema,
} from '@sakuradrive/shared';
import type { Services } from '../services/container.js';
import { errorMessage, parseBody, parseQuery } from './helpers.js';

export function registerSettingsRoutes(app: FastifyInstance, services: Services): void {
  const { settings, catalog, notifier, kopia, backup, db } = services;

  app.get('/api/settings', async () => {
    const config = settings.get();
    return {
      // Credentials are masked; submitting the mask back leaves them unchanged.
      settings: settings.getRedacted(),
      schedule: {
        windows: describeSchedule(config.schedule.heavyIo),
        summary: formatSchedule(config.schedule.heavyIo),
        hoursPerWeek: enabledHoursPerWeek(config.schedule.heavyIo),
        empty: isScheduleEmpty(config.schedule.heavyIo),
      },
      timezones: supportedTimezones(),
    };
  });

  app.patch('/api/settings', async (request, reply) => {
    try {
      const next = settings.update(request.body);
      // Removing a root deliberately leaves its catalog in place. This is a
      // disaster-recovery tool: a root deleted by accident must not take the record of
      // what was on that disk with it. The rows are surfaced as "orphaned" and can be
      // purged explicitly once the operator confirms they are not needed.
      const knownRoots = new Set(next.catalog.roots.map((root) => root.id));
      return {
        settings: settings.getRedacted(),
        orphanedRoots: orphanedRoots(services, knownRoots),
      };
    } catch (error) {
      return reply.code(400).send({
        error: 'invalid_settings',
        message: errorMessage(error),
      });
    }
  });

  /** Validate a settings patch without saving it, for live form feedback. */
  app.post('/api/settings/validate', async (request, reply) => {
    const result = settingsSchema.deepPartial().safeParse(request.body);
    if (!result.success) {
      return reply.code(400).send({
        error: 'invalid_settings',
        message: 'Validation failed',
        details: result.error.flatten(),
      });
    }
    return { ok: true };
  });

  /** Catalog data left behind by roots that are no longer configured. */
  app.get('/api/catalog/orphaned', async () => {
    const knownRoots = new Set(settings.get().catalog.roots.map((root) => root.id));
    return {
      roots: orphanedRoots(services, knownRoots).map((rootId) => ({
        rootId,
        stats: catalog.rootStats(rootId),
      })),
    };
  });

  app.delete<{ Params: { rootId: string } }>('/api/catalog/roots/:rootId/data', async (request, reply) => {
    const { rootId } = request.params;
    // Only ever purge a root that is genuinely gone from the configuration, so a typo
    // in a URL cannot erase the catalog of a root that is still in use.
    if (settings.get().catalog.roots.some((root) => root.id === rootId)) {
      return reply.code(409).send({
        error: 'root_in_use',
        message: 'That root is still configured. Remove it from settings first.',
      });
    }
    const removed = catalog.purgeRoot(rootId);
    services.logger.info({ rootId, removed }, 'purged the catalog of a removed root');
    return { rootId, removed };
  });

  app.put('/api/settings/schedule', async (request, reply) => {
    const body = parseBody(z.object({ heavyIo: z.array(z.string()) }), request, reply);
    if (!body) return reply;
    settings.update({ schedule: { heavyIo: normalizeSchedule(body.heavyIo) } });
    const config = settings.get();
    return {
      heavyIo: config.schedule.heavyIo,
      summary: formatSchedule(config.schedule.heavyIo),
      hoursPerWeek: enabledHoursPerWeek(config.schedule.heavyIo),
    };
  });

  /**
   * The pool parts the agent has actually seen, so a root can be configured by picking
   * one rather than by typing a volume GUID. `dpcmd list-poolparts` reports these paths
   * and the agent forwards them with every poll, which is what makes a letterless disk
   * addressable at all.
   */
  app.get('/api/catalog/known-paths', async () => {
    const parts = db
      .prepare<[], {
        pool_id: string; volume_label: string | null; drive_letter: string | null;
        path: string | null; size_bytes: number | null; missing: number;
      }>(
        `SELECT pool_id, volume_label, drive_letter, path, size_bytes, missing
           FROM pool_parts ORDER BY volume_label`,
      )
      .all();
    return {
      poolParts: parts
        .filter((part) => part.path)
        .map((part) => ({
          poolId: part.pool_id,
          label: part.volume_label ?? '',
          driveLetter: part.drive_letter,
          hostPath: part.path!,
          sizeBytes: part.size_bytes,
          missing: part.missing === 1,
        })),
    };
  });

  app.post('/api/settings/test-discord', async (request, reply) => {
    const body = parseBody(
      z.object({ webhookUrl: z.string().optional(), username: z.string().optional() }),
      request,
      reply,
    );
    if (!body) return reply;
    const config = settings.get().notifications.discord;
    const url = body.webhookUrl && body.webhookUrl !== '__REDACTED__' ? body.webhookUrl : config.webhookUrl;
    if (!url) {
      return reply.code(400).send({ error: 'no_webhook', message: 'No webhook URL configured' });
    }
    return notifier.sendTest(url, body.username ?? config.username);
  });

  app.post('/api/settings/test-kopia', async (_request, reply) => {
    const config = settings.get().backup;
    if (config.mode === 'disabled') {
      return reply.code(400).send({ error: 'disabled', message: 'Backup verification is disabled' });
    }
    if (config.mode === 'manifest') {
      const exists = config.manifestPath !== '' && fs.existsSync(config.manifestPath);
      return {
        ok: exists,
        mode: 'manifest',
        message: exists ? `Manifest found at ${config.manifestPath}` : 'Manifest file not found',
      };
    }
    try {
      const client = kopia();
      const version = await client.version();
      const connected = await client.connect(config);
      if (!connected.ok) return { ok: false, mode: 'kopia', version, message: connected.message };
      const snapshots = await client.listSnapshots();
      return {
        ok: true,
        mode: 'kopia',
        version,
        message: `${snapshots.length} snapshot(s) visible`,
        sources: [...new Set(snapshots.map((snapshot) => snapshot.source))].slice(0, 50),
      };
    } catch (error) {
      return { ok: false, mode: 'kopia', message: errorMessage(error) };
    }
  });

  app.get('/api/backup/runs', async () => ({ runs: backup.listRuns(), summary: backup.summary() }));

  /**
   * What the backup rules cover and what they do not. Deliberately not an alert: a
   * folder left out of the backup is usually a cost decision, and the tool's job is to
   * make that decision visible rather than to nag about it.
   */
  app.get('/api/backup/coverage', async () => ({ roots: backup.coverage() }));

  app.get('/api/backup/issues', async (request, reply) => {
    const query = parseQuery(
      z.object({
        runId: z.coerce.number().int().optional(),
        kind: z.enum(['missing', 'stale', 'size-mismatch']).optional(),
        status: z.enum(['open', 'dismissed', 'resolved', 'any']).default('open'),
        search: z.string().optional(),
        limit: z.coerce.number().int().min(1).max(5000).default(200),
        offset: z.coerce.number().int().min(0).default(0),
      }),
      request,
      reply,
    );
    if (!query) return reply;
    return backup.listIssues(query);
  });

  app.post('/api/backup/issues/status', async (request, reply) => {
    const body = parseBody(
      z.object({
        ids: z.array(z.number().int()).min(1),
        status: z.enum(['open', 'dismissed', 'resolved']),
        note: z.string().max(1000).default(''),
      }),
      request,
      reply,
    );
    if (!body) return reply;
    return { changed: backup.setIssueStatus(body.ids, body.status, body.note) };
  });
}

/** Root ids that still have catalog rows but are no longer configured. */
function orphanedRoots(services: Services, knownRoots: Set<string>): string[] {
  const rows = services.db
    .prepare<[], { root_id: string }>('SELECT DISTINCT root_id FROM files')
    .all();
  return rows.map((row) => row.root_id).filter((rootId) => !knownRoots.has(rootId));
}

/**
 * Timezones the browser can offer. `supportedValuesOf` exists in Node 18+ but is
 * guarded so an exotic build cannot break the settings page.
 */
function supportedTimezones(): string[] {
  try {
    return (Intl as unknown as { supportedValuesOf(key: string): string[] }).supportedValuesOf(
      'timeZone',
    );
  } catch {
    return ['UTC', 'America/Los_Angeles', 'America/New_York', 'Europe/London', 'Asia/Tokyo'];
  }
}
