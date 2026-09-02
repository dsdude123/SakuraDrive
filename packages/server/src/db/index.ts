import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { Database as Db } from 'better-sqlite3';
import { applyMigrations } from './migrations.js';

export type { Db };

export interface OpenDatabaseOptions {
  /** Path to the SQLite file, or `:memory:` in tests. */
  file: string;
  readonly?: boolean;
}

/**
 * Open the database with pragmas tuned for this workload: one writer (the workflow
 * engine) inserting hundreds of thousands of catalog rows while the UI reads.
 */
export function openDatabase({ file, readonly = false }: OpenDatabaseOptions): Db {
  if (file !== ':memory:') {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }
  const db = new Database(file, { readonly });

  if (!readonly) {
    // WAL lets the UI read while a scan writes; NORMAL sync is the standard
    // durability/throughput trade-off for WAL and is safe against process crashes.
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 15000');
    // 64 MiB page cache and a generous mmap keep catalog scans off the disk.
    db.pragma('cache_size = -65536');
    db.pragma('mmap_size = 268435456');
    db.pragma('temp_store = MEMORY');
    /*
      Give the query planner statistics.

      Without them SQLite has to guess, and on the catalog it guessed badly: the pool
      rollup grouped by path across every member disk, and with no stats it chose the
      per-root index and built a temporary B-tree over the whole result -- which cannot
      be paged, so the process was held for as long as it took. With stats it walks the
      path_key index in order and the same work streams in bounded chunks.

      `optimize` only analyses what has changed enough to matter, so it is cheap here
      and worth repeating after a scan has poured in a few million rows.
    */
    db.pragma('optimize');

    /*
      Fold the write-ahead log back into the database.

      WAL only shrinks when a checkpoint completes, and a checkpoint cannot complete
      while anything is reading. A server that is being polled while it writes can go a
      very long time without one, and every read then has to search a log that keeps
      growing -- which makes everything slower, including signing in, and survives a
      restart because the file is still there. Startup is the one moment nothing else
      is using the database, so it is the one moment this always works.
    */
    const walPages = (db.pragma('wal_checkpoint(TRUNCATE)', { simple: false }) as unknown[])[0];
    void walPages;
    applyMigrations(db);
  }
  return db;
}

/** In-memory database with the schema applied. Used throughout the test suite. */
export function openTestDatabase(): Db {
  return openDatabase({ file: ':memory:' });
}

/**
 * Run `fn` inside a transaction, returning its result. better-sqlite3 transactions are
 * synchronous, so callers must not await inside `fn`.
 */
export function transact<T>(db: Db, fn: () => T): T {
  return db.transaction(fn)();
}

/** ISO-8601 timestamp in UTC — the format every `*_at` column stores. */
export function nowIso(): string {
  return new Date().toISOString();
}

export function toJson(value: unknown): string {
  return JSON.stringify(value ?? null);
}

export function fromJson<T>(value: string | null | undefined, fallback: T): T {
  if (value === null || value === undefined || value === '') return fallback;
  try {
    const parsed = JSON.parse(value) as T;
    return parsed === null ? fallback : parsed;
  } catch {
    return fallback;
  }
}

/** SQLite stores booleans as integers. */
export function toDbBool(value: boolean | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  return value ? 1 : 0;
}

export function fromDbBool(value: number | null | undefined): boolean | null {
  if (value === null || value === undefined) return null;
  return value !== 0;
}
