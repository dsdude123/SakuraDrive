import pino, { type Logger } from 'pino';

export type { Logger };

export function createLogger(level: string): Logger {
  return pino({
    level,
    // The container log is read with `docker logs`, so keep it terse and readable.
    timestamp: pino.stdTimeFunctions.isoTime,
    base: undefined,
  });
}

/** A logger that discards everything; used by tests and by workflow dry runs. */
export function createSilentLogger(): Logger {
  return pino({ level: 'silent' });
}
