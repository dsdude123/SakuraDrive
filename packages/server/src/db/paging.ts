import type { Db } from './index.js';

/**
 * Read a query's rows in batches, leaving the connection free between them.
 *
 * better-sqlite3 refuses to run a *write* while a statement is iterating — it throws
 * "This database connection is busy executing a query". Reads are allowed, which is
 * what makes the rule easy to break by accident: a loop over `.iterate()` that reads a
 * lookup table works fine, and then one day it also writes something and stops.
 *
 * Holding the cursor across an `await` is worse again. An async generator feeding a
 * stream suspends at every `yield`, so the statement stays open for as long as the
 * whole pipeline takes, and *nothing else in the process* can write for that entire
 * time — not an agent report, not an alert, not another workflow's progress.
 *
 * Batching closes the statement between pages, so the only window where writes are
 * refused is the microseconds a single page takes to read.
 *
 * The statement must end with `… AND rowid > ? ORDER BY rowid LIMIT ?` and select the
 * cursor as `__cursor`; `rowidCursor()` builds that clause so call sites do not have to
 * remember the shape. Paged on rowid rather than OFFSET deliberately: OFFSET re-walks
 * the table for every page, which turns one pass into a quadratic one, and a row
 * deleted mid-read shifts every later page up and silently skips a row.
 */
export const CURSOR_COLUMN = '__cursor';

/** The cursor expression to select, named so `readInBatches` can find and strip it. */
export const ROWID_CURSOR = `rowid AS ${CURSOR_COLUMN}`;

export function* readInBatches<T extends Record<string, unknown>>(
  db: Db,
  sql: string,
  params: readonly unknown[] = [],
  batchSize = 1_000,
): Generator<T[], void> {
  const statement = db.prepare(sql);
  let cursor = 0;
  for (;;) {
    const rows = statement.all(...params, cursor, batchSize) as Array<Record<string, unknown>>;
    if (rows.length === 0) return;

    const last = rows[rows.length - 1]![CURSOR_COLUMN];
    if (typeof last !== 'number') {
      // Without this the cursor would stay undefined, the next page would repeat the
      // first, and the caller would read the same rows until it ran out of memory.
      throw new Error(
        `readInBatches: the query must select its cursor as \`${ROWID_CURSOR}\`, got ${JSON.stringify(last)}`,
      );
    }
    cursor = last;
    for (const row of rows) delete row[CURSOR_COLUMN];

    yield rows as T[];
    if (rows.length < batchSize) return;
  }
}
