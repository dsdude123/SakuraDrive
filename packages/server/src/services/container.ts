import os from 'node:os';
import path from 'node:path';
import type { ServerConfig } from '../config.js';
import { openDatabase, type Db } from '../db/index.js';
import { createLogger, createSilentLogger, type Logger } from '../logger.js';
import { createBackupVerifyWorkflow } from '../workflows/backup-verify.js';
import { createCatalogHashWorkflow } from '../workflows/catalog-hash.js';
import { createCatalogScanWorkflow } from '../workflows/catalog-scan.js';
import { createDuplicationWorkflow } from '../workflows/catalog-duplication.js';
import { WorkflowManager } from '../workflows/engine.js';
import { createExportBackupWorkflow } from '../workflows/export-backup.js';
import { createMaintenanceWorkflow } from '../workflows/maintenance-prune.js';
import { AgentService } from './agent-service.js';
import { AlertService } from './alert-service.js';
import { AuthService } from './auth-service.js';
import { BackupService } from './backup-service.js';
import { BitrotService } from './bitrot-service.js';
import { CatalogService } from './catalog-service.js';
import { DiscordNotifier, type FetchLike } from './discord-notifier.js';
import { ExportService } from './export-service.js';
import { KopiaClient, createSpawnRunner, type KopiaRunner } from './kopia-client.js';
import { SettingsService } from './settings-service.js';

export interface Services {
  config: ServerConfig;
  db: Db;
  logger: Logger;
  settings: SettingsService;
  alerts: AlertService;
  auth: AuthService;
  agents: AgentService;
  catalog: CatalogService;
  bitrot: BitrotService;
  backup: BackupService;
  exports: ExportService;
  notifier: DiscordNotifier;
  workflows: WorkflowManager;
  kopia: () => KopiaClient;
  /** Stop timers and close the database. */
  shutdown(): Promise<void>;
}

export interface CreateServicesOptions {
  config: ServerConfig;
  db?: Db;
  logger?: Logger;
  /** Injected in tests so no real webhook or CLI is touched. */
  fetchImpl?: FetchLike;
  kopiaRunner?: KopiaRunner;
  now?: () => Date;
}

/**
 * Wire every service together.
 *
 * One place that knows the dependency graph, so the HTTP layer and the test suite get
 * an identical object and nothing has to reach for a global.
 */
export function createServices(options: CreateServicesOptions): Services {
  const { config } = options;
  const logger = options.logger ?? (config.disableBackgroundJobs ? createSilentLogger() : createLogger(config.logLevel));
  const db = options.db ?? openDatabase({ file: config.databasePath });

  const settings = new SettingsService(db);
  const alerts = new AlertService(db);
  const auth = new AuthService(db);
  const agents = new AgentService({ db, settings, alerts, logger });
  const catalog = new CatalogService(db, settings);
  const bitrot = new BitrotService(db, alerts);

  const kopia = (): KopiaClient => {
    if (options.kopiaRunner) return new KopiaClient(options.kopiaRunner);
    const backupConfig = settings.get().backup;
    return new KopiaClient(
      createSpawnRunner({
        binary: backupConfig.kopiaBinary || 'kopia',
        configFile: backupConfig.configFile || path.join(config.dataDir, 'kopia', 'repository.config'),
        cacheDirectory: backupConfig.cacheDirectory || path.join(config.dataDir, 'kopia-cache'),
        password: backupConfig.password,
        extraArgs: backupConfig.extraArgs,
        timeoutMs: 10 * 60_000,
      }),
    );
  };

  const backup = new BackupService({ db, settings, alerts, kopia: kopia() });
  const exports = new ExportService({
    db,
    settings,
    logger,
    dataDir: config.dataDir,
    appVersion: config.version,
    hostname: os.hostname(),
  });

  const notifier = new DiscordNotifier({
    db,
    settings,
    alerts,
    logger,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.now ? { now: options.now } : {}),
  });
  notifier.attach();

  const workflows = new WorkflowManager({
    db,
    settings,
    logger,
    ...(options.now ? { now: options.now } : {}),
  });
  workflows.register(createCatalogScanWorkflow({ settings, catalog, alerts }));
  workflows.register(createCatalogHashWorkflow({ settings, catalog, bitrot, alerts }));
  workflows.register(createDuplicationWorkflow({ db, settings, catalog, alerts }));
  workflows.register(createBackupVerifyWorkflow({ db, settings, backup }));
  workflows.register(
    createExportBackupWorkflow({
      db,
      settings,
      exports,
      alerts,
      ...(options.now ? { now: options.now } : {}),
    }),
  );
  workflows.register(
    createMaintenanceWorkflow({
      db,
      settings,
      catalog,
      agents,
      alerts,
      auth,
      manager: () => workflows,
    }),
  );

  // A failing workflow is worth a Discord message: a scan that silently stopped
  // running is how a catalog quietly goes stale.
  workflows.on('failed', (run: { workflowId: string }, message: string) => {
    if (!settings.get().notifications.discord.notifyOnWorkflowFailure) return;
    notifier.notifyMessage(`Workflow "${run.workflowId}" failed`, message, 'warning');
  });

  return {
    config,
    db,
    logger,
    settings,
    alerts,
    auth,
    agents,
    catalog,
    bitrot,
    backup,
    exports,
    notifier,
    workflows,
    kopia,
    async shutdown() {
      workflows.stopScheduler();
      notifier.stop();
      workflows.stopAll('shutdown');
      await workflows.drain();
      db.close();
    },
  };
}

/** Start the background timers. Skipped in tests via `disableBackgroundJobs`. */
export function startBackgroundJobs(services: Services): void {
  if (services.config.disableBackgroundJobs) return;
  const recovered = services.workflows.recoverInterruptedRuns();
  if (recovered > 0) {
    services.logger.info({ recovered }, 'recovered workflow runs interrupted by a restart');
  }
  services.workflows.startScheduler(30_000);
  services.notifier.start(10_000);
}
