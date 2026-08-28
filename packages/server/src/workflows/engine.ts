import { EventEmitter } from 'node:events';
import {
  isAllowedAt,
  isTerminalRunState,
  minutesUntilWindowCloses,
  minutesUntilWindowOpens,
  type WorkflowId,
  type WorkflowProgress,
  type WorkflowRun,
  type WorkflowRunState,
  type WorkflowStatus,
} from '@sakuradrive/shared';
import { fromJson, nowIso, toJson, type Db } from '../db/index.js';
import type { Logger } from '../logger.js';
import type { SettingsService } from '../services/settings-service.js';

export type StopReason = 'none' | 'manual' | 'window-closed' | 'shutdown';

export interface WorkflowContext {
  runId: number;
  params: Record<string, unknown>;
  logger: Logger;
  signal: AbortSignal;
  /**
   * Poll this between units of work. Returns false when the run must wind down —
   * either the operator pressed stop or the I/O window closed. Workflows are expected
   * to save a cursor and return `{ state: 'paused' }` promptly when it goes false.
   */
  shouldContinue(): boolean;
  stopReason(): StopReason;
  setProgress(progress: Partial<WorkflowProgress>): void;
  setCursor(cursor: unknown): void;
  getCursor<T>(): T | null;
  setStats(stats: Record<string, number>): void;
  addStat(key: string, delta: number): void;
  log(message: string): void;
}

export interface WorkflowResult {
  /** `paused` means "there is more to do"; the scheduler resumes it next window. */
  state: 'completed' | 'paused';
  stats?: Record<string, number>;
}

export interface WorkflowDefinition {
  id: WorkflowId;
  name: string;
  description: string;
  /** When true the run only proceeds inside a painted I/O window. */
  respectsSchedule: boolean;
  /** Only one workflow per group runs at a time. */
  concurrencyGroup: string | null;
  /** Start automatically when the window opens and there is work to do. */
  autoStart: boolean;
  /** Cheap check used by the scheduler to avoid starting empty runs. */
  hasWork(): boolean | Promise<boolean>;
  run(ctx: WorkflowContext): Promise<WorkflowResult>;
}

interface RunRow {
  id: number;
  workflow_id: string;
  state: string;
  trigger: string;
  started_at: string | null;
  finished_at: string | null;
  updated_at: string;
  progress_json: string;
  cursor_json: string | null;
  params_json: string;
  stats_json: string;
  log_json: string;
  error: string | null;
}

const EMPTY_PROGRESS: WorkflowProgress = { done: 0, total: null, unit: 'items', message: '' };

function toRun(row: RunRow): WorkflowRun {
  return {
    id: row.id,
    workflowId: row.workflow_id as WorkflowId,
    state: row.state as WorkflowRunState,
    trigger: row.trigger as WorkflowRun['trigger'],
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    updatedAt: row.updated_at,
    progress: fromJson<WorkflowProgress>(row.progress_json, EMPTY_PROGRESS),
    cursor: fromJson<unknown>(row.cursor_json, null),
    params: fromJson<Record<string, unknown>>(row.params_json, {}),
    stats: fromJson<Record<string, number>>(row.stats_json, {}),
    logTail: fromJson<string[]>(row.log_json, []),
    error: row.error,
  };
}

interface ActiveRun {
  runId: number;
  workflowId: WorkflowId;
  controller: AbortController;
  stopReason: StopReason;
  promise: Promise<void>;
}

export interface WorkflowManagerOptions {
  db: Db;
  settings: SettingsService;
  logger: Logger;
  now?: () => Date;
}

/**
 * Runs workflows, respecting the painted I/O schedule.
 *
 * The contract that makes the schedule useful: a workflow is never killed at a window
 * boundary. It is *asked* to stop, saves a cursor and returns `paused`; the next time
 * the window opens the same run resumes from that cursor. A run the operator starts
 * by hand ignores window boundaries entirely — pressing "Run now" at 8pm means run now.
 */
export class WorkflowManager extends EventEmitter {
  private readonly db: Db;
  private readonly settings: SettingsService;
  private readonly logger: Logger;
  private readonly now: () => Date;
  private readonly definitions = new Map<WorkflowId, WorkflowDefinition>();
  private readonly active = new Map<WorkflowId, ActiveRun>();
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;

  constructor(options: WorkflowManagerOptions) {
    super();
    this.db = options.db;
    this.settings = options.settings;
    this.logger = options.logger;
    this.now = options.now ?? (() => new Date());
  }

  register(definition: WorkflowDefinition): void {
    this.definitions.set(definition.id, definition);
  }

  definition(id: WorkflowId): WorkflowDefinition | undefined {
    return this.definitions.get(id);
  }

  list(): WorkflowDefinition[] {
    return [...this.definitions.values()];
  }

  /**
   * Mark runs left mid-flight by a crash or restart as paused so they can be resumed
   * rather than appearing to be running forever.
   */
  recoverInterruptedRuns(): number {
    const info = this.db
      .prepare(
        `UPDATE workflow_runs
            SET state = 'paused', updated_at = ?,
                error = COALESCE(error, 'Interrupted by a service restart')
          WHERE state IN ('running', 'queued')`,
      )
      .run(nowIso());
    return info.changes;
  }

  isRunning(id: WorkflowId): boolean {
    return this.active.has(id);
  }

  windowOpen(): boolean {
    const settings = this.settings.get();
    return isAllowedAt(settings.schedule.heavyIo, this.now(), settings.general.timezone);
  }

  /** Start a workflow. Returns the run, or throws when it cannot start right now. */
  async start(
    id: WorkflowId,
    options: {
      trigger?: WorkflowRun['trigger'];
      params?: Record<string, unknown>;
      /** Ignore the schedule window; what the "Run now" button sends. */
      force?: boolean;
    } = {},
  ): Promise<WorkflowRun> {
    const definition = this.definitions.get(id);
    if (!definition) throw new Error(`Unknown workflow: ${id}`);
    if (this.active.has(id)) throw new Error(`${definition.name} is already running`);

    const force = options.force ?? false;
    if (!force && definition.respectsSchedule && !this.windowOpen()) {
      throw new Error(
        `${definition.name} is outside its scheduled window. Use "Run now" to start it anyway.`,
      );
    }

    if (definition.concurrencyGroup) {
      for (const [otherId, run] of this.active) {
        const other = this.definitions.get(run.workflowId);
        if (otherId !== id && other?.concurrencyGroup === definition.concurrencyGroup) {
          throw new Error(`${other.name} is already using the disks; stop it first`);
        }
      }
    }

    const resumable = this.resumableRun(id);
    const params = { ...(resumable?.params ?? {}), ...(options.params ?? {}), force };
    const runId = resumable
      ? this.resumeRow(resumable.id, params)
      : this.createRow(id, options.trigger ?? 'manual', params);

    const controller = new AbortController();
    const activeRun: ActiveRun = {
      runId,
      workflowId: id,
      controller,
      stopReason: 'none',
      promise: Promise.resolve(),
    };
    this.active.set(id, activeRun);

    activeRun.promise = this.execute(definition, activeRun, params).finally(() => {
      this.active.delete(id);
    });

    const run = this.run(runId)!;
    this.emit('started', run);
    return run;
  }

  /** Ask a running workflow to wind down. It saves its cursor and stops cooperatively. */
  stop(id: WorkflowId, reason: StopReason = 'manual'): boolean {
    const active = this.active.get(id);
    if (!active) return false;
    active.stopReason = reason;
    active.controller.abort();
    this.appendLog(active.runId, `Stop requested (${reason})`);
    return true;
  }

  stopAll(reason: StopReason = 'shutdown'): void {
    for (const id of [...this.active.keys()]) this.stop(id, reason);
  }

  /** Wait for every in-flight workflow to finish. Used on shutdown and in tests. */
  async drain(): Promise<void> {
    await Promise.allSettled([...this.active.values()].map((run) => run.promise));
  }

  /**
   * One scheduler pass. Starts work whose window has opened, and asks running work to
   * pause when its window has closed.
   */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const settings = this.settings.get();
      const open = this.windowOpen();

      // Pause scheduled work whose window just closed. A forced run is left alone.
      if (!open && settings.schedule.pauseOutsideWindow) {
        for (const [id, active] of this.active) {
          const definition = this.definitions.get(id);
          if (!definition?.respectsSchedule) continue;
          const run = this.run(active.runId);
          if (run?.params.force === true) continue;
          if (active.stopReason === 'none') this.stop(id, 'window-closed');
        }
      }

      for (const definition of this.orderedDefinitions()) {
        if (!definition.autoStart) continue;
        // Heavy-I/O workflows wait for a painted window; light ones (verification,
        // exports, retention) run whenever they say they have work.
        if (definition.respectsSchedule && !open) continue;
        if (this.active.has(definition.id)) continue;
        if (this.groupBusy(definition.concurrencyGroup)) continue;

        const resumable = this.resumableRun(definition.id);
        if (resumable && !settings.schedule.autoResume) continue;
        if (!resumable && !(await definition.hasWork())) continue;

        try {
          await this.start(definition.id, { trigger: 'schedule' });
        } catch (error) {
          this.logger.warn({ error, workflow: definition.id }, 'scheduled start failed');
        }
      }
    } finally {
      this.ticking = false;
    }
  }

  startScheduler(intervalMs = 30_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick().catch((error) => this.logger.error({ error }, 'workflow tick failed'));
    }, intervalMs);
    this.timer.unref?.();
  }

  stopScheduler(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /* ------------------------------------------------------------- reporting */

  run(runId: number): WorkflowRun | null {
    const row = this.db
      .prepare<[number], RunRow>('SELECT * FROM workflow_runs WHERE id = ?')
      .get(runId);
    return row ? toRun(row) : null;
  }

  runs(id?: WorkflowId, limit = 50): WorkflowRun[] {
    const rows = id
      ? this.db
          .prepare<[string, number], RunRow>(
            'SELECT * FROM workflow_runs WHERE workflow_id = ? ORDER BY id DESC LIMIT ?',
          )
          .all(id, limit)
      : this.db
          .prepare<[number], RunRow>('SELECT * FROM workflow_runs ORDER BY id DESC LIMIT ?')
          .all(limit);
    return rows.map(toRun);
  }

  status(): WorkflowStatus[] {
    const settings = this.settings.get();
    const timezone = settings.general.timezone;
    const schedule = settings.schedule.heavyIo;
    const open = this.windowOpen();

    return this.orderedDefinitions().map((definition) => {
      const active = this.active.get(definition.id);
      const currentRun = active ? this.run(active.runId) : this.pausedRun(definition.id);
      const lastRow = this.db
        .prepare<[string], RunRow>(
          `SELECT * FROM workflow_runs WHERE workflow_id = ? AND state IN ('completed','failed','cancelled')
            ORDER BY id DESC LIMIT 1`,
        )
        .get(definition.id);
      return {
        id: definition.id,
        name: definition.name,
        description: definition.description,
        respectsSchedule: definition.respectsSchedule,
        enabled: definition.autoStart,
        concurrencyGroup: definition.concurrencyGroup,
        currentRun,
        lastRun: lastRow ? toRun(lastRow) : null,
        minutesUntilWindow: definition.respectsSchedule
          ? open
            ? minutesUntilWindowCloses(schedule, this.now(), timezone)
            : minutesUntilWindowOpens(schedule, this.now(), timezone)
          : null,
        windowOpen: definition.respectsSchedule ? open : true,
      };
    });
  }

  /** Trim run history to the configured limit. */
  pruneRuns(keep: number): number {
    return this.db
      .prepare(
        `DELETE FROM workflow_runs
          WHERE state IN ('completed','failed','cancelled')
            AND id NOT IN (SELECT id FROM workflow_runs
                            WHERE state IN ('completed','failed','cancelled')
                            ORDER BY id DESC LIMIT ?)`,
      )
      .run(keep).changes;
  }

  /* ------------------------------------------------------------- internals */

  private orderedDefinitions(): WorkflowDefinition[] {
    // Cataloguing must precede hashing: hashing a stale file list wastes the window.
    const order: WorkflowId[] = [
      'catalog.scan',
      'catalog.duplication',
      'catalog.hash',
      'backup.verify',
      'export.backup',
      'maintenance.prune',
    ];
    return [...this.definitions.values()].sort(
      (a, b) => order.indexOf(a.id) - order.indexOf(b.id),
    );
  }

  private groupBusy(group: string | null): boolean {
    if (!group) return false;
    for (const active of this.active.values()) {
      if (this.definitions.get(active.workflowId)?.concurrencyGroup === group) return true;
    }
    return false;
  }

  /** The paused run for a workflow, if one is waiting to be resumed. */
  private resumableRun(id: WorkflowId): WorkflowRun | null {
    const row = this.db
      .prepare<[string], RunRow>(
        `SELECT * FROM workflow_runs WHERE workflow_id = ? AND state = 'paused' ORDER BY id DESC LIMIT 1`,
      )
      .get(id);
    return row ? toRun(row) : null;
  }

  private pausedRun(id: WorkflowId): WorkflowRun | null {
    return this.resumableRun(id);
  }

  private createRow(id: WorkflowId, trigger: string, params: Record<string, unknown>): number {
    const now = nowIso();
    const info = this.db
      .prepare(
        `INSERT INTO workflow_runs (workflow_id, state, trigger, started_at, updated_at, params_json, progress_json)
         VALUES (?, 'running', ?, ?, ?, ?, ?)`,
      )
      .run(id, trigger, now, now, toJson(params), toJson(EMPTY_PROGRESS));
    return Number(info.lastInsertRowid);
  }

  private resumeRow(runId: number, params: Record<string, unknown>): number {
    this.db
      .prepare(
        `UPDATE workflow_runs SET state = 'running', updated_at = ?, error = NULL, params_json = ?
          WHERE id = ?`,
      )
      .run(nowIso(), toJson(params), runId);
    this.appendLog(runId, 'Resumed');
    return runId;
  }

  private async execute(
    definition: WorkflowDefinition,
    active: ActiveRun,
    params: Record<string, unknown>,
  ): Promise<void> {
    const { runId } = active;
    const logger = this.logger.child({ workflow: definition.id, runId });
    let lastProgressWrite = 0;
    let progress: WorkflowProgress = { ...EMPTY_PROGRESS };
    let stats = this.run(runId)?.stats ?? {};

    const flushProgress = (force = false) => {
      const now = Date.now();
      // Progress is written at most twice a second: a scan updates it per file.
      if (!force && now - lastProgressWrite < 500) return;
      lastProgressWrite = now;
      this.db
        .prepare('UPDATE workflow_runs SET progress_json = ?, stats_json = ?, updated_at = ? WHERE id = ?')
        .run(toJson(progress), toJson(stats), nowIso(), runId);
    };

    const context: WorkflowContext = {
      runId,
      params,
      logger,
      signal: active.controller.signal,
      shouldContinue: () => active.stopReason === 'none' && !active.controller.signal.aborted,
      stopReason: () => active.stopReason,
      setProgress: (update) => {
        progress = { ...progress, ...update };
        flushProgress();
      },
      setCursor: (cursor) => {
        this.db
          .prepare('UPDATE workflow_runs SET cursor_json = ?, updated_at = ? WHERE id = ?')
          .run(toJson(cursor), nowIso(), runId);
      },
      // `run()` already decodes cursor_json, so hand back the decoded value.
      getCursor: <T,>() => (this.run(runId)?.cursor as T | undefined) ?? null,
      setStats: (next) => {
        stats = { ...stats, ...next };
        flushProgress(true);
      },
      addStat: (key, delta) => {
        stats = { ...stats, [key]: (stats[key] ?? 0) + delta };
        flushProgress();
      },
      log: (message) => {
        logger.info(message);
        this.appendLog(runId, message);
      },
    };

    try {
      const result = await definition.run(context);
      progress = { ...progress, message: result.state === 'paused' ? 'Paused' : 'Finished' };
      stats = { ...stats, ...(result.stats ?? {}) };
      flushProgress(true);
      this.finishRun(runId, result.state === 'paused' ? 'paused' : 'completed', null);
      this.emit(result.state === 'paused' ? 'paused' : 'completed', this.run(runId));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const cancelled = active.stopReason !== 'none';
      flushProgress(true);
      this.finishRun(runId, cancelled ? 'paused' : 'failed', message);
      if (cancelled) {
        logger.info({ reason: active.stopReason }, 'workflow stopped');
        this.emit('paused', this.run(runId));
      } else {
        logger.error({ error }, 'workflow failed');
        this.emit('failed', this.run(runId), message);
      }
    }
  }

  private finishRun(runId: number, state: WorkflowRunState, error: string | null): void {
    const now = nowIso();
    this.db
      .prepare(
        `UPDATE workflow_runs
            SET state = ?, updated_at = ?, error = ?,
                finished_at = CASE WHEN ? IN ('completed','failed','cancelled') THEN ? ELSE NULL END,
                cursor_json = CASE WHEN ? = 'paused' THEN cursor_json ELSE NULL END
          WHERE id = ?`,
      )
      .run(state, now, error, state, now, state, runId);
    if (isTerminalRunState(state)) {
      this.db.prepare('UPDATE workflow_runs SET cursor_json = NULL WHERE id = ?').run(runId);
    }
  }

  private appendLog(runId: number, message: string): void {
    const row = this.db
      .prepare<[number], { log_json: string }>('SELECT log_json FROM workflow_runs WHERE id = ?')
      .get(runId);
    const log = fromJson<string[]>(row?.log_json, []);
    log.push(`${nowIso()} ${message}`);
    // Keep the tail bounded; the full history lives in the container log.
    while (log.length > 200) log.shift();
    this.db.prepare('UPDATE workflow_runs SET log_json = ? WHERE id = ?').run(toJson(log), runId);
  }
}
