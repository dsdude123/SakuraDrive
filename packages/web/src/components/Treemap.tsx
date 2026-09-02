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
 * Rectangles are laid out server-side (see `/api/storage/treemap`) so the browser only
 * receives what it draws.
 *
 * Colour identifies which top-level folder a tile belongs to, in a fixed order by size.
 * It used to encode depth, which the nesting geometry already shows -- so the whole map
 * came out as shades of one purple and told you nothing about what you were looking at.
 * Depth is now lightness within the folder's own hue, so a branch reads as a branch.
 */
export function Treemap({ nodes, width, height, onOpen, onHover }: TreemapProps): JSX.Element {
  const [hovered, setHovered] = useState<string | null>(null);
  const groups = colourGroups(nodes);

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
              fill={tileColour(groups.get(node.id) ?? 0, node.depth, hovered === node.id)}
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

/**
 * Which folder is which colour, spelled out.
 *
 * Identity is never colour alone: a map with eight hues and no key asks the reader to
 * remember which blue was which, and a colourblind reader to guess. The tiles carry
 * labels too, but only where they are big enough to fit one.
 */
export function TreemapLegend({
  nodes,
  onOpen,
}: {
  nodes: TreemapNode[];
  onOpen?: (relPath: string) => void;
}): JSX.Element | null {
  const groups = colourGroups(nodes);
  const tops = nodes.filter((node) => node.parentId === null);
  if (tops.length < 2) return null;

  return (
    <div className="viz-legend">
      {tops.map((node) => {
        const relPath = (node.meta as { relPath?: string } | undefined)?.relPath;
        const slot = groups.get(node.id) ?? 0;
        return (
          <button
            key={node.id}
            type="button"
            onClick={() => {
              if (node.kind === 'directory' && relPath) onOpen?.(relPath);
            }}
            title={`${node.name} · ${formatBytes(node.value)}`}
          >
            <span className="swatch" style={{ background: tileColour(slot, 0, false) }} />
            {node.name}
          </button>
        );
      })}
    </div>
  );
}

/** How many hues there are before a folder folds into the neutral. */
export const VIZ_SLOTS = 8;

/**
 * Which colour slot each tile belongs to.
 *
 * A tile takes the slot of the top-level folder it sits under, so a whole branch shares
 * a hue. Slots are handed out in fixed order to the largest top-level entries; a ninth
 * is never a generated hue, it folds into the neutral -- by then the tile is a sliver
 * anyway, and inventing hues is how a map ends up with fourteen indistinguishable
 * purples.
 */
export function colourGroups(nodes: TreemapNode[]): Map<string, number> {
  const slots = new Map<string, number>();
  let nextSlot = 0;

  // parentId rather than the path: it is what the layout actually links nodes by, so a
  // collapsed "Other" node or a name containing a slash cannot mislead it.
  for (const node of nodes) {
    if (node.parentId === null) {
      // Slot 0 is the neutral, so the palette is 1-based.
      slots.set(node.id, nextSlot < VIZ_SLOTS ? ++nextSlot : NEUTRAL_SLOT);
      continue;
    }
    // The layout emits a parent before its children, so its slot is already known. A
    // node whose parent is not in this response inherits the neutral rather than
    // starting a new hue that would collide with a real folder's.
    slots.set(node.id, slots.get(node.parentId) ?? NEUTRAL_SLOT);
  }

  return slots;
}

const NEUTRAL_SLOT = 0;

/**
 * A tile's fill: its folder's hue, mixed towards the surface as it nests deeper.
 *
 * Mixing rather than a second palette keeps the hue exactly as validated at depth 0,
 * where the tiles are biggest and identity matters most, and lets deeper tiles recede
 * without needing eight more colours that would have to be validated too.
 */
export function tileColour(slot: number, depth: number, hovered: boolean): string {
  const hue = slot === NEUTRAL_SLOT ? 'var(--viz-other)' : `var(--viz-${slot})`;
  // Capped, so a deep tree does not fade into the background entirely.
  const recede = Math.min(46, depth * 15);
  const base =
    recede === 0 ? hue : `color-mix(in oklab, ${hue}, var(--viz-recede) ${recede}%)`;
  if (!hovered) return base;
  // Hover brightens rather than shifting hue, so the tile stays identifiably itself.
  return `color-mix(in oklab, ${base}, white 22%)`;
}

export function truncate(text: string, maxChars: number): string {
  if (maxChars <= 1) return '';
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(1, maxChars - 1))}…`;
}
