import fs from 'node:fs';
import readline from 'node:readline';
import {
  compileGlobList,
  isUnder,
  normalizeRelPath,
  type BackupExpectation,
  type BackupIssue,
  type BackupIssueKind,
  type BackupVerificationSummary,
} from '@sakuradrive/shared';
import { nowIso, type Db } from '../db/index.js';
import type { AlertService } from './alert-service.js';
import type { KopiaClient, KopiaEntry } from './kopia-client.js';
import type { SettingsService } from './settings-service.js';

const ENTRY_TABLE = 'temp_backup_entries';

export interface VerifyOptions {
  expectation: BackupExpectation;
  workflowRunId: number | null;
  signal?: AbortSignal;
  onProgress?: (checked: number, total: number | null, message: string) => void;
  shouldContinue?: () => boolean;
}

export interface BackupServiceOptions {
  db: Db;
  settings: SettingsService;
  alerts: AlertService;
  /** Null when Kopia is not configured; `manifest` mode does not need it. */
  kopia: KopiaClient | null;
}

/**
 * Verifies that everything expected to be backed up is actually in the repository.
 *
 * Not everything on the pool gets the Backblaze treatment — it would cost a fortune —
 * so "expected" is defined by explicit include/exclude rules per catalog root. Anything
 * matching a rule and absent from the latest snapshot is a real gap in protection.
 */
export class BackupService {
  private readonly db: Db;
  private readonly settings: SettingsService;
  private readonly alerts: AlertService;
  private readonly kopia: KopiaClient | null;

  constructor(options: BackupServiceOptions) {
    this.db = options.db;
    this.settings = options.settings;
    this.alerts = options.alerts;
    this.kopia = options.kopia;
  }

  /** Verify one expectation and record the resulting issues. */
  async verify(options: VerifyOptions): Promise<BackupVerificationSummary> {
    const { expectation } = options;
    const config = this.settings.get().backup;
    const startedAt = nowIso();

    const runId = Number(
      this.db
        .prepare(
          `INSERT INTO backup_runs (workflow_run_id, expectation_id, expectation_name, started_at)
           VALUES (?, ?, ?, ?)`,
        )
        .run(options.workflowRunId, expectation.id, expectation.name, startedAt).lastInsertRowid,
    );

    const summary: BackupVerificationSummary = {
      runId,
      startedAt,
      finishedAt: null,
      expectationId: expectation.id,
      expectationName: expectation.name,
      snapshotId: null,
      snapshotTime: null,
      expectedFiles: 0,
      presentFiles: 0,
      missingFiles: 0,
      staleFiles: 0,
      mismatchedFiles: 0,
      missingBytes: 0,
      error: null,
    };

    try {
      this.resetEntryTable();
      let entryCount = 0;

      if (config.mode === 'manifest') {
        entryCount = await this.loadManifest(config.manifestPath, options.signal);
        summary.snapshotId = `manifest:${config.manifestPath}`;
      } else if (config.mode === 'kopia') {
        if (!this.kopia) throw new Error('Kopia is not configured');
        const snapshot = await this.kopia.latestSnapshot(expectation.kopiaSource);
        if (!snapshot) {
          throw new Error(
            `No Kopia snapshot found for source "${expectation.kopiaSource}". Check the source string against "kopia snapshot list".`,
          );
        }
        summary.snapshotId = snapshot.id;
        summary.snapshotTime = snapshot.endTime ?? snapshot.startTime;
        entryCount = await this.loadKopiaEntries(snapshot.id, config.maxEntriesPerSnapshot, options.signal);
      } else {
        throw new Error('Backup verification is disabled');
      }

      if (entryCount === 0) {
        throw new Error(
          'The snapshot listing was empty. Refusing to report every expected file as missing — check the source and the repository connection.',
        );
      }

      this.compare(runId, expectation, summary, options);

      // Snapshot age is its own check: a repository that stopped receiving snapshots
      // looks perfectly complete right up until you need it.
      if (summary.snapshotTime && expectation.maxSnapshotAgeHours > 0) {
        const ageHours = (Date.now() - Date.parse(summary.snapshotTime)) / 3_600_000;
        if (ageHours > expectation.maxSnapshotAgeHours) {
          this.alerts.raise({
            dedupeKey: `backup:${expectation.id}:stale-snapshot`,
            category: 'backup',
            severity: 'warning',
            title: `Backup for "${expectation.name}" is ${Math.round(ageHours)} hours old`,
            detail: `The newest snapshot is older than the ${expectation.maxSnapshotAgeHours}-hour limit. Check that the Kopia scheduled task is still running on the host.`,
            context: { expectation: expectation.name, snapshotTime: summary.snapshotTime },
          });
        } else {
          this.alerts.resolve(`backup:${expectation.id}:stale-snapshot`);
        }
      }
    } catch (error) {
      summary.error = error instanceof Error ? error.message : String(error);
      this.alerts.raise({
        dedupeKey: `backup:${expectation.id}:error`,
        category: 'backup',
        severity: 'warning',
        title: `Backup verification failed for "${expectation.name}"`,
        detail: summary.error,
        context: { expectation: expectation.name },
      });
    } finally {
      this.dropEntryTable();
    }

    if (!summary.error) this.alerts.resolve(`backup:${expectation.id}:error`);

    summary.finishedAt = nowIso();
    this.db
      .prepare(
        `UPDATE backup_runs SET finished_at = ?, snapshot_id = ?, snapshot_time = ?,
                                expected_files = ?, present_files = ?, missing_files = ?,
                                stale_files = ?, mismatched_files = ?, missing_bytes = ?, error = ?
          WHERE id = ?`,
      )
      .run(
        summary.finishedAt,
        summary.snapshotId,
        summary.snapshotTime,
        summary.expectedFiles,
        summary.presentFiles,
        summary.missingFiles,
        summary.staleFiles,
        summary.mismatchedFiles,
        summary.missingBytes,
        summary.error,
        runId,
      );

    this.syncAlert(expectation, summary);
    return summary;
  }

  /**
   * The folder the snapshot has that our paths do not.
   *
   * Written as `PoolPart.*` it is resolved against the snapshot's own top level, so the
   * pool GUID never has to be copied into the settings — and it keeps working after
   * DrivePool is removed and re-added to a disk, which changes that GUID.
   */
  private resolveSnapshotPrefix(pattern: string | null | undefined): string {
    // Settings written before this field existed simply do not have it.
    const wanted = normalizeRelPath(pattern ?? '');
    if (wanted === '') return '';
    if (!wanted.includes('*')) return wanted;

    const match = compileGlobList([wanted]);
    const rows = this.db
      .prepare<[], { segment: string }>(
        `SELECT DISTINCT CASE WHEN INSTR(path_key, '/') > 0
                              THEN SUBSTR(path_key, 1, INSTR(path_key, '/') - 1)
                              ELSE path_key END AS segment
           FROM ${ENTRY_TABLE}`,
      )
      .all();
    // Lowercased because path_key is; the glob is compiled case-insensitively already.
    return rows.find((row) => match(row.segment))?.segment ?? '';
  }

  /* ---------------------------------------------------------- comparison */

  private compare(
    runId: number,
    expectation: BackupExpectation,
    summary: BackupVerificationSummary,
    options: VerifyOptions,
  ): void {
    const include = expectation.includeGlobs;
    const exclude = expectation.excludeGlobs;
    const includeMatch = include.length === 0 ? () => true : compileGlobList(include);
    const excludeMatch = compileGlobList(exclude);
    const prefix = normalizeRelPath(expectation.kopiaPathPrefix);
    const snapshotPrefix = this.resolveSnapshotPrefix(expectation.kopiaSnapshotPrefix);

    const total =
      this.db
        .prepare<[string], { n: number }>(
          'SELECT COUNT(*) AS n FROM files WHERE root_id = ? AND deleted_at IS NULL',
        )
        .get(expectation.rootId)?.n ?? 0;

    const lookup = this.db.prepare<[string], { size_bytes: number; mtime_ms: number | null }>(
      `SELECT size_bytes, mtime_ms FROM ${ENTRY_TABLE} WHERE path_key = ?`,
    );
    const insertIssue = this.db.prepare(
      `INSERT INTO backup_issues
         (run_id, expectation_id, root_id, rel_path, kind, size_bytes, backup_size_bytes,
          catalog_mtime_ms, backup_mtime_ms, detected_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    const rows = this.db
      .prepare<[string], { rel_path: string; size_bytes: number; mtime_ms: number }>(
        'SELECT rel_path, size_bytes, mtime_ms FROM files WHERE root_id = ? AND deleted_at IS NULL',
      )
      .iterate(expectation.rootId);

    const now = nowIso();
    let checked = 0;
    const pending: Array<[BackupIssueKind, string, number, number | null, number, number | null]> = [];

    const flush = () => {
      if (pending.length === 0) return;
      this.db.transaction(() => {
        for (const [kind, relPath, size, backupSize, mtime, backupMtime] of pending) {
          insertIssue.run(
            runId,
            expectation.id,
            expectation.rootId,
            relPath,
            kind,
            size,
            backupSize,
            mtime,
            backupMtime,
            now,
          );
        }
      })();
      pending.length = 0;
    };

    for (const row of rows) {
      checked += 1;
      if (checked % 5000 === 0) {
        options.onProgress?.(checked, total, `${expectation.name}: ${checked.toLocaleString()} files checked`);
        if (options.shouldContinue && !options.shouldContinue()) break;
      }

      const relPath = row.rel_path;
      if (prefix !== '' && !isUnder(prefix, relPath)) continue;
      if (excludeMatch(relPath) || !includeMatch(relPath)) continue;
      if (row.size_bytes < expectation.minFileSizeBytes) continue;

      summary.expectedFiles += 1;
      const stripped = stripPrefix(relPath, prefix);
      const snapshotPath = snapshotPrefix === '' ? stripped : `${snapshotPrefix}/${stripped}`;
      const entry = lookup.get(snapshotPath.toLowerCase());

      if (!entry) {
        summary.missingFiles += 1;
        summary.missingBytes += row.size_bytes;
        pending.push(['missing', relPath, row.size_bytes, null, row.mtime_ms, null]);
      } else {
        summary.presentFiles += 1;
        if (entry.size_bytes >= 0 && entry.size_bytes !== row.size_bytes) {
          summary.mismatchedFiles += 1;
          pending.push([
            'size-mismatch',
            relPath,
            row.size_bytes,
            entry.size_bytes,
            row.mtime_ms,
            entry.mtime_ms,
          ]);
        } else if (entry.mtime_ms !== null && entry.mtime_ms + 60_000 < row.mtime_ms) {
          // The file changed after it was backed up, so the copy is out of date.
          summary.staleFiles += 1;
          pending.push([
            'stale',
            relPath,
            row.size_bytes,
            entry.size_bytes,
            row.mtime_ms,
            entry.mtime_ms,
          ]);
        }
      }
      if (pending.length >= 500) flush();
    }
    flush();
    options.onProgress?.(checked, total, `${expectation.name}: finished`);
  }

  /* --------------------------------------------------------- entry loading */

  private resetEntryTable(): void {
    this.db.exec(`DROP TABLE IF EXISTS ${ENTRY_TABLE}`);
    this.db.exec(
      `CREATE TEMP TABLE ${ENTRY_TABLE} (
         path_key   TEXT PRIMARY KEY,
         size_bytes INTEGER NOT NULL,
         mtime_ms   INTEGER
       )`,
    );
  }

  private dropEntryTable(): void {
    try {
      this.db.exec(`DROP TABLE IF EXISTS ${ENTRY_TABLE}`);
    } catch {
      // The table is temporary; failing to drop it is not worth surfacing.
    }
  }

  private insertEntries(entries: Iterable<KopiaEntry>): number {
    const insert = this.db.prepare(
      `INSERT OR REPLACE INTO ${ENTRY_TABLE} (path_key, size_bytes, mtime_ms) VALUES (?, ?, ?)`,
    );
    let count = 0;
    this.db.transaction(() => {
      for (const entry of entries) {
        if (entry.type !== 'file') continue;
        insert.run(entry.relPath.toLowerCase(), entry.sizeBytes, entry.mtimeMs);
        count += 1;
      }
    })();
    return count;
  }

  private async loadKopiaEntries(
    snapshotId: string,
    maxEntries: number,
    signal?: AbortSignal,
  ): Promise<number> {
    if (!this.kopia) throw new Error('Kopia is not configured');
    let total = 0;
    let batch: KopiaEntry[] = [];
    for await (const entry of this.kopia.listEntries(snapshotId, { maxEntries, signal })) {
      batch.push(entry);
      if (batch.length >= 2000) {
        total += this.insertEntries(batch);
        batch = [];
      }
    }
    total += this.insertEntries(batch);
    return total;
  }

  /** Read a listing file. Tolerates NDJSON, tab-separated columns and bare paths. */
  private async loadManifest(manifestPath: string, signal?: AbortSignal): Promise<number> {
    if (!manifestPath) throw new Error('No manifest path is configured');
    if (!fs.existsSync(manifestPath)) throw new Error(`Manifest file not found: ${manifestPath}`);

    const stream = fs.createReadStream(manifestPath, { encoding: 'utf8' });
    const lines = readline.createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });
    let batch: KopiaEntry[] = [];
    let total = 0;
    try {
      for await (const line of lines) {
        if (signal?.aborted) break;
        const entry = parseManifestLine(line);
        if (!entry) continue;
        batch.push(entry);
        if (batch.length >= 2000) {
          total += this.insertEntries(batch);
          batch = [];
        }
      }
    } finally {
      lines.close();
      stream.destroy();
    }
    total += this.insertEntries(batch);
    return total;
  }

  /* ------------------------------------------------------------- reporting */

  private syncAlert(expectation: BackupExpectation, summary: BackupVerificationSummary): void {
    const dedupeKey = `backup:${expectation.id}:missing`;
    if (summary.error || summary.missingFiles === 0) {
      if (summary.missingFiles === 0 && !summary.error) this.alerts.resolve(dedupeKey);
      return;
    }
    this.alerts.raise({
      dedupeKey,
      category: 'backup',
      severity: 'critical',
      title: `${summary.missingFiles.toLocaleString()} expected files are not in the backup for "${expectation.name}"`,
      detail:
        `${summary.missingFiles.toLocaleString()} of ${summary.expectedFiles.toLocaleString()} expected files were not found in the latest snapshot. ` +
        'Those files exist on the pool but are not protected — a disk failure would lose them for good.',
      context: {
        expectation: expectation.name,
        missing: summary.missingFiles,
        expected: summary.expectedFiles,
        snapshot: summary.snapshotId ?? '',
      },
    });
  }

  listRuns(limit = 50): BackupVerificationSummary[] {
    return this.db
      .prepare<[number], {
        id: number; started_at: string; finished_at: string | null; expectation_id: string;
        expectation_name: string; snapshot_id: string | null; snapshot_time: string | null;
        expected_files: number; present_files: number; missing_files: number; stale_files: number;
        mismatched_files: number; missing_bytes: number; error: string | null;
      }>('SELECT * FROM backup_runs ORDER BY id DESC LIMIT ?')
      .all(limit)
      .map((row) => ({
        runId: row.id,
        startedAt: row.started_at,
        finishedAt: row.finished_at,
        expectationId: row.expectation_id,
        expectationName: row.expectation_name,
        snapshotId: row.snapshot_id,
        snapshotTime: row.snapshot_time,
        expectedFiles: row.expected_files,
        presentFiles: row.present_files,
        missingFiles: row.missing_files,
        staleFiles: row.stale_files,
        mismatchedFiles: row.mismatched_files,
        missingBytes: row.missing_bytes,
        error: row.error,
      }));
  }

  listIssues(query: {
    runId?: number;
    kind?: BackupIssueKind;
    status?: 'open' | 'dismissed' | 'resolved' | 'any';
    search?: string;
    limit?: number;
    offset?: number;
  } = {}): { issues: BackupIssue[]; total: number } {
    const where: string[] = [];
    const params: unknown[] = [];
    if (query.runId !== undefined) {
      where.push('run_id = ?');
      params.push(query.runId);
    } else {
      // Default to the newest run per expectation so the page shows current state.
      where.push(
        'run_id IN (SELECT MAX(id) FROM backup_runs WHERE error IS NULL GROUP BY expectation_id)',
      );
    }
    if (query.kind) {
      where.push('kind = ?');
      params.push(query.kind);
    }
    const status = query.status ?? 'open';
    if (status !== 'any') {
      where.push('status = ?');
      params.push(status);
    }
    if (query.search) {
      where.push('rel_path LIKE ?');
      params.push(`%${query.search}%`);
    }
    const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const total =
      this.db
        .prepare<unknown[], { n: number }>(`SELECT COUNT(*) AS n FROM backup_issues ${clause}`)
        .get(...params)?.n ?? 0;
    const rows = this.db
      .prepare<unknown[], {
        id: number; run_id: number; expectation_id: string; root_id: string; rel_path: string;
        kind: string; size_bytes: number | null; backup_size_bytes: number | null;
        catalog_mtime_ms: number | null; backup_mtime_ms: number | null; detected_at: string;
        status: string; note: string;
      }>(`SELECT * FROM backup_issues ${clause} ORDER BY size_bytes DESC LIMIT ? OFFSET ?`)
      .all(...params, Math.min(query.limit ?? 200, 5000), query.offset ?? 0);

    return {
      total,
      issues: rows.map((row) => ({
        id: row.id,
        runId: row.run_id,
        expectationId: row.expectation_id,
        rootId: row.root_id,
        relPath: row.rel_path,
        kind: row.kind as BackupIssueKind,
        sizeBytes: row.size_bytes,
        backupSizeBytes: row.backup_size_bytes,
        catalogMtimeMs: row.catalog_mtime_ms,
        backupMtimeMs: row.backup_mtime_ms,
        detectedAt: row.detected_at,
        status: row.status as BackupIssue['status'],
        note: row.note,
      })),
    };
  }

  setIssueStatus(ids: readonly number[], status: 'open' | 'dismissed' | 'resolved', note = ''): number {
    const update = this.db.prepare('UPDATE backup_issues SET status = ?, note = ? WHERE id = ?');
    let changed = 0;
    this.db.transaction(() => {
      for (const id of ids) changed += update.run(status, note, id).changes;
    })();
    return changed;
  }

  /**
   * What the backup rules do and do not cover.
   *
   * Not everything is meant to be backed up — cloud storage costs money and some of
   * this data is replaceable — so a root with no expectation is a *decision*, not a
   * fault, and it raises no alert. But a decision you cannot see is indistinguishable
   * from an oversight, and the moment that matters is the one where a disk has just
   * died. This is the answer to "what am I not protecting?", available before then.
   *
   * Coverage is judged per top-level folder, because that is the granularity people
   * actually think in (Tier0, Tier1, ...) and the granularity the rules are written at.
   * A folder is covered when some enabled rule's include globs reach into it; what a
   * rule then excludes *within* that folder is verification's business, not this.
   */
  coverage(): Array<{
    rootId: string;
    rootName: string;
    expectations: string[];
    coveredFiles: number;
    coveredBytes: number;
    uncoveredFiles: number;
    uncoveredBytes: number;
    uncoveredFolders: Array<{ name: string; files: number; bytes: number }>;
  }> {
    const config = this.settings.get();
    const enabledExpectations = config.backup.expectations.filter(
      (expectation) => expectation.enabled,
    );

    return config.catalog.roots
      .filter((root) => root.enabled !== false)
      .map((root) => {
        const rules = enabledExpectations.filter(
          (expectation) => expectation.rootId === root.id,
        );
        // Include globs only. They are written against folders ("Tier1/**"), which is
        // the question here: does any rule reach into this folder at all? Excludes are
        // file-level refinements inside a folder a rule already claims, and verification
        // is what reports on those — counting them here would call a folder unprotected
        // because one `*.tmp` in it is skipped.
        const matchers = rules.map((rule) =>
          rule.includeGlobs.length === 0 ? () => true : compileGlobList(rule.includeGlobs),
        );

        // One pass over the root's top-level folders rather than over every file: the
        // rules are written against folders, and a pool disk holds millions of files.
        const folders = this.db
          .prepare<[string], { name: string; files: number; bytes: number; sample: string }>(
            `SELECT CASE WHEN INSTR(rel_path, '/') > 0
                         THEN SUBSTR(rel_path, 1, INSTR(rel_path, '/') - 1)
                         ELSE '' END AS name,
                    COUNT(*)                    AS files,
                    COALESCE(SUM(size_bytes),0) AS bytes,
                    MIN(rel_path)               AS sample
               FROM files
              WHERE root_id = ? AND deleted_at IS NULL
              GROUP BY name`,
          )
          .all(root.id);

        let coveredFiles = 0;
        let coveredBytes = 0;
        const uncoveredFolders: Array<{ name: string; files: number; bytes: number }> = [];

        for (const folder of folders) {
          // A folder counts as covered when some rule would accept a file in it. The
          // sample path is a real path from that folder, so a rule like `Tier1/**`
          // matches exactly as it will during verification.
          const covered = matchers.some((matcher) => matcher(folder.sample));
          if (covered) {
            coveredFiles += folder.files;
            coveredBytes += folder.bytes;
          } else {
            uncoveredFolders.push({
              name: folder.name === '' ? '(root)' : folder.name,
              files: folder.files,
              bytes: folder.bytes,
            });
          }
        }

        uncoveredFolders.sort((a, b) => b.bytes - a.bytes);
        return {
          rootId: root.id,
          rootName: root.name,
          expectations: rules.map((rule) => rule.name),
          coveredFiles,
          coveredBytes,
          uncoveredFiles: uncoveredFolders.reduce((sum, folder) => sum + folder.files, 0),
          uncoveredBytes: uncoveredFolders.reduce((sum, folder) => sum + folder.bytes, 0),
          uncoveredFolders,
        };
      });
  }

  summary(): { enabled: boolean; lastRunAt: string | null; missingFiles: number; missingBytes: number; expectations: number } {
    const config = this.settings.get().backup;
    const latest = this.db
      .prepare<[], { started_at: string | null; missing_files: number | null; missing_bytes: number | null }>(
        `SELECT started_at, SUM(missing_files) AS missing_files, SUM(missing_bytes) AS missing_bytes
           FROM backup_runs
          WHERE id IN (SELECT MAX(id) FROM backup_runs WHERE error IS NULL GROUP BY expectation_id)`,
      )
      .get();
    return {
      enabled: config.enabled && config.mode !== 'disabled',
      lastRunAt: latest?.started_at ?? null,
      missingFiles: latest?.missing_files ?? 0,
      missingBytes: latest?.missing_bytes ?? 0,
      expectations: config.expectations.filter((expectation) => expectation.enabled).length,
    };
  }
}

/** `Media/Movies/a.mkv` with prefix `Media` becomes `Movies/a.mkv`. */
export function stripPrefix(relPath: string, prefix: string): string {
  const normalizedPrefix = normalizeRelPath(prefix);
  if (normalizedPrefix === '') return normalizeRelPath(relPath);
  const normalized = normalizeRelPath(relPath);
  if (!isUnder(normalizedPrefix, normalized)) return normalized;
  return normalizeRelPath(normalized.slice(normalizedPrefix.length));
}

/** Parse one line of a manifest file into an entry, or null when it is not one. */
export function parseManifestLine(line: string): KopiaEntry | null {
  const trimmed = line.trim();
  if (trimmed === '') return null;

  if (trimmed.startsWith('{')) {
    try {
      const record = JSON.parse(trimmed) as Record<string, unknown>;
      const name = String(record.name ?? record.path ?? '');
      if (name === '') return null;
      const type = String(record.type ?? 'f');
      if (type === 'd' || type === 'directory') return null;
      const mtimeRaw = record.mtime ?? record.modTime;
      const mtimeMs = typeof mtimeRaw === 'string' ? Date.parse(mtimeRaw) : Number(mtimeRaw);
      return {
        relPath: normalizeRelPath(name),
        sizeBytes: Number(record.size ?? 0) || 0,
        mtimeMs: Number.isFinite(mtimeMs) ? mtimeMs : null,
        type: 'file',
      };
    } catch {
      return null;
    }
  }

  // `size<TAB>mtime<TAB>path`, or just a path.
  const columns = trimmed.split('\t');
  if (columns.length >= 3) {
    const size = Number(columns[0]);
    const mtime = Date.parse(columns[1] ?? '');
    return {
      relPath: normalizeRelPath(columns.slice(2).join('\t')),
      sizeBytes: Number.isFinite(size) ? size : 0,
      mtimeMs: Number.isFinite(mtime) ? mtime : null,
      type: 'file',
    };
  }
  // A bare path carries no size or timestamp; -1 marks it unknown so the comparison
  // reports presence only, instead of flagging every file as a size mismatch.
  return { relPath: normalizeRelPath(trimmed), sizeBytes: -1, mtimeMs: null, type: 'file' };
}
