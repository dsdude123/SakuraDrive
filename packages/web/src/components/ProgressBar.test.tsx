import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ProgressBar } from './ProgressBar.js';

describe('ProgressBar', () => {
  it('shows a percentage when the total is known', () => {
    render(
      <ProgressBar
        progress={{ done: 250, total: 1000, unit: 'files', message: 'Media/Movies/a.mkv' }}
      />,
    );
    const bar = screen.getByRole('progressbar');
    expect(bar).toHaveAttribute('aria-valuenow', '25');
    expect(screen.getByText(/250 \/ 1,000 files · 25%/)).toBeInTheDocument();
  });

  it('falls back to an indeterminate bar while the total is unknown', () => {
    render(<ProgressBar progress={{ done: 42, total: null, unit: 'directories', message: '' }} />);
    const bar = screen.getByRole('progressbar');
    expect(bar.className).toContain('indeterminate');
    expect(bar).not.toHaveAttribute('aria-valuenow');
    expect(screen.getByText(/42 directories/)).toBeInTheDocument();
  });

  it('never exceeds 100% when the total was underestimated', () => {
    render(<ProgressBar progress={{ done: 150, total: 100, unit: 'files', message: '' }} />);
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '100');
  });

  it('shows bytes processed when reported', () => {
    render(
      <ProgressBar
        progress={{ done: 1, total: 2, unit: 'files', message: '', bytes: 1024 * 1024 * 5 }}
      />,
    );
    expect(screen.getByText(/5\.0 MB/)).toBeInTheDocument();
  });

  /**
   * A first catalog scan cannot know its total: the walk discovers directories as it
   * goes. It used to divide by what it had found so far, which pinned the bar near
   * 100% from the first minute and told the operator nothing.
   */
  it('shows movement, not a percentage, when there is nothing to compare against', () => {
    render(
      <ProgressBar
        progress={{ done: 120_000, total: null, unit: 'files', message: '' }}
        indeterminate
      />,
    );
    expect(screen.getByRole('progressbar').className).toContain('indeterminate');
    expect(screen.queryByText(/%/)).not.toBeInTheDocument();
    expect(screen.getByText(/120,000 files/)).toBeInTheDocument();
  });

  // A rescan has a real basis: what the root held last time. It is an estimate, and
  // saying so is the difference between a useful number and a wrong one.
  it('marks a percentage against a prior measurement as an estimate', () => {
    render(
      <ProgressBar
        progress={{ done: 500, total: 1000, unit: 'files', message: '' }}
        estimated
      />,
    );
    expect(screen.getByText(/500 \/ ~1,000 files · ~50%/)).toBeInTheDocument();
  });

  /**
   * The bar cannot overflow its track, but the number is allowed to: "150%" says the
   * root grew since the last scan, which is true and worth knowing. Clamping the text
   * would show a finished-looking bar for a scan with plenty left to do.
   */
  it('lets an estimate run past 100% rather than claiming to be finished', () => {
    render(
      <ProgressBar
        progress={{ done: 1500, total: 1000, unit: 'files', message: '' }}
        estimated
      />,
    );
    expect(screen.getByText(/~150%/)).toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '100');
  });

  it('leaves a known total unmarked', () => {
    render(<ProgressBar progress={{ done: 1, total: 4, unit: 'files', message: '' }} />);
    expect(screen.getByText(/1 \/ 4 files · 25%/)).toBeInTheDocument();
  });

  it('uses the message as the accessible name', () => {
    render(<ProgressBar progress={{ done: 0, total: 1, unit: 'files', message: 'Scanning HDD Pool' }} />);
    expect(screen.getByRole('progressbar')).toHaveAccessibleName('Scanning HDD Pool');
  });
});
