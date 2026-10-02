import { beforeEach, describe, expect, it } from 'vitest';
import { openTestDatabase, type Db } from './index.js';
import { CURSOR_COLUMN, ROWID_CURSOR, readInBatches } from './paging.js';

let db: Db;

beforeEach(() => {
  db = openTestDatabase();
  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT NOT NULL, keep INTEGER NOT NULL)');
  const insert = db.prepare('INSERT INTO t (name, keep) VALUES (?, ?)');
  for (let i = 1; i <= 25; i += 1) insert.run(`row-${i}`, i % 2);
});

const SQL = `SELECT *, ${ROWID_CURSOR} FROM t WHERE rowid > ? ORDER BY rowid LIMIT ?`;

describe('readInBatches', () => {
  it('reads every row exactly once, whatever the batch size', () => {
    for (const batchSize of [1, 2, 3, 7, 24, 25, 26, 1000]) {
      const seen: string[] = [];
      for (const batch of readInBatches<{ name: string }>(db, SQL, [], batchSize)) {
        for (const row of batch) seen.push(row.name);
      }
      expect({ batchSize, count: seen.length, unique: new Set(seen).size }).toEqual({
        batchSize,
        count: 25,
        unique: 25,
      });
    }
  });

  it('strips the cursor, so rows are exactly the table\'s own columns', () => {
    const [first] = [...readInBatches<Record<string, unknown>>(db, SQL, [], 5)];
    expect(Object.keys(first![0]!)).toEqual(['id', 'name', 'keep']);
    expect(first![0]).not.toHaveProperty(CURSOR_COLUMN);
  });

  it('passes the caller\'s parameters before the cursor and the limit', () => {
    const seen: string[] = [];
    const sql = `SELECT *, ${ROWID_CURSOR} FROM t WHERE keep = ? AND rowid > ? ORDER BY rowid LIMIT ?`;
    for (const batch of readInBatches<{ name: string }>(db, sql, [1], 4)) {
      for (const row of batch) seen.push(row.name);
    }
    expect(seen).toEqual(['row-1', 'row-3', 'row-5', 'row-7', 'row-9', 'row-11', 'row-13', 'row-15', 'row-17', 'row-19', 'row-21', 'row-23', 'row-25']);
  });

  it('yields nothing for an empty table', () => {
    db.exec('DELETE FROM t');
    expect([...readInBatches(db, SQL, [], 10)]).toEqual([]);
  });

  /**
   * The whole reason this exists: the connection has to be writable between pages, or
   * a progress update mid-read throws "This database connection is busy executing a
   * query" and takes the workflow down with it.
   */
  it('leaves the connection free to write between batches', () => {
    db.exec('CREATE TABLE progress (id INTEGER PRIMARY KEY, done INTEGER NOT NULL)');
    db.prepare('INSERT INTO progress (id, done) VALUES (1, 0)').run();
    const update = db.prepare('UPDATE progress SET done = ? WHERE id = 1');

    let done = 0;
    for (const batch of readInBatches<{ name: string }>(db, SQL, [], 5)) {
      done += batch.length;
      expect(() => update.run(done)).not.toThrow();
    }
    expect(db.prepare('SELECT done FROM progress WHERE id = 1').get()).toEqual({ done: 25 });
  });

  it('refuses a query that forgot to select its cursor, rather than looping forever', () => {
    expect(() => [
      ...readInBatches(db, 'SELECT * FROM t WHERE rowid > ? ORDER BY rowid LIMIT ?', [], 5),
    ]).toThrow(/must select its cursor/);
  });

  it('does not re-read rows added behind the cursor while it is paging', () => {
    // A row inserted during the read gets a higher rowid, so it is picked up once and
    // never duplicates one already seen.
    const seen: string[] = [];
    let added = false;
    for (const batch of readInBatches<{ name: string }>(db, SQL, [], 10)) {
      for (const row of batch) seen.push(row.name);
      if (!added) {
        db.prepare('INSERT INTO t (name, keep) VALUES (?, ?)').run('late', 1);
        added = true;
      }
    }
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toContain('late');
  });
});
