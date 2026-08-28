import type { BackupService } from '../services/backup-service.js';
import type { SettingsService } from '../services/settings-service.js';
import type { Db } from '../db/index.js';
import type { WorkflowDefinition } from './engine.js';
import { hoursSince, lastCompletedAt } from './support.js';

export interface BackupVerifyDeps {
  db: Db;
  settings: SettingsService;
  backup: BackupService;
}

/**
 * Check that everything expected to be in the Kopia repository actually is.
 *
 * Reads the catalog and the repository listing; it does not touch the pool, so it is
 * not bound to the heavy-I/O window.
 */
export function createBackupVerifyWorkflow(deps: BackupVerifyDeps): WorkflowDefinition {
  const { db, settings, backup } = deps;

  const enabled = () => {
    const config = settings.get().backup;
    return (
      config.enabled &&
      config.mode !== 'disabled' &&
      config.expectations.some((expectation) => expectation.enabled)
    );
  };

  return {
    id: 'backup.verify',
    name: 'Backup verification',
    description:
      'Lists the latest Kopia snapshot for each expectation and reports files that should be backed up but are missing, stale or the wrong size.',
    respectsSchedule: false,
    concurrencyGroup: null,
    autoStart: true,

    hasWork: () =>
      enabled() &&
      hoursSince(lastCompletedAt(db, 'backup.verify')) >= settings.get().backup.verifyIntervalHours,

    async run(ctx) {
      const config = settings.get().backup;
      const expectations = config.expectations.filter((expectation) => expectation.enabled);
      if (expectations.length === 0) {
        ctx.log('No backup expectations are configured.');
        return { state: 'completed' };
      }

      let missing = 0;
      let expected = 0;
      let failures = 0;

      for (const [index, expectation] of expectations.entries()) {
        if (!ctx.shouldContinue()) return { state: 'paused' };
        ctx.setProgress({
          done: index,
          total: expectations.length,
          unit: 'expectations',
          message: `Verifying ${expectation.name}`,
        });

        const summary = await backup.verify({
          expectation,
          workflowRunId: ctx.runId,
          signal: ctx.signal,
          shouldContinue: ctx.shouldContinue,
          onProgress: (checked, total, message) => {
            ctx.setProgress({ done: checked, total, unit: 'files', message });
          },
        });

        if (summary.error) {
          failures += 1;
          ctx.log(`${expectation.name}: ${summary.error}`);
        } else {
          missing += summary.missingFiles;
          expected += summary.expectedFiles;
          ctx.log(
            `${expectation.name}: ${summary.presentFiles.toLocaleString()}/${summary.expectedFiles.toLocaleString()} present, ` +
              `${summary.missingFiles.toLocaleString()} missing, ${summary.staleFiles.toLocaleString()} stale`,
          );
        }
      }

      return {
        state: 'completed',
        stats: { expectedFiles: expected, missingFiles: missing, failedExpectations: failures },
      };
    },
  };
}
