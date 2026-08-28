import { describe, expect, it } from 'vitest';
import {
  compactDuplicationRules,
  createDuplicationResolver,
  effectiveSize,
  findDuplicationMismatches,
  resolveDuplication,
  sortDuplicationRules,
  type DuplicationRule,
} from './duplication.js';

const rules: DuplicationRule[] = [
  { path: '', level: 1, source: 'drivepool' },
  { path: 'Media', level: 2, source: 'drivepool' },
  { path: 'Media/Movies/4K', level: 3, source: 'drivepool' },
  { path: 'Backups', level: 2, source: 'manual' },
];

describe('resolveDuplication', () => {
  it('inherits the closest ancestor rule, the way DrivePool does', () => {
    expect(resolveDuplication('Media/Movies/foo.mkv', rules).level).toBe(2);
    expect(resolveDuplication('Media/Movies/4K/foo.mkv', rules).level).toBe(3);
    expect(resolveDuplication('Media/Movies/4K/nested/deep/foo.mkv', rules).level).toBe(3);
  });

  it('falls back to the pool default when nothing matches', () => {
    const sparse: DuplicationRule[] = [{ path: 'Media', level: 2, source: 'drivepool' }];
    const resolution = resolveDuplication('Other/thing.txt', sparse, 1);
    expect(resolution.level).toBe(1);
    expect(resolution.rule).toBeNull();
    expect(resolution.source).toBe('default');
  });

  it('honours an explicit root rule over the supplied default', () => {
    expect(resolveDuplication('anything.txt', rules, 5).level).toBe(1);
  });

  it('does not let a prefix match a sibling with a longer name', () => {
    const tricky: DuplicationRule[] = [{ path: 'Media', level: 3, source: 'drivepool' }];
    expect(resolveDuplication('Media2/file.txt', tricky, 1).level).toBe(1);
    expect(resolveDuplication('MediaArchive/file.txt', tricky, 1).level).toBe(1);
  });

  it('matches case-insensitively because the volumes are NTFS', () => {
    expect(resolveDuplication('media/MOVIES/4k/foo.mkv', rules).level).toBe(3);
  });

  it('accepts Windows-style separators', () => {
    expect(resolveDuplication('Media\\Movies\\4K\\foo.mkv', rules).level).toBe(3);
  });

  it('applies a rule to the folder itself, not only its children', () => {
    expect(resolveDuplication('Media', rules).level).toBe(2);
  });

  it('prefers a manual rule over a DrivePool rule at the same depth', () => {
    const conflicting: DuplicationRule[] = [
      { path: 'Media', level: 2, source: 'drivepool' },
      { path: 'Media', level: 4, source: 'manual' },
    ];
    const resolution = resolveDuplication('Media/x.mkv', conflicting);
    expect(resolution.level).toBe(4);
    expect(resolution.source).toBe('manual');
  });
});

describe('sortDuplicationRules', () => {
  it('orders deepest first so callers can take the first match', () => {
    const sorted = sortDuplicationRules(rules).map((rule) => rule.path);
    expect(sorted[0]).toBe('Media/Movies/4K');
    expect(sorted.at(-1)).toBe('');
  });
});

describe('createDuplicationResolver', () => {
  it('matches resolveDuplication for many paths', () => {
    const resolver = createDuplicationResolver(rules);
    for (const path of [
      'Media/Movies/foo.mkv',
      'Media/Movies/4K/foo.mkv',
      'Backups/db.bak',
      'Loose.txt',
    ]) {
      expect(resolver(path)).toBe(resolveDuplication(path, rules).level);
    }
  });

  it('caches per directory without leaking across directories', () => {
    const resolver = createDuplicationResolver(rules);
    expect(resolver('Media/Movies/4K/a.mkv')).toBe(3);
    expect(resolver('Media/Movies/4K/b.mkv')).toBe(3);
    expect(resolver('Media/Movies/c.mkv')).toBe(2);
    expect(resolver('root.txt')).toBe(1);
  });
});

describe('effectiveSize', () => {
  it('multiplies logical size by the duplication level', () => {
    expect(effectiveSize(1024, 2)).toBe(2048);
    expect(effectiveSize(1024, 1)).toBe(1024);
  });

  it('treats an invalid level as unduplicated rather than losing the file', () => {
    expect(effectiveSize(1024, 0)).toBe(1024);
    expect(effectiveSize(1024, Number.NaN)).toBe(1024);
    expect(effectiveSize(1024, -3)).toBe(1024);
  });
});

describe('compactDuplicationRules', () => {
  it('drops descendants that merely repeat an inherited level', () => {
    const compact = compactDuplicationRules([
      { path: '', level: 1, source: 'drivepool' },
      { path: 'Media', level: 2, source: 'drivepool' },
      { path: 'Media/Movies', level: 2, source: 'drivepool' },
      { path: 'Media/Movies/4K', level: 3, source: 'drivepool' },
    ]);
    expect(compact.map((rule) => rule.path)).toEqual(['', 'Media', 'Media/Movies/4K']);
  });

  it('keeps the root rule even when it matches the default', () => {
    const compact = compactDuplicationRules([{ path: '', level: 1, source: 'manual' }]);
    expect(compact).toHaveLength(1);
  });
});

describe('findDuplicationMismatches', () => {
  it('reports files stored on fewer parts than configured', () => {
    const observed = new Map([
      ['Media/Movies/a.mkv', 1],
      ['Media/Movies/b.mkv', 2],
      ['Media/Movies/4K/c.mkv', 2],
      ['Loose.txt', 1],
    ]);
    const mismatches = findDuplicationMismatches(observed, rules);
    expect(mismatches).toEqual([
      { relPath: 'Media/Movies/a.mkv', expectedLevel: 2, observedLevel: 1 },
      { relPath: 'Media/Movies/4K/c.mkv', expectedLevel: 3, observedLevel: 2 },
    ]);
  });

  it('does not flag over-duplication, which is harmless', () => {
    const observed = new Map([['Loose.txt', 3]]);
    expect(findDuplicationMismatches(observed, rules)).toEqual([]);
  });
});
