import type { PerfSlowness } from '@sakuradrive/shared';

/**
 * Deciding whether a disk is slow.
 *
 * Pure functions so the rule that raises an alert is the rule the tests pin, and so the
 * interface can show exactly why a disk is flagged without a second implementation.
 *
 * A disk is compared two ways. Against its peers -- the other disks in the same pool on
 * the same kind of media, measured in the same run -- because a disk that is slow next
 * to identical neighbours under identical conditions is the disk to look at. And against
 * its own recent results, because a disk with no peers (the standalone SSD) can still be
 * getting worse.
 */

export function median(values: readonly number[]): number | null {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

/** Nearest-rank percentile, `p` in 0..100. */
export function percentile(values: readonly number[], p: number): number | null {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1]!;
}

export interface DiskFigures {
  readMBps: number | null;
  writeMBps: number | null;
  latencyMs: number | null;
}

/**
 * Fewer comparable disks than this and a median says nothing: with one peer, "slower
 * than the median" is "slower than the other disk", which is a coin toss.
 */
export const MIN_PEERS = 2;
/** Prior results needed before a disk is compared with its own history. */
export const MIN_HISTORY = 2;

const round = (value: number) => (value >= 100 ? Math.round(value) : Math.round(value * 10) / 10);

/**
 * Every way `current` falls short.
 *
 * `peers` excludes the disk itself, so one slow disk does not drag its own reference
 * down. `history` is its own earlier results, newest first, not including `current`.
 * `slowFraction` 0.5 means "less than half the reference" for throughput and "more than
 * twice the reference" for latency.
 */
export function assessDisk(input: {
  current: DiskFigures;
  peers: readonly DiskFigures[];
  history: readonly DiskFigures[];
  slowFraction: number;
}): PerfSlowness[] {
  const { current, peers, history, slowFraction } = input;
  const findings: PerfSlowness[] = [];

  const below = (value: number | null, reference: number | null) =>
    value !== null && reference !== null && reference > 0 && value < reference * slowFraction;
  const above = (value: number | null, reference: number | null) =>
    value !== null && reference !== null && reference > 0 && value > reference / slowFraction;

  if (peers.length >= MIN_PEERS) {
    const n = peers.length;
    const read = median(numbers(peers.map((peer) => peer.readMBps)));
    const write = median(numbers(peers.map((peer) => peer.writeMBps)));
    const latency = median(numbers(peers.map((peer) => peer.latencyMs)));

    if (below(current.readMBps, read)) {
      findings.push({
        reason: 'peers',
        metric: 'read',
        value: current.readMBps!,
        reference: read!,
        detail: `Read ${round(current.readMBps!)} MB/s against a median of ${round(read!)} MB/s across ${n} comparable disks.`,
      });
    }
    if (below(current.writeMBps, write)) {
      findings.push({
        reason: 'peers',
        metric: 'write',
        value: current.writeMBps!,
        reference: write!,
        detail: `Write ${round(current.writeMBps!)} MB/s against a median of ${round(write!)} MB/s across ${n} comparable disks.`,
      });
    }
    if (above(current.latencyMs, latency)) {
      findings.push({
        reason: 'peers',
        metric: 'latency',
        value: current.latencyMs!,
        reference: latency!,
        detail: `Random read latency ${round(current.latencyMs!)} ms against a median of ${round(latency!)} ms across ${n} comparable disks.`,
      });
    }
  }

  if (history.length >= MIN_HISTORY) {
    const n = history.length;
    const read = median(numbers(history.map((past) => past.readMBps)));
    const latency = median(numbers(history.map((past) => past.latencyMs)));
    if (below(current.readMBps, read)) {
      findings.push({
        reason: 'history',
        metric: 'read',
        value: current.readMBps!,
        reference: read!,
        detail: `Read ${round(current.readMBps!)} MB/s against ${round(read!)} MB/s over its last ${n} benchmarks.`,
      });
    }
    if (above(current.latencyMs, latency)) {
      findings.push({
        reason: 'history',
        metric: 'latency',
        value: current.latencyMs!,
        reference: latency!,
        detail: `Random read latency ${round(current.latencyMs!)} ms against ${round(latency!)} ms over its last ${n} benchmarks.`,
      });
    }
  }

  return findings;
}

function numbers(values: ReadonlyArray<number | null>): number[] {
  return values.filter((value): value is number => value !== null && Number.isFinite(value));
}

/**
 * Pool members no PrimoCache task fronts.
 *
 * Matched on volume label, which is how PrimoCache names its target volumes. Case is
 * ignored: `rxpcc` and Windows do not always agree on it.
 */
export function uncoveredVolumes<T extends { label: string | null }>(
  poolMembers: readonly T[],
  caches: ReadonlyArray<{ targetVolumes?: string[] | null; volumeStats?: Array<{ label?: string | null }> | null }>,
): T[] {
  const covered = new Set<string>();
  for (const cache of caches) {
    for (const label of cache.targetVolumes ?? []) covered.add(label.trim().toLowerCase());
    for (const stat of cache.volumeStats ?? []) {
      if (stat.label) covered.add(stat.label.trim().toLowerCase());
    }
  }
  return poolMembers.filter((member) => !member.label || !covered.has(member.label.trim().toLowerCase()));
}
