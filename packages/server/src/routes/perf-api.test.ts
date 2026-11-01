import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PerfOverview } from '@sakuradrive/shared';
import { PERF_ROOT } from '../services/agent-job-service.js';
import { buildAgentReport } from '../test/helpers.js';
import { createAppHarness, request, type AppHarness } from '../test/app-harness.js';

const CLIENT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../clients/sakuradrive-netperf.py');

let h: AppHarness;
let token: string;

beforeEach(async () => {
  h = await createAppHarness();
  await h.signIn();
  const created = await request(h, { method: 'POST', url: '/api/agents/tokens', payload: { name: 'NAS-01' } });
  token = (JSON.parse(created.body) as { token: { token: string } }).token.token;
});

afterEach(async () => {
  await h.close();
});

const agent = (url: string, payload: unknown) =>
  h.app.inject({ method: 'POST', url, headers: { authorization: `Bearer ${token}` }, payload: payload as never });

describe('benchmark jobs through the agent endpoints', () => {
  /**
   * Every other job belongs to a configured catalog root, and claim and batch both
   * cancel a job whose root is not configured. A benchmark has no root, so without the
   * stand-in it would be cancelled the moment the agent asked for it.
   */
  it('hands out a benchmark job and records what the agent measured', async () => {
    await agent('/api/agent/report', buildAgentReport());
    const job = h.services.agentJobs.enqueue({
      type: 'perf.benchmark',
      root: PERF_ROOT,
      workflowRunId: null,
      catalogRunId: null,
      payload: {
        targets: [{ key: '\\\\?\\Volume{aaaa}\\', label: 'DRIVEPOOL27', kind: 'disk', path: '\\\\?\\Volume{aaaa}\\' }],
        testSizeBytes: 1024 ** 3,
        latencySamples: 64,
      },
    });

    const claim = await agent('/api/agent/jobs/claim', { hostname: 'NAS-01' });
    expect(claim.statusCode).toBe(200);
    const wire = (JSON.parse(claim.body) as { job: Record<string, unknown> }).job;
    expect(wire).toMatchObject({ jobId: job.id, type: 'perf.benchmark', testSizeBytes: 1024 ** 3, latencySamples: 64 });
    expect((wire.targets as unknown[]).length).toBe(1);

    const batch = await agent(`/api/agent/jobs/${job.id}/batch`, {
      perf: [{ key: '\\\\?\\Volume{aaaa}\\', kind: 'disk', bytesTested: 2 * 1024 ** 3, writeMBps: 151.2, readMBps: 183.9, latencyMs: 9.1, latencyP95Ms: 14.3 }],
      dirsDone: 1,
      dirsRemaining: 0,
    });
    expect(JSON.parse(batch.body)).toEqual({ accepted: 1, continue: true });

    const recorded = h.services.perf.latest('disk')[0]!;
    expect(recorded).toMatchObject({ targetLabel: 'DRIVEPOOL27', host: 'NAS-01', readMBps: 183.9, latencyP95Ms: 14.3 });

    const listed = await request(h, { method: 'GET', url: '/api/agents/jobs' });
    expect(listed.body).toContain('Performance benchmark');
  });
});

describe('network results', () => {
  const submission = { client: 'laptop', platform: 'win32', share: '\\\\tokyo-3\\Tier1', bytesTested: 1, writeMBps: 104, readMBps: 112, latencyMs: 3.2 };

  it('accepts a result with an agent token', async () => {
    const response = await agent('/api/agent/perf/network', submission);
    expect(response.statusCode).toBe(200);
    expect(h.services.perf.latest('network')[0]).toMatchObject({ host: 'laptop', readMBps: 112 });
  });

  it('refuses a result without one', async () => {
    const response = await h.app.inject({ method: 'POST', url: '/api/agent/perf/network', payload: submission });
    expect(response.statusCode).toBe(401);
  });

  it('refuses a result missing the share', async () => {
    const response = await agent('/api/agent/perf/network', { client: 'laptop' });
    expect(response.statusCode).toBe(400);
  });
});

describe('the overview and the client download', () => {
  it('reports disks, pools, network and container results together', async () => {
    await agent('/api/agent/report', buildAgentReport());
    await agent('/api/agent/perf/network', { client: 'laptop', share: '\\\\tokyo-3\\Tier1', readMBps: 112 });
    const overview = JSON.parse((await request(h, { method: 'GET', url: '/api/perf' })).body) as PerfOverview;
    expect(overview.enabled).toBe(true);
    expect(overview.disks.map((disk) => disk.label)).toEqual(['DRIVEPOOL27']);
    expect(overview.network.map((result) => result.host)).toEqual(['laptop']);
    expect(overview.lastRunAt).toBeNull();
  });

  // Fetched with curl from machines that have no session.
  it('serves the network client without a session', async () => {
    await request(h, { method: 'POST', url: '/api/auth/logout' });
    const response = await h.app.inject({ method: 'GET', url: '/api/perf/netperf.py' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-disposition']).toContain('sakuradrive-netperf.py');
    expect(response.body).toBe(fs.readFileSync(CLIENT, 'utf8'));
  });
});

/**
 * The real client against the real server, over a real socket: the contract between a
 * Python script and a zod schema is exactly the kind of thing that drifts unnoticed.
 */
describe('the network client end to end', () => {
  it('measures a directory and its result lands in the overview', async () => {
    await h.app.listen({ host: '127.0.0.1', port: 0 });
    const address = h.app.server.address() as { port: number };
    const share = fs.mkdtempSync(path.join(os.tmpdir(), 'sakuradrive-share-'));
    try {
      const output = await new Promise<string>((resolve, reject) => {
        execFile(
          'python3',
          ['-I', CLIENT, '--server', `http://127.0.0.1:${address.port}`, '--token', token, '--share', share, '--size-mb', '4', '--samples', '3', '--client', 'e2e'],
          { timeout: 60_000 },
          (error, stdout, stderr) => (error ? reject(new Error(`${error.message}\n${stderr}`)) : resolve(stdout)),
        );
      });
      expect(output).toContain('MB/s');
      expect(fs.readdirSync(share)).toEqual([]);
      const result = h.services.perf.latest('network').find((entry) => entry.host === 'e2e')!;
      expect(result.targetKey).toBe(share);
      expect(result.writeMBps).toBeGreaterThan(0);
      expect(result.details.platform).toBe('linux');
    } finally {
      fs.rmSync(share, { recursive: true, force: true });
    }
  });
});

describe('the network client', () => {
  // CI runs `npm test` and nothing else, so the client's own suite is run from here.
  it('passes its own unit tests', async () => {
    const result = await new Promise<{ code: number; output: string }>((resolve) => {
      execFile(
        'python3',
        ['-m', 'unittest', 'discover', '-s', path.dirname(CLIENT)],
        { timeout: 120_000 },
        (error, stdout, stderr) => resolve({ code: error ? 1 : 0, output: `${stdout}${stderr}` }),
      );
    });
    expect(result.output).toMatch(/\nOK/);
    expect(result.code).toBe(0);
  }, 120_000);
});
