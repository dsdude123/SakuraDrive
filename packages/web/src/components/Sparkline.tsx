/**
 * Minimal SVG line chart.
 *
 * Hand-rolled rather than pulling in a charting library: the only charts here are
 * "has this SMART counter moved" and "is latency creeping up", both of which are a
 * single series over time.
 */
export function Sparkline({
  points,
  width = 220,
  height = 44,
  color = 'var(--accent)',
  fill = true,
  label,
}: {
  points: Array<number | null>;
  width?: number;
  height?: number;
  color?: string;
  fill?: boolean;
  label?: string;
}): JSX.Element {
  const values = points.filter((value): value is number => value !== null && Number.isFinite(value));
  if (values.length === 0) {
    return (
      <svg className="sparkline" width={width} height={height} role="img" aria-label={label ?? 'No data'}>
        <text x={4} y={height / 2 + 4} fontSize="11" fill="var(--text-faint)">
          no data
        </text>
      </svg>
    );
  }

  const min = Math.min(...values);
  const max = Math.max(...values);
  // A flat series should sit in the middle rather than dividing by zero.
  const span = max - min || 1;
  const stepX = values.length > 1 ? width / (values.length - 1) : 0;
  const padding = 3;
  const usable = height - padding * 2;

  const coordinates = values.map((value, index) => {
    const x = values.length === 1 ? width / 2 : index * stepX;
    const y = padding + usable - ((value - min) / span) * usable;
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  });

  const line = `M${coordinates.join(' L')}`;
  const area = `${line} L${width},${height} L0,${height} Z`;

  return (
    <svg
      className="sparkline"
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={label ?? `${values.length} points, ${min} to ${max}`}
    >
      {fill && <path d={area} fill={color} opacity={0.12} />}
      <path d={line} fill="none" stroke={color} strokeWidth={1.6} strokeLinejoin="round" />
    </svg>
  );
}
