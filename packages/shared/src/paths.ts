/**
 * Path helpers.
 *
 * Everything stored in the catalog is a POSIX-style, root-relative path with no
 * leading slash (`Media/Movies/foo.mkv`). The container sees the pools through bind
 * mounts while the agent and the user think in Windows paths, so translation happens
 * at the edges and the database only ever holds the normalized form.
 */

/** `D:\Media\Movies` -> `D:/Media/Movies`, collapsing duplicate separators. */
export function toPosix(input: string): string {
  return input.replace(/\\/g, '/').replace(/\/{2,}/g, '/');
}

/** `Media/Movies` -> `Media\Movies` for display next to Windows tooling. */
export function toWindows(input: string): string {
  return input.replace(/\//g, '\\');
}

/** Strip leading/trailing separators and collapse `.` segments. */
export function normalizeRelPath(input: string): string {
  const posix = toPosix(input.trim());
  const segments: string[] = [];
  for (const segment of posix.split('/')) {
    if (segment === '' || segment === '.') continue;
    segments.push(segment);
  }
  return segments.join('/');
}

/** Normalize a mount root: absolute POSIX path without a trailing slash. */
export function normalizeRootPath(input: string): string {
  const posix = toPosix(input.trim());
  if (posix === '/') return '/';
  return posix.replace(/\/+$/, '');
}

export function joinRelPath(...parts: Array<string | null | undefined>): string {
  return normalizeRelPath(parts.filter((p): p is string => !!p).join('/'));
}

export function dirnameRel(relPath: string): string {
  const normalized = normalizeRelPath(relPath);
  const index = normalized.lastIndexOf('/');
  return index === -1 ? '' : normalized.slice(0, index);
}

export function basename(relPath: string): string {
  const normalized = normalizeRelPath(relPath);
  const index = normalized.lastIndexOf('/');
  return index === -1 ? normalized : normalized.slice(index + 1);
}

/** Lowercase extension without the dot; empty string when there is none. */
export function extname(relPath: string): string {
  const name = basename(relPath);
  const index = name.lastIndexOf('.');
  if (index <= 0 || index === name.length - 1) return '';
  return name.slice(index + 1).toLowerCase();
}

/** All ancestor directories of a path, shallowest first, excluding the file itself. */
export function ancestors(relPath: string): string[] {
  const normalized = normalizeRelPath(relPath);
  if (normalized === '') return [];
  const segments = normalized.split('/');
  segments.pop();
  const out: string[] = [];
  let current = '';
  for (const segment of segments) {
    current = current === '' ? segment : `${current}/${segment}`;
    out.push(current);
  }
  return out;
}

/**
 * True when `child` is `prefix` itself or lives underneath it. Comparison is
 * case-insensitive (NTFS) and segment-aware so `Media2` never matches `Media`.
 */
export function isUnder(prefix: string, child: string): boolean {
  const p = normalizeRelPath(prefix).toLowerCase();
  const c = normalizeRelPath(child).toLowerCase();
  if (p === '') return true;
  if (c === p) return true;
  return c.startsWith(`${p}/`);
}

/** Strip a StableBit DrivePool `PoolPart.<guid>` prefix, yielding the pool-relative path. */
export function stripPoolPartPrefix(relPath: string): string {
  const normalized = normalizeRelPath(relPath);
  const match = /^poolpart\.[0-9a-f-]{8,}\/?/i.exec(normalized);
  if (!match) return normalized;
  return normalizeRelPath(normalized.slice(match[0].length));
}

export const POOL_PART_DIR_PATTERN = /^poolpart\.[0-9a-f-]{8,}$/i;

export function isPoolPartDirName(name: string): boolean {
  return POOL_PART_DIR_PATTERN.test(name);
}

/**
 * Directories DrivePool and Windows maintain that must never appear in the catalog:
 * cataloguing them produces noise, false "deleted" diffs and useless hashing work.
 */
export const DEFAULT_EXCLUDED_DIR_NAMES = [
  '$RECYCLE.BIN',
  'System Volume Information',
  '.covefs',
  'covefs',
  '$Recycle.Bin',
  'found.000',
  'RECYCLER',
] as const;

const EXCLUDED_LOWER = new Set(DEFAULT_EXCLUDED_DIR_NAMES.map((d) => d.toLowerCase()));

export function isSystemDirName(name: string): boolean {
  return EXCLUDED_LOWER.has(name.toLowerCase());
}

/** Translate a container path back to the Windows path the user would type. */
export function toHostPath(containerRoot: string, hostRoot: string, containerPath: string): string {
  const root = normalizeRootPath(containerRoot);
  const posix = toPosix(containerPath);
  const rel = posix.startsWith(root) ? normalizeRelPath(posix.slice(root.length)) : normalizeRelPath(posix);
  const host = hostRoot.replace(/[\\/]+$/, '');
  return rel === '' ? host : `${host}\\${toWindows(rel)}`;
}
