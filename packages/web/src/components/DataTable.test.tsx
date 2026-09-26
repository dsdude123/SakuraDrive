import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DataTable, compareValues, sortRows, sortTime, type DataColumn } from './DataTable.js';

describe('compareValues', () => {
  it('orders numbers by size, not by their text', () => {
    expect(compareValues(9, 100, 'asc')).toBeLessThan(0);
    expect(compareValues(9, 100, 'desc')).toBeGreaterThan(0);
  });

  it('orders text naturally, so DRIVEPOOL4 comes before DRIVEPOOL27', () => {
    expect(compareValues('DRIVEPOOL4', 'DRIVEPOOL27', 'asc')).toBeLessThan(0);
  });

  it('ignores case', () => {
    expect(compareValues('apple', 'Apple', 'asc')).toBe(0);
  });

  /**
   * The point of sorting by temperature is to find the hottest disk. Putting the disks
   * with no reading at the top pushes the answer off the bottom of the table.
   */
  it('keeps missing values last whichever way the column points', () => {
    for (const direction of ['asc', 'desc'] as const) {
      expect(compareValues(null, 5, direction)).toBeGreaterThan(0);
      expect(compareValues(5, null, direction)).toBeLessThan(0);
      expect(compareValues(undefined, 'a', direction)).toBeGreaterThan(0);
      // Blank text renders as an em dash, so it counts as missing too.
      expect(compareValues('   ', 'a', direction)).toBeGreaterThan(0);
      expect(compareValues(Number.NaN, 1, direction)).toBeGreaterThan(0);
    }
  });

  it('treats two missing values as equal', () => {
    expect(compareValues(null, undefined, 'asc')).toBe(0);
  });

  it('sorts false before true', () => {
    expect(compareValues(false, true, 'asc')).toBeLessThan(0);
  });
});

describe('sortTime', () => {
  it('turns timestamps into something comparable', () => {
    expect(sortTime('2026-01-02T00:00:00Z')).toBeGreaterThan(sortTime('2026-01-01T00:00:00Z')!);
  });

  it('treats a missing or unparseable timestamp as missing', () => {
    expect(sortTime(null)).toBeNull();
    expect(sortTime('')).toBeNull();
    expect(sortTime('never')).toBeNull();
  });
});

interface Row {
  name: string;
  size: number | null;
}
const columns: Array<DataColumn<Row>> = [
  { key: 'name', header: 'Name', sort: (row) => row.name },
  { key: 'size', header: 'Size', numeric: true, sort: (row) => row.size },
  { key: 'actions', header: '' },
];
const rows: Row[] = [
  { name: 'beta', size: 10 },
  { name: 'alpha', size: null },
  { name: 'gamma', size: 200 },
];

describe('sortRows', () => {
  it('leaves the order alone for a column that declares no value', () => {
    expect(sortRows(rows, columns[2], 'asc')).toBe(rows);
  });

  it('does not mutate the rows it was given', () => {
    const before = [...rows];
    sortRows(rows, columns[0], 'desc');
    expect(rows).toEqual(before);
  });

  it('is stable, so rows it cannot tell apart keep the server order', () => {
    const tied: Row[] = [
      { name: 'first', size: 5 },
      { name: 'second', size: 5 },
      { name: 'third', size: 5 },
    ];
    expect(sortRows(tied, columns[1], 'desc').map((row) => row.name)).toEqual([
      'first',
      'second',
      'third',
    ]);
  });
});

const names = () =>
  screen.getAllByRole('row').slice(1).map((row) => row.querySelectorAll('td')[0]!.textContent);

describe('DataTable', () => {
  it('shows the server order until a heading is clicked', () => {
    render(<DataTable rows={rows} columns={columns} rowKey={(row) => row.name} />);
    expect(names()).toEqual(['beta', 'alpha', 'gamma']);
  });

  it('sorts by a column when its heading is clicked, and reverses on a second click', async () => {
    render(<DataTable rows={rows} columns={columns} rowKey={(row) => row.name} />);
    await userEvent.click(screen.getByRole('button', { name: /Name/ }));
    expect(names()).toEqual(['alpha', 'beta', 'gamma']);
    await userEvent.click(screen.getByRole('button', { name: /Name/ }));
    expect(names()).toEqual(['gamma', 'beta', 'alpha']);
  });

  it('starts a numeric column at largest-first, because that is the question being asked', async () => {
    render(<DataTable rows={rows} columns={columns} rowKey={(row) => row.name} />);
    await userEvent.click(screen.getByRole('button', { name: /Size/ }));
    expect(names()).toEqual(['gamma', 'beta', 'alpha']);
  });

  /**
   * A rank column's worst value is its highest number, so the plain text default of
   * A-to-Z puts the rows that matter at the bottom -- which is how the alerts table
   * shipped its first click showing info first and critical last.
   */
  it('lets a column choose which way it sorts first', async () => {
    const ranked: Array<DataColumn<Row>> = [
      columns[0]!,
      { key: 'rank', header: 'Rank', defaultDirection: 'desc', sort: (row) => row.size },
    ];
    render(<DataTable rows={rows} columns={ranked} rowKey={(row) => row.name} />);
    await userEvent.click(screen.getByRole('button', { name: /Rank/ }));
    expect(names()).toEqual(['gamma', 'beta', 'alpha']);
  });

  it('still toggles from whichever direction the column starts in', async () => {
    const ranked: Array<DataColumn<Row>> = [
      columns[0]!,
      { key: 'rank', header: 'Rank', defaultDirection: 'desc', sort: (row) => row.size },
    ];
    render(<DataTable rows={rows} columns={ranked} rowKey={(row) => row.name} />);
    await userEvent.click(screen.getByRole('button', { name: /Rank/ }));
    await userEvent.click(screen.getByRole('button', { name: /Rank/ }));
    expect(names()).toEqual(['beta', 'gamma', 'alpha']);
  });

  it('gives a column of controls no sort button', () => {
    render(<DataTable rows={rows} columns={columns} rowKey={(row) => row.name} />);
    expect(screen.getAllByRole('button')).toHaveLength(2);
  });

  it('tells assistive technology which column is sorted, and which way', async () => {
    render(<DataTable rows={rows} columns={columns} rowKey={(row) => row.name} />);
    const header = screen.getByRole('columnheader', { name: /Name/ });
    expect(header).toHaveAttribute('aria-sort', 'none');
    await userEvent.click(screen.getByRole('button', { name: /Name/ }));
    expect(header).toHaveAttribute('aria-sort', 'ascending');
    await userEvent.click(screen.getByRole('button', { name: /Name/ }));
    expect(header).toHaveAttribute('aria-sort', 'descending');
  });

  it('honours an initial sort', () => {
    render(
      <DataTable
        rows={rows}
        columns={columns}
        rowKey={(row) => row.name}
        initialSort={{ key: 'size', direction: 'asc' }}
      />,
    );
    // Ascending by size: 10, 200, then the row with no size at all.
    expect(names()).toEqual(['beta', 'gamma', 'alpha']);
  });

  it('ignores an initial sort naming a column that is not there', () => {
    render(
      <DataTable rows={rows} columns={columns} rowKey={(row) => row.name} initialSort={{ key: 'nope' }} />,
    );
    expect(names()).toEqual(['beta', 'alpha', 'gamma']);
  });

  it('renders an em dash for a missing value rather than nothing at all', () => {
    render(
      <DataTable
        rows={[{ name: 'alpha', size: null }]}
        columns={[{ key: 'size', header: 'Size', numeric: true, sort: (row) => row.size }]}
        rowKey={(row) => row.name}
      />,
    );
    expect(screen.getAllByRole('cell')[0]!.textContent).toBe('—');
  });

  it('makes rows clickable when asked, and reports which row', async () => {
    const clicked: string[] = [];
    render(
      <DataTable
        rows={rows}
        columns={columns}
        rowKey={(row) => row.name}
        onRowClick={(row) => clicked.push(row.name)}
      />,
    );
    await userEvent.click(screen.getAllByRole('row')[1]!);
    expect(clicked).toEqual(['beta']);
    expect(screen.getAllByRole('row')[1]).toHaveClass('clickable');
  });

  /**
   * Pressing a button in a clickable row must not also trigger the row: on the alerts
   * page that would resolve the alert and open its detail modal in one click.
   */
  it('keeps a click on a controls column from reaching the row', async () => {
    const clicked: string[] = [];
    const pressed: string[] = [];
    render(
      <DataTable
        rows={rows}
        columns={[
          columns[0]!,
          {
            key: 'actions',
            header: '',
            controls: true,
            cell: (row) => <button onClick={() => pressed.push(row.name)}>Resolve</button>,
          },
        ]}
        rowKey={(row) => row.name}
        onRowClick={(row) => clicked.push(row.name)}
      />,
    );
    await userEvent.click(screen.getAllByRole('button', { name: 'Resolve' })[0]!);
    expect(pressed).toEqual(['beta']);
    expect(clicked).toEqual([]);
  });

  it('re-sorts when the rows change underneath it', () => {
    const { rerender } = render(
      <DataTable rows={rows} columns={columns} rowKey={(row) => row.name} initialSort={{ key: 'name' }} />,
    );
    expect(names()).toEqual(['alpha', 'beta', 'gamma']);
    // These tables poll, so a refresh must not drop the sort the operator chose.
    rerender(
      <DataTable
        rows={[...rows, { name: 'aaa', size: 1 }]}
        columns={columns}
        rowKey={(row) => row.name}
        initialSort={{ key: 'name' }}
      />,
    );
    expect(names()).toEqual(['aaa', 'alpha', 'beta', 'gamma']);
  });

  it('numbers stay right-aligned once the header is a button', () => {
    render(<DataTable rows={rows} columns={columns} rowKey={(row) => row.name} />);
    expect(screen.getByRole('columnheader', { name: /Size/ })).toHaveClass('num');
  });
});
