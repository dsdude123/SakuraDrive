import { describe, expect, it } from 'vitest';
import { assessDisk, median, percentile, uncoveredVolumes, type DiskFigures } from './perf-analysis.js';

const disk = (readMBps: number | null, writeMBps: number | null = 150, latencyMs: number | null = 8): DiskFigures => ({
  readMBps,
  writeMBps,
  latencyMs,
});

describe('median and percentile', () => {
  it('takes the middle value, averaging the two middles of an even list', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBeNull();
  });

  it('ignores values that are not numbers', () => {
    expect(median([Number.NaN, 5, Number.POSITIVE_INFINITY])).toBe(5);
  });

  it('uses nearest rank for percentiles', () => {
    const values = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(values, 95)).toBe(95);
    expect(percentile(values, 50)).toBe(50);
    expect(percentile([7], 95)).toBe(7);
    expect(percentile([], 95)).toBeNull();
  });
});

describe('assessDisk against peers', () => {
  const peers = [disk(180), disk(190), disk(170), disk(185)];

  it('flags a disk reading at under half the median of its peers', () => {
    const findings = assessDisk({ current: disk(62), peers, history: [], slowFraction: 0.5 });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ reason: 'peers', metric: 'read', value: 62, reference: 182.5 });
    expect(findings[0]!.detail).toBe('Read 62 MB/s against a median of 183 MB/s across 4 comparable disks.');
  });

  it('leaves a disk alone that is merely a little slower', () => {
    expect(assessDisk({ current: disk(140), peers, history: [], slowFraction: 0.5 })).toEqual([]);
  });

  it('flags latency at more than twice the peer median', () => {
    const findings = assessDisk({ current: disk(180, 150, 40), peers, history: [], slowFraction: 0.5 });
    expect(findings.map((finding) => finding.metric)).toEqual(['latency']);
  });

  it('flags a slow write separately from reads', () => {
    const findings = assessDisk({ current: disk(180, 20), peers, history: [], slowFraction: 0.5 });
    expect(findings.map((finding) => finding.metric)).toEqual(['write']);
  });

  // With one peer, "slower than the median" is "slower than the other disk".
  it('does not compare against fewer than two peers', () => {
    expect(assessDisk({ current: disk(10), peers: [disk(200)], history: [], slowFraction: 0.5 })).toEqual([]);
  });

  it('honours the configured fraction', () => {
    expect(assessDisk({ current: disk(140), peers, history: [], slowFraction: 0.9 })).toHaveLength(1);
  });

  it('says nothing about a figure the disk did not produce', () => {
    expect(assessDisk({ current: disk(null, null, null), peers, history: [], slowFraction: 0.5 })).toEqual([]);
  });
});

describe('assessDisk against its own history', () => {
  it('flags a disk that has halved since its recent benchmarks', () => {
    const findings = assessDisk({
      current: disk(240),
      peers: [],
      history: [disk(520), disk(510), disk(530)],
      slowFraction: 0.5,
    });
    expect(findings).toEqual([
      expect.objectContaining({ reason: 'history', metric: 'read', reference: 520 }),
    ]);
    expect(findings[0]!.detail).toBe('Read 240 MB/s against 520 MB/s over its last 3 benchmarks.');
  });

  it('needs at least two earlier results', () => {
    expect(assessDisk({ current: disk(100), peers: [], history: [disk(500)], slowFraction: 0.5 })).toEqual([]);
  });
});

describe('uncoveredVolumes', () => {
  const members = [{ label: 'DRIVEPOOL4' }, { label: 'DRIVEPOOL9' }, { label: 'drivepool27' }, { label: null }];

  it('lists pool members no cache task targets, matching labels without regard to case', () => {
    const caches = [{ targetVolumes: ['DrivePool4', 'DRIVEPOOL27'] }];
    expect(uncoveredVolumes(members, caches).map((member) => member.label)).toEqual(['DRIVEPOOL9', null]);
  });

  it('counts a volume a cache reports statistics for as covered', () => {
    const caches = [{ targetVolumes: [], volumeStats: [{ label: 'DRIVEPOOL9' }] }];
    expect(uncoveredVolumes(members, caches).map((member) => member.label)).toContain('DRIVEPOOL4');
    expect(uncoveredVolumes(members, caches).map((member) => member.label)).not.toContain('DRIVEPOOL9');
  });
});
