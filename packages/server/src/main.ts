import { statSync } from 'node:fs';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { migrateDataDir } from './db/migrate-data-dir.js';
import { createLogger } from './logger.js';
import { createServices, startBackgroundJobs } from './services/container.js';

/** Container entry point. */
async function main(): Promise<void> {
  const config = loadConfig();

  // Before anything opens the database: a previous data directory is copied across if
  // this one is empty, so moving off a slow mount is a stack update rather than three
  // docker commands run by hand.
  const startupLogger = createLogger(config.logLevel);
  migrateDataDir({
    dataDir: config.dataDir,
    databasePath: config.databasePath,
    legacyDir: config.legacyDataDir,
    logger: startupLogger,
  });

  const services = createServices({ config });
  const { logger } = services;

  // Sizes on disk, because "why is everything slow" has been unanswerable from the log
  // so far and a database that has outgrown its cache is the first thing to rule out.
  const sizeOf = (file: string): number => {
    try {
      return statSync(file).size;
    } catch {
      return 0;
    }
  };
  const mb = (bytes: number): string => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

  logger.info(
    {
      dataDir: config.dataDir,
      port: config.port,
      version: config.version,
      database: mb(sizeOf(config.databasePath)),
      writeAheadLog: mb(sizeOf(`${config.databasePath}-wal`)),
    },
    'starting SakuraDrive',
  );

  if (config.disableAuth) {
    logger.warn('authentication is disabled — anyone who can reach this port has full control');
  }

  const app = await buildApp(services);

  // Give in-flight workflows a chance to checkpoint before the container dies.
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');
    try {
      await app.close();
      await services.shutdown();
    } catch (error) {
      logger.error({ error }, 'error during shutdown');
    }
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => logger.error({ reason }, 'unhandled rejection'));

  await app.listen({ host: config.host, port: config.port });
  logger.info(`SakuraDrive is listening on http://${config.host}:${config.port}`);

  // Only now. Workflows do heavy synchronous work, and starting them before the
  // listener meant a busy one could stop the server ever coming up -- which reads from
  // outside as a dead container rather than a busy one, health check included.
  startBackgroundJobs(services);
}

main().catch((error) => {
  console.error('SakuraDrive failed to start:', error);
  process.exit(1);
});
