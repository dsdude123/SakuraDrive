import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { benchmarkPath, dropFromCache, isWindowsFilesystem, mountFor } from './storage-bench.js';

const MOUNTS = [
  'overlay / overlay rw,relatime 0 0',
  '/dev/sdd /data ext4 rw,relatime 0 0',
  'drvfs /backup/sakuradrive 9p rw,noatime,dirsync,aname=drvfs;path=J:\\Tier0 0 0',
  'drvfs /mnt/with\\040space 9p rw 0 0',
].join('\n');

describe('mountFor', () => {
  it('finds the longest mount point containing the path', () => {
    expect(mountFor('/data', MOUNTS)).toEqual({ mountPoint: '/data', fsType: 'ext4' });
    expect(mountFor('/data/exports', MOUNTS)).toEqual({ mountPoint: '/data', fsType: 'ext4' });
    expect(mountFor('/backup/sakuradrive', MOUNTS)?.fsType).toBe('9p');
    expect(mountFor('/srv/elsewhere', MOUNTS)).toEqual({ mountPoint: '/', fsType: 'overlay' });
  });

  it('does not mistake a sibling with a shared prefix for a parent', () => {
    expect(mountFor('/database', MOUNTS)?.mountPoint).toBe('/');
  });

  it('decodes the octal escapes /proc/mounts uses for spaces', () => {
    expect(mountFor('/mnt/with space/x', MOUNTS)?.mountPoint).toBe('/mnt/with space');
  });
});

describe('isWindowsFilesystem', () => {
  it('recognises the ways WSL2 surfaces a Windows drive', () => {
    expect(isWindowsFilesystem('9p')).toBe(true);
    expect(isWindowsFilesystem('drvfs')).toBe(true);
    expect(isWindowsFilesystem('ext4')).toBe(false);
    expect(isWindowsFilesystem(null)).toBe(false);
  });
});

describe('benchmarkPath', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sakuradrive-bench-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('measures write, read and sync latency, and leaves nothing behind', async () => {
    const result = await benchmarkPath(dir, { sizeBytes: 8 * 1024 * 1024, syncSamples: 10, mountsText: MOUNTS });
    expect(result.error).toBeNull();
    expect(result.skipped).toBeNull();
    expect(result.writeMBps).toBeGreaterThan(0);
    expect(result.readMBps).toBeGreaterThan(0);
    expect(result.latencyMs).toBeGreaterThan(0);
    expect(result.latencyP95Ms).toBeGreaterThanOrEqual(result.latencyMs!);
    // Written once, read once.
    expect(result.bytesTested).toBe(16 * 1024 * 1024);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('says when it could not get the file out of the cache before reading it', async () => {
    const result = await benchmarkPath(dir, {
      sizeBytes: 4 * 1024 * 1024,
      syncSamples: 4,
      dropCache: async () => false,
    });
    expect(result.readMayBeCached).toBe(true);
  });

  it('skips a directory it cannot write to rather than failing', async () => {
    const result = await benchmarkPath(path.join(dir, 'does-not-exist'), { sizeBytes: 4 * 1024 * 1024, syncSamples: 4 });
    expect(result.skipped).toContain('Not writable');
    expect(result.writeMBps).toBeNull();
  });

  it('skips when the test would not fit twice over', async () => {
    const result = await benchmarkPath(dir, { sizeBytes: Number.MAX_SAFE_INTEGER / 4, syncSamples: 4 });
    expect(result.skipped).toContain('Not enough free space');
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('records the filesystem it measured', async () => {
    const result = await benchmarkPath('/data-does-not-exist', { sizeBytes: 4 * 1024 * 1024, syncSamples: 4, mountsText: MOUNTS });
    expect(result.details.fsType).toBe('overlay');
  });
});

describe('dropFromCache', () => {
  it('succeeds on an ordinary file with the dd this image ships', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sakuradrive-drop-'));
    const file = path.join(dir, 'f');
    fs.writeFileSync(file, Buffer.alloc(1024));
    try {
      expect(await dropFromCache(file)).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports failure rather than throwing for a file that is not there', async () => {
    expect(await dropFromCache('/no/such/file')).toBe(false);
  });
});
