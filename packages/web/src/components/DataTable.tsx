import { useMemo, useState, type ReactNode } from 'react';

/**
 * A table you can sort by clicking a column heading.
 *
 * Sorting is done on values the column declares, never on the rendered cell: `14.2 TB`,
 * `—` and `3 days ago` are text, and sorting text gives an order that looks arbitrary,
 * which is what the plain tables did. Each column says what it sorts on and the cell is
 * free to render that however it likes.
 */

/** What a column can sort on. `null` means "no value", which always sorts last. */
export type SortValue = string | number | boolean | null | undefined;

export type SortDirection = 'asc' | 'desc';

export interface DataColumn<T> {
  /** Stable id for the sort state, and the column's React key. */
  key: string;
  header: ReactNode;
  /** Right-aligns the column with tabular figures, and sorts it largest-first. */
  numeric?: boolean;
  /**
   * The value to sort this column on. Omit for a column of controls, which then gets
   * no sort button.
   */
  sort?: (row: T) => SortValue;
  /** The cell. Defaults to the sort value, which covers plain text columns. */
  cell?: (row: T) => ReactNode;
  /** Extra class on every cell in the column, e.g. `mono` or `path`. */
  className?: string;
  /**
   * The column holds buttons or inputs rather than data.
   *
   * Clicks in it stop at the cell, so pressing Resolve in a row that is itself clickable
   * does not also open the row.
   */
  controls?: boolean;
  /**
   * Which way this column sorts on its first click.
   *
   * Defaults to largest-first for numbers and A-to-Z for text, which is right for
   * sizes and names but wrong for a rank: a severity column whose worst value is the
   * highest number needs `desc`, or the first click buries the critical rows at the
   * bottom. Set it wherever the useful end of the column is not the default one.
   */
  defaultDirection?: SortDirection;
}

/** ISO timestamp to something sortable. Dates as text sort by their own punctuation. */
export function sortTime(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const parsed = Date.parse(iso);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * Compare two column values.
 *
 * Missing values sort last in *both* directions. Sorting by temperature to find the
 * hottest disk should not put the ones with no reading at the top: "unknown" is not a
 * high number, and the row you are looking for would be pushed off the bottom.
 */
export function compareValues(a: SortValue, b: SortValue, direction: SortDirection): number {
  const left = normalize(a);
  const right = normalize(b);
  if (left === null && right === null) return 0;
  if (left === null) return 1;
  if (right === null) return -1;

  let order: number;
  if (typeof left === 'number' && typeof right === 'number') {
    order = left - right;
  } else {
    // Numeric collation so DRIVEPOOL4 comes before DRIVEPOOL27 rather than after it --
    // plain text ordering compares the `2` against the `4` and is the single biggest
    // reason these lists looked unordered.
    order = String(left).localeCompare(String(right), undefined, {
      numeric: true,
      sensitivity: 'base',
    });
  }
  return direction === 'asc' ? order : -order;
}

/** Booleans sort false-first; blank text counts as missing, like the `—` it renders as. */
function normalize(value: SortValue): string | number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  return value.trim() === '' ? null : value;
}

/**
 * Order `rows` by one column.
 *
 * A copy, and a stable sort, so rows the column cannot tell apart keep the order the
 * server sent -- which is usually meaningful (newest first, or the pool's own order).
 */
export function sortRows<T>(
  rows: readonly T[],
  column: DataColumn<T> | undefined,
  direction: SortDirection,
): readonly T[] {
  if (!column?.sort) return rows;
  const value = column.sort;
  return [...rows].sort((a, b) => compareValues(value(a), value(b), direction));
}

/** Numbers read largest-first; names read A to Z; anything else says so itself. */
function defaultDirection<T>(column: DataColumn<T>): SortDirection {
  return column.defaultDirection ?? (column.numeric ? 'desc' : 'asc');
}

export function DataTable<T>({
  rows,
  columns,
  rowKey,
  initialSort,
  rowProps,
  onRowClick,
}: {
  rows: readonly T[];
  columns: ReadonlyArray<DataColumn<T>>;
  rowKey: (row: T, index: number) => string | number;
  /** Column to sort by before anyone clicks. Omit to show the server's order. */
  initialSort?: { key: string; direction?: SortDirection };
  /** Per-row attributes, for row styling and titles. */
  rowProps?: (row: T) => { className?: string; title?: string };
  /** Makes rows clickable. Columns marked `controls` swallow the click. */
  onRowClick?: (row: T) => void;
}): JSX.Element {
  const [sort, setSort] = useState<{ key: string; direction: SortDirection } | null>(() => {
    if (!initialSort) return null;
    const column = columns.find((candidate) => candidate.key === initialSort.key);
    if (!column) return null;
    return { key: initialSort.key, direction: initialSort.direction ?? defaultDirection(column) };
  });

  const active = sort ? columns.find((column) => column.key === sort.key) : undefined;
  const sorted = useMemo(
    () => sortRows(rows, active, sort?.direction ?? 'asc'),
    [rows, active, sort?.direction],
  );

  const toggle = (column: DataColumn<T>) => {
    setSort((current) =>
      current?.key === column.key
        ? { key: column.key, direction: current.direction === 'asc' ? 'desc' : 'asc' }
        : { key: column.key, direction: defaultDirection(column) },
    );
  };

  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            {columns.map((column) => {
              const isActive = sort?.key === column.key;
              return (
                <th
                  key={column.key}
                  className={column.numeric ? 'num' : undefined}
                  aria-sort={
                    isActive ? (sort!.direction === 'asc' ? 'ascending' : 'descending') : 'none'
                  }
                >
                  {column.sort ? (
                    <button
                      type="button"
                      className={isActive ? 'th-sort active' : 'th-sort'}
                      onClick={() => toggle(column)}
                    >
                      <span>{column.header}</span>
                      <span aria-hidden="true" className="th-arrow">
                        {isActive ? (sort!.direction === 'asc' ? '▲' : '▼') : '↕'}
                      </span>
                    </button>
                  ) : (
                    column.header
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {sorted.map((row, index) => {
            const extra = rowProps?.(row) ?? {};
            const className = [extra.className ?? '', onRowClick ? 'clickable' : '']
              .filter(Boolean)
              .join(' ');
            return (
              <tr
                key={rowKey(row, index)}
                title={extra.title}
                className={className || undefined}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
              >
                {columns.map((column) => (
                  <td
                    key={column.key}
                    className={[column.numeric ? 'num' : '', column.className ?? '']
                      .filter(Boolean)
                      .join(' ') || undefined}
                    onClick={column.controls ? (event) => event.stopPropagation() : undefined}
                  >
                    {column.cell ? column.cell(row) : renderValue(column.sort?.(row))}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function renderValue(value: SortValue): ReactNode {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  return String(value);
}
