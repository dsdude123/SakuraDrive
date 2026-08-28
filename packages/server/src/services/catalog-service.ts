import {
  basename,
  createDuplicationResolver,
  dirnameRel,
  effectiveSize,
  extname,
  normalizeRelPath,
  stripPoolPartPrefix,
  type CatalogChange,
  type CatalogChangeKind,
  type CatalogDiffSummary,
  type DirectoryEntry,
  type DiskLossImpact,
  type DuplicationRule,
  type ScanRoot,
} from '@sakuradrive/shared';
import { nowIso, type Db } from '../db/index.js';
import type { WalkedFile } from '../util/fs-walk.js';
import type { SettingsService } from './settings-service.js';

export interface CatalogRunStats {
  filesSeen: number;
  dirsSeen: number;
  bytesSeen: number;
  created: number;
  modified: number;
  deleted: number;
  restored: number;
}

export interface HashCandidate {
  id: number;
  rootId: string;
  relPath: string;
  sizeBytes: number;
  mtimeMs: number;
  hash: string | null;
  hashAlgorithm: string | null;
  hashSizeBytes: number | null;
  hashMtimeMs: number | null;
  hashedAt: string | null;
}

interface FileRow {
  id: number;
  size_bytes: number;
  mtime_ms: number;
  deleted_at: string | null;
}

/**
 * The file catalog.
 *
 * Every row keeps both the on-disk casing (`rel_path`, for display) and a lower-cased
 * `path_key` used for all lookups, joins and uniqueness — NTFS is case-insensitive, so
 * treating `Media/A.mkv` and `media/a.mkv` as two files would produce phantom
 * created/deleted pairs on every scan.
 */
export class CatalogService {
  constructor(
    private readonly db: Db,
    private readonly settings: SettingsService,
  ) {}

  /* ------------------------------------------------------------------ runs */

  beginRun(rootId: string, workflowRunId: number | null): number {
    const info = this.db
      .prepare('INSERT INTO catalog_runs (workflow_run_id, root_id, started_at) VALUES (?, ?, ?)')
      .run(workflowRunId, rootId, nowIso());
    return Number(info.lastInsertRowid);
  }

  /** The run currently in progress for a root, so a paused scan resumes its own run. */
  activeRun(rootId: string): number | null {
    const row = this.db
      .prepare<[string], { id: number }>(
        `SELECT id FROM catalog_runs WHERE root_id = ? AND state = 'running' ORDER BY id DESC LIMIT 1`,
      )
      .get(rootId);
    return row?.id ?? null;
  }

  finishRun(runId: number, state: 'completed' | 'failed' | 'cancelled', error?: string): void {
    this.db
      .prepare('UPDATE catalog_runs SET state = ?, finished_at = ?, error = ? WHERE id = ?')
      .run(state, nowIso(), error ?? null, runId);
  }

  updateRunStats(runId: number, stats: Partial<CatalogRunStats>): void {
    this.db
      .prepare(
        `UPDATE catalog_runs
            SET files_seen = COALESCE(?, files_seen),
                dirs_seen = COALESCE(?, dirs_seen),
                bytes_seen = COALESCE(?, bytes_seen),
                created_count = COALESCE(?, created_count),
                modified_count = COALESCE(?, modified_count),
                deleted_count = COALESCE(?, deleted_count),
                restored_count = COALESCE(?, restored_count)
          WHERE id = ?`,
      )
      .run(
        stats.filesSeen ?? null,
        stats.dirsSeen ?? null,
        stats.bytesSeen ?? null,
        stats.created ?? null,
        stats.modified ?? null,
        stats.deleted ?? null,
        stats.restored ?? null,
        runId,
      );
  }

  listRuns(rootId?: string, limit = 50) {
    const rows = rootId
      ? this.db
          .prepare(
            'SELECT * FROM catalog_runs WHERE root_id = ? ORDER BY id DESC LIMIT ?',
          )
          .all(rootId, limit)
      : this.db.prepare('SELECT * FROM catalog_runs ORDER BY id DESC LIMIT ?').all(limit);
    return (rows as Array<Record<string, unknown>>).map((row) => ({
      id: row.id as number,
      rootId: row.root_id as string,
      startedAt: row.started_at as string,
      finishedAt: row.finished_at as string | null,
      state: row.state as string,
      filesSeen: row.files_seen as number,
      dirsSeen: row.dirs_seen as number,
      bytesSeen: row.bytes_seen as number,
      created: row.created_count as number,
      modified: row.modified_count as number,
      deleted: row.deleted_count as number,
      restored: row.restored_count as number,
      error: row.error as string | null,
    }));
  }

  /* -------------------------------------------------------------- ingestion */

  /**
   * Upsert a batch of walked files, recording created/modified/restored changes.
   *
   * Runs in one transaction — batching is what makes cataloguing millions of files
   * practical, and it keeps the catalog consistent if the process dies mid-scan.
   */
  recordFiles(
    runId: number,
    root: ScanRoot,
    files: readonly WalkedFile[],
    duplicationFor: (relPath: string) => number,
  ): { created: number; modified: number; restored: number; bytes: number } {
    if (files.length === 0) return { created: 0, modified: 0, restored: 0, bytes: 0 };
    const now = nowIso();
    let created = 0;
    let modified = 0;
    let restored = 0;
    let bytes = 0;

    const select = this.db.prepare<[string, string], FileRow>(
      'SELECT id, size_bytes, mtime_ms, deleted_at FROM files WHERE root_id = ? AND path_key = ?',
    );
    const insert = this.db.prepare(
      `INSERT INTO files (root_id, rel_path, path_key, dir_key, name, ext, size_bytes, mtime_ms,
                          ctime_ms, duplication_level, first_seen_at, last_seen_at, last_run_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const update = this.db.prepare(
      `UPDATE files SET rel_path = ?, size_bytes = ?, mtime_ms = ?, ctime_ms = ?,
                        duplication_level = ?, last_seen_at = ?, last_run_id = ?, deleted_at = NULL
        WHERE id = ?`,
    );
    const change = this.db.prepare(
      `INSERT INTO catalog_changes (run_id, root_id, rel_path, kind, size_bytes, previous_size_bytes,
                                    mtime_ms, previous_mtime_ms, detected_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    this.db.transaction(() => {
      for (const file of files) {
        // A pool-part root is normally mounted at the disk root, so its paths start
        // with DrivePool's `PoolPart.<guid>` folder. Strip it: the catalog stores
        // pool-relative paths so the same file on two different disks compares equal,
        // which is what makes the disaster-recovery query work.
        const relPath =
          root.kind === 'poolpart'
            ? stripPoolPartPrefix(file.relPath)
            : normalizeRelPath(file.relPath);
        if (relPath === '') continue;
        const pathKey = relPath.toLowerCase();
        const dirKey = dirnameRel(pathKey);
        const level = duplicationFor(relPath);
        bytes += file.sizeBytes;

        const existing = select.get(root.id, pathKey);
        if (!existing) {
          insert.run(
            root.id,
            relPath,
            pathKey,
            dirKey,
            basename(relPath),
            extname(relPath),
            file.sizeBytes,
            file.mtimeMs,
            file.ctimeMs,
            level,
            now,
            now,
            runId,
          );
          change.run(runId, root.id, relPath, 'created', file.sizeBytes, null, file.mtimeMs, null, now);
          created += 1;
          continue;
        }

        const wasDeleted = existing.deleted_at !== null;
        const contentChanged =
          existing.size_bytes !== file.sizeBytes || existing.mtime_ms !== file.mtimeMs;

        update.run(
          relPath,
          file.sizeBytes,
          file.mtimeMs,
          file.ctimeMs,
          level,
          now,
          runId,
          existing.id,
        );

        if (wasDeleted) {
          change.run(
            runId,
            root.id,
            relPath,
            'restored',
            file.sizeBytes,
            existing.size_bytes,
            file.mtimeMs,
            existing.mtime_ms,
            now,
          );
          restored += 1;
        } else if (contentChanged) {
          change.run(
            runId,
            root.id,
            relPath,
            'modified',
            file.sizeBytes,
            existing.size_bytes,
            file.mtimeMs,
            existing.mtime_ms,
            now,
          );
          modified += 1;
        }
      }
    })();

    return { created, modified, restored, bytes };
  }

  /**
   * Mark everything the run did not see as deleted.
   *
   * Only safe once a scan has walked the whole root — calling it after an interrupted
   * pass would delete the entire catalog, which is exactly the data a DR tool must not
   * lose. The scan workflow enforces that.
   */
  markMissingAsDeleted(runId: number, rootId: string): number {
    const now = nowIso();
    const missing = this.db
      .prepare<[string, number], { id: number; rel_path: string; size_bytes: number; mtime_ms: number }>(
        `SELECT id, rel_path, size_bytes, mtime_ms FROM files
          WHERE root_id = ? AND deleted_at IS NULL AND (last_run_id IS NULL OR last_run_id != ?)`,
      )
      .all(rootId, runId);
    if (missing.length === 0) return 0;

    const markDeleted = this.db.prepare('UPDATE files SET deleted_at = ? WHERE id = ?');
    const change = this.db.prepare(
      `INSERT INTO catalog_changes (run_id, root_id, rel_path, kind, size_bytes, previous_size_bytes,
                                    mtime_ms, previous_mtime_ms, detected_at)
       VALUES (?, ?, ?, 'deleted', NULL, ?, NULL, ?, ?)`,
    );
    this.db.transaction(() => {
      for (const row of missing) {
        markDeleted.run(now, row.id);
        change.run(runId, rootId, row.rel_path, row.size_bytes, row.mtime_ms, now);
      }
    })();
    return missing.length;
  }

  /** Re-apply duplication rules to every catalogued file in a root. */
  refreshDuplicationLevels(rootId: string, rules: readonly DuplicationRule[], defaultLevel: number): number {
    const resolver = createDuplicationResolver(rules, defaultLevel);
    const rows = this.db
      .prepare<[string], { id: number; rel_path: string; duplication_level: number }>(
        'SELECT id, rel_path, duplication_level FROM files WHERE root_id = ? AND deleted_at IS NULL',
      )
      .all(rootId);
    const update = this.db.prepare('UPDATE files SET duplication_level = ? WHERE id = ?');
    let changed = 0;
    this.db.transaction(() => {
      for (const row of rows) {
        const level = resolver(row.rel_path);
        if (level !== row.duplication_level) {
          update.run(level, row.id);
          changed += 1;
        }
      }
    })();
    return changed;
  }

  /* ------------------------------------------------------------- directory stats */

  /**
   * Rebuild the directory rollups used by the storage view.
   *
   * Done as one pass over the catalog plus an in-memory roll-up from the deepest
   * directory upward, which is far cheaper than recursive SQL and keeps the treemap
   * instant regardless of catalog size.
   */
  rebuildDirStats(rootId: string): number {
    const grouped = this.db
      .prepare<[string], {
        dir_key: string;
        sample_path: string;
        files: number;
        bytes: number;
        effective_bytes: number;
      }>(
        `SELECT dir_key,
                MIN(rel_path) AS sample_path,
                COUNT(*) AS files,
                COALESCE(SUM(size_bytes), 0) AS bytes,
                COALESCE(SUM(size_bytes * duplication_level), 0) AS effective_bytes
           FROM files
          WHERE root_id = ? AND deleted_at IS NULL
          GROUP BY dir_key`,
      )
      .all(rootId);

    interface Node {
      dirKey: string;
      relPath: string;
      depth: number;
      parentKey: string | null;
      directFiles: number;
      directBytes: number;
      directEffective: number;
      totalFiles: number;
      totalBytes: number;
      totalEffective: number;
    }

    const nodes = new Map<string, Node>();
    const ensure = (dirKey: string, relPath: string): Node => {
      const existing = nodes.get(dirKey);
      if (existing) return existing;
      const depth = dirKey === '' ? 0 : dirKey.split('/').length;
      const parentKey = dirKey === '' ? null : dirnameRel(dirKey);
      const node: Node = {
        dirKey,
        relPath,
        depth,
        parentKey,
        directFiles: 0,
        directBytes: 0,
        directEffective: 0,
        totalFiles: 0,
        totalBytes: 0,
        totalEffective: 0,
      };
      nodes.set(dirKey, node);
      return node;
    };

    ensure('', '');
    for (const row of grouped) {
      // `sample_path` preserves the on-disk casing of the directory chain.
      const displayDir = dirnameRel(row.sample_path);
      const node = ensure(row.dir_key, displayDir);
      node.relPath = displayDir;
      node.directFiles = row.files;
      node.directBytes = row.bytes;
      node.directEffective = row.effective_bytes;
      node.totalFiles = row.files;
      node.totalBytes = row.bytes;
      node.totalEffective = row.effective_bytes;

      // Materialise every ancestor so directories holding only subdirectories appear.
      let key = row.dir_key;
      let display = displayDir;
      while (key !== '') {
        const parentKey = dirnameRel(key);
        const parentDisplay = dirnameRel(display);
        ensure(parentKey, parentDisplay);
        key = parentKey;
        display = parentDisplay;
      }
    }

    const ordered = [...nodes.values()].sort((a, b) => b.depth - a.depth);
    for (const node of ordered) {
      if (node.parentKey === null) continue;
      const parent = nodes.get(node.parentKey);
      if (!parent) continue;
      parent.totalFiles += node.totalFiles;
      parent.totalBytes += node.totalBytes;
      parent.totalEffective += node.totalEffective;
    }

    const now = nowIso();
    const insert = this.db.prepare(
      `INSERT INTO dir_stats (root_id, dir_key, rel_path, depth, parent_key, direct_files, direct_bytes,
                              direct_effective_bytes, total_files, total_bytes, total_effective_bytes, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM dir_stats WHERE root_id = ?').run(rootId);
      for (const node of nodes.values()) {
        insert.run(
          rootId,
          node.dirKey,
          node.relPath,
          node.depth,
          node.parentKey,
          node.directFiles,
          node.directBytes,
          node.directEffective,
          node.totalFiles,
          node.totalBytes,
          node.totalEffective,
          now,
        );
      }
    })();

    return nodes.size;
  }

  /* --------------------------------------------------------------- queries */

  rootStats(rootId: string): {
    files: number;
    bytes: number;
    effectiveBytes: number;
    hashedFiles: number;
    deletedFiles: number;
    lastScanAt: string | null;
  } {
    const row = this.db
      .prepare<[string], {
        files: number; bytes: number; effective_bytes: number; hashed: number; deleted: number;
      }>(
        `SELECT
           SUM(CASE WHEN deleted_at IS NULL THEN 1 ELSE 0 END) AS files,
           COALESCE(SUM(CASE WHEN deleted_at IS NULL THEN size_bytes ELSE 0 END), 0) AS bytes,
           COALESCE(SUM(CASE WHEN deleted_at IS NULL THEN size_bytes * duplication_level ELSE 0 END), 0) AS effective_bytes,
           SUM(CASE WHEN deleted_at IS NULL AND hash IS NOT NULL THEN 1 ELSE 0 END) AS hashed,
           SUM(CASE WHEN deleted_at IS NOT NULL THEN 1 ELSE 0 END) AS deleted
         FROM files WHERE root_id = ?`,
      )
      .get(rootId);
    const lastRun = this.db
      .prepare<[string], { finished_at: string | null }>(
        `SELECT finished_at FROM catalog_runs WHERE root_id = ? AND state = 'completed'
          ORDER BY id DESC LIMIT 1`,
      )
      .get(rootId);
    return {
      files: row?.files ?? 0,
      bytes: row?.bytes ?? 0,
      effectiveBytes: row?.effective_bytes ?? 0,
      hashedFiles: row?.hashed ?? 0,
      deletedFiles: row?.deleted ?? 0,
      lastScanAt: lastRun?.finished_at ?? null,
    };
  }

  totals(): { files: number; bytes: number; effectiveBytes: number; hashedFiles: number } {
    const row = this.db
      .prepare<[], { files: number; bytes: number; effective_bytes: number; hashed: number }>(
        `SELECT COUNT(*) AS files,
                COALESCE(SUM(size_bytes), 0) AS bytes,
                COALESCE(SUM(size_bytes * duplication_level), 0) AS effective_bytes,
                SUM(CASE WHEN hash IS NOT NULL THEN 1 ELSE 0 END) AS hashed
           FROM files WHERE deleted_at IS NULL`,
      )
      .get();
    return {
      files: row?.files ?? 0,
      bytes: row?.bytes ?? 0,
      effectiveBytes: row?.effective_bytes ?? 0,
      hashedFiles: row?.hashed ?? 0,
    };
  }

  /** One level of the tree: subdirectories (from the rollups) then files. */
  listDirectory(
    rootId: string,
    relDir: string,
    options: { limit?: number; offset?: number; sort?: 'size' | 'name' } = {},
  ): { entries: DirectoryEntry[]; total: number } {
    const dirKey = normalizeRelPath(relDir).toLowerCase();
    const limit = Math.min(options.limit ?? 500, 5000);
    const offset = options.offset ?? 0;
    const sort = options.sort ?? 'size';

    const dirs = this.db
      .prepare<[string, string], {
        rel_path: string; total_files: number; total_bytes: number; total_effective_bytes: number;
      }>(
        `SELECT rel_path, total_files, total_bytes, total_effective_bytes
           FROM dir_stats WHERE root_id = ? AND parent_key = ?`,
      )
      .all(rootId, dirKey);

    const files = this.db
      .prepare<[string, string], {
        rel_path: string; name: string; size_bytes: number; mtime_ms: number;
        duplication_level: number; hash: string | null;
      }>(
        `SELECT rel_path, name, size_bytes, mtime_ms, duplication_level, hash
           FROM files WHERE root_id = ? AND dir_key = ? AND deleted_at IS NULL`,
      )
      .all(rootId, dirKey);

    const entries: DirectoryEntry[] = [
      ...dirs.map((dir) => ({
        name: basename(dir.rel_path) || dir.rel_path,
        relPath: dir.rel_path,
        kind: 'directory' as const,
        sizeBytes: dir.total_bytes,
        effectiveBytes: dir.total_effective_bytes,
        fileCount: dir.total_files,
        duplicationLevel: null,
        mtimeMs: null,
      })),
      ...files.map((file) => ({
        name: file.name,
        relPath: file.rel_path,
        kind: 'file' as const,
        sizeBytes: file.size_bytes,
        effectiveBytes: effectiveSize(file.size_bytes, file.duplication_level),
        fileCount: 1,
        duplicationLevel: file.duplication_level,
        mtimeMs: file.mtime_ms,
        hash: file.hash,
      })),
    ];

    entries.sort((a, b) => {
      if (sort === 'name') return a.name.localeCompare(b.name);
      if (a.effectiveBytes !== b.effectiveBytes) return b.effectiveBytes - a.effectiveBytes;
      return a.name.localeCompare(b.name);
    });

    return { entries: entries.slice(offset, offset + limit), total: entries.length };
  }

  searchFiles(query: {
    rootId?: string;
    text?: string;
    minSizeBytes?: number;
    ext?: string;
    includeDeleted?: boolean;
    limit?: number;
    offset?: number;
  }): { files: Array<DirectoryEntry & { rootId: string; deletedAt: string | null }>; total: number } {
    const where: string[] = [];
    const params: unknown[] = [];
    if (query.rootId) {
      where.push('root_id = ?');
      params.push(query.rootId);
    }
    if (!query.includeDeleted) where.push('deleted_at IS NULL');
    if (query.text) {
      where.push('path_key LIKE ?');
      params.push(`%${query.text.toLowerCase()}%`);
    }
    if (query.ext) {
      where.push('ext = ?');
      params.push(query.ext.toLowerCase().replace(/^\./, ''));
    }
    if (query.minSizeBytes) {
      where.push('size_bytes >= ?');
      params.push(query.minSizeBytes);
    }
    const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const total =
      this.db.prepare<unknown[], { n: number }>(`SELECT COUNT(*) AS n FROM files ${clause}`).get(...params)
        ?.n ?? 0;
    const rows = this.db
      .prepare<unknown[], {
        root_id: string; rel_path: string; name: string; size_bytes: number; mtime_ms: number;
        duplication_level: number; hash: string | null; deleted_at: string | null;
      }>(
        `SELECT root_id, rel_path, name, size_bytes, mtime_ms, duplication_level, hash, deleted_at
           FROM files ${clause} ORDER BY size_bytes DESC LIMIT ? OFFSET ?`,
      )
      .all(...params, Math.min(query.limit ?? 200, 2000), query.offset ?? 0);

    return {
      total,
      files: rows.map((row) => ({
        rootId: row.root_id,
        name: row.name,
        relPath: row.rel_path,
        kind: 'file' as const,
        sizeBytes: row.size_bytes,
        effectiveBytes: effectiveSize(row.size_bytes, row.duplication_level),
        fileCount: 1,
        duplicationLevel: row.duplication_level,
        mtimeMs: row.mtime_ms,
        hash: row.hash,
        deletedAt: row.deleted_at,
      })),
    };
  }

  /* ----------------------------------------------------------------- diffs */

  diffSummary(runId: number): CatalogDiffSummary {
    const row = this.db
      .prepare<[number], {
        created: number; modified: number; deleted: number; restored: number;
        bytes_added: number; bytes_removed: number;
      }>(
        `SELECT
           SUM(CASE WHEN kind = 'created' THEN 1 ELSE 0 END) AS created,
           SUM(CASE WHEN kind = 'modified' THEN 1 ELSE 0 END) AS modified,
           SUM(CASE WHEN kind = 'deleted' THEN 1 ELSE 0 END) AS deleted,
           SUM(CASE WHEN kind = 'restored' THEN 1 ELSE 0 END) AS restored,
           COALESCE(SUM(CASE WHEN kind IN ('created','restored') THEN size_bytes ELSE 0 END), 0) AS bytes_added,
           COALESCE(SUM(CASE WHEN kind = 'deleted' THEN previous_size_bytes ELSE 0 END), 0) AS bytes_removed
         FROM catalog_changes WHERE run_id = ?`,
      )
      .get(runId);
    const previous = this.db
      .prepare<[number, number], { id: number }>(
        `SELECT id FROM catalog_runs
          WHERE id < ? AND root_id = (SELECT root_id FROM catalog_runs WHERE id = ?)
            AND state = 'completed'
          ORDER BY id DESC LIMIT 1`,
      )
      .get(runId, runId);
    return {
      fromRunId: previous?.id ?? null,
      toRunId: runId,
      created: row?.created ?? 0,
      modified: row?.modified ?? 0,
      deleted: row?.deleted ?? 0,
      restored: row?.restored ?? 0,
      bytesAdded: row?.bytes_added ?? 0,
      bytesRemoved: row?.bytes_removed ?? 0,
    };
  }

  listChanges(query: {
    runId?: number;
    rootId?: string;
    kind?: CatalogChangeKind;
    since?: string;
    search?: string;
    limit?: number;
    offset?: number;
  }): { changes: CatalogChange[]; total: number } {
    const where: string[] = [];
    const params: unknown[] = [];
    if (query.runId !== undefined) {
      where.push('run_id = ?');
      params.push(query.runId);
    }
    if (query.rootId) {
      where.push('root_id = ?');
      params.push(query.rootId);
    }
    if (query.kind) {
      where.push('kind = ?');
      params.push(query.kind);
    }
    if (query.since) {
      where.push('detected_at >= ?');
      params.push(query.since);
    }
    if (query.search) {
      where.push('rel_path LIKE ?');
      params.push(`%${query.search}%`);
    }
    const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const total =
      this.db
        .prepare<unknown[], { n: number }>(`SELECT COUNT(*) AS n FROM catalog_changes ${clause}`)
        .get(...params)?.n ?? 0;
    const rows = this.db
      .prepare<unknown[], {
        id: number; run_id: number; root_id: string; rel_path: string; kind: string;
        size_bytes: number | null; previous_size_bytes: number | null; mtime_ms: number | null;
        previous_mtime_ms: number | null; detected_at: string;
      }>(
        `SELECT * FROM catalog_changes ${clause} ORDER BY id DESC LIMIT ? OFFSET ?`,
      )
      .all(...params, Math.min(query.limit ?? 500, 10_000), query.offset ?? 0);

    return {
      total,
      changes: rows.map((row) => ({
        id: row.id,
        runId: row.run_id,
        rootId: row.root_id,
        relPath: row.rel_path,
        kind: row.kind as CatalogChangeKind,
        sizeBytes: row.size_bytes,
        previousSizeBytes: row.previous_size_bytes,
        mtimeMs: row.mtime_ms,
        previousMtimeMs: row.previous_mtime_ms,
        detectedAt: row.detected_at,
      })),
    };
  }

  /** Prune change records beyond the configured number of runs. */
  pruneChanges(keepRuns: number): number {
    const roots = this.db
      .prepare<[], { root_id: string }>('SELECT DISTINCT root_id FROM catalog_runs')
      .all();
    let removed = 0;
    for (const { root_id: rootId } of roots) {
      const keep = this.db
        .prepare<[string, number], { id: number }>(
          'SELECT id FROM catalog_runs WHERE root_id = ? ORDER BY id DESC LIMIT ?',
        )
        .all(rootId, keepRuns)
        .map((row) => row.id);
      if (keep.length === 0) continue;
      const oldest = Math.min(...keep);
      removed += this.db
        .prepare('DELETE FROM catalog_changes WHERE root_id = ? AND run_id < ?')
        .run(rootId, oldest).changes;
    }
    return removed;
  }

  /* ---------------------------------------------------------------- hashing */

  /**
   * Files that need hashing, worst-first: never-hashed files, then files whose content
   * changed since the last hash, then the oldest hashes due for re-verification.
   */
  hashQueue(rootId: string, rehashIntervalDays: number, limit: number, minSize = 0, maxSize = 0): HashCandidate[] {
    const cutoff =
      rehashIntervalDays > 0
        ? new Date(Date.now() - rehashIntervalDays * 86_400_000).toISOString()
        : null;
    const rows = this.db
      .prepare<[string, number, number, number, string | null, string | null, number], {
        id: number; root_id: string; rel_path: string; size_bytes: number; mtime_ms: number;
        hash: string | null; hash_algorithm: string | null; hash_size_bytes: number | null;
        hash_mtime_ms: number | null; hashed_at: string | null;
      }>(
        `SELECT id, root_id, rel_path, size_bytes, mtime_ms, hash, hash_algorithm,
                hash_size_bytes, hash_mtime_ms, hashed_at
           FROM files
          WHERE root_id = ?
            AND deleted_at IS NULL
            AND hash_error IS NULL
            AND size_bytes >= ?
            AND (? = 0 OR size_bytes <= ?)
            AND (hashed_at IS NULL
                 OR hash_size_bytes != size_bytes
                 OR hash_mtime_ms != mtime_ms
                 OR (? IS NOT NULL AND hashed_at < ?))
          ORDER BY (hashed_at IS NULL) DESC, hashed_at ASC, size_bytes ASC
          LIMIT ?`,
      )
      .all(rootId, minSize, maxSize, maxSize, cutoff, cutoff, limit);
    return rows.map((row) => ({
      id: row.id,
      rootId: row.root_id,
      relPath: row.rel_path,
      sizeBytes: row.size_bytes,
      mtimeMs: row.mtime_ms,
      hash: row.hash,
      hashAlgorithm: row.hash_algorithm,
      hashSizeBytes: row.hash_size_bytes,
      hashMtimeMs: row.hash_mtime_ms,
      hashedAt: row.hashed_at,
    }));
  }

  countHashQueue(rootId: string, rehashIntervalDays: number, minSize = 0, maxSize = 0): number {
    const cutoff =
      rehashIntervalDays > 0
        ? new Date(Date.now() - rehashIntervalDays * 86_400_000).toISOString()
        : null;
    const row = this.db
      .prepare<[string, number, number, number, string | null, string | null], { n: number }>(
        `SELECT COUNT(*) AS n FROM files
          WHERE root_id = ? AND deleted_at IS NULL AND hash_error IS NULL
            AND size_bytes >= ? AND (? = 0 OR size_bytes <= ?)
            AND (hashed_at IS NULL OR hash_size_bytes != size_bytes OR hash_mtime_ms != mtime_ms
                 OR (? IS NOT NULL AND hashed_at < ?))`,
      )
      .get(rootId, minSize, maxSize, maxSize, cutoff, cutoff);
    return row?.n ?? 0;
  }

  recordHash(
    fileId: number,
    hash: string,
    algorithm: string,
    sizeBytes: number,
    mtimeMs: number,
  ): void {
    this.db
      .prepare(
        `UPDATE files SET hash = ?, hash_algorithm = ?, hashed_at = ?, hash_size_bytes = ?,
                          hash_mtime_ms = ?, hash_error = NULL
          WHERE id = ?`,
      )
      .run(hash, algorithm, nowIso(), sizeBytes, mtimeMs, fileId);
  }

  recordHashError(fileId: number, message: string): void {
    this.db.prepare('UPDATE files SET hash_error = ? WHERE id = ?').run(message.slice(0, 500), fileId);
  }

  clearHashErrors(rootId: string): number {
    return this.db
      .prepare('UPDATE files SET hash_error = NULL WHERE root_id = ? AND hash_error IS NOT NULL')
      .run(rootId).changes;
  }

  fileById(id: number) {
    return this.db
      .prepare<[number], {
        id: number; root_id: string; rel_path: string; size_bytes: number; mtime_ms: number;
        hash: string | null; hash_algorithm: string | null; hashed_at: string | null;
        hash_size_bytes: number | null; hash_mtime_ms: number | null; deleted_at: string | null;
        duplication_level: number; first_seen_at: string; last_seen_at: string;
      }>('SELECT * FROM files WHERE id = ?')
      .get(id);
  }

  /* ------------------------------------------------------- disaster recovery */

  /**
   * What is lost if a specific disk dies.
   *
   * Precise only when the disk's `PoolPart.*` folder is catalogued as its own root:
   * then a file is unrecoverable exactly when no sibling pool part holds the same
   * pool-relative path. Without pool-part roots this falls back to the duplication
   * rules, which can only say what *should* have a second copy.
   */
  diskLossImpact(partRootId: string): DiskLossImpact {
    const settings = this.settings.get();
    const root = settings.catalog.roots.find((candidate) => candidate.id === partRootId);
    const siblings = settings.catalog.roots.filter(
      (candidate) =>
        candidate.id !== partRootId &&
        candidate.kind === 'poolpart' &&
        candidate.poolId !== null &&
        candidate.poolId === root?.poolId,
    );

    const generatedAt = nowIso();
    if (!root) {
      return {
        deviceKey: partRootId,
        label: null,
        poolId: null,
        unrecoverableFiles: 0,
        unrecoverableBytes: 0,
        duplicatedFiles: 0,
        duplicatedBytes: 0,
        backedUpFiles: 0,
        backedUpBytes: 0,
        generatedAt,
      };
    }

    if (siblings.length === 0) {
      // Fall back to configured duplication: level 1 means no second copy exists.
      const row = this.db
        .prepare<[string], { files: number; bytes: number; dup_files: number; dup_bytes: number }>(
          `SELECT
             SUM(CASE WHEN duplication_level <= 1 THEN 1 ELSE 0 END) AS files,
             COALESCE(SUM(CASE WHEN duplication_level <= 1 THEN size_bytes ELSE 0 END), 0) AS bytes,
             SUM(CASE WHEN duplication_level > 1 THEN 1 ELSE 0 END) AS dup_files,
             COALESCE(SUM(CASE WHEN duplication_level > 1 THEN size_bytes ELSE 0 END), 0) AS dup_bytes
           FROM files WHERE root_id = ? AND deleted_at IS NULL`,
        )
        .get(partRootId);
      return {
        deviceKey: partRootId,
        label: root.driveLabel || root.name,
        poolId: root.poolId,
        unrecoverableFiles: row?.files ?? 0,
        unrecoverableBytes: row?.bytes ?? 0,
        duplicatedFiles: row?.dup_files ?? 0,
        duplicatedBytes: row?.dup_bytes ?? 0,
        backedUpFiles: 0,
        backedUpBytes: 0,
        generatedAt,
      };
    }

    const placeholders = siblings.map(() => '?').join(', ');
    const row = this.db
      .prepare<unknown[], { files: number; bytes: number }>(
        `SELECT COUNT(*) AS files, COALESCE(SUM(f.size_bytes), 0) AS bytes
           FROM files f
          WHERE f.root_id = ? AND f.deleted_at IS NULL
            AND NOT EXISTS (
              SELECT 1 FROM files o
               WHERE o.root_id IN (${placeholders})
                 AND o.path_key = f.path_key
                 AND o.deleted_at IS NULL)`,
      )
      .get(partRootId, ...siblings.map((sibling) => sibling.id));

    const total = this.db
      .prepare<[string], { files: number; bytes: number }>(
        `SELECT COUNT(*) AS files, COALESCE(SUM(size_bytes), 0) AS bytes
           FROM files WHERE root_id = ? AND deleted_at IS NULL`,
      )
      .get(partRootId);

    return {
      deviceKey: partRootId,
      label: root.driveLabel || root.name,
      poolId: root.poolId,
      unrecoverableFiles: row?.files ?? 0,
      unrecoverableBytes: row?.bytes ?? 0,
      duplicatedFiles: (total?.files ?? 0) - (row?.files ?? 0),
      duplicatedBytes: (total?.bytes ?? 0) - (row?.bytes ?? 0),
      backedUpFiles: 0,
      backedUpBytes: 0,
      generatedAt,
    };
  }

  /** The actual unrecoverable files, for the DR report and its CSV export. */
  listUnrecoverableFiles(
    partRootId: string,
    limit = 1000,
    offset = 0,
  ): { files: Array<{ relPath: string; sizeBytes: number; mtimeMs: number }>; total: number } {
    const settings = this.settings.get();
    const root = settings.catalog.roots.find((candidate) => candidate.id === partRootId);
    const siblings = settings.catalog.roots.filter(
      (candidate) =>
        candidate.id !== partRootId &&
        candidate.kind === 'poolpart' &&
        candidate.poolId !== null &&
        candidate.poolId === root?.poolId,
    );

    if (siblings.length === 0) {
      const rows = this.db
        .prepare<[string, number, number], { rel_path: string; size_bytes: number; mtime_ms: number }>(
          `SELECT rel_path, size_bytes, mtime_ms FROM files
            WHERE root_id = ? AND deleted_at IS NULL AND duplication_level <= 1
            ORDER BY size_bytes DESC LIMIT ? OFFSET ?`,
        )
        .all(partRootId, limit, offset);
      const total =
        this.db
          .prepare<[string], { n: number }>(
            `SELECT COUNT(*) AS n FROM files WHERE root_id = ? AND deleted_at IS NULL AND duplication_level <= 1`,
          )
          .get(partRootId)?.n ?? 0;
      return {
        total,
        files: rows.map((row) => ({
          relPath: row.rel_path,
          sizeBytes: row.size_bytes,
          mtimeMs: row.mtime_ms,
        })),
      };
    }

    const placeholders = siblings.map(() => '?').join(', ');
    const siblingIds = siblings.map((sibling) => sibling.id);
    const condition = `f.root_id = ? AND f.deleted_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM files o WHERE o.root_id IN (${placeholders})
                          AND o.path_key = f.path_key AND o.deleted_at IS NULL)`;
    const rows = this.db
      .prepare<unknown[], { rel_path: string; size_bytes: number; mtime_ms: number }>(
        `SELECT f.rel_path, f.size_bytes, f.mtime_ms FROM files f WHERE ${condition}
          ORDER BY f.size_bytes DESC LIMIT ? OFFSET ?`,
      )
      .all(partRootId, ...siblingIds, limit, offset);
    const total =
      this.db
        .prepare<unknown[], { n: number }>(`SELECT COUNT(*) AS n FROM files f WHERE ${condition}`)
        .get(partRootId, ...siblingIds)?.n ?? 0;

    return {
      total,
      files: rows.map((row) => ({
        relPath: row.rel_path,
        sizeBytes: row.size_bytes,
        mtimeMs: row.mtime_ms,
      })),
    };
  }

  /**
   * Compare the pool root against its pool parts to find files stored fewer times
   * than their duplication rule requires.
   */
  findUnderDuplicated(poolId: string, limit = 500): Array<{
    relPath: string;
    expectedLevel: number;
    observedLevel: number;
    sizeBytes: number;
  }> {
    const settings = this.settings.get();
    const partRoots = settings.catalog.roots.filter(
      (root) => root.kind === 'poolpart' && root.poolId === poolId,
    );
    if (partRoots.length === 0) return [];

    const placeholders = partRoots.map(() => '?').join(', ');
    const rows = this.db
      .prepare<unknown[], {
        path_key: string; rel_path: string; copies: number; size_bytes: number; duplication_level: number;
      }>(
        `SELECT path_key, MIN(rel_path) AS rel_path, COUNT(*) AS copies,
                MAX(size_bytes) AS size_bytes, MAX(duplication_level) AS duplication_level
           FROM files
          WHERE root_id IN (${placeholders}) AND deleted_at IS NULL
          GROUP BY path_key
         HAVING copies < MAX(duplication_level)
          ORDER BY size_bytes DESC
          LIMIT ?`,
      )
      .all(...partRoots.map((root) => root.id), limit);

    return rows.map((row) => ({
      relPath: row.rel_path,
      expectedLevel: row.duplication_level,
      observedLevel: row.copies,
      sizeBytes: row.size_bytes,
    }));
  }

  /** Remove every catalog row for a root — used when a root is deleted from settings. */
  purgeRoot(rootId: string): number {
    return this.db.transaction(() => {
      this.db.prepare('DELETE FROM dir_stats WHERE root_id = ?').run(rootId);
      this.db.prepare('DELETE FROM bitrot_findings WHERE root_id = ?').run(rootId);
      const changes = this.db.prepare('DELETE FROM files WHERE root_id = ?').run(rootId).changes;
      this.db.prepare('DELETE FROM catalog_runs WHERE root_id = ?').run(rootId);
      return changes;
    })();
  }
}
