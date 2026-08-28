import { beforeEach, describe, expect, it, vi } from 'vitest';
import { emptySchedule, fullSchedule, setHour } from '@sakuradrive/shared';
import { openTestDatabase, type Db } from '../db/index.js';
import { createSilentLogger } from '../logger.js';
import { SettingsService } from '../services/settings-service.js';
import { WorkflowManager, type WorkflowContext, type WorkflowDefinition } from './engine.js';

let db: Db;
let settings: SettingsService;
let manager: WorkflowManager;
let clock: Date;

function makeWorkflow(overrides: Partial<WorkflowDefinition> = {}): WorkflowDefinition {
  return {
    id: 'catalog.scan',
    name: 'Catalog scan',
    description: 'test',
    respectsSchedule: true,
    concurrencyGroup: 'io',
    autoStart: true,
    hasWork: () => true,
    run: async () => ({ state: 'completed' }),
    ...overrides,
  };
}

/** Resolves once the workflow's promise settles. */
async function settle(): Promise<void> {
  await manager.drain();
}

beforeEach(() => {
  db = openTestDatabase();
  settings = new SettingsService(db);
  clock = new Date('2024-03-05T03:00:00Z'); // inside the default overnight window
  settings.update({ general: { timezone: 'UTC' }, schedule: { heavyIo: fullSchedule() } });
  manager = new WorkflowManager({ db, settings, logger: createSilentLogger(), now: () => clock });
});

describe('start', () => {
  it('runs a workflow and records a completed run', async () => {
    const run = vi.fn(async () => ({ state: 'completed' as const, stats: { files: 5 } }));
    manager.register(makeWorkflow({ run }));
    const started = await manager.start('catalog.scan');
    await settle();

    expect(run).toHaveBeenCalledOnce();
    const finished = manager.run(started.id)!;
    expect(finished.state).toBe('completed');
    expect(finished.stats.files).toBe(5);
    expect(finished.finishedAt).not.toBeNull();
  });

  it('refuses to start an unknown workflow', async () => {
    await expect(manager.start('backup.verify')).rejects.toThrow(/Unknown workflow/);
  });

  it('refuses to start the same workflow twice', async () => {
    let release = () => {};
    manager.register(
      makeWorkflow({
        run: () => new Promise((resolve) => {
          release = () => resolve({ state: 'completed' });
        }),
      }),
    );
    await manager.start('catalog.scan');
    await expect(manager.start('catalog.scan')).rejects.toThrow(/already running/);
    release();
    await settle();
  });

  it('refuses a second workflow in the same concurrency group', async () => {
    let release = () => {};
    manager.register(
      makeWorkflow({
        run: () => new Promise((resolve) => {
          release = () => resolve({ state: 'completed' });
        }),
      }),
    );
    manager.register(makeWorkflow({ id: 'catalog.hash', name: 'Hash', concurrencyGroup: 'io' }));
    await manager.start('catalog.scan');
    await expect(manager.start('catalog.hash')).rejects.toThrow(/using the disks/);
    release();
    await settle();
  });

  it('allows workflows in different groups to run together', async () => {
    let release = () => {};
    manager.register(
      makeWorkflow({
        run: () => new Promise((resolve) => {
          release = () => resolve({ state: 'completed' });
        }),
      }),
    );
    manager.register(
      makeWorkflow({ id: 'backup.verify', name: 'Backup', concurrencyGroup: null, respectsSchedule: false }),
    );
    await manager.start('catalog.scan');
    await expect(manager.start('backup.verify')).resolves.toBeTruthy();
    release();
    await settle();
  });

  it('refuses a scheduled workflow outside its window', async () => {
    settings.update({ schedule: { heavyIo: emptySchedule() } });
    manager.register(makeWorkflow());
    await expect(manager.start('catalog.scan')).rejects.toThrow(/outside its scheduled window/);
  });

  it('starts outside the window when forced, which is what "Run now" does', async () => {
    settings.update({ schedule: { heavyIo: emptySchedule() } });
    const run = vi.fn(async () => ({ state: 'completed' as const }));
    manager.register(makeWorkflow({ run }));
    await manager.start('catalog.scan', { force: true });
    await settle();
    expect(run).toHaveBeenCalledOnce();
  });

  it('ignores the window entirely for workflows that do not respect it', async () => {
    settings.update({ schedule: { heavyIo: emptySchedule() } });
    manager.register(makeWorkflow({ respectsSchedule: false }));
    await expect(manager.start('catalog.scan')).resolves.toBeTruthy();
    await settle();
  });
});

describe('failure handling', () => {
  it('records the error and marks the run failed', async () => {
    manager.register(
      makeWorkflow({
        run: async () => {
          throw new Error('disk on fire');
        },
      }),
    );
    const started = await manager.start('catalog.scan');
    await settle();
    const run = manager.run(started.id)!;
    expect(run.state).toBe('failed');
    expect(run.error).toBe('disk on fire');
  });

  it('emits failed with the message', async () => {
    const listener = vi.fn();
    manager.on('failed', listener);
    manager.register(
      makeWorkflow({
        run: async () => {
          throw new Error('nope');
        },
      }),
    );
    await manager.start('catalog.scan');
    await settle();
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ state: 'failed' }), 'nope');
  });
});

describe('stop and resume', () => {
  it('asks a workflow to stop and records it as paused with its cursor', async () => {
    let observed: WorkflowContext | null = null;
    manager.register(
      makeWorkflow({
        run: async (ctx) => {
          observed = ctx;
          ctx.setCursor({ nextDirectory: 'Media/Movies' });
          while (ctx.shouldContinue()) await new Promise((r) => setTimeout(r, 5));
          return { state: 'paused' };
        },
      }),
    );
    const started = await manager.start('catalog.scan');
    await new Promise((r) => setTimeout(r, 20));
    expect(manager.stop('catalog.scan')).toBe(true);
    await settle();

    expect(observed).not.toBeNull();
    const run = manager.run(started.id)!;
    expect(run.state).toBe('paused');
    expect(run.cursor).toEqual({ nextDirectory: 'Media/Movies' });
    expect(run.finishedAt).toBeNull();
  });

  it('resumes the paused run rather than starting a new one', async () => {
    const seenCursors: unknown[] = [];
    let shouldPause = true;
    manager.register(
      makeWorkflow({
        run: async (ctx) => {
          seenCursors.push(ctx.getCursor());
          if (shouldPause) {
            ctx.setCursor({ at: 42 });
            return { state: 'paused' };
          }
          return { state: 'completed' };
        },
      }),
    );

    const first = await manager.start('catalog.scan');
    await settle();
    expect(manager.run(first.id)!.state).toBe('paused');

    shouldPause = false;
    const second = await manager.start('catalog.scan');
    await settle();
    expect(second.id).toBe(first.id);
    expect(seenCursors).toEqual([null, { at: 42 }]);
    expect(manager.run(first.id)!.state).toBe('completed');
    expect(manager.run(first.id)!.cursor).toBeNull();
  });

  it('reports stop as false when nothing is running', () => {
    manager.register(makeWorkflow());
    expect(manager.stop('catalog.scan')).toBe(false);
  });

  it('surfaces the stop reason to the workflow', async () => {
    const reasons: string[] = [];
    manager.register(
      makeWorkflow({
        run: async (ctx) => {
          while (ctx.shouldContinue()) await new Promise((r) => setTimeout(r, 5));
          reasons.push(ctx.stopReason());
          return { state: 'paused' };
        },
      }),
    );
    await manager.start('catalog.scan');
    await new Promise((r) => setTimeout(r, 15));
    manager.stop('catalog.scan', 'window-closed');
    await settle();
    expect(reasons).toEqual(['window-closed']);
  });

  it('treats an abort thrown mid-run as a pause, not a failure', async () => {
    manager.register(
      makeWorkflow({
        run: async (ctx) => {
          while (ctx.shouldContinue()) await new Promise((r) => setTimeout(r, 5));
          throw new Error('Aborted');
        },
      }),
    );
    const started = await manager.start('catalog.scan');
    await new Promise((r) => setTimeout(r, 15));
    manager.stop('catalog.scan');
    await settle();
    expect(manager.run(started.id)!.state).toBe('paused');
  });
});

describe('scheduler tick', () => {
  it('starts an autoStart workflow when the window is open and there is work', async () => {
    const run = vi.fn(async () => ({ state: 'completed' as const }));
    manager.register(makeWorkflow({ run }));
    await manager.tick();
    await settle();
    expect(run).toHaveBeenCalledOnce();
  });

  it('does not start when the window is closed', async () => {
    settings.update({ schedule: { heavyIo: emptySchedule() } });
    const run = vi.fn(async () => ({ state: 'completed' as const }));
    manager.register(makeWorkflow({ run }));
    await manager.tick();
    await settle();
    expect(run).not.toHaveBeenCalled();
  });

  it('does not start a workflow with nothing to do', async () => {
    const run = vi.fn(async () => ({ state: 'completed' as const }));
    manager.register(makeWorkflow({ run, hasWork: () => false }));
    await manager.tick();
    await settle();
    expect(run).not.toHaveBeenCalled();
  });

  it('resumes a paused run even when hasWork says no', async () => {
    let phase = 0;
    manager.register(
      makeWorkflow({
        hasWork: () => phase === 0,
        run: async () => {
          phase += 1;
          return phase === 1 ? { state: 'paused' } : { state: 'completed' };
        },
      }),
    );
    await manager.tick();
    await settle();
    expect(phase).toBe(1);

    await manager.tick();
    await settle();
    expect(phase).toBe(2);
  });

  it('asks a scheduled workflow to pause when its window closes', async () => {
    manager.register(
      makeWorkflow({
        run: async (ctx) => {
          while (ctx.shouldContinue()) await new Promise((r) => setTimeout(r, 5));
          return { state: 'paused' };
        },
      }),
    );
    const started = await manager.start('catalog.scan');
    settings.update({ schedule: { heavyIo: emptySchedule() } });
    await manager.tick();
    await settle();
    expect(manager.run(started.id)!.state).toBe('paused');
  });

  it('leaves a forced run alone when the window closes', async () => {
    manager.register(
      makeWorkflow({
        run: async (ctx) => {
          for (let i = 0; i < 3; i += 1) {
            if (!ctx.shouldContinue()) return { state: 'paused' };
            await new Promise((r) => setTimeout(r, 5));
          }
          return { state: 'completed' };
        },
      }),
    );
    const started = await manager.start('catalog.scan', { force: true });
    settings.update({ schedule: { heavyIo: emptySchedule() } });
    await manager.tick();
    await settle();
    expect(manager.run(started.id)!.state).toBe('completed');
  });

  it('respects pauseOutsideWindow being turned off', async () => {
    settings.update({ schedule: { pauseOutsideWindow: false } });
    manager.register(
      makeWorkflow({
        run: async (ctx) => {
          for (let i = 0; i < 3; i += 1) {
            if (!ctx.shouldContinue()) return { state: 'paused' };
            await new Promise((r) => setTimeout(r, 5));
          }
          return { state: 'completed' };
        },
      }),
    );
    const started = await manager.start('catalog.scan');
    settings.update({ schedule: { heavyIo: emptySchedule() } });
    await manager.tick();
    await settle();
    expect(manager.run(started.id)!.state).toBe('completed');
  });

  it('starts catalog scanning before hashing when both are due', async () => {
    const order: string[] = [];
    manager.register(
      makeWorkflow({
        id: 'catalog.hash',
        name: 'Hash',
        run: async () => {
          order.push('hash');
          return { state: 'completed' };
        },
      }),
    );
    manager.register(
      makeWorkflow({
        id: 'catalog.scan',
        name: 'Scan',
        // Scanning has work exactly once, so the second tick must pick hashing.
        hasWork: () => !order.includes('scan'),
        run: async () => {
          order.push('scan');
          return { state: 'completed' };
        },
      }),
    );
    await manager.tick();
    await settle();
    await manager.tick();
    await settle();
    expect(order).toEqual(['scan', 'hash']);
  });

  it('does not overlap ticks', async () => {
    let concurrent = 0;
    let max = 0;
    manager.register(
      makeWorkflow({
        hasWork: async () => {
          concurrent += 1;
          max = Math.max(max, concurrent);
          await new Promise((r) => setTimeout(r, 10));
          concurrent -= 1;
          return false;
        },
      }),
    );
    await Promise.all([manager.tick(), manager.tick(), manager.tick()]);
    expect(max).toBe(1);
  });
});

describe('status', () => {
  it('reports window state and minutes until the next transition', () => {
    settings.update({ schedule: { heavyIo: setHour(emptySchedule(), 2, 4, true) } });
    clock = new Date('2024-03-05T03:30:00Z'); // Tuesday 03:30, window opens at 04:00
    manager.register(makeWorkflow());
    const [status] = manager.status();
    expect(status!.windowOpen).toBe(false);
    expect(status!.minutesUntilWindow).toBe(30);

    clock = new Date('2024-03-05T04:15:00Z');
    const [open] = manager.status();
    expect(open!.windowOpen).toBe(true);
    expect(open!.minutesUntilWindow).toBe(45);
  });

  it('always reports the window as open for workflows that ignore the schedule', () => {
    settings.update({ schedule: { heavyIo: emptySchedule() } });
    manager.register(makeWorkflow({ respectsSchedule: false }));
    expect(manager.status()[0]!.windowOpen).toBe(true);
    expect(manager.status()[0]!.minutesUntilWindow).toBeNull();
  });

  it('exposes the paused run as the current run so the UI can offer resume', async () => {
    manager.register(makeWorkflow({ run: async () => ({ state: 'paused' }) }));
    await manager.start('catalog.scan');
    await settle();
    expect(manager.status()[0]!.currentRun!.state).toBe('paused');
  });

  it('reports the last terminal run separately', async () => {
    manager.register(makeWorkflow({ run: async () => ({ state: 'completed' }) }));
    await manager.start('catalog.scan');
    await settle();
    expect(manager.status()[0]!.lastRun!.state).toBe('completed');
  });
});

describe('progress and logging', () => {
  it('persists progress, stats and a bounded log tail', async () => {
    manager.register(
      makeWorkflow({
        run: async (ctx) => {
          ctx.setProgress({ done: 10, total: 100, unit: 'files', message: 'Scanning Media' });
          ctx.addStat('created', 3);
          ctx.addStat('created', 2);
          for (let i = 0; i < 250; i += 1) ctx.log(`line ${i}`);
          return { state: 'completed' };
        },
      }),
    );
    const started = await manager.start('catalog.scan');
    await settle();
    const run = manager.run(started.id)!;
    expect(run.progress).toMatchObject({ done: 10, total: 100, unit: 'files' });
    expect(run.stats.created).toBe(5);
    expect(run.logTail).toHaveLength(200);
    expect(run.logTail.at(-1)).toContain('line 249');
  });
});

describe('recovery and retention', () => {
  it('turns runs orphaned by a restart into resumable paused runs', () => {
    db.prepare(
      `INSERT INTO workflow_runs (workflow_id, state, trigger, updated_at) VALUES ('catalog.scan', 'running', 'schedule', 'now')`,
    ).run();
    expect(manager.recoverInterruptedRuns()).toBe(1);
    const run = manager.runs('catalog.scan')[0]!;
    expect(run.state).toBe('paused');
    expect(run.error).toContain('restart');
  });

  it('prunes old runs but keeps the most recent', async () => {
    manager.register(makeWorkflow({ run: async () => ({ state: 'completed' }) }));
    for (let i = 0; i < 5; i += 1) {
      await manager.start('catalog.scan');
      await settle();
    }
    expect(manager.pruneRuns(2)).toBe(3);
    expect(manager.runs()).toHaveLength(2);
  });
});
