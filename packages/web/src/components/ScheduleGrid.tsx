import { useCallback, useEffect, useRef, useState } from 'react';
import {
  DAY_SHORT_NAMES,
  HOURS_PER_DAY,
  isHourEnabled,
  normalizeSchedule,
  setRange,
  zonedParts,
  type WeeklySchedule,
} from '@sakuradrive/shared';

export interface ScheduleGridProps {
  value: WeeklySchedule;
  onChange: (next: string[]) => void;
  /** Used to outline the hour that is current in the operator's timezone. */
  timezone?: string;
  disabled?: boolean;
}

/**
 * The 7x24 hour painter.
 *
 * Click a cell to toggle it, or drag to paint a block; whichever value the first cell
 * takes is applied to the whole drag, which is how every calendar-style grid behaves
 * and means an accidental drag over a mixed area cannot scramble it. The header row
 * and the day labels are also buttons, so a whole hour or a whole day is one click —
 * and everything is reachable from the keyboard.
 */
export function ScheduleGrid({
  value,
  onChange,
  timezone = 'UTC',
  disabled = false,
}: ScheduleGridProps): JSX.Element {
  const grid = normalizeSchedule(value);
  const [dragging, setDragging] = useState<{ target: boolean } | null>(null);
  const touched = useRef<Set<string>>(new Set());

  // A drag that ends outside the grid must still finish cleanly.
  useEffect(() => {
    const stop = () => {
      setDragging(null);
      touched.current.clear();
    };
    window.addEventListener('pointerup', stop);
    window.addEventListener('pointercancel', stop);
    return () => {
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', stop);
    };
  }, []);

  const now = zonedParts(new Date(), timezone);

  const apply = useCallback(
    (day: number, hour: number, target: boolean) => {
      const key = `${day}:${hour}`;
      if (touched.current.has(key)) return;
      touched.current.add(key);
      onChange(setRange(grid, [day], [hour], target));
    },
    [grid, onChange],
  );

  const startDrag = (day: number, hour: number) => {
    if (disabled) return;
    const target = !isHourEnabled(grid, day, hour);
    touched.current.clear();
    setDragging({ target });
    apply(day, hour, target);
  };

  const enterCell = (day: number, hour: number) => {
    if (!dragging || disabled) return;
    apply(day, hour, dragging.target);
  };

  const toggleColumn = (hour: number) => {
    if (disabled) return;
    const allOn = grid.every((_, day) => isHourEnabled(grid, day, hour));
    onChange(setRange(grid, [0, 1, 2, 3, 4, 5, 6], [hour], !allOn));
  };

  const toggleRow = (day: number) => {
    if (disabled) return;
    const allOn = [...Array(HOURS_PER_DAY).keys()].every((hour) => isHourEnabled(grid, day, hour));
    onChange(setRange(grid, [day], [...Array(HOURS_PER_DAY).keys()], !allOn));
  };

  return (
    <div
      className="schedule"
      role="grid"
      aria-label="Weekly heavy I/O schedule"
      aria-disabled={disabled}
    >
      <div className="corner" />
      {Array.from({ length: HOURS_PER_DAY }, (_, hour) => (
        <button
          key={`h${hour}`}
          type="button"
          className="hour-label ghost"
          style={{ padding: 0, minWidth: 0 }}
          onClick={() => toggleColumn(hour)}
          title={`Toggle ${String(hour).padStart(2, '0')}:00 on every day`}
        >
          {hour % 3 === 0 ? String(hour).padStart(2, '0') : ''}
        </button>
      ))}

      {DAY_SHORT_NAMES.map((dayName, day) => (
        <RowFragment
          key={dayName}
          day={day}
          dayName={dayName}
          grid={grid}
          now={now}
          disabled={disabled}
          onToggleRow={toggleRow}
          onStartDrag={startDrag}
          onEnterCell={enterCell}
        />
      ))}
    </div>
  );
}

function RowFragment({
  day,
  dayName,
  grid,
  now,
  disabled,
  onToggleRow,
  onStartDrag,
  onEnterCell,
}: {
  day: number;
  dayName: string;
  grid: string[];
  now: { day: number; hour: number };
  disabled: boolean;
  onToggleRow: (day: number) => void;
  onStartDrag: (day: number, hour: number) => void;
  onEnterCell: (day: number, hour: number) => void;
}): JSX.Element {
  return (
    <>
      <button
        type="button"
        className="day-label ghost"
        style={{ padding: 0, minWidth: 0 }}
        onClick={() => onToggleRow(day)}
        title={`Toggle all of ${dayName}`}
      >
        {dayName}
      </button>
      {Array.from({ length: HOURS_PER_DAY }, (_, hour) => {
        const on = grid[day]![hour] === '1';
        const isNow = now.day === day && now.hour === hour;
        return (
          <button
            key={`${day}-${hour}`}
            type="button"
            role="gridcell"
            aria-selected={on}
            aria-label={`${dayName} ${String(hour).padStart(2, '0')}:00 ${on ? 'enabled' : 'disabled'}`}
            className={`cell${on ? ' on' : ''}${isNow ? ' now' : ''}`}
            disabled={disabled}
            onPointerDown={(event) => {
              event.preventDefault();
              onStartDrag(day, hour);
            }}
            onPointerEnter={() => onEnterCell(day, hour)}
            title={`${dayName} ${String(hour).padStart(2, '0')}:00–${String((hour + 1) % 24).padStart(2, '0')}:00`}
          />
        );
      })}
    </>
  );
}
