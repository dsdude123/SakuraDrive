import type { WorkflowId } from '@sakuradrive/shared';
import type { Db } from '../db/index.js';

/** When did this workflow last finish successfully? Used by self-scheduling workflows. */
export function lastCompletedAt(db: Db, workflowId: WorkflowId): string | null {
  const row = db
    .prepare<[string], { finished_at: string | null }>(
      `SELECT finished_at FROM workflow_runs
        WHERE workflow_id = ? AND state = 'completed' ORDER BY id DESC LIMIT 1`,
    )
    .get(workflowId);
  return row?.finished_at ?? null;
}

export function hoursSince(iso: string | null): number {
  if (!iso) return Number.POSITIVE_INFINITY;
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return Number.POSITIVE_INFINITY;
  return (Date.now() - parsed) / 3_600_000;
}

/**
 * Is it time for a daily job that should run at `timeOfDay` on the given weekdays?
 *
 * True once the local time has passed the configured hour and nothing has run yet
 * today, so a service that was down at 04:30 still takes its backup when it comes up.
 */
export function isDailyJobDue(
  now: Date,
  timeZone: string,
  timeOfDay: string,
  daysOfWeek: readonly number[],
  lastRunAt: string | null,
): boolean {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: safeTimeZone(timeZone),
    weekday: 'short',
    hour: 'numeric',
    minute: 'numeric',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour12: false,
  }).formatToParts(now);
  const lookup = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? '';

  const weekdayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const day = weekdayNames.findIndex(
    (name) => name.toLowerCase() === lookup('weekday').toLowerCase(),
  );
  if (day === -1 || !daysOfWeek.includes(day)) return false;

  const [hourText, minuteText] = timeOfDay.split(':');
  const targetHour = Number(hourText);
  const targetMinute = Number(minuteText ?? '0');
  if (!Number.isFinite(targetHour)) return false;

  const hour = Number(lookup('hour')) % 24;
  const minute = Number(lookup('minute'));
  if (hour < targetHour || (hour === targetHour && minute < targetMinute)) return false;

  if (!lastRunAt) return true;
  // "Already ran today" is judged in the operator's timezone, not UTC.
  const today = `${lookup('year')}-${lookup('month')}-${lookup('day')}`;
  const lastLocalDate = localDate(new Date(lastRunAt), timeZone);
  return lastLocalDate !== today;
}

function localDate(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: safeTimeZone(timeZone),
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const lookup = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? '';
  return `${lookup('year')}-${lookup('month')}-${lookup('day')}`;
}

function safeTimeZone(timeZone: string): string {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return timeZone;
  } catch {
    return 'UTC';
  }
}
