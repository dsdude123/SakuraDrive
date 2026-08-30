import type { AgentHashResult } from '@sakuradrive/shared';
import type { Db } from '../db/index.js';
import type { BitrotService } from './bitrot-service.js';
import type { CatalogService } from './catalog-service.js';
import type { SettingsService } from './settings-service.js';

export interface HashIngestDeps {
  db: Db;
  catalog: CatalogService;
  bitrot: BitrotService;
  settings: SettingsService;
}

interface FileRow {
  id: number;
  root_id: string;
  rel_path: string;
  size_bytes: number;
  mtime_ms: number;
  hash: string | null;
  hash_algorithm: string | null;
  hashed_at: string | null;
  hash_size_bytes: number | null;
  hash_mtime_ms: number | null;
}

export interface HashIngestResult {
  recorded: number;
  errors: number;
  findings: number;
}

/**
 * Apply hashes the agent computed.
 *
 * This is where bit rot is decided, and it stays on the server for the same reason
 * everything else does: the agent reads bytes, it does not hold opinions. What arrives
 * is a hash plus the size and mtime as of the moment the file was open. Rot is
 * "the content changed while neither of those did", so the comparison needs both, and
 * needs the algorithm to match too -- a hash computed under a different algorithm is
 * not evidence of anything.
 *
 * The agent is told what we hold and re-reads once if its result disagrees, because a
 * controller glitch produces a different hash without the bytes having changed. An
 * unverified disagreement is recorded as such rather than raised as rot.
 */
export function applyAgentHashes(
  deps: HashIngestDeps,
  results: readonly AgentHashResult[],
  algorithm: string,
): HashIngestResult {
  const { db, catalog, bitrot, settings } = deps;
  const config = settings.get();
  const outcome: HashIngestResult = { recorded: 0, errors: 0, findings: 0 };

  const load = db.prepare<[number], FileRow>(
    `SELECT id, root_id, rel_path, size_bytes, mtime_ms, hash, hash_algorithm, hashed_at,
            hash_size_bytes, hash_mtime_ms
       FROM files WHERE id = ?`,
  );

  for (const result of results) {
    if (result.error || !result.hash) {
      catalog.recordHashError(result.fileId, result.error ?? 'The agent returned no hash');
      outcome.errors += 1;
      continue;
    }

    const row = load.get(result.fileId);
    if (!row) continue;

    // The size and mtime the agent saw, not what the catalog last recorded: the file
    // may have been written between the scan and the hash, and that is not rot.
    const sizeBytes = result.sizeBytes ?? row.size_bytes;
    const mtimeMs = result.mtimeMs ?? row.mtime_ms;

    const contentShouldBeIdentical =
      row.hash !== null &&
      row.hash_size_bytes === sizeBytes &&
      row.hash_mtime_ms !== null &&
      Math.abs(row.hash_mtime_ms - mtimeMs) <= config.bitrot.mtimeToleranceMs &&
      row.hash_algorithm === algorithm;

    if (contentShouldBeIdentical && row.hash !== result.hash) {
      const { isNew } = bitrot.record({
        fileId: row.id,
        rootId: row.root_id,
        relPath: row.rel_path,
        sizeBytes,
        mtimeMs,
        expectedHash: row.hash!,
        actualHash: result.hash,
        hashAlgorithm: algorithm,
        previousHashedAt: row.hashed_at,
        // Absent means the agent did not re-read, so it is not confirmed.
        verified: result.verified === true,
      });
      if (isNew) outcome.findings += 1;
    }

    catalog.recordHash(row.id, result.hash, algorithm, sizeBytes, mtimeMs);
    outcome.recorded += 1;
  }

  return outcome;
}
