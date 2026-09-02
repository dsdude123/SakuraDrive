import { formatBytes, formatCount, type WorkflowProgress } from '@sakuradrive/shared';

/**
 * Progress for a running workflow.
 *
 * A first catalog scan does not know its total and cannot: the walk discovers
 * directories as it goes, so any ratio it could compute is against a total that does
 * not exist yet. It gets an indeterminate bar and the counts that are real -- files,
 * bytes, rate -- rather than a percentage that means nothing.
 *
 * A rescan does have something to compare against: what the root held last time. That
 * is an estimate, so it is shown as one, and it is allowed to run past 100% rather
 * than being clamped into a lie when a root has grown.
 */
export function ProgressBar({
  progress,
  indeterminate,
  estimated,
}: {
  progress: WorkflowProgress;
  indeterminate?: boolean;
  /** The total is a prior measurement, not a known quantity. Shown with a `~`. */
  estimated?: boolean;
}): JSX.Element {
  const total = progress.total ?? 0;
  const known = total > 0 && !indeterminate;
  const rawPercent = known ? Math.round((progress.done / total) * 100) : 0;
  // The bar cannot overflow its track, but the number is allowed to: "112%" says the
  // root grew since the last scan, which is true and worth knowing. Clamping it to 100
  // would show a finished-looking bar for a scan with plenty left to do.
  const percent = Math.min(100, rawPercent);

  return (
    <div>
      <div
        className={known ? 'progress' : 'progress indeterminate'}
        role="progressbar"
        aria-valuenow={known ? percent : undefined}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={progress.message || 'Progress'}
      >
        <span style={{ width: `${percent}%` }} />
      </div>
      <div className="progress-meta">
        <span className="message" title={progress.message}>
          {progress.message || ' '}
        </span>
        <span className="nowrap">
          {known ? (
            <>
              {formatCount(progress.done)} / {estimated ? '~' : ''}
              {formatCount(total)} {progress.unit} · {estimated ? '~' : ''}
              {rawPercent}%
            </>
          ) : (
            <>
              {formatCount(progress.done)} {progress.unit}
            </>
          )}
          {progress.bytes ? ` · ${formatBytes(progress.bytes)}` : ''}
        </span>
      </div>
    </div>
  );
}
