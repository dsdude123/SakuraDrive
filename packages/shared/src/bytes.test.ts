import { describe, expect, it } from 'vitest';
import {
  formatBytes,
  formatCount,
  formatDurationMs,
  formatPercent,
  formatRelative,
  parseBytes,
} from './bytes.js';

describe('formatBytes', () => {
  it('formats using binary multiples', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(14_000_519_643_136)).toBe('12.7 TB');
  });

  it('handles bigint, negatives and missing values', () => {
    expect(formatBytes(2n ** 40n)).toBe('1.0 TB');
    expect(formatBytes(-2048)).toBe('-2.0 KB');
    expect(formatBytes(null)).toBe('—');
    expect(formatBytes(undefined)).toBe('—');
    expect(formatBytes(Number.NaN)).toBe('—');
  });

  it('respects the requested precision', () => {
    expect(formatBytes(1_500_000, 2)).toBe('1.43 MB');
  });
});

describe('parseBytes', () => {
  it('parses suffixed sizes', () => {
    expect(parseBytes('1024')).toBe(1024);
    expect(parseBytes('1KB')).toBe(1024);
    expect(parseBytes('1.5 GB')).toBe(Math.round(1.5 * 1024 ** 3));
    expect(parseBytes('2TiB')).toBe(2 * 1024 ** 4);
  });

  it('returns null for nonsense', () => {
    expect(parseBytes('lots')).toBeNull();
    expect(parseBytes('')).toBeNull();
    expect(parseBytes(null)).toBeNull();
  });

  it('passes numbers straight through', () => {
    expect(parseBytes(99)).toBe(99);
  });
});

describe('formatDurationMs', () => {
  it('formats sub-second, minutes, hours and days', () => {
    expect(formatDurationMs(250)).toBe('250ms');
    expect(formatDurationMs(90_000)).toBe('1m 30s');
    expect(formatDurationMs(3_600_000)).toBe('1h');
    expect(formatDurationMs(90_000_000)).toBe('1d 1h');
  });

  it('handles missing values', () => {
    expect(formatDurationMs(null)).toBe('—');
  });
});

describe('formatRelative', () => {
  const now = Date.parse('2024-03-05T12:00:00Z');

  it('describes the recent past', () => {
    expect(formatRelative('2024-03-05T11:58:00Z', now)).toBe('2m ago');
    expect(formatRelative('2024-03-05T11:59:59Z', now)).toBe('just now');
  });

  it('describes the future', () => {
    expect(formatRelative('2024-03-05T13:00:00Z', now)).toBe('in 1h');
  });

  it('handles never', () => {
    expect(formatRelative(null, now)).toBe('never');
    expect(formatRelative('not a date', now)).toBe('never');
  });
});

describe('misc formatting', () => {
  it('formats percentages and counts', () => {
    expect(formatPercent(0.5)).toBe('50%');
    expect(formatPercent(0.1234, 1)).toBe('12.3%');
    expect(formatPercent(null)).toBe('—');
    expect(formatCount(1234567)).toBe('1,234,567');
    expect(formatCount(null)).toBe('—');
  });
});
