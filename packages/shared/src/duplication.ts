/**
 * StableBit DrivePool duplication resolution.
 *
 * DrivePool sets a duplication level per folder and every descendant inherits it
 * until another folder overrides it, so resolving a path is a longest-prefix match.
 * Rules come either from the agent (`dpcmd get-duplication`) or from rules the user
 * enters in the UI when the agent cannot reach DrivePool; manual rules win so a human
 * can always correct a bad reading.
 */

import { isUnder, normalizeRelPath } from './paths.js';

export type DuplicationSource = 'drivepool' | 'manual' | 'default' | 'observed';

export interface DuplicationRule {
  /** Pool-relative folder path. Empty string is the pool root (the default level). */
  path: string;
  /** Copies DrivePool keeps of each file. 1 means unduplicated. */
  level: number;
  source: DuplicationSource;
  poolId?: string | null;
}

export interface DuplicationResolution {
  level: number;
  /** The rule that won, or null when the pool default applied. */
  rule: DuplicationRule | null;
  source: DuplicationSource;
}

export const DEFAULT_DUPLICATION_LEVEL = 1;

/**
 * Order rules so the most specific wins and, at equal specificity, a human-entered
 * rule beats one scraped from DrivePool.
 */
function specificity(rule: DuplicationRule): [number, number] {
  const path = normalizeRelPath(rule.path);
  const depth = path === '' ? 0 : path.split('/').length;
  const sourceRank = rule.source === 'manual' ? 2 : rule.source === 'drivepool' ? 1 : 0;
  return [depth, sourceRank];
}

/** Pre-sort rules once when resolving many paths against the same rule set. */
export function sortDuplicationRules(rules: readonly DuplicationRule[]): DuplicationRule[] {
  return [...rules].sort((a, b) => {
    const [depthA, rankA] = specificity(a);
    const [depthB, rankB] = specificity(b);
    if (depthA !== depthB) return depthB - depthA;
    return rankB - rankA;
  });
}

/** Resolve the duplication level configured for a pool-relative path. */
export function resolveDuplication(
  relPath: string,
  rules: readonly DuplicationRule[],
  defaultLevel = DEFAULT_DUPLICATION_LEVEL,
): DuplicationResolution {
  const target = normalizeRelPath(relPath);
  for (const rule of sortDuplicationRules(rules)) {
    if (isUnder(rule.path, target)) {
      return { level: rule.level, rule, source: rule.source };
    }
  }
  return { level: defaultLevel, rule: null, source: 'default' };
}

/**
 * Build a resolver that caches per-directory, which matters when walking a catalog of
 * millions of files: consecutive files almost always share a parent directory.
 */
export function createDuplicationResolver(
  rules: readonly DuplicationRule[],
  defaultLevel = DEFAULT_DUPLICATION_LEVEL,
): (relPath: string) => number {
  const sorted = sortDuplicationRules(rules);
  const cache = new Map<string, number>();
  return (relPath: string): number => {
    const normalized = normalizeRelPath(relPath);
    const lastSlash = normalized.lastIndexOf('/');
    const dir = lastSlash === -1 ? '' : normalized.slice(0, lastSlash);
    const cached = cache.get(dir);
    if (cached !== undefined) return cached;
    let level = defaultLevel;
    for (const rule of sorted) {
      if (isUnder(rule.path, dir)) {
        level = rule.level;
        break;
      }
    }
    // Bound the cache so a pathological tree cannot exhaust memory mid-scan.
    if (cache.size > 50_000) cache.clear();
    cache.set(dir, level);
    return level;
  };
}

/** Bytes a file actually consumes across the pool once duplication is applied. */
export function effectiveSize(logicalSize: number, duplicationLevel: number): number {
  const level = Number.isFinite(duplicationLevel) && duplicationLevel > 0 ? duplicationLevel : 1;
  return logicalSize * level;
}

/**
 * Remove rules made redundant by an ancestor with the same level, so the UI shows the
 * short list a human would have written.
 */
export function compactDuplicationRules(rules: readonly DuplicationRule[]): DuplicationRule[] {
  const sorted = [...rules].sort(
    (a, b) => normalizeRelPath(a.path).length - normalizeRelPath(b.path).length,
  );
  const kept: DuplicationRule[] = [];
  for (const rule of sorted) {
    const inheritedLevel = kept.reduce<number | null>((acc, candidate) => {
      if (candidate === rule) return acc;
      return isUnder(candidate.path, rule.path) ? candidate.level : acc;
    }, null);
    if (inheritedLevel === rule.level && normalizeRelPath(rule.path) !== '') continue;
    kept.push({ ...rule, path: normalizeRelPath(rule.path) });
  }
  return kept;
}

export interface DuplicationMismatch {
  relPath: string;
  expectedLevel: number;
  observedLevel: number;
}

/**
 * Compare configured duplication against the number of pool parts actually holding a
 * file. Under-duplication is a real data-loss risk and is the reason poolpart-level
 * catalog roots are worth scanning.
 */
export function findDuplicationMismatches(
  observed: ReadonlyMap<string, number>,
  rules: readonly DuplicationRule[],
  defaultLevel = DEFAULT_DUPLICATION_LEVEL,
): DuplicationMismatch[] {
  const resolver = createDuplicationResolver(rules, defaultLevel);
  const mismatches: DuplicationMismatch[] = [];
  for (const [relPath, observedLevel] of observed) {
    const expectedLevel = resolver(relPath);
    if (observedLevel < expectedLevel) {
      mismatches.push({ relPath, expectedLevel, observedLevel });
    }
  }
  return mismatches;
}
