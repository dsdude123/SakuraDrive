import type { Database } from 'better-sqlite3';

/**
 * Forward-only schema migrations.
 *
 * Each entry runs once, inside a transaction, and the applied version is recorded in
 * `schema_migrations`. Never edit a migration that has shipped — add another one.
 */
export interface Migration {
  version: number;
  name: string;
  up: string;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'initial',
    up: `
    CREATE TABLE meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    -- Settings are one JSON document validated by the shared zod schema.
    CREATE TABLE settings (
      id         INTEGER PRIMARY KEY CHECK (id = 1),
      json       TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE users (
      id            INTEGER PRIMARY KEY,
      username      TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at    TEXT NOT NULL,
      last_login_at TEXT
    );

    CREATE TABLE sessions (
      id         TEXT PRIMARY KEY,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );
    CREATE INDEX sessions_expires ON sessions(expires_at);

    -- Bearer tokens for the Windows agent. Only the hash is stored.
    CREATE TABLE agent_tokens (
      id           INTEGER PRIMARY KEY,
      name         TEXT NOT NULL,
      token_hash   TEXT NOT NULL UNIQUE,
      prefix       TEXT NOT NULL,
      created_at   TEXT NOT NULL,
      last_used_at TEXT,
      revoked_at   TEXT
    );

    CREATE TABLE agents (
      id               INTEGER PRIMARY KEY,
      hostname         TEXT NOT NULL UNIQUE,
      agent_version    TEXT NOT NULL DEFAULT 'unknown',
      protocol_version INTEGER NOT NULL DEFAULT 1,
      first_seen_at    TEXT NOT NULL,
      last_report_at   TEXT,
      report_count     INTEGER NOT NULL DEFAULT 0,
      last_errors      TEXT NOT NULL DEFAULT '[]'
    );

    -- One row per physical disk, keyed by serial number where available so the
    -- identity survives a reboot renumbering the devices.
    CREATE TABLE drives (
      id                    INTEGER PRIMARY KEY,
      device_key            TEXT NOT NULL UNIQUE,
      device_id             TEXT,
      serial_number         TEXT,
      model                 TEXT,
      firmware              TEXT,
      size_bytes            INTEGER,
      media_type            TEXT,
      bus_type              TEXT,
      physical_location     TEXT,
      hostname              TEXT,
      labels                TEXT NOT NULL DEFAULT '[]',
      drive_letters         TEXT NOT NULL DEFAULT '[]',
      health_status         TEXT,
      operational_status    TEXT,
      overall_health_passed INTEGER,
      temperature_c         REAL,
      power_on_hours        REAL,
      power_cycles          REAL,
      severity              TEXT,
      first_seen_at         TEXT NOT NULL,
      last_seen_at          TEXT NOT NULL,
      retired_at            TEXT
    );

    CREATE TABLE smart_snapshots (
      id                    INTEGER PRIMARY KEY,
      drive_id              INTEGER NOT NULL REFERENCES drives(id) ON DELETE CASCADE,
      collected_at          TEXT NOT NULL,
      received_at           TEXT NOT NULL,
      source                TEXT NOT NULL DEFAULT 'unknown',
      overall_health_passed INTEGER,
      temperature_c         REAL,
      power_on_hours        REAL,
      power_cycles          REAL,
      attributes_json       TEXT NOT NULL DEFAULT '[]',
      nvme_json             TEXT,
      self_test_json        TEXT
    );
    CREATE INDEX smart_snapshots_drive_time ON smart_snapshots(drive_id, collected_at DESC);

    -- Sparse time series: a row is written only when an attribute's raw value moves,
    -- which keeps years of history small while still charting every change.
    CREATE TABLE smart_attribute_history (
      id           INTEGER PRIMARY KEY,
      drive_id     INTEGER NOT NULL REFERENCES drives(id) ON DELETE CASCADE,
      attribute_id INTEGER NOT NULL,
      collected_at TEXT NOT NULL,
      raw          REAL,
      value        REAL
    );
    CREATE INDEX smart_attr_history_lookup
      ON smart_attribute_history(drive_id, attribute_id, collected_at DESC);

    CREATE TABLE volumes (
      id                 INTEGER PRIMARY KEY,
      volume_id          TEXT NOT NULL UNIQUE,
      label              TEXT,
      drive_letter       TEXT,
      path               TEXT,
      file_system        TEXT,
      size_bytes         INTEGER,
      free_bytes         INTEGER,
      health_status      TEXT,
      operational_status TEXT,
      dirty              INTEGER,
      device_keys        TEXT NOT NULL DEFAULT '[]',
      hostname           TEXT,
      first_seen_at      TEXT NOT NULL,
      last_seen_at       TEXT NOT NULL
    );

    CREATE TABLE pools (
      id                 INTEGER PRIMARY KEY,
      pool_id            TEXT NOT NULL UNIQUE,
      name               TEXT,
      drive_letter       TEXT,
      size_bytes         INTEGER,
      free_bytes         INTEGER,
      duplicated_bytes   INTEGER,
      unduplicated_bytes INTEGER,
      first_seen_at      TEXT NOT NULL,
      last_seen_at       TEXT NOT NULL
    );

    CREATE TABLE pool_parts (
      id           INTEGER PRIMARY KEY,
      pool_id      TEXT NOT NULL,
      part_id      TEXT NOT NULL,
      name         TEXT,
      volume_id    TEXT,
      volume_label TEXT,
      drive_letter TEXT,
      path         TEXT,
      size_bytes   INTEGER,
      free_bytes   INTEGER,
      used_bytes   INTEGER,
      device_key   TEXT,
      missing      INTEGER NOT NULL DEFAULT 0,
      last_seen_at TEXT NOT NULL,
      UNIQUE(pool_id, part_id)
    );

    CREATE TABLE performance_samples (
      id               INTEGER PRIMARY KEY,
      drive_id         INTEGER REFERENCES drives(id) ON DELETE CASCADE,
      instance         TEXT NOT NULL,
      collected_at     TEXT NOT NULL,
      read_latency_ms  REAL,
      write_latency_ms REAL,
      queue_length     REAL,
      read_bps         REAL,
      write_bps        REAL,
      busy_percent     REAL
    );
    CREATE INDEX performance_samples_lookup ON performance_samples(drive_id, collected_at DESC);
    CREATE INDEX performance_samples_time ON performance_samples(collected_at);

    CREATE TABLE primocache_samples (
      id           INTEGER PRIMARY KEY,
      hostname     TEXT NOT NULL,
      collected_at TEXT NOT NULL,
      available    INTEGER NOT NULL DEFAULT 0,
      json         TEXT NOT NULL
    );
    CREATE INDEX primocache_samples_time ON primocache_samples(collected_at DESC);

    -- ------------------------------------------------------------------ catalog
    -- rel_path keeps the on-disk casing for display; path_key is lower-cased and is
    -- what every lookup, join and uniqueness constraint uses (the volumes are NTFS).
    CREATE TABLE files (
      id                 INTEGER PRIMARY KEY,
      root_id            TEXT NOT NULL,
      rel_path           TEXT NOT NULL,
      path_key           TEXT NOT NULL,
      dir_key            TEXT NOT NULL,
      name               TEXT NOT NULL,
      ext                TEXT NOT NULL DEFAULT '',
      size_bytes         INTEGER NOT NULL DEFAULT 0,
      mtime_ms           INTEGER NOT NULL DEFAULT 0,
      ctime_ms           INTEGER,
      duplication_level  INTEGER NOT NULL DEFAULT 1,
      hash               TEXT,
      hash_algorithm     TEXT,
      hashed_at          TEXT,
      -- Size and mtime as of the last hash. Bit rot is "content changed while these
      -- did not", so both must be recorded alongside the hash itself.
      hash_size_bytes    INTEGER,
      hash_mtime_ms      INTEGER,
      hash_error         TEXT,
      first_seen_at      TEXT NOT NULL,
      last_seen_at       TEXT NOT NULL,
      last_run_id        INTEGER,
      deleted_at         TEXT,
      UNIQUE(root_id, path_key)
    );
    CREATE INDEX files_dir ON files(root_id, dir_key);
    CREATE INDEX files_path_key ON files(path_key);
    CREATE INDEX files_hash_queue ON files(root_id, hashed_at) WHERE deleted_at IS NULL;
    CREATE INDEX files_deleted ON files(root_id, deleted_at);
    CREATE INDEX files_size ON files(root_id, size_bytes DESC);

    CREATE TABLE catalog_runs (
      id              INTEGER PRIMARY KEY,
      workflow_run_id INTEGER,
      root_id         TEXT NOT NULL,
      started_at      TEXT NOT NULL,
      finished_at     TEXT,
      state           TEXT NOT NULL DEFAULT 'running',
      files_seen      INTEGER NOT NULL DEFAULT 0,
      dirs_seen       INTEGER NOT NULL DEFAULT 0,
      bytes_seen      INTEGER NOT NULL DEFAULT 0,
      created_count   INTEGER NOT NULL DEFAULT 0,
      modified_count  INTEGER NOT NULL DEFAULT 0,
      deleted_count   INTEGER NOT NULL DEFAULT 0,
      restored_count  INTEGER NOT NULL DEFAULT 0,
      error           TEXT
    );
    CREATE INDEX catalog_runs_root ON catalog_runs(root_id, started_at DESC);

    CREATE TABLE catalog_changes (
      id                INTEGER PRIMARY KEY,
      run_id            INTEGER NOT NULL REFERENCES catalog_runs(id) ON DELETE CASCADE,
      root_id           TEXT NOT NULL,
      rel_path          TEXT NOT NULL,
      kind              TEXT NOT NULL,
      size_bytes        INTEGER,
      previous_size_bytes INTEGER,
      mtime_ms          INTEGER,
      previous_mtime_ms INTEGER,
      detected_at       TEXT NOT NULL
    );
    CREATE INDEX catalog_changes_run ON catalog_changes(run_id, kind);
    CREATE INDEX catalog_changes_root ON catalog_changes(root_id, detected_at DESC);

    -- Rolled-up directory sizes, rebuilt at the end of each catalog scan so the
    -- treemap does not have to aggregate millions of rows on every page load.
    CREATE TABLE dir_stats (
      root_id                TEXT NOT NULL,
      dir_key                TEXT NOT NULL,
      rel_path               TEXT NOT NULL,
      depth                  INTEGER NOT NULL,
      parent_key             TEXT,
      direct_files           INTEGER NOT NULL DEFAULT 0,
      direct_bytes           INTEGER NOT NULL DEFAULT 0,
      direct_effective_bytes INTEGER NOT NULL DEFAULT 0,
      total_files            INTEGER NOT NULL DEFAULT 0,
      total_bytes            INTEGER NOT NULL DEFAULT 0,
      total_effective_bytes  INTEGER NOT NULL DEFAULT 0,
      updated_at             TEXT NOT NULL,
      PRIMARY KEY (root_id, dir_key)
    );
    CREATE INDEX dir_stats_parent ON dir_stats(root_id, parent_key);
    CREATE INDEX dir_stats_size ON dir_stats(root_id, total_effective_bytes DESC);

    CREATE TABLE bitrot_findings (
      id                 INTEGER PRIMARY KEY,
      file_id            INTEGER,
      root_id            TEXT NOT NULL,
      rel_path           TEXT NOT NULL,
      path_key           TEXT NOT NULL,
      size_bytes         INTEGER NOT NULL DEFAULT 0,
      mtime_ms           INTEGER NOT NULL DEFAULT 0,
      expected_hash      TEXT NOT NULL,
      actual_hash        TEXT NOT NULL,
      hash_algorithm     TEXT NOT NULL,
      detected_at        TEXT NOT NULL,
      verified_at        TEXT,
      previous_hashed_at TEXT,
      status             TEXT NOT NULL DEFAULT 'open',
      note               TEXT NOT NULL DEFAULT '',
      resolved_at        TEXT,
      UNIQUE(root_id, path_key, expected_hash, actual_hash)
    );
    CREATE INDEX bitrot_status ON bitrot_findings(status, detected_at DESC);

    CREATE TABLE alerts (
      id               INTEGER PRIMARY KEY,
      dedupe_key       TEXT NOT NULL UNIQUE,
      category         TEXT NOT NULL,
      severity         TEXT NOT NULL,
      title            TEXT NOT NULL,
      detail           TEXT NOT NULL DEFAULT '',
      context_json     TEXT NOT NULL DEFAULT '{}',
      state            TEXT NOT NULL DEFAULT 'open',
      first_seen_at    TEXT NOT NULL,
      last_seen_at     TEXT NOT NULL,
      resolved_at      TEXT,
      acknowledged_at  TEXT,
      acknowledged_by  TEXT,
      notified_at      TEXT,
      notified_severity TEXT,
      occurrences      INTEGER NOT NULL DEFAULT 1
    );
    CREATE INDEX alerts_state ON alerts(state, severity, last_seen_at DESC);
    CREATE INDEX alerts_category ON alerts(category, state);

    CREATE TABLE alert_events (
      id       INTEGER PRIMARY KEY,
      alert_id INTEGER NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
      at       TEXT NOT NULL,
      kind     TEXT NOT NULL,
      severity TEXT,
      message  TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX alert_events_alert ON alert_events(alert_id, at DESC);

    -- Outbox so a Discord outage delays notifications instead of losing them.
    CREATE TABLE notifications (
      id           INTEGER PRIMARY KEY,
      channel      TEXT NOT NULL,
      alert_id     INTEGER REFERENCES alerts(id) ON DELETE SET NULL,
      payload_json TEXT NOT NULL,
      created_at   TEXT NOT NULL,
      send_after   TEXT NOT NULL,
      sent_at      TEXT,
      attempts     INTEGER NOT NULL DEFAULT 0,
      last_error   TEXT,
      status       TEXT NOT NULL DEFAULT 'pending'
    );
    CREATE INDEX notifications_pending ON notifications(status, send_after);

    CREATE TABLE workflow_runs (
      id            INTEGER PRIMARY KEY,
      workflow_id   TEXT NOT NULL,
      state         TEXT NOT NULL,
      trigger       TEXT NOT NULL DEFAULT 'manual',
      started_at    TEXT,
      finished_at   TEXT,
      updated_at    TEXT NOT NULL,
      progress_json TEXT NOT NULL DEFAULT '{}',
      cursor_json   TEXT,
      params_json   TEXT NOT NULL DEFAULT '{}',
      stats_json    TEXT NOT NULL DEFAULT '{}',
      log_json      TEXT NOT NULL DEFAULT '[]',
      error         TEXT
    );
    CREATE INDEX workflow_runs_lookup ON workflow_runs(workflow_id, id DESC);
    CREATE INDEX workflow_runs_state ON workflow_runs(state);

    CREATE TABLE backup_runs (
      id                INTEGER PRIMARY KEY,
      workflow_run_id   INTEGER,
      expectation_id    TEXT NOT NULL,
      expectation_name  TEXT NOT NULL DEFAULT '',
      started_at        TEXT NOT NULL,
      finished_at       TEXT,
      snapshot_id       TEXT,
      snapshot_time     TEXT,
      expected_files    INTEGER NOT NULL DEFAULT 0,
      present_files     INTEGER NOT NULL DEFAULT 0,
      missing_files     INTEGER NOT NULL DEFAULT 0,
      stale_files       INTEGER NOT NULL DEFAULT 0,
      mismatched_files  INTEGER NOT NULL DEFAULT 0,
      missing_bytes     INTEGER NOT NULL DEFAULT 0,
      error             TEXT
    );
    CREATE INDEX backup_runs_time ON backup_runs(started_at DESC);

    CREATE TABLE backup_issues (
      id                INTEGER PRIMARY KEY,
      run_id            INTEGER NOT NULL REFERENCES backup_runs(id) ON DELETE CASCADE,
      expectation_id    TEXT NOT NULL,
      root_id           TEXT NOT NULL,
      rel_path          TEXT NOT NULL,
      kind              TEXT NOT NULL,
      size_bytes        INTEGER,
      backup_size_bytes INTEGER,
      catalog_mtime_ms  INTEGER,
      backup_mtime_ms   INTEGER,
      detected_at       TEXT NOT NULL,
      status            TEXT NOT NULL DEFAULT 'open',
      note              TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX backup_issues_run ON backup_issues(run_id, kind);
    CREATE INDEX backup_issues_status ON backup_issues(status, detected_at DESC);

    CREATE TABLE export_records (
      id               INTEGER PRIMARY KEY,
      created_at       TEXT NOT NULL,
      file_name        TEXT NOT NULL,
      destination_id   TEXT,
      destination_path TEXT,
      size_bytes       INTEGER NOT NULL DEFAULT 0,
      record_count     INTEGER NOT NULL DEFAULT 0,
      checksum         TEXT NOT NULL DEFAULT '',
      trigger          TEXT NOT NULL DEFAULT 'manual',
      verified         INTEGER NOT NULL DEFAULT 0,
      error            TEXT
    );
    CREATE INDEX export_records_time ON export_records(created_at DESC);
    `,
  },
];

export function currentSchemaVersion(): number {
  return MIGRATIONS.reduce((max, migration) => Math.max(max, migration.version), 0);
}

export function applyMigrations(db: Database): number {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version    INTEGER PRIMARY KEY,
    name       TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`);

  const applied = new Set(
    db
      .prepare<[], { version: number }>('SELECT version FROM schema_migrations')
      .all()
      .map((row) => row.version),
  );

  const record = db.prepare(
    'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)',
  );

  let count = 0;
  for (const migration of [...MIGRATIONS].sort((a, b) => a.version - b.version)) {
    if (applied.has(migration.version)) continue;
    db.transaction(() => {
      db.exec(migration.up);
      record.run(migration.version, migration.name, new Date().toISOString());
    })();
    count += 1;
  }
  return count;
}
