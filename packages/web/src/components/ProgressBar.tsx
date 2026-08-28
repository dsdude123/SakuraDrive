import { formatBytes, formatCount, type WorkflowProgress } from '@sakuradrive/shared';

/**
 * Progress for a running workflow.
 *
 * A catalog scan does not know its total until it has walked the tree, so the bar
 * falls back to an indeterminate animation rather than pretending to know a percentage.
 */
export function ProgressBar({
  progress,
  indeterminate,
}: {
  progress: WorkflowProgress;
  indeterminate?: boolean;
}): JSX.Element {
  const total = progress.total ?? 0;
  const known = total > 0 && !indeterminate;
  const percent = known ? Math.min(100, Math.round((progress.done / total) * 100)) : 0;

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
              {formatCount(progress.done)} / {formatCount(total)} {progress.unit} · {percent}%
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
