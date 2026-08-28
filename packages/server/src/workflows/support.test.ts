import { describe, expect, it } from 'vitest';
import { openTestDatabase } from '../db/index.js';
import { hoursSince, isDailyJobDue, lastCompletedAt } from './support.js';

describe('lastCompletedAt', () => {
  it('returns the finish time of the most recent completed run', () => {
    const db = openTestDatabase();
    db.prepare(
      `INSERT INTO workflow_runs (workflow_id, state, updated_at, finished_at)
       VALUES ('export.backup', 'completed', 'x', '2024-03-01T00:00:00Z')`,
    ).run();
    db.prepare(
      `INSERT INTO workflow_runs (workflow_id, state, updated_at, finished_at)
       VALUES ('export.backup', 'failed', 'x', '2024-03-02T00:00:00Z')`,
    ).run();
    expect(lastCompletedAt(db, 'export.backup')).toBe('2024-03-01T00:00:00Z');
    expect(lastCompletedAt(db, 'catalog.scan')).toBeNull();
    db.close();
  });
});

describe('hoursSince', () => {
  it('treats never as infinitely long ago', () => {
    expect(hoursSince(null)).toBe(Number.POSITIVE_INFINITY);
    expect(hoursSince('not a date')).toBe(Number.POSITIVE_INFINITY);
  });

  it('measures elapsed hours', () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 3_600_000).toISOString();
    expect(hoursSince(twoHoursAgo)).toBeCloseTo(2, 1);
  });
});

describe('isDailyJobDue', () => {
  const everyDay = [0, 1, 2, 3, 4, 5, 6];

  it('is due once the configured local time has passed', () => {
    // 12:00Z is 04:00 in Los Angeles (PST, UTC-8).
    const now = new Date('2024-01-16T12:00:00Z');
    expect(isDailyJobDue(now, 'America/Los_Angeles', '03:30', everyDay, null)).toBe(true);
    expect(isDailyJobDue(now, 'America/Los_Angeles', '05:00', everyDay, null)).toBe(false);
  });

  it('is not due twice on the same local day', () => {
    const now = new Date('2024-01-16T12:00:00Z');
    const earlierToday = new Date('2024-01-16T11:00:00Z').toISOString();
    expect(isDailyJobDue(now, 'America/Los_Angeles', '03:00', everyDay, earlierToday)).toBe(false);
  });

  it('becomes due again the next local day', () => {
    const now = new Date('2024-01-17T12:00:00Z');
    const yesterday = new Date('2024-01-16T12:00:00Z').toISOString();
    expect(isDailyJobDue(now, 'America/Los_Angeles', '03:00', everyDay, yesterday)).toBe(true);
  });

  it('catches up after downtime rather than skipping the day', () => {
    // The service was down at 04:30 and comes up at 09:00 local.
    const now = new Date('2024-01-16T17:00:00Z');
    expect(isDailyJobDue(now, 'America/Los_Angeles', '04:30', everyDay, null)).toBe(true);
  });

  it('respects the selected days of the week', () => {
    const tuesday = new Date('2024-01-16T20:00:00Z');
    expect(isDailyJobDue(tuesday, 'UTC', '01:00', [2], null)).toBe(true);
    expect(isDailyJobDue(tuesday, 'UTC', '01:00', [0, 6], null)).toBe(false);
  });

  it('falls back to UTC for an unknown timezone', () => {
    const now = new Date('2024-01-16T12:00:00Z');
    expect(isDailyJobDue(now, 'Mars/Olympus', '11:00', everyDay, null)).toBe(true);
  });

  it('rejects an unparseable time of day', () => {
    const now = new Date('2024-01-16T12:00:00Z');
    expect(isDailyJobDue(now, 'UTC', 'lunchtime', everyDay, null)).toBe(false);
  });
});
