import type { BitrotFinding, BitrotStatus } from '@sakuradrive/shared';
import { nowIso, type Db } from '../db/index.js';
import type { AlertService } from './alert-service.js';

export interface RecordBitrotInput {
  fileId: number;
  rootId: string;
  relPath: string;
  sizeBytes: number;
  mtimeMs: number;
  expectedHash: string;
  actualHash: string;
  hashAlgorithm: string;
  previousHashedAt: string | null;
  /** True when the file was re-read and the mismatch reproduced. */
  verified: boolean;
}

interface FindingRow {
  id: number;
  file_id: number | null;
  root_id: string;
  rel_path: string;
  size_bytes: number;
  mtime_ms: number;
  expected_hash: string;
  actual_hash: string;
  hash_algorithm: string;
  detected_at: string;
  verified_at: string | null;
  previous_hashed_at: string | null;
  status: string;
  note: string;
  resolved_at: string | null;
}

function toFinding(row: FindingRow): BitrotFinding {
  return {
    id: row.id,
    rootId: row.root_id,
    relPath: row.rel_path,
    sizeBytes: row.size_bytes,
    mtimeMs: row.mtime_ms,
    expectedHash: row.expected_hash,
    actualHash: row.actual_hash,
    hashAlgorithm: row.hash_algorithm,
    detectedAt: row.detected_at,
    verifiedAt: row.verified_at,
    status: row.status as BitrotStatus,
    note: row.note,
    resolvedAt: row.resolved_at,
    previousHashedAt: row.previous_hashed_at,
  };
}

/**
 * Bit-rot findings.
 *
 * A finding is raised when a file's content hash changes while its size *and*
 * modification time stay identical. Nothing legitimate rewrites a file's bytes without
 * touching its mtime, so that combination means the bytes on disk decayed, the
 * controller returned bad data, or something wrote behind the filesystem's back.
 *
 * Findings can be dismissed (a known false positive, e.g. an application that
 * deliberately preserves mtime) or resolved (the file was restored from backup).
 */
export class BitrotService {
  constructor(
    private readonly db: Db,
    private readonly alerts: AlertService,
  ) {}

  /** Record a finding. Re-detecting the same mismatch updates the existing row. */
  record(input: RecordBitrotInput): { finding: BitrotFinding; isNew: boolean } {
    const pathKey = input.relPath.toLowerCase();
    const now = nowIso();
    const existing = this.db
      .prepare<[string, string, string, string], FindingRow>(
        `SELECT * FROM bitrot_findings
          WHERE root_id = ? AND path_key = ? AND expected_hash = ? AND actual_hash = ?`,
      )
      .get(input.rootId, pathKey, input.expectedHash, input.actualHash);

    if (existing) {
      this.db
        .prepare('UPDATE bitrot_findings SET detected_at = ?, verified_at = COALESCE(?, verified_at) WHERE id = ?')
        .run(now, input.verified ? now : null, existing.id);
      return { finding: toFinding({ ...existing, detected_at: now }), isNew: false };
    }

    const info = this.db
      .prepare(
        `INSERT INTO bitrot_findings
           (file_id, root_id, rel_path, path_key, size_bytes, mtime_ms, expected_hash, actual_hash,
            hash_algorithm, detected_at, verified_at, previous_hashed_at, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.fileId,
        input.rootId,
        input.relPath,
        pathKey,
        input.sizeBytes,
        input.mtimeMs,
        input.expectedHash,
        input.actualHash,
        input.hashAlgorithm,
        now,
        input.verified ? now : null,
        input.previousHashedAt,
        input.verified ? 'confirmed' : 'open',
      );
    return { finding: this.byId(Number(info.lastInsertRowid))!, isNew: true };
  }

  byId(id: number): BitrotFinding | null {
    const row = this.db
      .prepare<[number], FindingRow>('SELECT * FROM bitrot_findings WHERE id = ?')
      .get(id);
    return row ? toFinding(row) : null;
  }

  list(query: {
    status?: BitrotStatus | 'active' | 'any';
    rootId?: string;
    search?: string;
    limit?: number;
    offset?: number;
  } = {}): { findings: BitrotFinding[]; total: number } {
    const where: string[] = [];
    const params: unknown[] = [];
    const status = query.status ?? 'active';
    if (status === 'active') where.push(`status IN ('open', 'confirmed')`);
    else if (status !== 'any') {
      where.push('status = ?');
      params.push(status);
    }
    if (query.rootId) {
      where.push('root_id = ?');
      params.push(query.rootId);
    }
    if (query.search) {
      where.push('rel_path LIKE ?');
      params.push(`%${query.search}%`);
    }
    const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const total =
      this.db
        .prepare<unknown[], { n: number }>(`SELECT COUNT(*) AS n FROM bitrot_findings ${clause}`)
        .get(...params)?.n ?? 0;
    const rows = this.db
      .prepare<unknown[], FindingRow>(
        `SELECT * FROM bitrot_findings ${clause} ORDER BY detected_at DESC LIMIT ? OFFSET ?`,
      )
      .all(...params, Math.min(query.limit ?? 200, 2000), query.offset ?? 0);
    return { findings: rows.map(toFinding), total };
  }

  counts(): { open: number; confirmed: number; dismissed: number; resolved: number; lastDetectedAt: string | null } {
    const row = this.db
      .prepare<[], { open: number; confirmed: number; dismissed: number; resolved: number; last: string | null }>(
        `SELECT
           SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) AS open,
           SUM(CASE WHEN status = 'confirmed' THEN 1 ELSE 0 END) AS confirmed,
           SUM(CASE WHEN status = 'dismissed' THEN 1 ELSE 0 END) AS dismissed,
           SUM(CASE WHEN status = 'resolved' THEN 1 ELSE 0 END) AS resolved,
           MAX(detected_at) AS last
         FROM bitrot_findings`,
      )
      .get();
    return {
      open: row?.open ?? 0,
      confirmed: row?.confirmed ?? 0,
      dismissed: row?.dismissed ?? 0,
      resolved: row?.resolved ?? 0,
      lastDetectedAt: row?.last ?? null,
    };
  }

  /** Change a finding's status. Dismissing or resolving stops it counting as a problem. */
  setStatus(id: number, status: BitrotStatus, note?: string): BitrotFinding | null {
    const resolvedAt = status === 'dismissed' || status === 'resolved' ? nowIso() : null;
    this.db
      .prepare(
        'UPDATE bitrot_findings SET status = ?, note = COALESCE(?, note), resolved_at = ? WHERE id = ?',
      )
      .run(status, note ?? null, resolvedAt, id);
    const finding = this.byId(id);
    if (finding) this.syncAlert();
    return finding;
  }

  bulkSetStatus(ids: readonly number[], status: BitrotStatus, note?: string): number {
    let changed = 0;
    this.db.transaction(() => {
      for (const id of ids) {
        if (this.setStatus(id, status, note)) changed += 1;
      }
    })();
    return changed;
  }

  /**
   * One rolled-up alert for all outstanding findings rather than one alert per file —
   * a failing disk can produce thousands, and a Discord channel full of them is worse
   * than useless.
   */
  syncAlert(): void {
    const counts = this.counts();
    const outstanding = counts.open + counts.confirmed;
    const dedupeKey = 'bitrot:summary';
    if (outstanding === 0) {
      this.alerts.resolve(dedupeKey);
      return;
    }
    const worst = this.db
      .prepare<[], { rel_path: string; root_id: string }>(
        `SELECT rel_path, root_id FROM bitrot_findings WHERE status IN ('open','confirmed')
          ORDER BY size_bytes DESC LIMIT 1`,
      )
      .get();
    this.alerts.raise({
      dedupeKey,
      category: 'bitrot',
      severity: counts.confirmed > 0 ? 'critical' : 'warning',
      title: `${outstanding} file${outstanding === 1 ? '' : 's'} may be suffering bit rot`,
      detail:
        `${counts.confirmed} confirmed by re-reading the file, ${counts.open} awaiting verification. ` +
        'These files changed content while their size and modification time stayed the same. ' +
        'Restore them from backup and then mark the findings resolved.',
      context: {
        confirmed: counts.confirmed,
        unverified: counts.open,
        example: worst ? `${worst.root_id}:${worst.rel_path}` : '',
      },
    });
  }

  /** Findings for a file, used when the same path is hashed again. */
  activeForPath(rootId: string, relPath: string): BitrotFinding[] {
    return this.db
      .prepare<[string, string], FindingRow>(
        `SELECT * FROM bitrot_findings WHERE root_id = ? AND path_key = ? AND status IN ('open','confirmed')`,
      )
      .all(rootId, relPath.toLowerCase())
      .map(toFinding);
  }
}
