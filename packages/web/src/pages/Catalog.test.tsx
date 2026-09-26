import { describe, expect, it } from 'vitest';
import { chooseCatalogRoot } from './Catalog.js';

/**
 * Which root the catalog opens on.
 *
 * This looked like a cosmetic default and was not. A DrivePool pool is catalogued one
 * member disk at a time, so "the first root" is one disk of however many the pool has —
 * and the page renders a part exactly as it renders the pool. Opening on a part meant
 * the catalog appeared to hold a fortieth of the files actually in it, which reads as
 * the scanner having lost the data rather than as the page showing a filtered view.
 */
describe('chooseCatalogRoot', () => {
  const pool = { id: 'pool:d304fce8' };
  const parts = [{ id: 'part-b85cff66f1' }, { id: 'part-371424c594' }];

  it('opens on the pool rather than on one of its member disks', () => {
    expect(chooseCatalogRoot([pool], parts, '')).toBe(pool);
  });

  it('honours an explicit choice of a member disk', () => {
    expect(chooseCatalogRoot([pool], parts, 'part-371424c594')).toBe(parts[1]);
  });

  it('honours an explicit choice of the pool', () => {
    expect(chooseCatalogRoot([pool], parts, 'pool:d304fce8')).toBe(pool);
  });

  // A root that was removed from settings while it was selected.
  it('falls back to the pool when the chosen root has gone', () => {
    expect(chooseCatalogRoot([pool], parts, 'part-deleted')).toBe(pool);
  });

  // Roots that are not pool members at all — a plain folder root, say.
  it('falls back to the first root when there is no pool', () => {
    expect(chooseCatalogRoot([], parts, '')).toBe(parts[0]);
  });

  it('has nothing to show when nothing is configured', () => {
    expect(chooseCatalogRoot([], [], '')).toBeUndefined();
  });
});
