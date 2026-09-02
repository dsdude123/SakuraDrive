/**
 * Making a slow server say why it is slow.
 *
 * better-sqlite3 is synchronous, so one long query stops the whole process: no other
 * request is served, no timer fires, the health check does not answer. From the outside
 * that looks like the network being down, and the log says nothing at all -- which is
 * exactly how a page taking sixty seconds went undiagnosed through two rounds of
 * guessing at what might be expensive.
 *
 * Two instruments, both cheap enough to leave on:
 *
 *  - Request timing, which names the endpoint that took the time.
 *  - Event loop lag, which catches the blocking a request cannot explain: a workflow
 *    rebuilding rollups holds the process just as hard, and belongs to nobody's request.
 */

import type { FastifyInstance } from 'fastify';
import type { Logger } from './logger.js';

/** A request slower than this is worth a line in the log. */
export const SLOW_REQUEST_MS = 1_000;
/** Loop lag above this means something ran synchronously for that long. */
export const BLOCKED_LOOP_MS = 500;
/** How often to check the loop. Short enough to attribute a stall, cheap enough to leave on. */
const LAG_SAMPLE_MS = 250;

export function registerRequestTiming(app: FastifyInstance, logger: Logger): void {
  app.addHook('onRequest', async (request) => {
    (request as { startedAt?: bigint }).startedAt = process.hrtime.bigint();
  });

  app.addHook('onResponse', async (request, reply) => {
    const startedAt = (request as { startedAt?: bigint }).startedAt;
    if (startedAt === undefined) return;
    const ms = Number(process.hrtime.bigint() - startedAt) / 1e6;
    if (ms < SLOW_REQUEST_MS) return;
    logger.warn(
      { url: request.url, method: request.method, status: reply.statusCode, ms: Math.round(ms) },
      'slow request',
    );
  });
}

export interface LoopMonitor {
  stop(): void;
  /** Longest stall seen, for the diagnostics endpoint. */
  worstMs(): number;
}

/**
 * Watch for the process being held.
 *
 * A timer set for N ms that fires at N + 4000 means something ran synchronously for four
 * seconds. Nothing else can see that: the stall is over by the time any code runs again,
 * so it has to be measured by how late the next tick was.
 */
export function watchEventLoop(logger: Logger, thresholdMs = BLOCKED_LOOP_MS): LoopMonitor {
  let last = process.hrtime.bigint();
  let worst = 0;

  const timer = setInterval(() => {
    const now = process.hrtime.bigint();
    const lag = Number(now - last) / 1e6 - LAG_SAMPLE_MS;
    last = now;
    if (lag < thresholdMs) return;
    worst = Math.max(worst, lag);
    logger.warn(
      { blockedMs: Math.round(lag) },
      'the event loop was blocked: a synchronous query held the process, and nothing else was served while it ran',
    );
  }, LAG_SAMPLE_MS);
  timer.unref();

  return {
    stop: () => clearInterval(timer),
    worstMs: () => Math.round(worst),
  };
}

/**
 * Time one synchronous operation and log it when it is slow enough to matter.
 *
 * Used around the rollup rebuilds, which are the operations big enough to stall the
 * process on a large pool.
 */
export function timed<T>(
  logger: Logger,
  what: string,
  context: Record<string, unknown>,
  run: () => T,
  thresholdMs = BLOCKED_LOOP_MS,
): T {
  const startedAt = process.hrtime.bigint();
  try {
    return run();
  } finally {
    const ms = Number(process.hrtime.bigint() - startedAt) / 1e6;
    if (ms >= thresholdMs) {
      logger.warn({ ...context, ms: Math.round(ms) }, `slow: ${what}`);
    }
  }
}
