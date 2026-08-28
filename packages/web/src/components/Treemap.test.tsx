import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { TreemapNode } from '@sakuradrive/shared';
import { Treemap, tileColour, truncate } from './Treemap.js';

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
  it('tints duplicated content differently from plain content', () => {
    expect(tileColour(0, 'directory', true, false)).not.toBe(tileColour(0, 'directory', false, false));
  });

  it('darkens with depth but never past black', () => {
    const deep = tileColour(9, 'file', false, false);
    expect(deep).toMatch(/hsl\(/);
    expect(Number(/(\d+)%\)$/.exec(deep)![1])).toBeGreaterThanOrEqual(14);
  });

  it('brightens on hover', () => {
    expect(tileColour(0, 'directory', false, true)).not.toBe(tileColour(0, 'directory', false, false));
  });
});

describe('truncate', () => {
  it('leaves short text alone and ellipsises long text', () => {
    expect(truncate('Media', 10)).toBe('Media');
    expect(truncate('A very long directory name', 8)).toBe('A very …');
    expect(truncate('anything', 0)).toBe('');
  });
});
