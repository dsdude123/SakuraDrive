import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { TreemapNode } from '@sakuradrive/shared';
import { Treemap, colourGroups, tileColour, truncate } from './Treemap.js';

const nodes: TreemapNode[] = [
  {
    id: 'media',
    name: 'Media',
    value: 800,
    kind: 'directory',
    depth: 0,
    parentId: null,
    x: 0,
    y: 0,
    width: 400,
    height: 300,
    meta: { relPath: 'Media', fileCount: 120, duplicationLevel: 2 },
  },
  {
    id: 'tiny',
    name: 'tiny.txt',
    value: 10,
    kind: 'file',
    depth: 1,
    parentId: 'media',
    x: 0,
    y: 0,
    width: 12,
    height: 8,
    meta: { relPath: 'Media/tiny.txt' },
  },
];

describe('Treemap', () => {
  it('renders one rectangle per node', () => {
    const { container } = render(<Treemap nodes={nodes} width={400} height={300} />);
    expect(container.querySelectorAll('rect')).toHaveLength(2);
  });

  it('labels rectangles that are large enough to read', () => {
    render(<Treemap nodes={nodes} width={400} height={300} />);
    expect(screen.getByText('Media')).toBeInTheDocument();
    // The 12x8 rectangle is far too small for a legible label.
    expect(screen.queryByText('tiny.txt')).not.toBeInTheDocument();
  });

  it('describes each tile in a tooltip', () => {
    const { container } = render(<Treemap nodes={nodes} width={400} height={300} />);
    const title = container.querySelector('title');
    expect(title?.textContent).toContain('Media');
    expect(title?.textContent).toContain('120 files');
    expect(title?.textContent).toContain('2x duplicated');
  });

  it('opens a directory when its rectangle is clicked', async () => {
    const onOpen = vi.fn();
    const { container } = render(<Treemap nodes={nodes} width={400} height={300} onOpen={onOpen} />);
    await userEvent.click(container.querySelectorAll('rect')[0]!);
    expect(onOpen).toHaveBeenCalledWith('Media');
  });

  it('does not try to open a file', async () => {
    const onOpen = vi.fn();
    const { container } = render(<Treemap nodes={nodes} width={400} height={300} onOpen={onOpen} />);
    await userEvent.click(container.querySelectorAll('rect')[1]!);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('does not try to open the synthetic "smaller items" tile', async () => {
    const onOpen = vi.fn();
    const collapsed: TreemapNode[] = [
      { ...nodes[0]!, id: 'other', name: '(40 smaller items)', meta: { relPath: 'Media', collapsed: true } },
    ];
    const { container } = render(<Treemap nodes={collapsed} width={400} height={300} onOpen={onOpen} />);
    await userEvent.click(container.querySelector('rect')!);
    expect(onOpen).not.toHaveBeenCalled();
  });
});

describe('tileColour', () => {
  it('gives each folder its own hue from the validated palette', () => {
    expect(tileColour(1, 0, false)).toBe('var(--viz-1)');
    expect(tileColour(3, 0, false)).toBe('var(--viz-3)');
    expect(tileColour(1, 0, false)).not.toBe(tileColour(2, 0, false));
  });

  // At depth 0 the tiles are biggest and identity matters most, so the hue has to be
  // exactly the colour that was validated -- not a mix of it.
  it('uses the palette colour unmixed at the top level', () => {
    expect(tileColour(2, 0, false)).toBe('var(--viz-2)');
  });

  it('recedes with depth, but only so far', () => {
    const shallow = tileColour(1, 1, false);
    const deep = tileColour(1, 9, false);
    expect(shallow).toContain('color-mix');
    expect(shallow).not.toBe(deep);
    // Capped, or a deep tree fades into the background entirely.
    expect(Number(/(\d+)%\)/.exec(deep)![1])).toBeLessThanOrEqual(46);
  });

  it('brightens on hover without changing hue', () => {
    const hovered = tileColour(1, 0, true);
    expect(hovered).not.toBe(tileColour(1, 0, false));
    expect(hovered).toContain('var(--viz-1)');
  });

  it('falls back to the neutral rather than inventing a ninth hue', () => {
    expect(tileColour(0, 0, false)).toBe('var(--viz-other)');
  });
});

describe('colourGroups', () => {
  const node = (id: string, relPath: string, depth: number, parentId: string | null = null): TreemapNode => ({
    id,
    name: relPath.split('/').pop()!,
    value: 100,
    kind: 'directory',
    depth,
    parentId,
    x: 0,
    y: 0,
    width: 10,
    height: 10,
    meta: { relPath },
  });

  it('gives each top-level folder its own slot, in order', () => {
    const groups = colourGroups([node('a', 'Media', 0), node('b', 'Backups', 0)]);
    expect(groups.get('a')).toBe(1);
    expect(groups.get('b')).toBe(2);
  });

  // The point of colouring by ancestor: a branch reads as a branch.
  it('gives a whole branch the colour of its top-level folder', () => {
    const groups = colourGroups([
      node('a', 'Media', 0),
      node('a2', 'Media/Movies', 1, 'a'),
      node('a3', 'Media/Movies/4K', 2, 'a2'),
      node('b', 'Backups', 0),
      node('b2', 'Backups/db', 1, 'b'),
    ]);
    expect(groups.get('a2')).toBe(groups.get('a'));
    expect(groups.get('a3')).toBe(groups.get('a'));
    expect(groups.get('b2')).toBe(groups.get('b'));
    expect(groups.get('b2')).not.toBe(groups.get('a'));
  });

  /**
   * A ninth hue is never generated. Fourteen slightly different purples is exactly the
   * map this replaced.
   */
  it('folds a ninth top-level folder into the neutral', () => {
    const tops = Array.from({ length: 10 }, (_unused, index) =>
      node(`t${index}`, `Folder${index}`, 0),
    );
    const groups = colourGroups(tops);
    expect(groups.get('t7')).toBe(8);
    expect(groups.get('t8')).toBe(0);
    expect(groups.get('t9')).toBe(0);
  });

  it('gives children of an overflowed folder the neutral too', () => {
    const tops = Array.from({ length: 9 }, (_unused, index) =>
      node(`t${index}`, `Folder${index}`, 0),
    );
    const groups = colourGroups([...tops, node('child', 'Folder8/inner', 1, 't8')]);
    expect(groups.get('child')).toBe(0);
  });

  // A hue invented for an orphan would collide with a real folder's.
  it('gives the neutral to a node whose parent is not in the response', () => {
    const groups = colourGroups([node('orphan', 'Missing/deep', 2, 'not-here')]);
    expect(groups.get('orphan')).toBe(0);
  });
});

describe('truncate', () => {
  it('leaves short text alone and ellipsises long text', () => {
    expect(truncate('Media', 10)).toBe('Media');
    expect(truncate('A very long directory name', 8)).toBe('A very …');
    expect(truncate('anything', 0)).toBe('');
  });
});
