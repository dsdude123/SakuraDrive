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
import type { SettingsService } from './settings-service.js';

/**
 * One file as recorded into the catalog. Produced by the agent's walk; the shape
 * predates that and is kept because it is the vocabulary the whole write path speaks.
 */
export interface WalkedFile {
  /** Root-relative POSIX path, original casing preserved. */
  relPath: string;
  name: string;
  sizeBytes: number;
  mtimeMs: number;
  ctimeMs: number;
}

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
  /**
   * Record a batch the agent walked, rather than one this container walked.
   *
   * The same write path as a local scan on purpose. Where the bytes were read is a
   * deployment detail; what a scan *means* -- created, modified, restored, and what the
   * deletion sweep may then conclude -- has exactly one implementation, here.
   */
  recordAgentFiles(
    runId: number,
    root: ScanRoot,
    entries: readonly { relPath: string; sizeBytes: number; mtimeMs: number; ctimeMs?: number }[],
  ): number {
    if (entries.length === 0) return 0;
    const config = this.settings.get();
    const duplicationFor = createDuplicationResolver(
      config.duplication.rules.filter(
        (rule) => rule.poolId === null || rule.poolId === root.poolId || root.poolId === null,
      ),
      config.duplication.defaultLevel,
    );

    const files: WalkedFile[] = entries.map((entry) => {
      // The agent speaks Windows; the catalog is normalised to forward slashes with the
      // on-disk casing kept, exactly as the local walker produces.
      const relPath = entry.relPath.replace(/\\/g, '/').replace(/^\/+/, '');
      const name = relPath.slice(relPath.lastIndexOf('/') + 1);
      return {
        relPath,
        name,
        sizeBytes: entry.sizeBytes,
        mtimeMs: entry.mtimeMs,
        ctimeMs: entry.ctimeMs ?? 0,
      };
    });

    this.recordFiles(runId, root, files, duplicationFor);
    return files.length;
  }

  /**
   * Record hashes the agent computed.
   *
   * Size and mtime are re-stated by the agent as of the moment it read the file, and
   * are stored alongside the hash: bit rot is "content changed while those did not", so
   * a hash without them cannot be reasoned about later.
   */
  recordAgentHashes(
    results: readonly {
      fileId: number;
      hash?: string | null;
      sizeBytes?: number | null;
      mtimeMs?: number | null;
      error?: string | null;
    }[],
    algorithm = 'sha256',
  ): number {
    let recorded = 0;
    this.db.transaction(() => {
      for (const result of results) {
        if (result.error || !result.hash) {
          this.recordHashError(result.fileId, result.error ?? 'The agent returned no hash');
          continue;
        }
        this.recordHash(
          result.fileId,
          result.hash,
          algorithm,
          result.sizeBytes ?? 0,
          result.mtimeMs ?? 0,
        );
        recorded += 1;
      }
    })();
    return recorded;
  }

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

  /* --------------------------------------------------- virtual pool views */

  /**
   * The pool is a *view*, not a scanned root.
   *
   * Cataloguing the DrivePool virtual drive as well as its member disks would read
   * every file twice and hash it twice, for a tree the member disks already describe
   * completely. Instead the pool is derived: take the union of its pool-part roots and
   * deduplicate by pool-relative path. That also makes the pool view strictly more
   * informative, because the number of parts holding a path *is* its real duplication.
   *
   * Virtual pools are addressed by the synthetic root id `pool:<poolId>`, which flows
   * through browse, search, the treemap and the storage totals like any other root.
   */
  static poolRootId(poolId: string): string {
    return `pool:${poolId}`;
  }

  /** The pool id behind a synthetic root id, or null for a real root. */
  static parsePoolRootId(rootId: string): string | null {
    return rootId.startsWith('pool:') ? rootId.slice('pool:'.length) : null;
  }

  /** Ids of the pool-part roots that make up a pool. */
  partRootIds(poolId: string): string[] {
    return this.settings
      .get()
      .catalog.roots.filter((root) => root.kind === 'poolpart' && root.poolId === poolId && root.enabled)
      .map((root) => root.id);
  }

  /** Every pool that has at least one catalogued member disk. */
  virtualPools(): Array<{ poolId: string; rootId: string; name: string; partRootIds: string[] }> {
    const roots = this.settings.get().catalog.roots;
    const poolIds = [
      ...new Set(
        roots
          .filter((root) => root.kind === 'poolpart' && root.enabled && root.poolId)
          .map((root) => root.poolId as string),
      ),
    ];
    // What the agent reported the pool is called. A pool id is a GUID, so without this
    // the interface labels a pool "Pool d304fce8-5935-..." while the agent has been
    // reporting "DrivePool (J:)" all along.
    const reported = new Map(
      this.db
        .prepare<[], { pool_id: string; name: string | null; drive_letter: string | null }>(
          'SELECT pool_id, name, drive_letter FROM pools',
        )
        .all()
        .map((row) => [row.pool_id, row]),
    );

    return poolIds.map((poolId) => {
      // A `pool` root is the operator overriding the name; otherwise use the agent's.
      const named = roots.find((root) => root.kind === 'pool' && root.poolId === poolId);
      const row = reported.get(poolId);
      const fromAgent = row?.name
        ? row.drive_letter
          ? `${row.name} (${row.drive_letter}:)`
          : row.name
        : null;
      return {
        poolId,
        rootId: CatalogService.poolRootId(poolId),
        name: named?.name ?? fromAgent ?? `Pool ${poolId}`,
        partRootIds: this.partRootIds(poolId),
      };
    });
  }

  /**
   * Which physical disk each pool-part root lives on.
   *
   * This is the crux of the redundancy model. StableBit DrivePool's guarantee is that
   * the N copies of a duplicated file land on N *different physical disks* — that is
   * the entire point of duplication. Counting pool parts is therefore only a valid
   * proxy while every part sits on its own disk. Two parts on one disk (two partitions
   * of the same drive added to the pool) would report "2 copies" for a file that one
   * disk failure destroys outright.
   *
   * So copies are counted per distinct physical disk, and a root whose disk cannot be
   * determined is treated as its own failure domain — the conservative reading, since
   * assuming two unknowns are the same disk would understate redundancy instead.
   */
  partDeviceKeys(rootIds: readonly string[]): Map<string, string> {
    const roots = this.settings.get().catalog.roots;
    const mapping = new Map<string, string>();

    for (const rootId of rootIds) {
      const root = roots.find((candidate) => candidate.id === rootId);
      const label = root?.driveLabel?.trim();

      // The agent reports the physical disk behind each pool part; prefer that.
      let deviceKey: string | null = null;
      if (label) {
        deviceKey =
          this.db
            .prepare<[string], { device_key: string | null }>(
              'SELECT device_key FROM pool_parts WHERE volume_label = ? AND device_key IS NOT NULL LIMIT 1',
            )
            .get(label)?.device_key ?? null;

        if (!deviceKey) {
          const volume = this.db
            .prepare<[string], { device_keys: string }>(
              'SELECT device_keys FROM volumes WHERE label = ? LIMIT 1',
            )
            .get(label);
          deviceKey = volume ? (JSON.parse(volume.device_keys) as string[])[0] ?? null : null;
        }
      }

      // Unknown disk: keep the root as its own failure domain rather than guessing.
      mapping.set(rootId, deviceKey ?? `root:${rootId}`);
    }
    return mapping;
  }

  /**
   * A SQL expression mapping `root_id` to its physical disk, for counting distinct
   * disks rather than distinct parts. Root ids are bound, never interpolated.
   */
  private deviceExpression(rootIds: readonly string[]): { expr: string; params: string[] } {
    const mapping = this.partDeviceKeys(rootIds);
    const params: string[] = [];
    let expr = 'CASE root_id';
    for (const [rootId, deviceKey] of mapping) {
      expr += ' WHEN ? THEN ?';
      params.push(rootId, deviceKey);
    }
    expr += ' ELSE root_id END';
    return { expr, params };
  }

  /**
   * Pool parts of one pool that share a physical disk.
   *
   * Duplication cannot protect anything stored only on these: DrivePool would believe
   * it had placed copies on separate disks when it had not. Worth an alert of its own.
   */
  findPartsSharingADisk(poolId: string): Array<{ deviceKey: string; rootIds: string[]; labels: string[] }> {
    const rootIds = this.partRootIds(poolId);
    const mapping = this.partDeviceKeys(rootIds);
    const roots = this.settings.get().catalog.roots;

    const byDevice = new Map<string, string[]>();
    for (const [rootId, deviceKey] of mapping) {
      // A root whose disk is unknown is its own domain, so it can never collide.
      if (deviceKey.startsWith('root:')) continue;
      byDevice.set(deviceKey, [...(byDevice.get(deviceKey) ?? []), rootId]);
    }

    return [...byDevice.entries()]
      .filter(([, ids]) => ids.length > 1)
      .map(([deviceKey, ids]) => ({
        deviceKey,
        rootIds: ids,
        labels: ids.map((id) => {
          const root = roots.find((candidate) => candidate.id === id);
          return root?.driveLabel || root?.name || id;
        }),
      }));
  }

  /**
   * One row per distinct pool-relative path across a pool's member disks.
   *
   * `copies` is how many parts hold the path, which is the observed duplication —
   * the number that matters, as opposed to the number DrivePool was told to keep.
   */
  private poolFileRows(poolId: string, extraWhere = '', params: unknown[] = []) {
    const rootIds = this.partRootIds(poolId);
    if (rootIds.length === 0) return null;
    const placeholders = rootIds.map(() => '?').join(', ');
    const device = this.deviceExpression(rootIds);
    return {
      // `copies` counts distinct physical disks, because that is what DrivePool's
      // duplication guarantee is about and what survives a disk failure.
      sql: `SELECT path_key,
                   MIN(rel_path)               AS rel_path,
                   MAX(size_bytes)             AS size_bytes,
                   MAX(mtime_ms)               AS mtime_ms,
                   MAX(duplication_level)      AS duplication_level,
                   COUNT(DISTINCT ${device.expr}) AS copies,
                   MAX(hash)                   AS hash
              FROM files
             WHERE root_id IN (${placeholders}) AND deleted_at IS NULL ${extraWhere}
             GROUP BY path_key`,
      params: [...device.params, ...rootIds, ...params],
    };
  }

  /**
   * Build the directory rollups for a virtual pool.
   *
   * Same shape as `rebuildDirStats`, but the source rows are the deduplicated union of
   * the member disks and `effective` bytes are `size × copies present` — what the pool
   * genuinely spends, rather than what the duplication rule asks for.
   */
  rebuildPoolDirStats(poolId: string): number {
    const query = this.poolFileRows(poolId);
    const rootId = CatalogService.poolRootId(poolId);
    if (!query) {
      this.db.prepare('DELETE FROM dir_stats WHERE root_id = ?').run(rootId);
      return 0;
    }

    const rows = this.db
      .prepare<unknown[], { rel_path: string; size_bytes: number; copies: number }>(
        `SELECT rel_path, size_bytes, copies FROM (${query.sql})`,
      )
      .all(...query.params);

    return this.writeDirStats(
      rootId,
      rows.map((row) => ({
        relPath: row.rel_path,
        sizeBytes: row.size_bytes,
        effectiveBytes: row.size_bytes * Math.max(1, row.copies),
      })),
    );
  }

  /** Rebuild every virtual pool whose membership includes this root. */
  rebuildPoolsContaining(rootId: string): void {
    const root = this.settings.get().catalog.roots.find((candidate) => candidate.id === rootId);
    if (!root || root.kind !== 'poolpart' || !root.poolId) return;
    this.rebuildPoolDirStats(root.poolId);
  }

  /**
   * Files that have vanished from every member disk of a pool.
   *
   * A file deleted from one disk but still present on another has not been lost — the
   * pool still serves it. Only a path with no surviving copy is missing from the pool,
   * and that is the list that matters after a disk dies.
   */
  poolMissingFiles(
    poolId: string,
    limit = 500,
    offset = 0,
  ): { files: Array<{ relPath: string; sizeBytes: number; deletedAt: string | null }>; total: number } {
    const rootIds = this.partRootIds(poolId);
    if (rootIds.length === 0) return { files: [], total: 0 };
    const placeholders = rootIds.map(() => '?').join(', ');
    const condition = `root_id IN (${placeholders})
        GROUP BY path_key
        HAVING SUM(CASE WHEN deleted_at IS NULL THEN 1 ELSE 0 END) = 0`;

    const rows = this.db
      .prepare<unknown[], { rel_path: string; size_bytes: number; deleted_at: string | null }>(
        `SELECT MIN(rel_path) AS rel_path, MAX(size_bytes) AS size_bytes, MAX(deleted_at) AS deleted_at
           FROM files WHERE ${condition}
          ORDER BY size_bytes DESC LIMIT ? OFFSET ?`,
      )
      .all(...rootIds, limit, offset);

    const total =
      this.db
        .prepare<unknown[], { n: number }>(
          `SELECT COUNT(*) AS n FROM (SELECT path_key FROM files WHERE ${condition})`,
        )
        .get(...rootIds)?.n ?? 0;

    return {
      total,
      files: rows.map((row) => ({
        relPath: row.rel_path,
        sizeBytes: row.size_bytes,
        deletedAt: row.deleted_at,
      })),
    };
  }

  /**
   * Rebuild the directory rollups used by the storage view.
   *
   * Done as one pass over the catalog plus an in-memory roll-up from the deepest
   * directory upward, which is far cheaper than recursive SQL and keeps the treemap
   * instant regardless of catalog size.
   */
  rebuildDirStats(rootId: string): number {
    const rows = this.db
      .prepare<[string], { rel_path: string; size_bytes: number; duplication_level: number }>(
        `SELECT rel_path, size_bytes, duplication_level
           FROM files WHERE root_id = ? AND deleted_at IS NULL`,
      )
      .all(rootId);

    return this.writeDirStats(
      rootId,
      rows.map((row) => ({
        relPath: row.rel_path,
        sizeBytes: row.size_bytes,
        effectiveBytes: row.size_bytes * Math.max(1, row.duplication_level),
      })),
    );
  }

  /**
   * Aggregate file entries into directory rollups and store them.
   *
   * Rolls up from the deepest directory outward in memory rather than with recursive
   * SQL: one pass, and the storage map then costs a single indexed read per level
   * regardless of how many files the catalog holds.
   */
  private writeDirStats(
    rootId: string,
    entries: ReadonlyArray<{ relPath: string; sizeBytes: number; effectiveBytes: number }>,
  ): number {
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
      const node: Node = {
        dirKey,
        relPath,
        depth,
        parentKey: dirKey === '' ? null : dirnameRel(dirKey),
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
    for (const entry of entries) {
      // `relPath` keeps the on-disk casing; `dirKey` is the lower-cased identity.
      const displayDir = dirnameRel(entry.relPath);
      const node = ensure(displayDir.toLowerCase(), displayDir);
      node.relPath = displayDir;
      node.directFiles += 1;
      node.directBytes += entry.sizeBytes;
      node.directEffective += entry.effectiveBytes;
      node.totalFiles += 1;
      node.totalBytes += entry.sizeBytes;
      node.totalEffective += entry.effectiveBytes;

      // Materialise ancestors so a directory holding only subdirectories still appears.
      let display = displayDir;
      while (display !== '') {
        const parentDisplay = dirnameRel(display);
        ensure(parentDisplay.toLowerCase(), parentDisplay);
        display = parentDisplay;
      }
    }

    for (const node of [...nodes.values()].sort((a, b) => b.depth - a.depth)) {
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
    const poolId = CatalogService.parsePoolRootId(rootId);
    if (poolId !== null) return this.poolStats(poolId);

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

  /** Totals for a virtual pool, read from the rollups its member disks produced. */
  private poolStats(poolId: string) {
    const rootId = CatalogService.poolRootId(poolId);
    const row = this.db
      .prepare<[string], { total_files: number; total_bytes: number; total_effective_bytes: number }>(
        `SELECT total_files, total_bytes, total_effective_bytes
           FROM dir_stats WHERE root_id = ? AND dir_key = ''`,
      )
      .get(rootId);

    const partRoots = this.partRootIds(poolId);
    let hashedFiles = 0;
    let lastScanAt: string | null = null;
    for (const partRoot of partRoots) {
      const stats = this.rootStats(partRoot);
      hashedFiles += stats.hashedFiles;
      // The pool is only as current as its least recently scanned member disk.
      if (stats.lastScanAt && (lastScanAt === null || stats.lastScanAt < lastScanAt)) {
        lastScanAt = stats.lastScanAt;
      }
    }

    return {
      files: row?.total_files ?? 0,
      bytes: row?.total_bytes ?? 0,
      effectiveBytes: row?.total_effective_bytes ?? 0,
      hashedFiles,
      deletedFiles: this.poolMissingFiles(poolId, 0, 0).total,
      lastScanAt: partRoots.length > 0 ? lastScanAt : null,
    };
  }

  /** Files directly in one directory of a virtual pool, deduplicated across disks. */
  private poolFilesInDirectory(poolId: string, dirKey: string) {
    const query = this.poolFileRows(poolId, 'AND dir_key = ?', [dirKey]);
    if (!query) return [];
    return this.db
      .prepare<unknown[], {
        rel_path: string; size_bytes: number; mtime_ms: number; copies: number; hash: string | null;
      }>(`SELECT rel_path, size_bytes, mtime_ms, copies, hash FROM (${query.sql})`)
      .all(...query.params)
      .map((row) => ({
        rel_path: row.rel_path,
        name: basename(row.rel_path),
        size_bytes: row.size_bytes,
        mtime_ms: row.mtime_ms,
        // In a pool view the honest duplication is how many disks hold the file.
        duplication_level: row.copies,
        hash: row.hash,
      }));
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

    const poolId = CatalogService.parsePoolRootId(rootId);
    const files =
      poolId !== null
        ? this.poolFilesInDirectory(poolId, dirKey)
        : this.db
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
    // Searching a virtual pool searches its member disks and collapses duplicates,
    // so a 2x-duplicated file is one result rather than two.
    const poolId = query.rootId ? CatalogService.parsePoolRootId(query.rootId) : null;
    let dedupeByPath = false;
    if (poolId !== null) {
      const rootIds = this.partRootIds(poolId);
      if (rootIds.length === 0) return { files: [], total: 0 };
      where.push(`root_id IN (${rootIds.map(() => '?').join(', ')})`);
      params.push(...rootIds);
      dedupeByPath = true;
    } else if (query.rootId) {
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
    const group = dedupeByPath ? 'GROUP BY path_key' : '';
    const total =
      this.db
        .prepare<unknown[], { n: number }>(
          dedupeByPath
            ? `SELECT COUNT(*) AS n FROM (SELECT path_key FROM files ${clause} ${group})`
            : `SELECT COUNT(*) AS n FROM files ${clause}`,
        )
        .get(...params)?.n ?? 0;
    const rows = this.db
      .prepare<unknown[], {
        root_id: string; rel_path: string; name: string; size_bytes: number; mtime_ms: number;
        duplication_level: number; hash: string | null; deleted_at: string | null;
      }>(
        dedupeByPath
          ? `SELECT MIN(root_id) AS root_id, MIN(rel_path) AS rel_path, MIN(name) AS name,
                    MAX(size_bytes) AS size_bytes, MAX(mtime_ms) AS mtime_ms,
                    COUNT(*) AS duplication_level, MAX(hash) AS hash, MAX(deleted_at) AS deleted_at
               FROM files ${clause} ${group} ORDER BY size_bytes DESC LIMIT ? OFFSET ?`
          : `SELECT root_id, rel_path, name, size_bytes, mtime_ms, duplication_level, hash, deleted_at
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

  /** Files whose last hash attempt failed, so the workflow can alert on them. */
  countHashErrors(rootId: string): number {
    return (
      this.db
        .prepare<[string], { n: number }>(
          'SELECT COUNT(*) AS n FROM files WHERE root_id = ? AND deleted_at IS NULL AND hash_error IS NOT NULL',
        )
        .get(rootId)?.n ?? 0
    );
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
   * The catalog roots that die together with one pool part.
   *
   * The failure domain is a *physical disk*, not a pool part. StableBit DrivePool
   * promises that the N copies of a duplicated file land on N different disks, so the
   * question "what survives if this disk dies?" has to be asked of disks: every pool
   * part sharing the dead disk goes with it, and only parts on other disks survive.
   * Treating one part as the unit would call a file safe because a second copy sits on
   * another partition of the very disk that just failed.
   */
  private failureDomain(partRootId: string) {
    const roots = this.settings.get().catalog.roots;
    const root = roots.find((candidate) => candidate.id === partRootId);
    const peers = roots
      .filter(
        (candidate) =>
          candidate.kind === 'poolpart' &&
          candidate.poolId !== null &&
          candidate.poolId === root?.poolId,
      )
      .map((candidate) => candidate.id);
    const ids = peers.includes(partRootId) ? peers : [partRootId, ...peers];

    const mapping = this.partDeviceKeys(ids);
    const deviceKey = mapping.get(partRootId) ?? `root:${partRootId}`;

    const lost: string[] = [];
    const surviving: string[] = [];
    for (const id of ids) {
      if (mapping.get(id) === deviceKey) lost.push(id);
      else surviving.push(id);
    }
    return { root, deviceKey, lost, surviving };
  }

  /**
   * What is lost if a specific disk dies.
   *
   * Precise only when the pool's `PoolPart.*` folders are catalogued as their own
   * roots: then a file is unrecoverable exactly when no part on a surviving disk holds
   * the same pool-relative path. With only one part catalogued this falls back to the
   * duplication rules, which can say what *should* have a second copy but not where.
   */
  diskLossImpact(partRootId: string): DiskLossImpact {
    const { root, deviceKey, lost, surviving } = this.failureDomain(partRootId);
    const generatedAt = nowIso();

    if (!root) {
      return {
        deviceKey: partRootId,
        label: null,
        poolId: null,
        sharedDiskRootIds: [],
        unrecoverableFiles: 0,
        unrecoverableBytes: 0,
        duplicatedFiles: 0,
        duplicatedBytes: 0,
        backedUpFiles: 0,
        backedUpBytes: 0,
        generatedAt,
      };
    }

    const base = {
      deviceKey,
      label: root.driveLabel || root.name,
      poolId: root.poolId,
      sharedDiskRootIds: lost.filter((id) => id !== partRootId),
      backedUpFiles: 0,
      backedUpBytes: 0,
      generatedAt,
    };

    if (surviving.length === 0 && lost.length === 1) {
      // Only this part of the pool is catalogued, so the catalog cannot say where the
      // other copies are. Fall back to configured duplication: level 1 means none.
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
        ...base,
        unrecoverableFiles: row?.files ?? 0,
        unrecoverableBytes: row?.bytes ?? 0,
        duplicatedFiles: row?.dup_files ?? 0,
        duplicatedBytes: row?.dup_bytes ?? 0,
      };
    }

    const lostPlaceholders = lost.map(() => '?').join(', ');
    // Distinct pool-relative paths, not rows: a file duplicated onto two parts of this
    // same disk is one file lost, and it is lost, not duplicated.
    const total = this.db
      .prepare<unknown[], { files: number; bytes: number }>(
        `SELECT COUNT(*) AS files, COALESCE(SUM(size_bytes), 0) AS bytes
           FROM (SELECT path_key, MAX(size_bytes) AS size_bytes
                   FROM files
                  WHERE root_id IN (${lostPlaceholders}) AND deleted_at IS NULL
                  GROUP BY path_key)`,
      )
      .get(...lost);

    if (surviving.length === 0) {
      // Every catalogued part of this pool sits on the one disk. Duplication placed no
      // copy beyond it, so the whole of it goes.
      return {
        ...base,
        unrecoverableFiles: total?.files ?? 0,
        unrecoverableBytes: total?.bytes ?? 0,
        duplicatedFiles: 0,
        duplicatedBytes: 0,
      };
    }

    const survivingPlaceholders = surviving.map(() => '?').join(', ');
    const row = this.db
      .prepare<unknown[], { files: number; bytes: number }>(
        `SELECT COUNT(*) AS files, COALESCE(SUM(size_bytes), 0) AS bytes
           FROM (SELECT f.path_key, MAX(f.size_bytes) AS size_bytes
                   FROM files f
                  WHERE f.root_id IN (${lostPlaceholders}) AND f.deleted_at IS NULL
                    AND NOT EXISTS (
                      SELECT 1 FROM files o
                       WHERE o.root_id IN (${survivingPlaceholders})
                         AND o.path_key = f.path_key
                         AND o.deleted_at IS NULL)
                  GROUP BY f.path_key)`,
      )
      .get(...lost, ...surviving);

    return {
      ...base,
      unrecoverableFiles: row?.files ?? 0,
      unrecoverableBytes: row?.bytes ?? 0,
      duplicatedFiles: (total?.files ?? 0) - (row?.files ?? 0),
      duplicatedBytes: (total?.bytes ?? 0) - (row?.bytes ?? 0),
    };
  }

  /** The actual unrecoverable files, for the DR report and its CSV export. */
  listUnrecoverableFiles(
    partRootId: string,
    limit = 1000,
    offset = 0,
  ): { files: Array<{ relPath: string; sizeBytes: number; mtimeMs: number }>; total: number } {
    const { lost, surviving } = this.failureDomain(partRootId);

    const read = (condition: string, params: unknown[]) => {
      const rows = this.db
        .prepare<unknown[], { rel_path: string; size_bytes: number; mtime_ms: number }>(
          `SELECT MIN(f.rel_path) AS rel_path, MAX(f.size_bytes) AS size_bytes,
                  MAX(f.mtime_ms) AS mtime_ms
             FROM files f WHERE ${condition}
            GROUP BY f.path_key
            ORDER BY size_bytes DESC LIMIT ? OFFSET ?`,
        )
        .all(...params, limit, offset);
      const total =
        this.db
          .prepare<unknown[], { n: number }>(
            `SELECT COUNT(*) AS n FROM (SELECT 1 FROM files f WHERE ${condition} GROUP BY f.path_key)`,
          )
          .get(...params)?.n ?? 0;
      return {
        total,
        files: rows.map((row) => ({
          relPath: row.rel_path,
          sizeBytes: row.size_bytes,
          mtimeMs: row.mtime_ms,
        })),
      };
    };

    if (surviving.length === 0 && lost.length === 1) {
      return read('f.root_id = ? AND f.deleted_at IS NULL AND f.duplication_level <= 1', [
        partRootId,
      ]);
    }

    const lostPlaceholders = lost.map(() => '?').join(', ');
    if (surviving.length === 0) {
      return read(`f.root_id IN (${lostPlaceholders}) AND f.deleted_at IS NULL`, [...lost]);
    }

    const survivingPlaceholders = surviving.map(() => '?').join(', ');
    return read(
      `f.root_id IN (${lostPlaceholders}) AND f.deleted_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM files o
                          WHERE o.root_id IN (${survivingPlaceholders})
                            AND o.path_key = f.path_key AND o.deleted_at IS NULL)`,
      [...lost, ...surviving],
    );
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

    const rootIds = partRoots.map((root) => root.id);
    const placeholders = rootIds.map(() => '?').join(', ');
    const device = this.deviceExpression(rootIds);
    const rows = this.db
      .prepare<unknown[], {
        path_key: string; rel_path: string; copies: number; size_bytes: number; duplication_level: number;
      }>(
        // Distinct physical disks, not distinct pool parts: two copies on one disk are
        // one copy as far as surviving that disk's failure goes, and DrivePool's
        // duplication level is a promise about disks.
        `SELECT path_key, MIN(rel_path) AS rel_path,
                COUNT(DISTINCT ${device.expr}) AS copies,
                MAX(size_bytes) AS size_bytes, MAX(duplication_level) AS duplication_level
           FROM files
          WHERE root_id IN (${placeholders}) AND deleted_at IS NULL
          GROUP BY path_key
         HAVING copies < MAX(duplication_level)
          ORDER BY size_bytes DESC
          LIMIT ?`,
      )
      .all(...device.params, ...rootIds, limit);

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
