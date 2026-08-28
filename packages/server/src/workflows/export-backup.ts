import fs from 'node:fs';
import path from 'node:path';
import { formatBytes } from '@sakuradrive/shared';
import type { AlertService } from '../services/alert-service.js';
import type { ExportService } from '../services/export-service.js';
import type { SettingsService } from '../services/settings-service.js';
import type { Db } from '../db/index.js';
import type { WorkflowDefinition } from './engine.js';
import { isDailyJobDue, lastCompletedAt } from './support.js';

export interface ExportBackupDeps {
  db: Db;
  settings: SettingsService;
  exports: ExportService;
  alerts: AlertService;
  now?: () => Date;
}

/**
 * Write the automatic export bundle to every configured destination.
 *
 * The whole point of this tool is to still have the catalog *after* a drive dies, so
 * the bundle is written outside the application's own data directory — normally into a
 * folder the host already backs up to Backblaze — and each write is verified by
 * reading it back.
 */
export function createExportBackupWorkflow(deps: ExportBackupDeps): WorkflowDefinition {
  const { db, settings, exports, alerts } = deps;
  const now = deps.now ?? (() => new Date());

  return {
    id: 'export.backup',
    name: 'Automatic export',
    description:
      'Writes a full export bundle (settings, catalog, hashes, findings and history) to each configured destination, verifies it and prunes older bundles.',
    respectsSchedule: false,
    concurrencyGroup: null,
    autoStart: true,

    hasWork: () => {
      const config = settings.get();
      if (!config.autoExport.enabled) return false;
      if (config.autoExport.destinations.filter((d) => d.enabled).length === 0) return false;
      return isDailyJobDue(
        now(),
        config.general.timezone,
        config.autoExport.timeOfDay,
        config.autoExport.daysOfWeek,
        lastCompletedAt(db, 'export.backup'),
      );
    },

    async run(ctx) {
      const config = settings.get();
      const destinations = config.autoExport.destinations.filter(
        (destination) => destination.enabled,
      );
      const trigger = ctx.params.force === true ? ('manual' as const) : ('schedule' as const);

      if (destinations.length === 0) {
        ctx.log('No export destinations are enabled.');
        alerts.raise({
          dedupeKey: 'export:no-destination',
          category: 'export',
          severity: 'warning',
          title: 'No export destination is configured',
          detail:
            'SakuraDrive is a disaster-recovery tool: without an off-box export, a failure that takes out this container also takes out the catalog you would use to recover. Add a destination under Settings → Backup & Export.',
        });
        return { state: 'completed' };
      }
      alerts.resolve('export:no-destination');

      ctx.setProgress({ done: 0, total: destinations.length, unit: 'destinations', message: 'Writing export' });
      const result = await exports.export(undefined, {
        includeCatalog: config.autoExport.includeCatalog,
        includeSmartHistory: config.autoExport.includeSmartHistory,
        includePerformanceHistory: config.autoExport.includePerformanceHistory,
        redactSecrets: config.autoExport.redactSecrets,
        trigger,
        signal: ctx.signal,
        onProgress: (records, table) => {
          ctx.setProgress({
            done: 0,
            total: destinations.length,
            unit: 'destinations',
            message: `Exporting ${table} (${records.toLocaleString()} records)`,
          });
        },
      });
      ctx.log(
        `Wrote ${result.fileName}: ${result.recordCount.toLocaleString()} records, ${formatBytes(result.sizeBytes)}`,
      );

      let written = 0;
      let failures = 0;

      for (const [index, destination] of destinations.entries()) {
        if (!ctx.shouldContinue()) return { state: 'paused' };
        ctx.setProgress({
          done: index,
          total: destinations.length,
          unit: 'destinations',
          message: `Copying to ${destination.name}`,
        });

        const targetPath = path.join(destination.path, result.fileName);
        try {
          fs.mkdirSync(destination.path, { recursive: true });
          fs.copyFileSync(result.filePath, targetPath);

          let verified = true;
          if (config.autoExport.verifyAfterWrite) {
            const check = await exports.verifyBundle(targetPath);
            verified = check.ok && check.recordCount === result.recordCount;
            if (!verified) {
              throw new Error(
                check.error ??
                  `Verification mismatch: wrote ${result.recordCount} records, read back ${check.recordCount}`,
              );
            }
          }

          exports.recordExport({
            fileName: result.fileName,
            destinationId: destination.id,
            destinationPath: targetPath,
            sizeBytes: result.sizeBytes,
            recordCount: result.recordCount,
            checksum: result.checksum,
            trigger,
            verified,
          });
          const pruned = exports.pruneDestination(destination.path, destination.retain);
          if (pruned.length > 0) ctx.log(`Pruned ${pruned.length} old bundle(s) from ${destination.name}`);
          written += 1;
          alerts.resolve(`export:${destination.id}:failed`);
        } catch (error) {
          failures += 1;
          const message = error instanceof Error ? error.message : String(error);
          ctx.log(`Failed to write to ${destination.name}: ${message}`);
          exports.recordExport({
            fileName: result.fileName,
            destinationId: destination.id,
            destinationPath: targetPath,
            sizeBytes: result.sizeBytes,
            recordCount: result.recordCount,
            checksum: result.checksum,
            trigger,
            verified: false,
            error: message,
          });
          alerts.raise({
            dedupeKey: `export:${destination.id}:failed`,
            category: 'export',
            severity: 'critical',
            title: `Export to "${destination.name}" failed`,
            detail: `${message}. Until this is fixed there is no off-box copy of the catalog, which is exactly what you would need after a disk failure.`,
            context: { destination: destination.name, path: destination.path },
          });
        }
      }

      // The staging copy in the data directory is redundant once it has been written
      // out, and would otherwise grow without bound alongside the database.
      exports.pruneDestination(exports.exportDir, 3);

      return {
        state: 'completed',
        stats: {
          destinationsWritten: written,
          destinationsFailed: failures,
          records: result.recordCount,
          bytes: result.sizeBytes,
        },
      };
    },
  };
}
