import { describe, expect, it } from 'vitest';
import { compileGlob, compileGlobList, isIncluded, matchesGlob, normalizeGlob } from './glob.js';

describe('matchesGlob', () => {
  it('matches literal paths', () => {
    expect(matchesGlob('Media/Movies/a.mkv', 'Media/Movies/a.mkv')).toBe(true);
    expect(matchesGlob('Media/Movies/a.mkv', 'Media/Movies/b.mkv')).toBe(false);
  });

  it('* does not cross directory separators', () => {
    expect(matchesGlob('Media/*.mkv', 'Media/a.mkv')).toBe(true);
    expect(matchesGlob('Media/*.mkv', 'Media/Movies/a.mkv')).toBe(false);
  });

  it('** crosses directory separators', () => {
    expect(matchesGlob('Media/**/*.mkv', 'Media/Movies/4K/a.mkv')).toBe(true);
    expect(matchesGlob('**/*.mkv', 'a.mkv')).toBe(true);
    expect(matchesGlob('**/Thumbs.db', 'Media/Movies/Thumbs.db')).toBe(true);
  });

  it('a/**/b also matches a/b', () => {
    expect(matchesGlob('Media/**/a.mkv', 'Media/a.mkv')).toBe(true);
  });

  it('a trailing ** matches everything below', () => {
    expect(matchesGlob('Media/**', 'Media/Movies/4K/a.mkv')).toBe(true);
    expect(matchesGlob('Media/**', 'Other/a.mkv')).toBe(false);
  });

  it('? matches exactly one non-separator character', () => {
    expect(matchesGlob('file?.txt', 'file1.txt')).toBe(true);
    expect(matchesGlob('file?.txt', 'file12.txt')).toBe(false);
    expect(matchesGlob('a?b', 'a/b')).toBe(false);
  });

  it('supports character classes and negation', () => {
    expect(matchesGlob('file[0-9].txt', 'file7.txt')).toBe(true);
    expect(matchesGlob('file[0-9].txt', 'filex.txt')).toBe(false);
    expect(matchesGlob('file[!0-9].txt', 'filex.txt')).toBe(true);
    expect(matchesGlob('file[^0-9].txt', 'file7.txt')).toBe(false);
  });

  it('supports brace alternation, including nesting', () => {
    expect(matchesGlob('**/*.{mkv,mp4}', 'Media/a.mp4')).toBe(true);
    expect(matchesGlob('**/*.{mkv,mp4}', 'Media/a.avi')).toBe(false);
    expect(matchesGlob('Media/{Movies,TV/{HD,SD}}/a.mkv', 'Media/TV/HD/a.mkv')).toBe(true);
  });

  it('escapes regex metacharacters in literals', () => {
    expect(matchesGlob('Media/a+b(c).mkv', 'Media/a+b(c).mkv')).toBe(true);
    expect(matchesGlob('Media/a.mkv', 'Media/aXmkv')).toBe(false);
  });

  it('is case-insensitive by default and can be made strict', () => {
    expect(matchesGlob('media/**', 'MEDIA/a.mkv')).toBe(true);
    expect(matchesGlob('media/**', 'MEDIA/a.mkv', { caseInsensitive: false })).toBe(false);
  });

  it('accepts Windows-style patterns and inputs', () => {
    expect(matchesGlob('Media\\**\\*.mkv', 'Media\\Movies\\a.mkv')).toBe(true);
    expect(normalizeGlob('.\\Media\\**')).toBe('Media/**');
  });

  it('does not hang or throw on an unbalanced brace', () => {
    expect(() => matchesGlob('Media/{Movies', 'Media/Movies')).not.toThrow();
    expect(matchesGlob('Media/{Movies', 'Media/Movies')).toBe(true);
  });

  it('treats an unterminated bracket as a literal', () => {
    expect(matchesGlob('Media/[abc', 'Media/[abc')).toBe(true);
  });

  it('can match descendants of a directory pattern', () => {
    const matcher = compileGlob('Media/Movies', { matchDescendants: true });
    expect(matcher('Media/Movies')).toBe(true);
    expect(matcher('Media/Movies/4K/a.mkv')).toBe(true);
    expect(matcher('Media/Music/a.flac')).toBe(false);
  });
});

describe('compileGlobList', () => {
  it('matches when any pattern matches', () => {
    const matcher = compileGlobList(['**/*.mkv', '**/*.flac']);
    expect(matcher('Media/a.mkv')).toBe(true);
    expect(matcher('Media/a.flac')).toBe(true);
    expect(matcher('Media/a.txt')).toBe(false);
  });

  it('never matches when the list is empty or blank', () => {
    expect(compileGlobList([])('anything')).toBe(false);
    expect(compileGlobList(['  '])('anything')).toBe(false);
  });
});

describe('isIncluded', () => {
  it('includes everything when no include patterns are given', () => {
    expect(isIncluded('Media/a.mkv', [], [])).toBe(true);
  });

  it('applies excludes over includes', () => {
    expect(isIncluded('Media/Movies/a.mkv', ['Media/**'], ['**/Movies/**'])).toBe(false);
    expect(isIncluded('Media/Music/a.flac', ['Media/**'], ['**/Movies/**'])).toBe(true);
  });

  it('excludes a path that matches no include pattern', () => {
    expect(isIncluded('Other/a.mkv', ['Media/**'], [])).toBe(false);
  });
});
