import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { migrateDataDir } from './migrate-data-dir.js';
import { createSilentLogger } from '../logger.js';
import { createTempDir } from '../test/helpers.js';

const temps: Array<{ dispose: () => void }> = [];
const tempDir = (): string => {
  const temp = createTempDir('sakuradrive-move-');
  temps.push(temp);
  return temp.path;
};

afterEach(() => {
  for (const temp of temps.splice(0)) temp.dispose();
});

const run = (dataDir: string, legacyDir: string) =>
  migrateDataDir({
    dataDir,
    databasePath: path.join(dataDir, 'sakuradrive.sqlite'),
    legacyDir,
    logger: createSilentLogger(),
  });

/**
 * Moving the database off a slow mount is worth minutes of copying, but not worth
 * asking someone driving Portainer to run three docker commands by hand. The container
 * does it once, on the first start where the new location is empty.
 */
describe('copying a previous data directory across', () => {
  it('copies the database and everything beside it', () => {
    const from = tempDir();
    const to = tempDir();
    fs.writeFileSync(path.join(from, 'sakuradrive.sqlite'), 'the catalog');
    fs.writeFileSync(path.join(from, 'sakuradrive.sqlite-wal'), 'the log');
    fs.mkdirSync(path.join(from, 'exports'));
    fs.writeFileSync(path.join(from, 'exports', 'bundle.json'), '{}');

    const result = run(to, from);
    expect(result.migrated).toBe(true);
    expect(fs.readFileSync(path.join(to, 'sakuradrive.sqlite'), 'utf8')).toBe('the catalog');
    expect(fs.readFileSync(path.join(to, 'sakuradrive.sqlite-wal'), 'utf8')).toBe('the log');
    expect(fs.readFileSync(path.join(to, 'exports', 'bundle.json'), 'utf8')).toBe('{}');
  });

  // The whole point: it must be a no-op on every start after the first.
  it('does nothing once the destination has a database', () => {
    const from = tempDir();
    const to = tempDir();
    fs.writeFileSync(path.join(from, 'sakuradrive.sqlite'), 'the old one');
    fs.writeFileSync(path.join(to, 'sakuradrive.sqlite'), 'the one in use');

    const result = run(to, from);
    expect(result.migrated).toBe(false);
    expect(result.reason).toMatch(/already has a database/);
    // And emphatically did not overwrite it.
    expect(fs.readFileSync(path.join(to, 'sakuradrive.sqlite'), 'utf8')).toBe('the one in use');
  });

  it('never modifies the directory it copied from', () => {
    const from = tempDir();
    const to = tempDir();
    fs.writeFileSync(path.join(from, 'sakuradrive.sqlite'), 'the catalog');

    run(to, from);
    expect(fs.readFileSync(path.join(from, 'sakuradrive.sqlite'), 'utf8')).toBe('the catalog');
  });

  // The cache is rebuilt on demand and can be larger than the catalog.
  it('leaves the Kopia cache behind', () => {
    const from = tempDir();
    const to = tempDir();
    fs.writeFileSync(path.join(from, 'sakuradrive.sqlite'), 'db');
    fs.mkdirSync(path.join(from, 'kopia-cache'));
    fs.writeFileSync(path.join(from, 'kopia-cache', 'blob'), 'x'.repeat(1000));

    run(to, from);
    expect(fs.existsSync(path.join(to, 'kopia-cache'))).toBe(false);
    expect(fs.existsSync(path.join(to, 'sakuradrive.sqlite'))).toBe(true);
  });

  it.each([
    ['no previous directory configured', () => ''],
    ['a previous directory that does not exist', () => '/nonexistent/data'],
  ])('does nothing given %s', (_label, legacy) => {
    const to = tempDir();
    expect(run(to, legacy()).migrated).toBe(false);
    expect(fs.existsSync(path.join(to, 'sakuradrive.sqlite'))).toBe(false);
  });

  it('does nothing when the previous directory holds no database', () => {
    const from = tempDir();
    const to = tempDir();
    fs.writeFileSync(path.join(from, 'notes.txt'), 'unrelated');
    expect(run(to, from).migrated).toBe(false);
    expect(fs.existsSync(path.join(to, 'notes.txt'))).toBe(false);
  });

  it('does nothing when told to copy a directory onto itself', () => {
    const both = tempDir();
    fs.writeFileSync(path.join(both, 'sakuradrive.sqlite'), 'db');
    expect(run(both, both).migrated).toBe(false);
  });

  /**
   * A half-copied database is worse than none: it would be opened as though it were
   * whole. The partial file is removed so the next start tries again.
   */
  it('leaves no database behind when the copy fails part-way', () => {
    const from = tempDir();
    const to = tempDir();
    fs.writeFileSync(path.join(from, 'sakuradrive.sqlite'), 'the catalog');
    fs.mkdirSync(path.join(from, 'exports'));
    fs.writeFileSync(path.join(from, 'exports', 'bundle.json'), '{}');

    // Make the destination unwritable part-way through by putting a directory where
    // the copy wants to write a file.
    fs.mkdirSync(path.join(to, 'exports'));
    fs.mkdirSync(path.join(to, 'exports', 'bundle.json'));

    expect(() => run(to, from)).toThrow();
    expect(fs.existsSync(path.join(to, 'sakuradrive.sqlite'))).toBe(false);
  });
});
