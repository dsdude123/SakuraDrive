import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { vi } from 'vitest';
import { buildApp } from '../app.js';
import { loadConfig } from '../config.js';
import { openTestDatabase } from '../db/index.js';
import { createSilentLogger } from '../logger.js';
import { createServices, type Services } from '../services/container.js';
import type { KopiaRunner } from '../services/kopia-client.js';
import { createTempDir } from './helpers.js';

export interface AppHarness {
  app: FastifyInstance;
  services: Services;
  dataDir: string;
  fetchMock: ReturnType<typeof vi.fn>;
  /** Session cookie for the account created by `signIn`. */
  cookie: string;
  signIn(username?: string, password?: string): Promise<void>;
  close(): Promise<void>;
}

export interface HarnessOptions {
  kopiaRunner?: KopiaRunner;
  disableAuth?: boolean;
  now?: () => Date;
  /** Point the distribution endpoints somewhere else, or at nothing at all. */
  agentDistDir?: string;
}

/**
 * The repository's agent directory, which is what a built image carries at /app/agent.
 * Resolved from this file rather than the working directory so the distribution tests
 * behave the same whether vitest was started from the repository root or this package.
 */
const REPO_AGENT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../agent');

/** A fully wired app against an in-memory database and a throwaway data directory. */
export async function createAppHarness(options: HarnessOptions = {}): Promise<AppHarness> {
  const temp = createTempDir('sakuradrive-app-');
  const config = loadConfig({
    dataDir: temp.path,
    databasePath: ':memory:',
    webRoot: `${temp.path}/public`,
    disableBackgroundJobs: true,
    disableAuth: options.disableAuth ?? false,
    agentDistDir: options.agentDistDir ?? REPO_AGENT_DIR,
    version: 'test',
  });

  const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
  const services = createServices({
    config,
    db: openTestDatabase(),
    logger: createSilentLogger(),
    fetchImpl: fetchMock as never,
    ...(options.kopiaRunner ? { kopiaRunner: options.kopiaRunner } : {}),
    ...(options.now ? { now: options.now } : {}),
  });

  const app = await buildApp(services);
  await app.ready();

  const harness: AppHarness = {
    app,
    services,
    dataDir: temp.path,
    fetchMock,
    cookie: '',
    async signIn(username = 'admin', password = 'correct horse battery') {
      const response = await app.inject({
        method: 'POST',
        url: services.auth.needsSetup() ? '/api/auth/setup' : '/api/auth/login',
        payload: { username, password },
      });
      const setCookie = response.headers['set-cookie'];
      const raw = Array.isArray(setCookie) ? setCookie[0] : setCookie;
      harness.cookie = typeof raw === 'string' ? (raw.split(';')[0] ?? '') : '';
    },
    async close() {
      await app.close();
      await services.shutdown();
      temp.dispose();
    },
  };

  return harness;
}

/** Convenience wrapper that attaches the session cookie. */
export async function request(
  harness: AppHarness,
  options: Parameters<FastifyInstance['inject']>[0] & { url: string },
) {
  return harness.app.inject({
    ...(options as Record<string, unknown>),
    headers: {
      ...((options as { headers?: Record<string, string> }).headers ?? {}),
      ...(harness.cookie ? { cookie: harness.cookie } : {}),
    },
  } as never);
}
