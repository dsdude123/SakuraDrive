/**
 * Small isomorphic glob matcher.
 *
 * The server matches backup expectation rules against millions of catalog paths and
 * the UI previews the same rules while you type, so the implementation has to run in
 * both places and behave identically. Supported syntax:
 *
 *   *          any run of characters except `/`
 *   **         any run of characters including `/` (path-segment aware)
 *   ?          exactly one character except `/`
 *   [abc]      character class, `[!abc]` / `[^abc]` negates
 *   {a,b,c}    alternation (may nest)
 *
 * Matching is case-insensitive by default because the catalogued volumes are NTFS.
 */

export interface GlobOptions {
  /** Defaults to true (NTFS semantics). */
  caseInsensitive?: boolean;
  /** When true, a pattern matching a directory also matches everything under it. */
  matchDescendants?: boolean;
}

const SPECIAL = /[.+^$()|\\]/g;

function escapeLiteral(text: string): string {
  return text.replace(SPECIAL, '\\$&');
}

/** Convert a glob into a regular expression source string (without anchors). */
export function globToRegexSource(pattern: string): string {
  let out = '';
  let i = 0;
  const depth: number[] = [];

  while (i < pattern.length) {
    const char = pattern[i]!;

    if (char === '*') {
      const isDouble = pattern[i + 1] === '*';
      if (isDouble) {
        const before = pattern[i - 1];
        const after = pattern[i + 2];
        i += 2;
        if (after === '/') i += 1;
        const atSegmentStart = before === undefined || before === '/';
        // `a/**/b` must also match `a/b`, so the separator is swallowed with the
        // segments. A trailing `**` is simply "everything below here".
        out += atSegmentStart && after === '/' ? '(?:.*/)?' : '.*';
      } else {
        out += '[^/]*';
        i += 1;
      }
      continue;
    }

    if (char === '?') {
      out += '[^/]';
      i += 1;
      continue;
    }

    if (char === '[') {
      const end = findClassEnd(pattern, i);
      if (end === -1) {
        out += '\\[';
        i += 1;
        continue;
      }
      let body = pattern.slice(i + 1, end);
      let negate = false;
      if (body.startsWith('!') || body.startsWith('^')) {
        negate = true;
        body = body.slice(1);
      }
      out += `[${negate ? '^' : ''}${body.replace(/\\/g, '\\\\').replace(/\]/g, '\\]')}]`;
      i = end + 1;
      continue;
    }

    if (char === '{') {
      depth.push(1);
      out += '(?:';
      i += 1;
      continue;
    }

    if (char === '}' && depth.length > 0) {
      depth.pop();
      out += ')';
      i += 1;
      continue;
    }

    if (char === ',' && depth.length > 0) {
      out += '|';
      i += 1;
      continue;
    }

    out += escapeLiteral(char);
    i += 1;
  }

  // Unbalanced `{` — close what we opened so the regex still compiles.
  while (depth.length > 0) {
    depth.pop();
    out += ')';
  }
  return out;
}

function findClassEnd(pattern: string, start: number): number {
  for (let j = start + 1; j < pattern.length; j += 1) {
    if (pattern[j] === ']' && j > start + 1) return j;
  }
  return -1;
}

export type GlobMatcher = (input: string) => boolean;

/** Compile one glob into a reusable matcher. */
export function compileGlob(pattern: string, options: GlobOptions = {}): GlobMatcher {
  const { caseInsensitive = true, matchDescendants = false } = options;
  const normalized = normalizeGlob(pattern);
  const source = globToRegexSource(normalized);
  const tail = matchDescendants ? '(?:/.*)?' : '';
  const regex = new RegExp(`^${source}${tail}$`, caseInsensitive ? 'i' : '');
  return (input: string) => regex.test(normalizePathForGlob(input));
}

/** Compile a list of globs into a single matcher that succeeds when any pattern matches. */
export function compileGlobList(patterns: readonly string[], options: GlobOptions = {}): GlobMatcher {
  const matchers = patterns.filter((p) => p.trim().length > 0).map((p) => compileGlob(p, options));
  if (matchers.length === 0) return () => false;
  return (input: string) => matchers.some((m) => m(input));
}

export function matchesGlob(pattern: string, input: string, options?: GlobOptions): boolean {
  return compileGlob(pattern, options)(input);
}

/** Accept Windows-style patterns (`\\`) and strip a leading `./`. */
export function normalizeGlob(pattern: string): string {
  return pattern.replace(/\\/g, '/').replace(/^\.\//, '');
}

export function normalizePathForGlob(input: string): string {
  return input.replace(/\\/g, '/').replace(/^\.\//, '');
}

/**
 * Evaluate ordered include/exclude rules. Excludes always win, which matches how
 * backup tooling (and users' intuition) treats them.
 */
export function isIncluded(
  path: string,
  includes: readonly string[],
  excludes: readonly string[],
  options?: GlobOptions,
): boolean {
  const includeMatch = includes.length === 0 ? () => true : compileGlobList(includes, options);
  const excludeMatch = compileGlobList(excludes, options);
  if (excludeMatch(path)) return false;
  return includeMatch(path);
}
