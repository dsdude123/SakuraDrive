import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import type { HashAlgorithm } from '@sakuradrive/shared';

export interface HashOptions {
  algorithm: HashAlgorithm;
  /** Throughput cap in bytes per second across this call. 0 disables throttling. */
  maxBytesPerSecond?: number;
  signal?: AbortSignal;
  /** Read buffer size. Larger is faster on spinning rust, worse for latency. */
  chunkSize?: number;
  /** Called with cumulative bytes read; used to drive the progress bar. */
  onProgress?: (bytesRead: number) => void;
}

export interface HashResult {
  hash: string;
  bytesRead: number;
  /** Size and mtime at the moment the hash was taken, for bit-rot comparison. */
  algorithm: HashAlgorithm;
}

export class HashAbortedError extends Error {
  constructor() {
    super('Hashing aborted');
    this.name = 'HashAbortedError';
  }
}

/**
 * Stream a file through a digest.
 *
 * Throttling matters more here than raw speed: the whole point of the scheduling
 * feature is that clients must not notice the scan. The cap is applied by sleeping
 * between chunks so the drive gets idle time rather than being saturated.
 */
export async function hashFile(filePath: string, options: HashOptions): Promise<HashResult> {
  const {
    algorithm,
    maxBytesPerSecond = 0,
    signal,
    chunkSize = 1024 * 1024,
    onProgress,
  } = options;

  if (signal?.aborted) throw new HashAbortedError();

  const digest = createHash(algorithm);
  const stream = createReadStream(filePath, { highWaterMark: chunkSize });
  let bytesRead = 0;
  const startedAt = Date.now();

  try {
    for await (const chunk of stream) {
      if (signal?.aborted) throw new HashAbortedError();
      const buffer = chunk as Buffer;
      digest.update(buffer);
      bytesRead += buffer.length;
      onProgress?.(bytesRead);

      if (maxBytesPerSecond > 0) {
        const elapsedMs = Date.now() - startedAt;
        const allowedMs = (bytesRead / maxBytesPerSecond) * 1000;
        if (allowedMs > elapsedMs) {
          await sleep(Math.min(allowedMs - elapsedMs, 5000), signal);
        }
      }
    }
  } finally {
    stream.destroy();
  }

  return { hash: digest.digest('hex'), bytesRead, algorithm };
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new HashAbortedError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Hash a string; used for export bundle checksums. */
export function hashString(value: string, algorithm: HashAlgorithm = 'sha256'): string {
  return createHash(algorithm).update(value).digest('hex');
}
