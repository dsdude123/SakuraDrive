import { describe, expect, it } from 'vitest';
import { collapseSmall, layoutTreemap, rollUp, squarify, type TreemapInput } from './treemap.js';

const RECT = { x: 0, y: 0, width: 600, height: 400 };

describe('squarify', () => {
  it('fills the rectangle exactly', () => {
    const items = [{ v: 6 }, { v: 6 }, { v: 4 }, { v: 3 }, { v: 2 }, { v: 2 }, { v: 1 }];
    const placements = squarify(items, (item) => item.v, RECT);
    const area = placements.reduce((sum, p) => sum + p.rect.width * p.rect.height, 0);
    expect(area).toBeCloseTo(RECT.width * RECT.height, 3);
  });

  it('produces rectangles proportional to their values', () => {
    const items = [{ v: 3 }, { v: 1 }];
    const placements = squarify(items, (item) => item.v, RECT);
    const [big, small] = placements;
    expect(big!.rect.width * big!.rect.height).toBeCloseTo(3 * small!.rect.width * small!.rect.height, 3);
  });

  it('keeps rectangles inside the bounds', () => {
    const items = Array.from({ length: 25 }, (_, i) => ({ v: (i + 1) * 3 }));
    for (const { rect } of squarify(items, (item) => item.v, RECT)) {
      expect(rect.x).toBeGreaterThanOrEqual(-1e-6);
      expect(rect.y).toBeGreaterThanOrEqual(-1e-6);
      expect(rect.x + rect.width).toBeLessThanOrEqual(RECT.width + 1e-6);
      expect(rect.y + rect.height).toBeLessThanOrEqual(RECT.height + 1e-6);
    }
  });

  it('produces reasonably square rectangles, which is the point of the algorithm', () => {
    const items = Array.from({ length: 12 }, () => ({ v: 1 }));
    const ratios = squarify(items, (item) => item.v, { x: 0, y: 0, width: 400, height: 400 }).map(
      ({ rect }) => Math.max(rect.width / rect.height, rect.height / rect.width),
    );
    expect(Math.max(...ratios)).toBeLessThan(3);
  });

  it('drops zero and negative values instead of emitting degenerate rectangles', () => {
    const placements = squarify([{ v: 5 }, { v: 0 }, { v: -2 }], (item) => item.v, RECT);
    expect(placements).toHaveLength(1);
  });

  it('returns nothing for an empty list or a zero-sized rectangle', () => {
    expect(squarify([], () => 1, RECT)).toEqual([]);
    expect(squarify([{ v: 1 }], (i) => i.v, { x: 0, y: 0, width: 0, height: 10 })).toEqual([]);
  });

  it('orders placements largest first', () => {
    const values = squarify([{ v: 1 }, { v: 9 }, { v: 4 }], (i) => i.v, RECT).map((p) => p.item.v);
    expect(values).toEqual([9, 4, 1]);
  });
});

describe('layoutTreemap', () => {
  const tree: TreemapInput = {
    id: 'root',
    name: 'root',
    value: 100,
    children: [
      {
        id: 'media',
        name: 'Media',
        value: 80,
        children: [
          { id: 'movies', name: 'Movies', value: 50, kind: 'file' },
          { id: 'music', name: 'Music', value: 30, kind: 'file' },
        ],
      },
      { id: 'backups', name: 'Backups', value: 20, kind: 'file' },
    ],
  };

  it('lays out children of the root at depth 0', () => {
    const nodes = layoutTreemap(tree, { width: 600, height: 400, maxDepth: 0 });
    expect(nodes.map((n) => n.id).sort()).toEqual(['backups', 'media']);
    expect(nodes.every((n) => n.depth === 0)).toBe(true);
  });

  it('descends into children up to maxDepth', () => {
    const nodes = layoutTreemap(tree, { width: 600, height: 400, maxDepth: 1 });
    const movies = nodes.find((n) => n.id === 'movies');
    expect(movies).toBeDefined();
    expect(movies!.depth).toBe(1);
    expect(movies!.parentId).toBe('media');
  });

  it('nests children inside their parent rectangle', () => {
    const nodes = layoutTreemap(tree, { width: 600, height: 400, maxDepth: 1, padding: 2 });
    const media = nodes.find((n) => n.id === 'media')!;
    for (const child of nodes.filter((n) => n.parentId === 'media')) {
      expect(child.x).toBeGreaterThanOrEqual(media.x - 1e-6);
      expect(child.y).toBeGreaterThanOrEqual(media.y - 1e-6);
      expect(child.x + child.width).toBeLessThanOrEqual(media.x + media.width + 1e-6);
      expect(child.y + child.height).toBeLessThanOrEqual(media.y + media.height + 1e-6);
    }
  });

  it('stops subdividing rectangles that are too small to read', () => {
    const nodes = layoutTreemap(tree, {
      width: 600,
      height: 400,
      maxDepth: 3,
      minSubdivideSize: 10_000,
    });
    expect(nodes.every((n) => n.depth === 0)).toBe(true);
  });

  it('infers node kind from the presence of children', () => {
    const nodes = layoutTreemap(tree, { width: 600, height: 400, maxDepth: 1 });
    expect(nodes.find((n) => n.id === 'media')!.kind).toBe('directory');
    expect(nodes.find((n) => n.id === 'backups')!.kind).toBe('file');
  });

  it('returns nothing for a zero-sized viewport', () => {
    expect(layoutTreemap(tree, { width: 0, height: 400 })).toEqual([]);
  });
});

describe('rollUp', () => {
  it('sums leaf values into ancestors', () => {
    const tree: TreemapInput = {
      id: 'root',
      name: 'root',
      value: 0,
      children: [
        {
          id: 'a',
          name: 'a',
          value: 0,
          children: [
            { id: 'a1', name: 'a1', value: 10 },
            { id: 'a2', name: 'a2', value: 5 },
          ],
        },
        { id: 'b', name: 'b', value: 3 },
      ],
    };
    expect(rollUp(tree)).toBe(18);
    expect(tree.children![0]!.value).toBe(15);
  });
});

describe('collapseSmall', () => {
  const nodes: TreemapInput[] = [
    { id: 'big', name: 'big', value: 900 },
    ...Array.from({ length: 200 }, (_, i) => ({ id: `s${i}`, name: `s${i}`, value: 1 })),
  ];

  it('folds slivers into a single synthetic node', () => {
    const collapsed = collapseSmall(nodes, { maxNodes: 10, minShare: 0.01 });
    expect(collapsed).toHaveLength(2);
    const other = collapsed.find((n) => n.name.includes('smaller items'))!;
    expect(other.value).toBe(200);
    expect(other.meta).toMatchObject({ collapsed: true, count: 200 });
  });

  it('preserves the total value', () => {
    const total = nodes.reduce((sum, n) => sum + n.value, 0);
    const collapsedTotal = collapseSmall(nodes, { maxNodes: 5, minShare: 0.05 }).reduce(
      (sum, n) => sum + n.value,
      0,
    );
    expect(collapsedTotal).toBe(total);
  });

  it('leaves a small list untouched', () => {
    const few: TreemapInput[] = [
      { id: 'a', name: 'a', value: 5 },
      { id: 'b', name: 'b', value: 5 },
    ];
    expect(collapseSmall(few)).toHaveLength(2);
  });

  it('returns nothing when everything is zero', () => {
    expect(collapseSmall([{ id: 'a', name: 'a', value: 0 }])).toEqual([]);
  });
});
