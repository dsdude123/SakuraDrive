import { beforeEach, describe, expect, it } from 'vitest';
import { openTestDatabase, type Db } from '../db/index.js';
import { AgentJobService } from './agent-job-service.js';
import { SettingsService } from './settings-service.js';

let db: Db;
let settings: SettingsService;
let jobs: AgentJobService;
let clock: Date;

/** A pool disk with no drive letter: the container cannot read it, the agent can. */
const ROOT = {
  id: 'dp16',
  name: 'DRIVEPOOL16',
  kind: 'poolpart' as const,
  poolId: 'hdd',
  source: 'agent' as const,
  agentHostname: '',
  containerPath: '',
  hostPath: '\\\\?\\Volume{9f3a}\\PoolPart.d304fce8',
  driveLabel: 'DRIVEPOOL16',
};

beforeEach(() => {
  db = openTestDatabase();
  settings = new SettingsService(db);
  clock = new Date('2026-08-29T12:00:00.000Z');
  jobs = new AgentJobService(db, () => clock);
  settings.update({ catalog: { roots: [ROOT] } });
});

const root = () => settings.get().catalog.roots[0]!;

function enqueueScan() {
  return jobs.enqueue({
    type: 'catalog.scan',
    root: root(),
    workflowRunId: 1,
    catalogRunId: 7,
    payload: { batchSize: 500, excludeGlobs: ['Temp/**'] },
  });
}

describe('queueing', () => {
  it('queues a job carrying what the agent needs to do the walk', () => {
    const job = enqueueScan();
    expect(job.state).toBe('queued');
    expect(job.rootId).toBe('dp16');
    expect(job.catalogRunId).toBe(7);

    const wire = jobs.toWireJob(job, root());
    expect(wire.hostPath).toBe('\\\\?\\Volume{9f3a}\\PoolPart.d304fce8');
    expect(wire.batchSize).toBe(500);
    expect(wire.excludeGlobs).toEqual(['Temp/**']);
  });

  // Two agents walking one tree into one catalog run would double-count the files and
  // race on the deletion sweep that follows it.
  it('will not queue a second job for a root that already has one', () => {
    const first = enqueueScan();
    const second = enqueueScan();
    expect(second.id).toBe(first.id);
    expect(jobs.list()).toHaveLength(1);
  });

  it('queues again once the outstanding job has finished', () => {
    const first = enqueueScan();
    jobs.finish(first.id, { state: 'completed', filesSeen: 3, bytesSeen: 30, dirsDone: 1 });
    expect(enqueueScan().id).not.toBe(first.id);
  });
});

describe('claiming', () => {
  it('hands an unassigned job to whichever agent asks', () => {
    const queued = enqueueScan();
    const claimed = jobs.claim('tokyo-3')!;
    expect(claimed.id).toBe(queued.id);
    expect(claimed.state).toBe('claimed');
    expect(claimed.claimedBy).toBe('tokyo-3');
  });

  it('does not hand the same job to a second agent', () => {
    enqueueScan();
    expect(jobs.claim('tokyo-3')).not.toBeNull();
    expect(jobs.claim('other-host')).toBeNull();
  });

  it('offers a host-specific job only to that host', () => {
    settings.update({ catalog: { roots: [{ ...ROOT, agentHostname: 'tokyo-3' }] } });
    enqueueScan();
    expect(jobs.claim('someone-else')).toBeNull();
    expect(jobs.claim('tokyo-3')).not.toBeNull();
  });

  it('returns nothing when there is no work', () => {
    expect(jobs.claim('tokyo-3')).toBeNull();
  });
});

describe('an agent that goes quiet', () => {
  // The host could be rebooting. The job goes back on the queue; the catalog run it was
  // feeding is untouched, because an unfinished scan must never be read as deletions.
  it('puts the job back on the queue after the stale window', () => {
    enqueueScan();
    jobs.claim('tokyo-3');

    clock = new Date('2026-08-29T12:02:00.000Z');
    expect(jobs.claim('tokyo-3')).toBeNull();

    clock = new Date('2026-08-29T12:10:00.000Z');
    const reclaimed = jobs.claim('tokyo-3');
    expect(reclaimed?.state).toBe('claimed');
  });

  it('keeps the job while the agent is still reporting in', () => {
    const job = enqueueScan();
    jobs.claim('tokyo-3');
    clock = new Date('2026-08-29T12:04:00.000Z');
    jobs.heartbeat(job.id, { cursor: { worklist: ['Tier1'] }, dirsDone: 10, dirsRemaining: 4 });

    clock = new Date('2026-08-29T12:08:00.000Z');
    expect(jobs.claim('tokyo-3')).toBeNull();
    expect(jobs.byId(job.id)!.state).toBe('claimed');
  });

  it('keeps the cursor, so a reclaimed job resumes rather than restarts', () => {
    const job = enqueueScan();
    jobs.claim('tokyo-3');
    jobs.heartbeat(job.id, { cursor: { worklist: ['Tier1/Movies'] }, dirsDone: 10, dirsRemaining: 4 });

    clock = new Date('2026-08-29T12:30:00.000Z');
    const reclaimed = jobs.claim('tokyo-3')!;
    expect(reclaimed.cursor).toEqual({ worklist: ['Tier1/Movies'] });
  });
});

describe('stopping at the window edge', () => {
  // The agent knows nothing about schedules. It is told "that's enough" in the reply to
  // its next batch, which is how the I/O window reaches across the process boundary.
  it('tells the agent to keep going until a cancel is requested', () => {
    const job = enqueueScan();
    jobs.claim('tokyo-3');
    expect(jobs.heartbeat(job.id, { cursor: null, dirsDone: 1, dirsRemaining: 9 })).toBe(true);

    jobs.requestCancel(job.id);
    expect(jobs.heartbeat(job.id, { cursor: null, dirsDone: 2, dirsRemaining: 8 })).toBe(false);
  });

  it('refuses batches for a job that is not claimed', () => {
    const job = enqueueScan();
    expect(jobs.heartbeat(job.id, { cursor: null, dirsDone: 1, dirsRemaining: 0 })).toBe(false);
  });

  it('records a pause with its cursor', () => {
    const job = enqueueScan();
    jobs.claim('tokyo-3');
    const finished = jobs.finish(job.id, {
      state: 'paused',
      cursor: { worklist: ['Tier2'] },
      filesSeen: 1200,
      bytesSeen: 4096,
      dirsDone: 30,
    })!;
    expect(finished.state).toBe('paused');
    expect(finished.cursor).toEqual({ worklist: ['Tier2'] });
    expect(finished.stats.filesSeen).toBe(1200);
  });

  it('records a failure with its reason', () => {
    const job = enqueueScan();
    jobs.claim('tokyo-3');
    const finished = jobs.finish(job.id, {
      state: 'failed',
      error: 'The volume is offline',
      filesSeen: 0,
      bytesSeen: 0,
      dirsDone: 0,
    })!;
    expect(finished.state).toBe('failed');
    expect(finished.error).toBe('The volume is offline');
  });
});

describe('housekeeping', () => {
  it('cancels an outstanding job, e.g. when its root is removed', () => {
    const job = enqueueScan();
    jobs.cancel(job.id, 'Root removed from settings');
    expect(jobs.byId(job.id)!.state).toBe('cancelled');
    expect(jobs.claim('tokyo-3')).toBeNull();
  });

  it('leaves a finished job alone when cancelling', () => {
    const job = enqueueScan();
    jobs.finish(job.id, { state: 'completed', filesSeen: 1, bytesSeen: 1, dirsDone: 1 });
    jobs.cancel(job.id, 'too late');
    expect(jobs.byId(job.id)!.state).toBe('completed');
  });

  it('prunes finished jobs but never an outstanding one', () => {
    const old = enqueueScan();
    jobs.finish(old.id, { state: 'completed', filesSeen: 1, bytesSeen: 1, dirsDone: 1 });
    const current = enqueueScan();

    clock = new Date('2026-09-29T12:00:00.000Z');
    expect(jobs.prune(14)).toBe(1);
    expect(jobs.byId(old.id)).toBeNull();
    expect(jobs.byId(current.id)).not.toBeNull();
  });
});
