import { execFile } from 'node:child_process';
import { randomBytes, randomFillSync } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { median, percentile } from './perf-analysis.js';

/**
 * Benchmarks of the container's own storage.
 *
 * The container runs inside WSL2, so a path is either on the VM's own ext4 disk or on a
 * Windows drive reached through drvfs, and the two differ by orders of magnitude for
 * exactly the operation a database lives on: a small write followed by a sync. That is
 * how the database once took eighty-five seconds to total the dashboard -- it was on a
 * drvfs mount and nothing measured it. The sync latency figure here is that measurement.
 *
 * Everything is async. A benchmark is the longest-running I/O the server does on its own
 * account, and a synchronous one would stop the interface for its whole duration.
 */

const CHUNK = 4 * 1024 * 1024;
const SYNC_BLOCK = 4096;

export interface StorageMeasurement {
  bytesTested: number;
  writeMBps: number | null;
  readMBps: number | null;
  latencyMs: number | null;
  latencyP95Ms: number | null;
  readMayBeCached: boolean;
  skipped: string | null;
  error: string | null;
  details: Record<string, unknown>;
}

export interface MountInfo {
  mountPoint: string;
  fsType: string;
}

/**
 * The mount a path lives on, from the text of /proc/mounts.
 *
 * The longest mount point that contains the path wins, which is how the kernel resolves
 * it too. On WSL2 a Windows drive shows as `9p` or `drvfs`; the VM's own disk as `ext4`.
 */
export function mountFor(target: string, mountsText: string): MountInfo | null {
  const resolved = path.posix.resolve(target);
  let best: MountInfo | null = null;
  for (const line of mountsText.split('\n')) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 3) continue;
    // /proc/mounts escapes spaces and the like as octal.
    const mountPoint = fields[1]!.replace(/\\(\d{3})/g, (_, octal: string) =>
      String.fromCharCode(Number.parseInt(octal, 8)),
    );
    const inside =
      mountPoint === '/' || resolved === mountPoint || resolved.startsWith(`${mountPoint}/`);
    if (inside && (!best || mountPoint.length > best.mountPoint.length)) {
      best = { mountPoint, fsType: fields[2]! };
    }
  }
  return best;
}

/** A Windows drive seen from inside WSL2, as opposed to the VM's own disk. */
export function isWindowsFilesystem(fsType: string | null | undefined): boolean {
  return fsType === '9p' || fsType === 'drvfs' || fsType === 'v9fs';
}

const mbps = (bytes: number, ms: number) => (ms > 0 ? bytes / 1e6 / (ms / 1000) : null);

/**
 * Drop a file from the page cache so reading it back measures the storage, not memory.
 *
 * `dd iflag=nocache count=0` is the documented coreutils way to do this without root:
 * it calls posix_fadvise(DONTNEED) on the file. Returns false when that is not possible,
 * and the read is then reported as possibly cached rather than silently trusted.
 */
export function dropFromCache(file: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('dd', [`if=${file}`, 'iflag=nocache', 'count=0', 'status=none'], { timeout: 30_000 }, (error) =>
      resolve(!error),
    );
  });
}

export async function benchmarkPath(
  directory: string,
  options: {
    sizeBytes: number;
    syncSamples: number;
    mountsText?: string;
    dropCache?: (file: string) => Promise<boolean>;
  },
): Promise<StorageMeasurement> {
  const result: StorageMeasurement = {
    bytesTested: 0,
    writeMBps: null,
    readMBps: null,
    latencyMs: null,
    latencyP95Ms: null,
    readMayBeCached: false,
    skipped: null,
    error: null,
    details: {},
  };

  const mount = options.mountsText !== undefined ? mountFor(directory, options.mountsText) : null;
  if (mount) {
    result.details.fsType = mount.fsType;
    result.details.mountPoint = mount.mountPoint;
    result.details.windowsFilesystem = isWindowsFilesystem(mount.fsType);
  }

  try {
    await fs.access(directory, fs.constants.W_OK);
  } catch {
    result.skipped = 'Not writable from inside the container.';
    return result;
  }

  // Twice the file, so the test never leaves a volume full even for a moment.
  const sizeBytes = Math.max(CHUNK, Math.ceil(options.sizeBytes / CHUNK) * CHUNK);
  try {
    const stats = await fs.statfs(directory);
    const free = Number(stats.bavail) * Number(stats.bsize);
    if (free < sizeBytes * 2) {
      result.skipped = `Not enough free space: ${Math.round(free / 1e6)} MB free, ${Math.round((sizeBytes * 2) / 1e6)} MB needed.`;
      return result;
    }
  } catch {
    // statfs is not supported everywhere. Carry on; the write will say if space runs out.
  }

  const tag = randomBytes(6).toString('hex');
  const bulkFile = path.join(directory, `.sakuradrive-perf-${tag}.tmp`);
  const syncFile = path.join(directory, `.sakuradrive-perf-${tag}-sync.tmp`);
  const chunk = Buffer.allocUnsafe(CHUNK);
  // Random rather than zeros, so a filesystem that compresses or dedupes cannot flatter it.
  randomFillSync(chunk);

  try {
    // Sequential write, synced at the end so the figure is what reached storage.
    const writer = await fs.open(bulkFile, 'wx');
    const writeStart = performance.now();
    try {
      for (let written = 0; written < sizeBytes; written += CHUNK) {
        await writer.write(chunk, 0, CHUNK);
      }
      await writer.sync();
    } finally {
      await writer.close();
    }
    result.writeMBps = mbps(sizeBytes, performance.now() - writeStart);
    result.bytesTested = sizeBytes;

    result.readMayBeCached = !(await (options.dropCache ?? dropFromCache)(bulkFile));

    const reader = await fs.open(bulkFile, 'r');
    const readStart = performance.now();
    let read = 0;
    try {
      for (;;) {
        const { bytesRead } = await reader.read(chunk, 0, CHUNK, null);
        if (bytesRead === 0) break;
        read += bytesRead;
      }
    } finally {
      await reader.close();
    }
    result.readMBps = mbps(read, performance.now() - readStart);
    result.bytesTested += read;

    // Small synced writes: what a database pays per commit.
    const syncer = await fs.open(syncFile, 'wx');
    const samples: number[] = [];
    try {
      const block = chunk.subarray(0, SYNC_BLOCK);
      for (let i = 0; i < options.syncSamples; i += 1) {
        const start = performance.now();
        await syncer.write(block, 0, SYNC_BLOCK, 0);
        await syncer.datasync();
        samples.push(performance.now() - start);
      }
    } finally {
      await syncer.close();
    }
    result.latencyMs = median(samples);
    result.latencyP95Ms = percentile(samples, 95);
    result.details.syncSamples = samples.length;
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
  } finally {
    await fs.rm(bulkFile, { force: true }).catch(() => undefined);
    await fs.rm(syncFile, { force: true }).catch(() => undefined);
  }

  return result;
}
