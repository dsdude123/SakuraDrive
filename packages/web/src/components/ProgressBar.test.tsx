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

  it('uses the message as the accessible name', () => {
    render(<ProgressBar progress={{ done: 0, total: 1, unit: 'files', message: 'Scanning HDD Pool' }} />);
    expect(screen.getByRole('progressbar')).toHaveAccessibleName('Scanning HDD Pool');
  });
});
