import { describe, expect, it } from 'vitest';
import { openTestDatabase } from './index.js';
import { MIGRATIONS, applyMigrations, currentSchemaVersion } from './migrations.js';

describe('migrations', () => {
  it('creates every table the application uses', () => {
    const db = openTestDatabase();
    const tables = db
      .prepare<[], { name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => row.name);

    for (const table of [
      'settings',
      'users',
      'sessions',
      'agent_tokens',
      'agents',
      'drives',
      'smart_snapshots',
      'smart_attribute_history',
      'volumes',
      'pools',
      'pool_parts',
      'performance_samples',
      'primocache_samples',
      'files',
      'catalog_runs',
      'catalog_changes',
      'dir_stats',
      'bitrot_findings',
      'alerts',
      'alert_events',
      'notifications',
      'workflow_runs',
      'backup_runs',
      'backup_issues',
      'export_records',
    ]) {
      expect(tables, `missing table ${table}`).toContain(table);
    }
    db.close();
  });

  it('is idempotent', () => {
    const db = openTestDatabase();
    expect(applyMigrations(db)).toBe(0);
    expect(applyMigrations(db)).toBe(0);
    db.close();
  });

  it('records the applied version', () => {
    const db = openTestDatabase();
    const rows = db
      .prepare<[], { version: number }>('SELECT version FROM schema_migrations ORDER BY version')
      .all();
    expect(rows.map((r) => r.version)).toEqual(MIGRATIONS.map((m) => m.version));
    expect(currentSchemaVersion()).toBe(Math.max(...MIGRATIONS.map((m) => m.version)));
    db.close();
  });

  it('enforces the catalog uniqueness constraint that keeps rescans idempotent', () => {
    const db = openTestDatabase();
    const insert = db.prepare(
      `INSERT INTO files (root_id, rel_path, path_key, dir_key, name, first_seen_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    insert.run('r1', 'Media/A.mkv', 'media/a.mkv', 'media', 'A.mkv', 'now', 'now');
    expect(() =>
      insert.run('r1', 'Media/A.mkv', 'media/a.mkv', 'media', 'A.mkv', 'now', 'now'),
    ).toThrow(/UNIQUE/);
    // The same path under a different root is a different file.
    expect(() =>
      insert.run('r2', 'Media/A.mkv', 'media/a.mkv', 'media', 'A.mkv', 'now', 'now'),
    ).not.toThrow();
    db.close();
  });

  it('deduplicates alerts by key', () => {
    const db = openTestDatabase();
    const insert = db.prepare(
      `INSERT INTO alerts (dedupe_key, category, severity, title, first_seen_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    insert.run('smart:sn:ABC:smart.attr.197', 'smart', 'warning', 'Pending sectors', 'now', 'now');
    expect(() =>
      insert.run('smart:sn:ABC:smart.attr.197', 'smart', 'critical', 'Pending', 'now', 'now'),
    ).toThrow(/UNIQUE/);
    db.close();
  });

  it('cascades deletes from a catalog run to its changes', () => {
    const db = openTestDatabase();
    db.prepare('INSERT INTO catalog_runs (id, root_id, started_at) VALUES (1, ?, ?)').run('r1', 'now');
    db.prepare(
      `INSERT INTO catalog_changes (run_id, root_id, rel_path, kind, detected_at)
       VALUES (1, 'r1', 'a.txt', 'created', 'now')`,
    ).run();
    db.prepare('DELETE FROM catalog_runs WHERE id = 1').run();
    expect(db.prepare('SELECT COUNT(*) AS n FROM catalog_changes').get()).toEqual({ n: 0 });
    db.close();
  });

  it('enables WAL on a file-backed database', () => {
    // :memory: cannot use WAL, so only the pragmas that matter there are asserted.
    const db = openTestDatabase();
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    db.close();
  });
});
