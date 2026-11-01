import fs from 'node:fs/promises';
import type { WorkflowId } from '@sakuradrive/shared';
import type { AlertService } from '../services/alert-service.js';
import { PERF_ROOT, type AgentJobService } from '../services/agent-job-service.js';
import type { PerfService } from '../services/perf-service.js';
import type { SettingsService } from '../services/settings-service.js';
import { benchmarkPath } from '../services/storage-bench.js';
import type { Db } from '../db/index.js';
import type { WorkflowContext, WorkflowDefinition, WorkflowResult } from './engine.js';
import { hoursSince, lastCompletedAt } from './support.js';

const MiB = 1024 * 1024;
const ID: WorkflowId = 'perf.benchmark';

export interface PerfBenchmarkDeps {
  db: Db;
  settings: SettingsService;
  perf: PerfService;
  agentJobs: AgentJobService;
  alerts: AlertService;
  /** The container's data directory: the database lives here. */
  dataDir: string;
  /** Injected in tests, which should not write hundreds of megabytes. */
  benchmark?: typeof benchmarkPath;
  readMounts?: () => Promise<string>;
}

/**
 * Benchmark every disk, every pool and the container's own storage.
 *
 * Runs inside the I/O window, and preempts the hashing that otherwise owns it: a few
 * minutes of benchmark, then the hash resumes from its cursor. Results that are already
 * in for this run are not repeated, so a benchmark the window cut short picks up with
 * the targets it had not reached.
 */
export function createPerfBenchmarkWorkflow(deps: PerfBenchmarkDeps): WorkflowDefinition {
  const { db, settings, perf, agentJobs, alerts } = deps;
  const benchmark = deps.benchmark ?? benchmarkPath;
  const readMounts = deps.readMounts ?? (() => fs.readFile('/proc/mounts', 'utf8').catch(() => ''));

  /** The paths inside the container worth measuring: the database, and every export destination. */
  const storageTargets = () => {
    const config = settings.get();
    const targets = [{ path: deps.dataDir, label: `Database (${deps.dataDir})` }];
    for (const destination of config.autoExport.destinations) {
      if (!destination.enabled) continue;
      if (targets.some((target) => target.path === destination.path)) continue;
      targets.push({ path: destination.path, label: `Export: ${destination.name} (${destination.path})` });
    }
    return targets;
  };

  return {
    id: ID,
    name: 'Performance benchmark',
    description:
      'Writes a temporary file to every disk, every pool and the container’s own storage, reads it back, times both and removes it. Flags disks well below comparable disks or their own recent results.',
    respectsSchedule: true,
    concurrencyGroup: 'io',
    autoStart: true,
    preempts: true,

    hasWork: () => {
      const config = settings.get().perfTest;
      if (!config.enabled) return false;
      // A run that just failed would otherwise be retried, and preempt the hashing, on
      // every tick until something changed. Give it a rest.
      const last = db
        .prepare<[string], { state: string; finished_at: string | null }>(
          'SELECT state, finished_at FROM workflow_runs WHERE workflow_id = ? ORDER BY id DESC LIMIT 1',
        )
        .get(ID);
      if (last?.state === 'failed' && hoursSince(last.finished_at) < 6) return false;
      return hoursSince(lastCompletedAt(db, ID)) >= config.intervalDays * 24;
    },

    async run(ctx: WorkflowContext): Promise<WorkflowResult> {
      const config = settings.get().perfTest;
      if (!config.enabled) {
        ctx.log('Performance benchmarking is switched off in settings.');
        return { state: 'completed' };
      }
      const done = new Set(perf.forRun(ctx.runId).map((result) => `${result.kind}:${result.targetKey}`));

      if (config.wsl.enabled) {
        const mounts = await readMounts();
        for (const target of storageTargets()) {
          if (!ctx.shouldContinue()) return { state: 'paused' };
          if (done.has(`wsl:${target.path}`)) continue;
          ctx.setProgress({ message: `Benchmarking ${target.label}` });
          const measured = await benchmark(target.path, {
            sizeBytes: config.wsl.testSizeMB * MiB,
            syncSamples: config.wsl.syncSamples,
            mountsText: mounts,
          });
          perf.record({ workflowRunId: ctx.runId, kind: 'wsl', targetKey: target.path, targetLabel: target.label, host: 'container', ...measured });
          ctx.log(describe(target.label, measured));
        }
      }

      const { targets, skipped } = perf.buildTargets();
      for (const target of skipped) {
        if (done.has(`${target.kind}:${target.key}`)) continue;
        perf.record({ workflowRunId: ctx.runId, kind: target.kind, targetKey: target.key, targetLabel: target.label, host: '', skipped: target.reason });
        ctx.log(`Skipped ${target.label}: ${target.reason}`);
      }

      const remaining = targets.filter((target) => !done.has(`${target.kind}:${target.key}`));
      if (remaining.length > 0) {
        const outcome = await benchmarkViaAgent(ctx, remaining);
        if (outcome === 'paused') return { state: 'paused' };
      }

      const { slow, failed } = perf.evaluateRun(ctx.runId);
      const results = perf.forRun(ctx.runId);
      ctx.log(`Measured ${results.filter((result) => !result.skipped && !result.error).length} targets; ${slow} slow, ${failed} failed.`);
      return {
        state: 'completed',
        stats: {
          measured: results.filter((result) => !result.skipped && !result.error).length,
          skipped: results.filter((result) => result.skipped).length,
          failed,
          slow,
        },
      };
    },
  };

  async function benchmarkViaAgent(
    ctx: WorkflowContext,
    targets: ReturnType<PerfService['buildTargets']>['targets'],
  ): Promise<'completed' | 'paused' | 'unavailable'> {
    const config = settings.get();
    const job = agentJobs.enqueue({
      type: 'perf.benchmark',
      root: PERF_ROOT,
      workflowRunId: ctx.runId,
      catalogRunId: null,
      payload: {
        targets,
        testSizeBytes: config.perfTest.diskTestSizeMB * MiB,
        latencySamples: config.perfTest.latencySamples,
      },
    });

    let cancelRequested = false;
    for (;;) {
      const current = agentJobs.byId(job.id);
      if (!current) return 'completed';

      if (current.state === 'queued') {
        const waited = (Date.now() - Date.parse(current.createdAt)) / 1000;
        if (waited > config.catalog.agentClaimTimeoutSeconds) {
          agentJobs.cancel(job.id, `No agent claimed this job within ${Math.round(waited)}s.`);
          ctx.log('No agent took the benchmark; disks and pools were not measured.');
          alerts.raise({
            dedupeKey: 'bench:agent-unavailable',
            category: 'performance',
            severity: 'warning',
            title: 'Benchmark not run: no agent took the job',
            detail: `Waited ${Math.round(waited)}s.`,
          });
          return 'unavailable';
        }
      }

      if (!ctx.shouldContinue() && !cancelRequested) {
        agentJobs.requestCancel(job.id);
        cancelRequested = true;
      }
      if (cancelRequested && current.state === 'queued') {
        agentJobs.cancel(job.id, 'The I/O window closed before an agent took this job.');
        return 'paused';
      }

      const stats = current.stats as { dirsDone?: number; dirsRemaining?: number };
      ctx.setProgress({
        done: stats.dirsDone ?? 0,
        total: (stats.dirsDone ?? 0) + (stats.dirsRemaining ?? targets.length),
        unit: 'targets',
        message: 'Benchmarking disks via the agent',
      });

      if (current.state === 'completed') {
        alerts.resolve('bench:agent-unavailable');
        return 'completed';
      }
      if (current.state === 'paused') return 'paused';
      if (current.state === 'failed' || current.state === 'cancelled') {
        ctx.log(`The agent's benchmark stopped: ${current.error ?? 'no reason given'}`);
        return 'completed';
      }

      await new Promise((resolve) => setTimeout(resolve, config.catalog.agentPollMs));
    }
  }
}

function describe(label: string, measured: { skipped: string | null; error: string | null; writeMBps: number | null; readMBps: number | null; latencyMs: number | null }): string {
  if (measured.skipped) return `Skipped ${label}: ${measured.skipped}`;
  if (measured.error) return `${label} failed: ${measured.error}`;
  const fixed = (value: number | null, digits = 0) => (value === null ? '?' : value.toFixed(digits));
  return `${label}: write ${fixed(measured.writeMBps)} MB/s, read ${fixed(measured.readMBps)} MB/s, synced 4 KiB write ${fixed(measured.latencyMs, 2)} ms`;
}
