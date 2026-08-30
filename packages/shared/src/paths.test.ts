import { describe, expect, it } from 'vitest';
import {
  ancestors,
  basename,
  dirnameRel,
  extname,
  isPoolPartDirName,
  isSystemDirName,
  isUnder,
  joinRelPath,
  normalizeRelPath,
  normalizeRootPath,
  stripPoolPartPrefix,
  toPosix,
  toWindows,
} from './paths.js';

describe('normalization', () => {
  it('converts Windows separators and collapses duplicates', () => {
    expect(toPosix('D:\\Media\\\\Movies')).toBe('D:/Media/Movies');
    expect(toWindows('Media/Movies')).toBe('Media\\Movies');
  });

  it('strips leading, trailing and dot segments from relative paths', () => {
    expect(normalizeRelPath('/Media/Movies/')).toBe('Media/Movies');
    expect(normalizeRelPath('./Media/./Movies')).toBe('Media/Movies');
    expect(normalizeRelPath('  \\Media\\Movies\\  ')).toBe('Media/Movies');
    expect(normalizeRelPath('')).toBe('');
  });

  it('keeps root paths absolute without a trailing slash', () => {
    expect(normalizeRootPath('/mnt/pools/hdd/')).toBe('/mnt/pools/hdd');
    expect(normalizeRootPath('/')).toBe('/');
  });

  it('joins parts, skipping empties', () => {
    expect(joinRelPath('Media', null, 'Movies', '', 'a.mkv')).toBe('Media/Movies/a.mkv');
  });
});

describe('path components', () => {
  it('splits directory and file name', () => {
    expect(dirnameRel('Media/Movies/a.mkv')).toBe('Media/Movies');
    expect(dirnameRel('a.mkv')).toBe('');
    expect(basename('Media/Movies/a.mkv')).toBe('a.mkv');
  });

  it('lowercases extensions and ignores dotfiles', () => {
    expect(extname('Media/a.MKV')).toBe('mkv');
    expect(extname('Media/.gitignore')).toBe('');
    expect(extname('Media/archive.tar.gz')).toBe('gz');
    expect(extname('Media/noext')).toBe('');
    expect(extname('Media/trailing.')).toBe('');
  });

  it('lists ancestors shallowest first', () => {
    expect(ancestors('a/b/c/d.txt')).toEqual(['a', 'a/b', 'a/b/c']);
    expect(ancestors('d.txt')).toEqual([]);
  });
});

describe('isUnder', () => {
  it('matches the folder itself and its descendants', () => {
    expect(isUnder('Media', 'Media')).toBe(true);
    expect(isUnder('Media', 'Media/Movies/a.mkv')).toBe(true);
  });

  it('is segment aware', () => {
    expect(isUnder('Media', 'Media2/a.mkv')).toBe(false);
  });

  it('treats the empty prefix as the root, matching everything', () => {
    expect(isUnder('', 'anything/at/all')).toBe(true);
  });

  it('ignores case', () => {
    expect(isUnder('media', 'MEDIA/Movies')).toBe(true);
  });
});

describe('DrivePool helpers', () => {
  it('recognises PoolPart directory names', () => {
    expect(isPoolPartDirName('PoolPart.6a41b3c0-1f2e-4d5a-9b8c-0d1e2f3a4b5c')).toBe(true);
    expect(isPoolPartDirName('poolpart.6a41b3c0')).toBe(true);
    expect(isPoolPartDirName('PoolPartyMix')).toBe(false);
  });

  it('strips a PoolPart prefix to get the pool-relative path', () => {
    expect(
      stripPoolPartPrefix('PoolPart.6a41b3c0-1f2e-4d5a-9b8c-0d1e2f3a4b5c/Media/Movies/a.mkv'),
    ).toBe('Media/Movies/a.mkv');
  });

  it('leaves a path without a prefix alone', () => {
    expect(stripPoolPartPrefix('Media/Movies/a.mkv')).toBe('Media/Movies/a.mkv');
  });

  it('knows the directories that must never be catalogued', () => {
    expect(isSystemDirName('$RECYCLE.BIN')).toBe(true);
    expect(isSystemDirName('system volume information')).toBe(true);
    expect(isSystemDirName('.covefs')).toBe(true);
    expect(isSystemDirName('Media')).toBe(false);
  });
});

