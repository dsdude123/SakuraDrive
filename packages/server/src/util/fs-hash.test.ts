import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTempDir, writeFile } from '../test/helpers.js';
import { isReadableDirectory, readDirectory } from './fs-walk.js';
import { HashAbortedError, hashFile, hashString, sleep } from './hash.js';

let temp: ReturnType<typeof createTempDir>;

beforeEach(() => {
  temp = createTempDir('sakuradrive-fs-');
});

afterEach(() => {
  temp.dispose();
});

describe('readDirectory', () => {
  it('lists files with size and timestamps, and subdirectories separately', async () => {
    writeFile(temp.path, 'a.txt', 'hello');
    writeFile(temp.path, 'sub/b.txt', 'world');

    const listing = await readDirectory(temp.path, '');
    expect(listing.files.map((file) => file.relPath)).toEqual(['a.txt']);
    expect(listing.files[0]!.sizeBytes).toBe(5);
    expect(listing.files[0]!.mtimeMs).toBeGreaterThan(0);
    expect(listing.directories).toEqual(['sub']);
    expect(listing.errors).toEqual([]);
  });

  it('returns entries in a stable sorted order', async () => {
    for (const name of ['c.txt', 'a.txt', 'b.txt']) writeFile(temp.path, name, 'x');
    const listing = await readDirectory(temp.path, '');
    expect(listing.files.map((file) => file.relPath)).toEqual(['a.txt', 'b.txt', 'c.txt']);
  });

  it('produces root-relative paths for a subdirectory', async () => {
    writeFile(temp.path, 'Media/Movies/a.mkv', 'x');
    const listing = await readDirectory(temp.path, 'Media/Movies');
    expect(listing.files[0]!.relPath).toBe('Media/Movies/a.mkv');
  });

  it('skips Windows and DrivePool system directories', async () => {
    fs.mkdirSync(path.join(temp.path, '$RECYCLE.BIN'));
    fs.mkdirSync(path.join(temp.path, 'System Volume Information'));
    fs.mkdirSync(path.join(temp.path, 'Media'));
    const listing = await readDirectory(temp.path, '');
    expect(listing.directories).toEqual(['Media']);
  });

  it('applies the caller filters', async () => {
    writeFile(temp.path, 'keep.mkv', 'x');
    writeFile(temp.path, 'drop.tmp', 'x');
    fs.mkdirSync(path.join(temp.path, 'skipme'));

    const listing = await readDirectory(temp.path, '', {
      includeFile: (relPath) => relPath.endsWith('.mkv'),
      excludeDirectory: (_relPath, name) => name === 'skipme',
    });
    expect(listing.files.map((file) => file.relPath)).toEqual(['keep.mkv']);
    expect(listing.directories).toEqual([]);
  });

  it('reports an unreadable directory as an error rather than throwing', async () => {
    const listing = await readDirectory(temp.path, 'does-not-exist');
    expect(listing.errors).toHaveLength(1);
    expect(listing.files).toEqual([]);
  });

  it('ignores symlinks by default and follows them when asked', async () => {
    writeFile(temp.path, 'real/a.txt', 'x');
    fs.symlinkSync(path.join(temp.path, 'real'), path.join(temp.path, 'link'), 'dir');

    const ignored = await readDirectory(temp.path, '');
    expect(ignored.directories).toEqual(['real']);

    const followed = await readDirectory(temp.path, '', { followSymlinks: true });
    expect(followed.directories.sort()).toEqual(['link', 'real']);
  });

  it('collects an error for a dangling symlink when following', async () => {
    fs.symlinkSync(path.join(temp.path, 'nowhere'), path.join(temp.path, 'broken'));
    const listing = await readDirectory(temp.path, '', { followSymlinks: true });
    expect(listing.errors).toHaveLength(1);
  });
});

describe('isReadableDirectory', () => {
  it('recognises a readable directory', async () => {
    expect(await isReadableDirectory(temp.path)).toBe(true);
  });

  it('rejects a file, a missing path and a path outside the container', async () => {
    writeFile(temp.path, 'a.txt', 'x');
    expect(await isReadableDirectory(path.join(temp.path, 'a.txt'))).toBe(false);
    expect(await isReadableDirectory(path.join(temp.path, 'nope'))).toBe(false);
  });
});

describe('hashFile', () => {
  it('hashes a file with the requested algorithm', async () => {
    const file = writeFile(temp.path, 'a.txt', 'hello');
    const sha = await hashFile(file, { algorithm: 'sha256' });
    expect(sha.hash).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
    expect(sha.bytesRead).toBe(5);

    const md5 = await hashFile(file, { algorithm: 'md5' });
    expect(md5.hash).toBe('5d41402abc4b2a76b9719d911017c592');
  });

  it('handles an empty file', async () => {
    const file = writeFile(temp.path, 'empty.txt', '');
    const result = await hashFile(file, { algorithm: 'sha256' });
    expect(result.bytesRead).toBe(0);
    expect(result.hash).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  it('reports progress as it reads', async () => {
    const file = writeFile(temp.path, 'big.bin', 'x'.repeat(300_000));
    const seen: number[] = [];
    await hashFile(file, { algorithm: 'sha256', chunkSize: 65_536, onProgress: (n) => seen.push(n) });
    expect(seen.length).toBeGreaterThan(1);
    expect(seen.at(-1)).toBe(300_000);
  });

  it('throws for a missing file', async () => {
    await expect(hashFile(path.join(temp.path, 'nope'), { algorithm: 'sha256' })).rejects.toThrow();
  });

  it('aborts promptly when the signal fires', async () => {
    const file = writeFile(temp.path, 'big.bin', 'x'.repeat(2_000_000));
    const controller = new AbortController();
    controller.abort();
    await expect(
      hashFile(file, { algorithm: 'sha256', signal: controller.signal }),
    ).rejects.toBeInstanceOf(HashAbortedError);
  });

  it('slows down when a throughput cap is set', async () => {
    const file = writeFile(temp.path, 'big.bin', 'x'.repeat(400_000));
    const started = Date.now();
    await hashFile(file, {
      algorithm: 'sha256',
      chunkSize: 100_000,
      maxBytesPerSecond: 2_000_000,
    });
    // 400 KB at 2 MB/s should take roughly 200ms; allow generous slack.
    expect(Date.now() - started).toBeGreaterThan(80);
  });
});

describe('sleep', () => {
  it('resolves after the delay', async () => {
    const started = Date.now();
    await sleep(30);
    expect(Date.now() - started).toBeGreaterThanOrEqual(25);
  });

  it('resolves immediately for a non-positive delay', async () => {
    await expect(sleep(0)).resolves.toBeUndefined();
  });

  it('rejects when aborted mid-sleep', async () => {
    const controller = new AbortController();
    const promise = sleep(1000, controller.signal);
    controller.abort();
    await expect(promise).rejects.toBeInstanceOf(HashAbortedError);
  });
});

describe('hashString', () => {
  it('hashes text', () => {
    expect(hashString('hello')).toBe(
      '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
    );
  });
});
