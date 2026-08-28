/**
 * Weekly I/O window schedule.
 *
 * Heavy cataloguing and hashing is only allowed inside windows the user paints on a
 * 7x24 grid in the UI. The grid is stored as seven 24-character strings of `0`/`1`
 * (index 0 = Sunday, matching `Date#getDay`) so exports stay readable and diffable.
 */

export const DAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;

export const DAY_SHORT_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

export type WeeklySchedule = readonly string[];

export const HOURS_PER_DAY = 24;
export const DAYS_PER_WEEK = 7;

const EMPTY_DAY = '0'.repeat(HOURS_PER_DAY);
const FULL_DAY = '1'.repeat(HOURS_PER_DAY);

/** A schedule that never allows heavy I/O. */
export function emptySchedule(): string[] {
  return Array.from({ length: DAYS_PER_WEEK }, () => EMPTY_DAY);
}

/** A schedule that always allows heavy I/O. */
export function fullSchedule(): string[] {
  return Array.from({ length: DAYS_PER_WEEK }, () => FULL_DAY);
}

/**
 * The out-of-the-box schedule: overnight windows when nobody is streaming from the
 * pool. 01:00-06:59 every night, extended to 01:00-09:59 at the weekend.
 */
export function defaultSchedule(): string[] {
  return Array.from({ length: DAYS_PER_WEEK }, (_, day) => {
    const weekend = day === 0 || day === 6;
    const endExclusive = weekend ? 10 : 7;
    let row = '';
    for (let hour = 0; hour < HOURS_PER_DAY; hour += 1) {
      row += hour >= 1 && hour < endExclusive ? '1' : '0';
    }
    return row;
  });
}

/** Coerce arbitrary stored/imported values into a valid grid, filling gaps with `0`. */
export function normalizeSchedule(input: unknown): string[] {
  const rows = Array.isArray(input) ? input : [];
  return Array.from({ length: DAYS_PER_WEEK }, (_, day) => {
    const raw = typeof rows[day] === 'string' ? (rows[day] as string) : '';
    let row = '';
    for (let hour = 0; hour < HOURS_PER_DAY; hour += 1) {
      row += raw[hour] === '1' ? '1' : '0';
    }
    return row;
  });
}

export function isScheduleEmpty(schedule: WeeklySchedule): boolean {
  return normalizeSchedule(schedule).every((row) => !row.includes('1'));
}

export function isScheduleFull(schedule: WeeklySchedule): boolean {
  return normalizeSchedule(schedule).every((row) => !row.includes('0'));
}

export function isHourEnabled(schedule: WeeklySchedule, day: number, hour: number): boolean {
  if (day < 0 || day >= DAYS_PER_WEEK || hour < 0 || hour >= HOURS_PER_DAY) return false;
  return normalizeSchedule(schedule)[day]![hour] === '1';
}

export function setHour(
  schedule: WeeklySchedule,
  day: number,
  hour: number,
  enabled: boolean,
): string[] {
  const next = normalizeSchedule(schedule);
  if (day < 0 || day >= DAYS_PER_WEEK || hour < 0 || hour >= HOURS_PER_DAY) return next;
  const row = next[day]!;
  next[day] = `${row.slice(0, hour)}${enabled ? '1' : '0'}${row.slice(hour + 1)}`;
  return next;
}

/** Set a rectangular block of the grid at once — what click-and-drag painting produces. */
export function setRange(
  schedule: WeeklySchedule,
  days: readonly number[],
  hours: readonly number[],
  enabled: boolean,
): string[] {
  let next = normalizeSchedule(schedule);
  for (const day of days) {
    for (const hour of hours) {
      next = setHour(next, day, hour, enabled);
    }
  }
  return next;
}

export interface ZonedParts {
  day: number;
  hour: number;
  minute: number;
}

/**
 * Resolve a UTC instant into weekday/hour/minute for the configured IANA timezone.
 * The container almost always runs UTC while the user thinks in local time, so every
 * schedule decision goes through here.
 */
export function zonedParts(date: Date, timeZone: string): ZonedParts {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      weekday: 'short',
      hour: 'numeric',
      minute: 'numeric',
      hour12: false,
    }).formatToParts(date);
  } catch {
    // Unknown timezone: fall back to UTC rather than blocking every workflow.
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'UTC',
      weekday: 'short',
      hour: 'numeric',
      minute: 'numeric',
      hour12: false,
    }).formatToParts(date);
  }
  const lookup = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? '';
  const weekday = lookup('weekday');
  const day = DAY_SHORT_NAMES.findIndex((name) => name.toLowerCase() === weekday.toLowerCase());
  const hourRaw = Number(lookup('hour'));
  return {
    day: day === -1 ? 0 : day,
    // `hour12: false` can render midnight as 24 in some ICU versions.
    hour: Number.isFinite(hourRaw) ? hourRaw % 24 : 0,
    minute: Number(lookup('minute')) || 0,
  };
}

export function isAllowedAt(schedule: WeeklySchedule, date: Date, timeZone: string): boolean {
  const { day, hour } = zonedParts(date, timeZone);
  return isHourEnabled(schedule, day, hour);
}

/** Minutes until the current window closes, or null when the window is not open. */
export function minutesUntilWindowCloses(
  schedule: WeeklySchedule,
  date: Date,
  timeZone: string,
): number | null {
  const grid = normalizeSchedule(schedule);
  const { day, hour, minute } = zonedParts(date, timeZone);
  if (!isHourEnabled(grid, day, hour)) return null;
  let remaining = 60 - minute;
  let cursorDay = day;
  let cursorHour = hour;
  for (let step = 0; step < DAYS_PER_WEEK * HOURS_PER_DAY - 1; step += 1) {
    cursorHour += 1;
    if (cursorHour >= HOURS_PER_DAY) {
      cursorHour = 0;
      cursorDay = (cursorDay + 1) % DAYS_PER_WEEK;
    }
    if (!isHourEnabled(grid, cursorDay, cursorHour)) break;
    remaining += 60;
  }
  return remaining;
}

/** Minutes until the next window opens, or null when the schedule is empty. */
export function minutesUntilWindowOpens(
  schedule: WeeklySchedule,
  date: Date,
  timeZone: string,
): number | null {
  const grid = normalizeSchedule(schedule);
  if (isScheduleEmpty(grid)) return null;
  const { day, hour, minute } = zonedParts(date, timeZone);
  if (isHourEnabled(grid, day, hour)) return 0;
  let waited = 60 - minute;
  let cursorDay = day;
  let cursorHour = hour;
  for (let step = 0; step < DAYS_PER_WEEK * HOURS_PER_DAY - 1; step += 1) {
    cursorHour += 1;
    if (cursorHour >= HOURS_PER_DAY) {
      cursorHour = 0;
      cursorDay = (cursorDay + 1) % DAYS_PER_WEEK;
    }
    if (isHourEnabled(grid, cursorDay, cursorHour)) return waited;
    waited += 60;
  }
  return null;
}

/** Total hours enabled per week — shown in the UI as a sanity check on the painted grid. */
export function enabledHoursPerWeek(schedule: WeeklySchedule): number {
  return normalizeSchedule(schedule).reduce(
    (total, row) => total + [...row].filter((c) => c === '1').length,
    0,
  );
}

export interface ScheduleWindow {
  day: number;
  startHour: number;
  /** Exclusive. 24 means "through the end of the day". */
  endHour: number;
}

/** Collapse the grid into contiguous per-day windows for compact display and export. */
export function describeSchedule(schedule: WeeklySchedule): ScheduleWindow[] {
  const grid = normalizeSchedule(schedule);
  const windows: ScheduleWindow[] = [];
  grid.forEach((row, day) => {
    let start: number | null = null;
    for (let hour = 0; hour < HOURS_PER_DAY; hour += 1) {
      const on = row[hour] === '1';
      if (on && start === null) start = hour;
      if (!on && start !== null) {
        windows.push({ day, startHour: start, endHour: hour });
        start = null;
      }
    }
    if (start !== null) windows.push({ day, startHour: start, endHour: HOURS_PER_DAY });
  });
  return windows;
}

export function formatScheduleWindow(window: ScheduleWindow): string {
  const pad = (h: number) => `${String(h % 24).padStart(2, '0')}:00`;
  const end = window.endHour === HOURS_PER_DAY ? '24:00' : pad(window.endHour);
  return `${DAY_SHORT_NAMES[window.day]} ${pad(window.startHour)}–${end}`;
}

export function formatSchedule(schedule: WeeklySchedule): string {
  const windows = describeSchedule(schedule);
  if (windows.length === 0) return 'Never (on-demand only)';
  if (isScheduleFull(schedule)) return 'Always';
  return windows.map(formatScheduleWindow).join(', ');
}
