import { useState } from 'react';
import { formatBytes, formatCount, type TreemapNode } from '@sakuradrive/shared';

export interface TreemapProps {
  nodes: TreemapNode[];
  width: number;
  height: number;
  onOpen?: (relPath: string) => void;
  /** Highlighted when the pointer is over a rectangle. */
  onHover?: (node: TreemapNode | null) => void;
}

/**
 * WizTree-style storage map.
 *
 * Rectangles are laid out server-side (see `/api/storage/treemap`) so the browser
 * only receives what it draws. Colour encodes depth so nesting reads at a glance,
 * with duplicated content tinted towards the accent because a 2x-duplicated folder
 * really is costing twice its logical size.
 */
export function Treemap({ nodes, width, height, onOpen, onHover }: TreemapProps): JSX.Element {
  const [hovered, setHovered] = useState<string | null>(null);

  return (
    <svg
      className="treemap"
      viewBox={`0 0 ${width} ${height}`}
      width="100%"
      height={height}
      role="img"
      aria-label="Storage treemap"
      onPointerLeave={() => {
        setHovered(null);
        onHover?.(null);
      }}
    >
      {nodes.map((node) => {
        const meta = (node.meta ?? {}) as {
          relPath?: string;
          fileCount?: number;
          sizeBytes?: number;
          effectiveBytes?: number;
          duplicationLevel?: number | null;
          collapsed?: boolean;
        };
        const duplicated = (meta.duplicationLevel ?? 1) > 1;
        const showLabel = node.width > 54 && node.height > 22;
        const showSize = node.width > 88 && node.height > 34;

        return (
          <g key={`${node.id}-${node.depth}`}>
            <rect
              x={node.x}
              y={node.y}
              width={Math.max(0, node.width)}
              height={Math.max(0, node.height)}
              fill={tileColour(node.depth, node.kind, duplicated, hovered === node.id)}
              onPointerEnter={() => {
                setHovered(node.id);
                onHover?.(node);
              }}
              onClick={() => {
                if (node.kind === 'directory' && meta.relPath && !meta.collapsed) {
                  onOpen?.(meta.relPath);
                }
              }}
            >
              <title>
                {`${meta.relPath ?? node.name}\n${formatBytes(node.value)}${
                  meta.fileCount ? ` · ${formatCount(meta.fileCount)} files` : ''
                }${duplicated ? ` · ${meta.duplicationLevel}x duplicated` : ''}`}
              </title>
            </rect>
            {showLabel && (
              <text x={node.x + 6} y={node.y + 14} clipPath={`inset(0 0 0 0)`}>
                {truncate(node.name, Math.floor(node.width / 6.6))}
              </text>
            )}
            {showSize && (
              <text className="size" x={node.x + 6} y={node.y + 27}>
                {formatBytes(node.value)}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

/** Depth is the primary hue step; duplicated content leans pink. */
export function tileColour(
  depth: number,
  kind: 'directory' | 'file',
  duplicated: boolean,
  hovered: boolean,
): string {
  const base = duplicated ? 336 : 258;
  const hue = base + depth * 9;
  const saturation = duplicated ? 52 : 34;
  const lightness = (kind === 'file' ? 30 : 38) - depth * 4 + (hovered ? 12 : 0);
  return `hsl(${hue} ${saturation}% ${Math.max(14, lightness)}%)`;
}

export function truncate(text: string, maxChars: number): string {
  if (maxChars <= 1) return '';
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(1, maxChars - 1))}…`;
}
