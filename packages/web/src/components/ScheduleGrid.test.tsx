import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { emptySchedule, enabledHoursPerWeek, fullSchedule, isHourEnabled } from '@sakuradrive/shared';
import { ScheduleGrid } from './ScheduleGrid.js';

function cell(day: string, hour: number) {
  return screen.getByRole('gridcell', {
    name: new RegExp(`^${day} ${String(hour).padStart(2, '0')}:00`),
  });
}

describe('ScheduleGrid', () => {
  it('renders a cell for every hour of every day', () => {
    render(<ScheduleGrid value={emptySchedule()} onChange={() => {}} />);
    expect(screen.getAllByRole('gridcell')).toHaveLength(7 * 24);
  });

  it('marks enabled hours as selected', () => {
    render(<ScheduleGrid value={fullSchedule()} onChange={() => {}} />);
    expect(cell('Mon', 3)).toHaveAttribute('aria-selected', 'true');
  });

  it('turns a cell on when clicked', async () => {
    const onChange = vi.fn();
    render(<ScheduleGrid value={emptySchedule()} onChange={onChange} />);
    await userEvent.click(cell('Tue', 5));

    expect(onChange).toHaveBeenCalledOnce();
    const next = onChange.mock.calls[0]![0] as string[];
    expect(isHourEnabled(next, 2, 5)).toBe(true);
    expect(enabledHoursPerWeek(next)).toBe(1);
  });

  it('turns a cell off when it was already on', async () => {
    const onChange = vi.fn();
    render(<ScheduleGrid value={fullSchedule()} onChange={onChange} />);
    await userEvent.click(cell('Wed', 12));
    const next = onChange.mock.calls[0]![0] as string[];
    expect(isHourEnabled(next, 3, 12)).toBe(false);
  });

  it('toggles an entire hour column from the header', async () => {
    const onChange = vi.fn();
    render(<ScheduleGrid value={emptySchedule()} onChange={onChange} />);
    await userEvent.click(screen.getByTitle('Toggle 03:00 on every day'));
    const next = onChange.mock.calls[0]![0] as string[];
    expect(enabledHoursPerWeek(next)).toBe(7);
    expect(isHourEnabled(next, 0, 3)).toBe(true);
    expect(isHourEnabled(next, 6, 3)).toBe(true);
  });

  it('toggles an entire day from the day label', async () => {
    const onChange = vi.fn();
    render(<ScheduleGrid value={emptySchedule()} onChange={onChange} />);
    await userEvent.click(screen.getByTitle('Toggle all of Fri'));
    const next = onChange.mock.calls[0]![0] as string[];
    expect(enabledHoursPerWeek(next)).toBe(24);
    expect(isHourEnabled(next, 5, 0)).toBe(true);
  });

  it('clears a fully enabled day rather than re-enabling it', async () => {
    const onChange = vi.fn();
    render(<ScheduleGrid value={fullSchedule()} onChange={onChange} />);
    await userEvent.click(screen.getByTitle('Toggle all of Sun'));
    const next = onChange.mock.calls[0]![0] as string[];
    expect(enabledHoursPerWeek(next)).toBe(7 * 24 - 24);
  });

  it('does not emit changes while disabled', async () => {
    const onChange = vi.fn();
    render(<ScheduleGrid value={emptySchedule()} onChange={onChange} disabled />);
    await userEvent.click(cell('Mon', 1));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('outlines the current hour in the configured timezone', () => {
    vi.setSystemTime(new Date('2024-03-05T09:30:00Z')); // Tue 01:30 in Los Angeles
    render(<ScheduleGrid value={emptySchedule()} onChange={() => {}} timezone="America/Los_Angeles" />);
    expect(cell('Tue', 1).className).toContain('now');
    expect(cell('Tue', 9).className).not.toContain('now');
    vi.useRealTimers();
  });

  it('labels each cell for screen readers', () => {
    render(<ScheduleGrid value={emptySchedule()} onChange={() => {}} />);
    expect(cell('Sat', 23)).toHaveAccessibleName('Sat 23:00 disabled');
  });
});
