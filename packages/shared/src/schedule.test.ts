import { describe, expect, it } from 'vitest';
import {
  DAY_SHORT_NAMES,
  defaultSchedule,
  describeSchedule,
  emptySchedule,
  enabledHoursPerWeek,
  formatSchedule,
  fullSchedule,
  isAllowedAt,
  isHourEnabled,
  isScheduleEmpty,
  isScheduleFull,
  minutesUntilWindowCloses,
  minutesUntilWindowOpens,
  normalizeSchedule,
  setHour,
  setRange,
  zonedParts,
} from './schedule.js';

describe('normalizeSchedule', () => {
  it('produces seven 24-character rows from nothing', () => {
    const schedule = normalizeSchedule(undefined);
    expect(schedule).toHaveLength(7);
    expect(schedule.every((row) => row.length === 24)).toBe(true);
    expect(isScheduleEmpty(schedule)).toBe(true);
  });

  it('pads short rows and drops extra rows', () => {
    const schedule = normalizeSchedule(['11', '1'.repeat(30), '', '', '', '', '', '1'.repeat(24)]);
    expect(schedule).toHaveLength(7);
    expect(schedule[0]).toBe(`11${'0'.repeat(22)}`);
    expect(schedule[1]).toBe('1'.repeat(24));
  });

  it('treats any character other than 1 as disabled', () => {
    expect(normalizeSchedule(['x1y1'])[0]!.slice(0, 4)).toBe('0101');
  });
});

describe('grid editing', () => {
  it('sets and clears individual hours', () => {
    let schedule = emptySchedule();
    schedule = setHour(schedule, 3, 14, true);
    expect(isHourEnabled(schedule, 3, 14)).toBe(true);
    expect(isHourEnabled(schedule, 3, 13)).toBe(false);
    schedule = setHour(schedule, 3, 14, false);
    expect(isHourEnabled(schedule, 3, 14)).toBe(false);
  });

  it('ignores out-of-range coordinates instead of corrupting the grid', () => {
    const schedule = setHour(emptySchedule(), 9, 99, true);
    expect(isScheduleEmpty(schedule)).toBe(true);
    expect(isHourEnabled(schedule, -1, 0)).toBe(false);
  });

  it('paints a rectangular block, which is what click-and-drag produces', () => {
    const schedule = setRange(emptySchedule(), [1, 2, 3], [22, 23], true);
    expect(enabledHoursPerWeek(schedule)).toBe(6);
    expect(isHourEnabled(schedule, 2, 23)).toBe(true);
    expect(isHourEnabled(schedule, 4, 23)).toBe(false);
  });
});

describe('defaults', () => {
  it('allows overnight windows on weeknights and longer ones at the weekend', () => {
    const schedule = defaultSchedule();
    expect(isHourEnabled(schedule, 3, 2)).toBe(true);
    expect(isHourEnabled(schedule, 3, 8)).toBe(false);
    expect(isHourEnabled(schedule, 0, 8)).toBe(true);
    expect(isHourEnabled(schedule, 6, 9)).toBe(true);
    expect(isHourEnabled(schedule, 3, 0)).toBe(false);
  });

  it('recognises empty and full grids', () => {
    expect(isScheduleEmpty(emptySchedule())).toBe(true);
    expect(isScheduleFull(fullSchedule())).toBe(true);
    expect(isScheduleFull(defaultSchedule())).toBe(false);
  });
});

describe('zonedParts', () => {
  it('maps a UTC instant into the configured timezone', () => {
    // 2024-03-05T09:30:00Z is a Tuesday; 01:30 in Los Angeles (UTC-8).
    const date = new Date('2024-03-05T09:30:00Z');
    expect(zonedParts(date, 'UTC')).toEqual({ day: 2, hour: 9, minute: 30 });
    expect(zonedParts(date, 'America/Los_Angeles')).toEqual({ day: 2, hour: 1, minute: 30 });
  });

  it('rolls the weekday backwards when the timezone crosses midnight', () => {
    const date = new Date('2024-03-05T02:00:00Z'); // Tuesday UTC
    const parts = zonedParts(date, 'America/New_York'); // Monday 21:00
    expect(DAY_SHORT_NAMES[parts.day]).toBe('Mon');
    expect(parts.hour).toBe(21);
  });

  it('renders midnight as hour 0, not 24', () => {
    expect(zonedParts(new Date('2024-03-05T00:15:00Z'), 'UTC').hour).toBe(0);
  });

  it('falls back to UTC for an unknown timezone rather than throwing', () => {
    expect(zonedParts(new Date('2024-03-05T09:30:00Z'), 'Mars/Olympus')).toEqual({
      day: 2,
      hour: 9,
      minute: 30,
    });
  });
});

describe('isAllowedAt', () => {
  it('honours the timezone when deciding whether heavy I/O may run', () => {
    // Allow 01:00-02:00 on Tuesday only.
    const schedule = setHour(emptySchedule(), 2, 1, true);
    const instant = new Date('2024-03-05T09:30:00Z');
    expect(isAllowedAt(schedule, instant, 'America/Los_Angeles')).toBe(true);
    expect(isAllowedAt(schedule, instant, 'UTC')).toBe(false);
  });
});

describe('window arithmetic', () => {
  const schedule = setRange(emptySchedule(), [2], [1, 2, 3], true);

  it('reports minutes remaining in an open window', () => {
    const instant = new Date('2024-03-05T01:15:00Z'); // Tue 01:15 UTC
    expect(minutesUntilWindowCloses(schedule, instant, 'UTC')).toBe(45 + 120);
  });

  it('returns null when the window is closed', () => {
    const instant = new Date('2024-03-05T05:00:00Z');
    expect(minutesUntilWindowCloses(schedule, instant, 'UTC')).toBeNull();
  });

  it('reports minutes until the next window opens', () => {
    const instant = new Date('2024-03-05T00:30:00Z'); // 30 min before Tue 01:00
    expect(minutesUntilWindowOpens(schedule, instant, 'UTC')).toBe(30);
  });

  it('returns 0 while a window is already open', () => {
    expect(minutesUntilWindowOpens(schedule, new Date('2024-03-05T02:00:00Z'), 'UTC')).toBe(0);
  });

  it('wraps across the end of the week', () => {
    // Saturday 23:00 with a window on Sunday 00:00.
    const sundaySchedule = setHour(emptySchedule(), 0, 0, true);
    const saturdayNight = new Date('2024-03-09T23:00:00Z');
    expect(minutesUntilWindowOpens(sundaySchedule, saturdayNight, 'UTC')).toBe(60);
  });

  it('returns null for an empty schedule instead of looping forever', () => {
    expect(minutesUntilWindowOpens(emptySchedule(), new Date(), 'UTC')).toBeNull();
  });

  it('caps a full schedule at one week of remaining time', () => {
    const remaining = minutesUntilWindowCloses(fullSchedule(), new Date('2024-03-05T00:00:00Z'), 'UTC');
    expect(remaining).toBe(7 * 24 * 60);
  });
});

describe('describeSchedule / formatSchedule', () => {
  it('collapses contiguous hours into windows', () => {
    const schedule = setRange(emptySchedule(), [1], [1, 2, 3, 10, 11], true);
    expect(describeSchedule(schedule)).toEqual([
      { day: 1, startHour: 1, endHour: 4 },
      { day: 1, startHour: 10, endHour: 12 },
    ]);
  });

  it('handles a window that runs to the end of the day', () => {
    const schedule = setRange(emptySchedule(), [5], [22, 23], true);
    expect(describeSchedule(schedule)).toEqual([{ day: 5, startHour: 22, endHour: 24 }]);
    expect(formatSchedule(schedule)).toBe('Fri 22:00–24:00');
  });

  it('describes the empty and full extremes in words', () => {
    expect(formatSchedule(emptySchedule())).toBe('Never (on-demand only)');
    expect(formatSchedule(fullSchedule())).toBe('Always');
  });
});
