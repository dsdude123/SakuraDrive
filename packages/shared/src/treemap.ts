/**
 * Squarified treemap layout — the WizTree-style storage view.
 *
 * Implemented here rather than pulled in as a dependency so the server can render
 * the same rectangles in exports and the UI can lay out without shipping d3.
 * Reference: Bruls, Huizing & van Wijk, "Squarified Treemaps" (2000).
 */

export interface TreemapInput {
  id: string;
  name: string;
  /** Must be >= 0. Zero-value nodes are dropped from the layout. */
  value: number;
  kind?: 'directory' | 'file';
  children?: TreemapInput[];
  meta?: Record<string, unknown>;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface TreemapNode extends Rect {
  id: string;
  name: string;
  value: number;
  kind: 'directory' | 'file';
  depth: number;
  parentId: string | null;
  meta?: Record<string, unknown>;
}

export interface TreemapOptions {
  width: number;
  height: number;
  /** How many levels of children to lay out. 1 = only the top level. */
  maxDepth?: number;
  /** Gap between sibling rectangles, in the same units as width/height. */
  padding?: number;
  /** Extra space reserved at the top of a directory for its label. */
  headerHeight?: number;
  /** Rectangles smaller than this in either dimension are not subdivided further. */
  minSubdivideSize?: number;
}

const worstRatio = (row: number[], length: number, scale: number): number => {
  if (row.length === 0 || length <= 0) return Number.POSITIVE_INFINITY;
  let sum = 0;
  let min = Number.POSITIVE_INFINITY;
  let max = 0;
  for (const value of row) {
    const scaled = value * scale;
    sum += scaled;
    if (scaled < min) min = scaled;
    if (scaled > max) max = scaled;
  }
  if (sum <= 0) return Number.POSITIVE_INFINITY;
  const side = length;
  return Math.max((side * side * max) / (sum * sum), (sum * sum) / (side * side * min));
};

interface Placement<T> {
  item: T;
  rect: Rect;
}

/**
 * Lay a single level of values into `rect`, largest first. Values need not be
 * pre-scaled; they are normalized to the area of `rect`.
 */
export function squarify<T>(
  items: readonly T[],
  valueOf: (item: T) => number,
  rect: Rect,
): Array<Placement<T>> {
  const positive = items.filter((item) => valueOf(item) > 0);
  const total = positive.reduce((sum, item) => sum + valueOf(item), 0);
  if (positive.length === 0 || total <= 0 || rect.width <= 0 || rect.height <= 0) return [];

  const area = rect.width * rect.height;
  const scale = area / total;
  const sorted = [...positive].sort((a, b) => valueOf(b) - valueOf(a));

  const out: Array<Placement<T>> = [];
  let free: Rect = { ...rect };
  let index = 0;

  while (index < sorted.length) {
    const shortSide = Math.min(free.width, free.height);
    const row: T[] = [];
    const rowValues: number[] = [];
    let bestRatio = Number.POSITIVE_INFINITY;

    while (index < sorted.length) {
      const candidate = sorted[index]!;
      const candidateValues = [...rowValues, valueOf(candidate)];
      const ratio = worstRatio(candidateValues, shortSide, scale);
      if (row.length > 0 && ratio > bestRatio) break;
      row.push(candidate);
      rowValues.push(valueOf(candidate));
      bestRatio = ratio;
      index += 1;
    }

    const rowArea = rowValues.reduce((sum, value) => sum + value, 0) * scale;
    const horizontal = free.width >= free.height;
    const rowThickness = shortSide > 0 ? rowArea / shortSide : 0;

    let offset = 0;
    for (let i = 0; i < row.length; i += 1) {
      const itemArea = rowValues[i]! * scale;
      const length = rowThickness > 0 ? itemArea / rowThickness : 0;
      const placedRect: Rect = horizontal
        ? { x: free.x, y: free.y + offset, width: rowThickness, height: length }
        : { x: free.x + offset, y: free.y, width: length, height: rowThickness };
      out.push({ item: row[i]!, rect: placedRect });
      offset += length;
    }

    free = horizontal
      ? { x: free.x + rowThickness, y: free.y, width: free.width - rowThickness, height: free.height }
      : { x: free.x, y: free.y + rowThickness, width: free.width, height: free.height - rowThickness };

    if (free.width <= 0.0001 || free.height <= 0.0001) break;
  }

  return out;
}

function insetRect(rect: Rect, padding: number, headerHeight: number): Rect {
  return {
    x: rect.x + padding,
    y: rect.y + padding + headerHeight,
    width: Math.max(0, rect.width - padding * 2),
    height: Math.max(0, rect.height - padding * 2 - headerHeight),
  };
}

/** Lay out a hierarchy into flat, absolutely positioned rectangles ready for SVG. */
export function layoutTreemap(root: TreemapInput, options: TreemapOptions): TreemapNode[] {
  const {
    width,
    height,
    maxDepth = 3,
    padding = 1,
    headerHeight = 0,
    minSubdivideSize = 24,
  } = options;

  const out: TreemapNode[] = [];
  if (width <= 0 || height <= 0) return out;

  const walk = (
    nodes: readonly TreemapInput[],
    rect: Rect,
    depth: number,
    parentId: string | null,
  ): void => {
    if (depth > maxDepth) return;
    const placements = squarify(nodes, (node) => node.value, rect);
    for (const { item, rect: placed } of placements) {
      const kind = item.kind ?? (item.children && item.children.length > 0 ? 'directory' : 'file');
      out.push({
        id: item.id,
        name: item.name,
        value: item.value,
        kind,
        depth,
        parentId,
        x: placed.x,
        y: placed.y,
        width: placed.width,
        height: placed.height,
        ...(item.meta ? { meta: item.meta } : {}),
      });
      const children = item.children ?? [];
      if (
        children.length > 0 &&
        depth < maxDepth &&
        placed.width >= minSubdivideSize &&
        placed.height >= minSubdivideSize + headerHeight
      ) {
        walk(children, insetRect(placed, padding, headerHeight), depth + 1, item.id);
      }
    }
  };

  walk(root.children ?? [root], { x: 0, y: 0, width, height }, 0, null);
  return out;
}

/** Sum leaf values into every ancestor; used before layout when only leaves carry sizes. */
export function rollUp(node: TreemapInput): number {
  if (!node.children || node.children.length === 0) return node.value;
  const total = node.children.reduce((sum, child) => sum + rollUp(child), 0);
  node.value = Math.max(node.value, total);
  return node.value;
}

/**
 * Collapse small children into a synthetic "(N smaller items)" node so a directory with
 * 40k files renders as a handful of readable rectangles instead of invisible slivers.
 */
export function collapseSmall(
  nodes: readonly TreemapInput[],
  options: { maxNodes?: number; minShare?: number } = {},
): TreemapInput[] {
  const { maxNodes = 60, minShare = 0.002 } = options;
  const total = nodes.reduce((sum, node) => sum + node.value, 0);
  if (total <= 0) return [];
  const sorted = [...nodes].sort((a, b) => b.value - a.value);
  const kept: TreemapInput[] = [];
  const collapsed: TreemapInput[] = [];
  for (const node of sorted) {
    if (kept.length < maxNodes && node.value / total >= minShare) kept.push(node);
    else collapsed.push(node);
  }
  if (collapsed.length > 0) {
    const value = collapsed.reduce((sum, node) => sum + node.value, 0);
    if (value > 0) {
      kept.push({
        id: `${kept[0]?.id ?? 'root'}::__other__`,
        name: `(${collapsed.length} smaller items)`,
        value,
        kind: 'directory',
        meta: { collapsed: true, count: collapsed.length },
      });
    }
  }
  return kept;
}
