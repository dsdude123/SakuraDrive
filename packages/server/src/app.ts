import path from 'node:path';
import fs from 'node:fs';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Services } from './services/container.js';
import { SESSION_COOKIE } from './routes/helpers.js';
import { registerAgentRoutes } from './routes/agent.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerCatalogRoutes } from './routes/catalog.js';
import { registerExportRoutes } from './routes/exports.js';
import { registerMonitoringRoutes } from './routes/monitoring.js';
import { registerSettingsRoutes } from './routes/settings.js';

/** Endpoints that must work before anyone is signed in. */
const PUBLIC_PATHS = new Set([
  '/api/health',
  '/api/auth/status',
  '/api/auth/setup',
  '/api/auth/login',
  '/api/auth/logout',
]);

export async function buildApp(services: Services): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false,
    // Catalog imports and agent reports from a large host can be sizeable.
    bodyLimit: 64 * 1024 * 1024,
    trustProxy: true,
  });

  await app.register(cookie, {});
  await app.register(multipart, {
    limits: { fileSize: 8 * 1024 * 1024 * 1024, files: 1 },
  });

  app.setErrorHandler((error: Error & { statusCode?: number }, request, reply) => {
    services.logger.error({ err: error, url: request.url }, 'request failed');
    const status = typeof error.statusCode === 'number' ? error.statusCode : 500;
    reply.code(status).send({
      error: status === 500 ? 'internal_error' : 'request_failed',
      message: error.message || 'Something went wrong',
    });
  });

  /**
   * Session gate. Everything under `/api/agent/` carries its own bearer token and is
   * checked in its own handler; everything else under /api needs a signed-in session
   * unless login is turned off for a trusted LAN.
   *
   * The prefix matters: this was written as an exact match on `/api/agent/report`, so
   * every endpoint added under `/api/agent/` afterwards was silently gated behind a
   * session the agent does not have and cannot get. It failed with a 401 that looked
   * like a token problem and was not one.
   */
  app.addHook('onRequest', async (request, reply) => {
    const url = request.url.split('?')[0] ?? '';
    if (!url.startsWith('/api/')) return;
    if (PUBLIC_PATHS.has(url) || url.startsWith('/api/agent/')) return;
    if (services.config.disableAuth) return;
    if (!services.settings.get().security.requireLogin) return;
    // Before the first account exists the UI shows a setup screen, so let it through.
    if (services.auth.needsSetup()) return;

    const user = services.auth.resolveSession(request.cookies[SESSION_COOKIE]);
    if (!user) {
      reply.code(401).send({ error: 'unauthorized', message: 'Sign in to continue' });
    }
  });

  app.get('/api/health', async () => ({
    status: 'ok',
    version: services.config.version,
    time: new Date().toISOString(),
  }));

  registerAuthRoutes(app, services);
  registerAgentRoutes(app, services);
  registerSettingsRoutes(app, services);
  registerMonitoringRoutes(app, services);
  registerCatalogRoutes(app, services);
  registerExportRoutes(app, services);

  await registerWebUi(app, services);
  return app;
}

/** Serve the built single-page UI, falling back to index.html for client routes. */
async function registerWebUi(app: FastifyInstance, services: Services): Promise<void> {
  const webRoot = services.config.webRoot;
  const indexPath = path.join(webRoot, 'index.html');
  const hasUi = fs.existsSync(indexPath);

  if (hasUi) {
    await app.register(fastifyStatic, { root: webRoot, index: false, wildcard: false });
  } else {
    services.logger.warn({ webRoot }, 'web UI not found; serving the API only');
  }

  // Registered whether or not the UI was built, so an unknown /api path always
  // answers with JSON rather than Fastify's HTML-ish default.
  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith('/api/')) {
      return reply.code(404).send({ error: 'not_found', message: 'No such endpoint' });
    }
    if (!hasUi) {
      return reply
        .code(503)
        .type('text/plain')
        .send('SakuraDrive API is running, but the web UI was not built into this image.');
    }
    // Any other path is a client-side route: hand back the SPA shell.
    return reply.type('text/html').send(fs.createReadStream(indexPath));
  });
}
