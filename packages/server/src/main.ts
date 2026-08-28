import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createServices, startBackgroundJobs } from './services/container.js';

/** Container entry point. */
async function main(): Promise<void> {
  const config = loadConfig();
  const services = createServices({ config });
  const { logger } = services;

  logger.info(
    { dataDir: config.dataDir, port: config.port, version: config.version },
    'starting SakuraDrive',
  );

  if (config.disableAuth) {
    logger.warn('authentication is disabled — anyone who can reach this port has full control');
  }

  const app = await buildApp(services);
  startBackgroundJobs(services);

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
}

main().catch((error) => {
  console.error('SakuraDrive failed to start:', error);
  process.exit(1);
});
