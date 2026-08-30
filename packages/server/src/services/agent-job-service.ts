import {
  type AgentJob,
  type AgentJobBatch,
  type AgentJobFinish,
  type AgentJobType,
  type ScanRoot,
} from '@sakuradrive/shared';
import type { Db } from '../db/index.js';

/**
 * The queue of work the server hands to the Windows agent.
 *
 * Roots whose `source` is `agent` are read by the agent rather than through a bind
 * mount, because a disk with no drive letter is invisible to the container: WSL2 only
 * surfaces lettered drives, and drvfs will not follow a folder mount point into another
 * volume. Rather than bending the host's disk layout around that, the reading moves to
 * the side of the boundary that can already see everything.
 *
 * The split of responsibility is deliberate. The server keeps the schedule, the cursor,
 * the catalog and the definition of what a scan means; the agent contributes file
 * listings and hashes. So there is one implementation of the interesting logic, the
 * agent stays a thin collector, and nothing about the container's view of the host
 * leaks into the design.
 */
export interface AgentJobRow {
  id: number;
  type: AgentJobType;
  rootId: string;
  hostname: string;
  state: 'queued' | 'claimed' | 'completed' | 'paused' | 'failed' | 'cancelled';
  payload: Record<string, unknown>;
  cursor: unknown;
  stats: Record<string, unknown>;
  error: string | null;
  cancelRequested: boolean;
  workflowRunId: number | null;
  catalogRunId: number | null;
  claimedBy: string | null;
  createdAt: string;
  claimedAt: string | null;
  heartbeatAt: string | null;
  finishedAt: string | null;
}

interface DbRow {
  id: number;
  type: string;
  root_id: string;
  hostname: string;
  state: string;
  payload_json: string;
  cursor_json: string | null;
  stats_json: string;
  error: string | null;
  cancel_requested: number;
  workflow_run_id: number | null;
  catalog_run_id: number | null;
  claimed_by: string | null;
  created_at: string;
  claimed_at: string | null;
  heartbeat_at: string | null;
  finished_at: string | null;
}

function toJob(row: DbRow): AgentJobRow {
  return {
    id: row.id,
    type: row.type as AgentJobType,
    rootId: row.root_id,
    hostname: row.hostname,
    state: row.state as AgentJobRow['state'],
    payload: JSON.parse(row.payload_json) as Record<string, unknown>,
    cursor: row.cursor_json === null ? null : (JSON.parse(row.cursor_json) as unknown),
    stats: JSON.parse(row.stats_json) as Record<string, unknown>,
    error: row.error,
    cancelRequested: row.cancel_requested === 1,
    workflowRunId: row.workflow_run_id,
    catalogRunId: row.catalog_run_id,
    claimedBy: row.claimed_by,
    createdAt: row.created_at,
    claimedAt: row.claimed_at,
    heartbeatAt: row.heartbeat_at,
    finishedAt: row.finished_at,
  };
}

export interface EnqueueInput {
  type: AgentJobType;
  root: ScanRoot;
  workflowRunId: number | null;
  catalogRunId: number | null;
  payload: Record<string, unknown>;
  cursor?: unknown;
}

/** A claimed job that has not been heard from for this long is considered abandoned. */
const DEFAULT_STALE_SECONDS = 300;

export class AgentJobService {
  constructor(
    private readonly db: Db,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * Queue work for a root, or return the job already outstanding for it.
   *
   * One job per root at a time: two agents walking the same tree into the same catalog
   * run would double-count and race on the deletion sweep.
   */
  enqueue(input: EnqueueInput): AgentJobRow {
    const existing = this.activeForRoot(input.root.id);
    if (existing && existing.type === input.type) return existing;

    const id = this.db
      .prepare(
        `INSERT INTO agent_jobs
           (type, root_id, hostname, state, payload_json, cursor_json, stats_json,
            workflow_run_id, catalog_run_id, created_at)
         VALUES (?, ?, ?, 'queued', ?, ?, '{}', ?, ?, ?)`,
      )
      .run(
        input.type,
        input.root.id,
        input.root.agentHostname ?? '',
        JSON.stringify(input.payload),
        input.cursor === undefined ? null : JSON.stringify(input.cursor),
        input.workflowRunId,
        input.catalogRunId,
        this.now().toISOString(),
      ).lastInsertRowid;

    return this.byId(Number(id))!;
  }

  byId(id: number): AgentJobRow | null {
    const row = this.db.prepare<[number], DbRow>('SELECT * FROM agent_jobs WHERE id = ?').get(id);
    return row ? toJob(row) : null;
  }

  /** The outstanding job for a root, if any. */
  activeForRoot(rootId: string): AgentJobRow | null {
    const row = this.db
      .prepare<[string], DbRow>(
        `SELECT * FROM agent_jobs
          WHERE root_id = ? AND state IN ('queued', 'claimed')
          ORDER BY id DESC LIMIT 1`,
      )
      .get(rootId);
    return row ? toJob(row) : null;
  }

  /**
   * Hand the next job to an agent.
   *
   * A job with a hostname is only offered to that host; a blank one goes to whoever
   * asks, which is the single-agent case and the one that needs no configuration.
   */
  claim(hostname: string, staleSeconds = DEFAULT_STALE_SECONDS): AgentJobRow | null {
    this.reclaimAbandoned(staleSeconds);
    const row = this.db
      .prepare<[string], DbRow>(
        `SELECT * FROM agent_jobs
          WHERE state = 'queued' AND (hostname = '' OR hostname = ?)
          ORDER BY id LIMIT 1`,
      )
      .get(hostname);
    if (!row) return null;

    const at = this.now().toISOString();
    this.db
      .prepare(
        `UPDATE agent_jobs SET state = 'claimed', claimed_by = ?, claimed_at = ?, heartbeat_at = ?
          WHERE id = ? AND state = 'queued'`,
      )
      .run(hostname, at, at, row.id);
    return this.byId(row.id);
  }

  /**
   * Put a job whose agent went quiet back on the queue.
   *
   * The agent could be rebooting, or the host could be down. Either way the catalog run
   * it was feeding is left alone: an unfinished scan must never be read as deletions.
   */
  reclaimAbandoned(staleSeconds = DEFAULT_STALE_SECONDS): number {
    const cutoff = new Date(this.now().getTime() - staleSeconds * 1000).toISOString();
    return this.db
      .prepare(
        `UPDATE agent_jobs
            SET state = 'queued', claimed_by = NULL, claimed_at = NULL
          WHERE state = 'claimed' AND COALESCE(heartbeat_at, claimed_at) < ?`,
      )
      .run(cutoff).changes;
  }

  /** Record that the agent is still working, and whether it should keep going. */
  heartbeat(id: number, batch: Pick<AgentJobBatch, 'cursor' | 'dirsDone' | 'dirsRemaining'>): boolean {
    const job = this.byId(id);
    if (!job || job.state !== 'claimed') return false;

    this.db
      .prepare(
        `UPDATE agent_jobs SET heartbeat_at = ?, cursor_json = ?, stats_json = ? WHERE id = ?`,
      )
      .run(
        this.now().toISOString(),
        batch.cursor === undefined ? job.cursor === null ? null : JSON.stringify(job.cursor) : JSON.stringify(batch.cursor ?? null),
        JSON.stringify({ ...job.stats, dirsDone: batch.dirsDone, dirsRemaining: batch.dirsRemaining }),
        id,
      );
    return !job.cancelRequested;
  }

  /**
   * Ask the agent to stop at the next batch boundary.
   *
   * This is how the I/O window reaches across the process boundary. The agent knows
   * nothing about schedules; it just gets told "that's enough" in the reply to its next
   * batch, and posts a cursor so the next window resumes rather than restarts.
   */
  requestCancel(id: number): void {
    this.db.prepare('UPDATE agent_jobs SET cancel_requested = 1 WHERE id = ?').run(id);
  }

  finish(id: number, result: AgentJobFinish): AgentJobRow | null {
    const job = this.byId(id);
    if (!job) return null;
    this.db
      .prepare(
        `UPDATE agent_jobs
            SET state = ?, cursor_json = ?, error = ?, finished_at = ?, stats_json = ?
          WHERE id = ?`,
      )
      .run(
        result.state,
        result.cursor === undefined || result.cursor === null ? null : JSON.stringify(result.cursor),
        result.error ?? null,
        this.now().toISOString(),
        JSON.stringify({
          ...job.stats,
          filesSeen: result.filesSeen,
          bytesSeen: result.bytesSeen,
          dirsDone: result.dirsDone,
        }),
        id,
      );
    return this.byId(id);
  }

  /** Abandon a job outright, e.g. because its root was removed from settings. */
  cancel(id: number, reason: string): void {
    this.db
      .prepare(
        `UPDATE agent_jobs SET state = 'cancelled', error = ?, finished_at = ?
          WHERE id = ? AND state IN ('queued', 'claimed')`,
      )
      .run(reason, this.now().toISOString(), id);
  }

  /** For the interface: what the agent is doing and what it last did. */
  list(limit = 50): AgentJobRow[] {
    return this.db
      .prepare<[number], DbRow>('SELECT * FROM agent_jobs ORDER BY id DESC LIMIT ?')
      .all(limit)
      .map(toJob);
  }

  /** Drop finished jobs older than the retention window. */
  prune(keepDays: number): number {
    const cutoff = new Date(this.now().getTime() - keepDays * 86_400_000).toISOString();
    return this.db
      .prepare(
        `DELETE FROM agent_jobs
          WHERE state IN ('completed', 'failed', 'cancelled') AND finished_at < ?`,
      )
      .run(cutoff).changes;
  }

  /** Shape a stored job as the agent sees it. */
  toWireJob(job: AgentJobRow, root: ScanRoot): AgentJob {
    const payload = job.payload as Partial<AgentJob>;
    return {
      jobId: job.id,
      type: job.type,
      rootId: job.rootId,
      rootName: root.name,
      hostPath: root.hostPath,
      includeGlobs: payload.includeGlobs ?? [],
      excludeGlobs: payload.excludeGlobs ?? [],
      followSymlinks: payload.followSymlinks ?? false,
      batchSize: payload.batchSize ?? 2000,
      cursor: job.cursor,
      hashAlgorithm: payload.hashAlgorithm ?? 'sha256',
      maxBytesPerSecond: payload.maxBytesPerSecond ?? 0,
      files: payload.files ?? [],
    };
  }
}
