import { beforeEach, describe, expect, it } from 'vitest';
import type { AgentReport, PerfMeasurement, PerfTarget } from '@sakuradrive/shared';
import { AgentJobService } from '../services/agent-job-service.js';
import { PerfService } from '../services/perf-service.js';
import type { benchmarkPath } from '../services/storage-bench.js';
import { buildAgentReport, createTestContext, type TestContext } from '../test/helpers.js';
import { WorkflowManager } from './engine.js';
import { createPerfBenchmarkWorkflow } from './perf-benchmark.js';

let ctx: TestContext;
let perf: PerfService;
let agentJobs: AgentJobService;
let manager: WorkflowManager;
let workflow: ReturnType<typeof createPerfBenchmarkWorkflow>;
let benchmarked: string[];

const fakeBenchmark: typeof benchmarkPath = async (directory) => {
  benchmarked.push(directory);
  return {
    bytesTested: 1,
    writeMBps: 900,
    readMBps: 1200,
    latencyMs: 0.4,
    latencyP95Ms: 0.9,
    readMayBeCached: false,
    skipped: null,
    error: null,
    details: { fsType: 'ext4' },
  };
};

function hostWithDisks(count: number): AgentReport {
  const base = buildAgentReport();
  const disks = Array.from({ length: count }, (_, i) => i);
  return {
    ...base,
    physicalDisks: disks.map((i) => ({ ...base.physicalDisks[0]!, deviceId: `\\\\.\\PHYSICALDRIVE${i}`, serialNumber: `SN-${i}` })),
    smart: [],
    volumes: disks.map((i) => ({
      ...base.volumes[0]!,
      volumeId: `\\\\?\\Volume{v${i}}\\`,
      label: `DRIVEPOOL${i}`,
      driveLetter: null,
      physicalDiskIds: [`\\\\.\\PHYSICALDRIVE${i}`],
    })),
    pools: [
      {
        ...base.pools[0]!,
        parts: disks.map((i) => ({
          ...base.pools[0]!.parts[0]!,
          partId: `part-${i}`,
          volumeId: `\\\\?\\Volume{v${i}}\\`,
          volumeLabel: `DRIVEPOOL${i}`,
        })),
      },
    ],
  };
}

/**
 * Stands in for the Windows agent: claims the benchmark job, measures each target with
 * `measure`, and posts the results the way the batch endpoint records them.
 */
async function serveBenchmark(measure: (target: PerfTarget) => Partial<PerfMeasurement>): Promise<PerfTarget[] | null> {
  for (let waited = 0; waited < 3000; waited += 20) {
    const job = agentJobs.claim('NAS-01');
    if (job) {
      const targets = (job.payload.targets ?? []) as PerfTarget[];
      perf.recordAgentMeasurements(
        job.workflowRunId,
        'NAS-01',
        targets,
        targets.map((target) => ({ key: target.key, kind: target.kind, bytesTested: 1, readMayBeCached: false, ...measure(target) })),
      );
      agentJobs.finish(job.id, { state: 'completed', filesSeen: targets.length, bytesSeen: 0, dirsDone: targets.length });
      return targets;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return null;
}

async function runBenchmark(measure: (target: PerfTarget) => Partial<PerfMeasurement> = () => ({ readMBps: 180, writeMBps: 150, latencyMs: 8 })) {
  const started = await manager.start('perf.benchmark', { force: true });
  const targets = await serveBenchmark(measure);
  await manager.drain();
  return { run: manager.run(started.id)!, targets };
}

beforeEach(() => {
  ctx = createTestContext();
  perf = new PerfService(ctx.db, ctx.settings, ctx.alerts);
  agentJobs = new AgentJobService(ctx.db);
  benchmarked = [];
  ctx.settings.update({ catalog: { agentPollMs: 200 } });
  manager = new WorkflowManager({ db: ctx.db, settings: ctx.settings, logger: ctx.logger });
  workflow = createPerfBenchmarkWorkflow({
    db: ctx.db,
    settings: ctx.settings,
    perf,
    agentJobs,
    alerts: ctx.alerts,
    dataDir: '/data',
    benchmark: fakeBenchmark,
    readMounts: async () => '/dev/sdd /data ext4 rw 0 0',
  });
  manager.register(workflow);
});

describe('the benchmark run', () => {
  it('measures the container storage, then every disk and pool through the agent', async () => {
    ctx.agents.ingest(hostWithDisks(3));
    ctx.settings.update({
      autoExport: { destinations: [{ id: 'd1', name: 'Tier0', path: '/backup/sakuradrive', enabled: true, retain: 14 }] },
    });
    const { run, targets } = await runBenchmark();

    expect(run.state).toBe('completed');
    expect(benchmarked).toEqual(['/data', '/backup/sakuradrive']);
    expect(targets!.map((target) => `${target.kind}:${target.label}`)).toEqual([
      'disk:DRIVEPOOL0',
      'disk:DRIVEPOOL1',
      'disk:DRIVEPOOL2',
      'pool:HDD Pool',
    ]);
    expect(perf.latest('wsl').map((result) => result.targetLabel)).toEqual([
      'Database (/data)',
      'Export: Tier0 (/backup/sakuradrive)',
    ]);
    expect(run.stats).toMatchObject({ measured: 6, slow: 0, failed: 0 });
  });

  it('hands the agent the configured test size and sample count', async () => {
    ctx.agents.ingest(hostWithDisks(1));
    ctx.settings.update({ perfTest: { diskTestSizeMB: 256, latencySamples: 32 } });
    await manager.start('perf.benchmark', { force: true });
    for (let i = 0; i < 100 && !agentJobs.list().some((job) => job.type === 'perf.benchmark'); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const job = agentJobs.list().find((candidate) => candidate.type === 'perf.benchmark')!;
    expect(job.payload).toMatchObject({ testSizeBytes: 256 * 1024 * 1024, latencySamples: 32 });
    await serveBenchmark(() => ({ readMBps: 100 }));
    await manager.drain();
  });

  it('raises an alert for the disk that came out slow', async () => {
    ctx.agents.ingest(hostWithDisks(4));
    await runBenchmark((target) => ({ readMBps: target.label === 'DRIVEPOOL3' ? 40 : 180, writeMBps: 150, latencyMs: 8 }));
    const alert = ctx.alerts.byKey('bench:slow:\\\\?\\Volume{v3}\\');
    expect(alert?.detail).toBe('Read 40 MB/s against a median of 180 MB/s across 3 comparable disks.');
  });

  it('records the targets it skipped, and why', async () => {
    const report = hostWithDisks(2);
    report.volumes[1] = { ...report.volumes[1]!, freeBytes: 1_000_000_000 };
    ctx.agents.ingest(report);
    const { run } = await runBenchmark();
    expect(run.stats.skipped).toBe(1);
    expect(perf.latest('disk').find((result) => result.targetLabel === 'DRIVEPOOL1')!.skipped).toMatch(/^Not enough free space/);
  });

  it('can leave the container storage out', async () => {
    ctx.agents.ingest(hostWithDisks(1));
    ctx.settings.update({ perfTest: { wsl: { enabled: false } } });
    await runBenchmark();
    expect(benchmarked).toEqual([]);
  });

  // A benchmark the window cut short picks up where it stopped rather than starting over.
  it('does not repeat targets already measured in the same run', async () => {
    ctx.agents.ingest(hostWithDisks(3));
    const runId = (await manager.start('perf.benchmark', { force: true })).id;
    manager.stop('perf.benchmark');
    await manager.drain();
    // The container storage and the first disk made it in before the stop.
    perf.record({ workflowRunId: runId, kind: 'disk', targetKey: '\\\\?\\Volume{v0}\\', targetLabel: 'DRIVEPOOL0', host: 'NAS-01', readMBps: 180 });
    for (const job of agentJobs.list()) agentJobs.cancel(job.id, 'test');

    benchmarked = [];
    const { targets } = await runBenchmark();
    expect(targets!.map((target) => target.label)).toEqual(['DRIVEPOOL1', 'DRIVEPOOL2', 'HDD Pool']);
  });
});

describe('when it is due', () => {
  const definition = () => workflow;

  it('is due when it has never run', async () => {
    expect(await definition().hasWork()).toBe(true);
  });

  it('is not due again until the interval has passed', async () => {
    ctx.agents.ingest(hostWithDisks(1));
    await runBenchmark();
    expect(await definition().hasWork()).toBe(false);
  });

  it('is never due when switched off', async () => {
    ctx.settings.update({ perfTest: { enabled: false } });
    expect(await definition().hasWork()).toBe(false);
  });

  /**
   * It preempts the hashing. A run that failed would otherwise be retried -- and pause
   * the hash -- on every scheduler tick until whatever broke it was fixed.
   */
  it('rests for a while after a failed run rather than retrying every tick', async () => {
    ctx.db
      .prepare(
        `INSERT INTO workflow_runs (workflow_id, state, trigger, started_at, finished_at, updated_at)
         VALUES ('perf.benchmark', 'failed', 'schedule', ?, ?, ?)`,
      )
      .run(new Date().toISOString(), new Date().toISOString(), new Date().toISOString());
    expect(await definition().hasWork()).toBe(false);
  });
});
