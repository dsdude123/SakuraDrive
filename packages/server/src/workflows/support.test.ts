import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openTestDatabase, type Db } from '../db/index.js';
import { createSilentLogger } from '../logger.js';
import { AgentService } from '../services/agent-service.js';
import { AgentJobService } from '../services/agent-job-service.js';
import { AlertService } from '../services/alert-service.js';
import { AuthService } from '../services/auth-service.js';
import { CatalogService } from '../services/catalog-service.js';
import { SettingsService } from '../services/settings-service.js';
import { WorkflowManager } from './engine.js';
import { createMaintenanceWorkflow } from './maintenance-prune.js';
import { createTempDir } from '../test/helpers.js';
import { hoursSince, isDailyJobDue, lastCompletedAt } from './support.js';

describe('lastCompletedAt', () => {
  it('returns the finish time of the most recent completed run', () => {
    const db = openTestDatabase();
    db.prepare(
      `INSERT INTO workflow_runs (workflow_id, state, updated_at, finished_at)
       VALUES ('export.backup', 'completed', 'x', '2024-03-01T00:00:00Z')`,
    ).run();
    db.prepare(
      `INSERT INTO workflow_runs (workflow_id, state, updated_at, finished_at)
       VALUES ('export.backup', 'failed', 'x', '2024-03-02T00:00:00Z')`,
    ).run();
    expect(lastCompletedAt(db, 'export.backup')).toBe('2024-03-01T00:00:00Z');
    expect(lastCompletedAt(db, 'catalog.scan')).toBeNull();
    db.close();
  });
});

describe('hoursSince', () => {
  it('treats never as infinitely long ago', () => {
    expect(hoursSince(null)).toBe(Number.POSITIVE_INFINITY);
    expect(hoursSince('not a date')).toBe(Number.POSITIVE_INFINITY);
  });

  it('measures elapsed hours', () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 3_600_000).toISOString();
    expect(hoursSince(twoHoursAgo)).toBeCloseTo(2, 1);
  });
});

describe('isDailyJobDue', () => {
  const everyDay = [0, 1, 2, 3, 4, 5, 6];

  it('is due once the configured local time has passed', () => {
    // 12:00Z is 04:00 in Los Angeles (PST, UTC-8).
    const now = new Date('2024-01-16T12:00:00Z');
    expect(isDailyJobDue(now, 'America/Los_Angeles', '03:30', everyDay, null)).toBe(true);
    expect(isDailyJobDue(now, 'America/Los_Angeles', '05:00', everyDay, null)).toBe(false);
  });

  it('is not due twice on the same local day', () => {
    const now = new Date('2024-01-16T12:00:00Z');
    const earlierToday = new Date('2024-01-16T11:00:00Z').toISOString();
    expect(isDailyJobDue(now, 'America/Los_Angeles', '03:00', everyDay, earlierToday)).toBe(false);
  });

  it('becomes due again the next local day', () => {
    const now = new Date('2024-01-17T12:00:00Z');
    const yesterday = new Date('2024-01-16T12:00:00Z').toISOString();
    expect(isDailyJobDue(now, 'America/Los_Angeles', '03:00', everyDay, yesterday)).toBe(true);
  });

  it('catches up after downtime rather than skipping the day', () => {
    // The service was down at 04:30 and comes up at 09:00 local.
    const now = new Date('2024-01-16T17:00:00Z');
    expect(isDailyJobDue(now, 'America/Los_Angeles', '04:30', everyDay, null)).toBe(true);
  });

  it('respects the selected days of the week', () => {
    const tuesday = new Date('2024-01-16T20:00:00Z');
    expect(isDailyJobDue(tuesday, 'UTC', '01:00', [2], null)).toBe(true);
    expect(isDailyJobDue(tuesday, 'UTC', '01:00', [0, 6], null)).toBe(false);
  });

  it('falls back to UTC for an unknown timezone', () => {
    const now = new Date('2024-01-16T12:00:00Z');
    expect(isDailyJobDue(now, 'Mars/Olympus', '11:00', everyDay, null)).toBe(true);
  });

  it('rejects an unparseable time of day', () => {
    const now = new Date('2024-01-16T12:00:00Z');
    expect(isDailyJobDue(now, 'UTC', 'lunchtime', everyDay, null)).toBe(false);
  });
});

describe('maintenance: configured roots stay reachable', () => {
  let db: Db;
  let alerts: AlertService;
  let settings: SettingsService;
  let temp: ReturnType<typeof createTempDir>;
  let workflow: ReturnType<typeof createMaintenanceWorkflow>;

  beforeEach(() => {
    db = openTestDatabase();
    temp = createTempDir('sakuradrive-mount-');
    settings = new SettingsService(db);
    alerts = new AlertService(db);
    const logger = createSilentLogger();
    const catalog = new CatalogService(db, settings);
    const agents = new AgentService({ db, settings, alerts, logger });
    const auth = new AuthService(db);
    const manager = new WorkflowManager({ db, settings, logger });
    workflow = createMaintenanceWorkflow({
      db, settings, catalog, agents, alerts, auth,
      agentJobs: new AgentJobService(db),
      manager: () => manager,
    });
  });

  afterEach(() => {
    temp.dispose();
    db.close();
  });

  const run = async () => {
    const context = {
      runId: 1,
      params: {},
      logger: createSilentLogger(),
      signal: new AbortController().signal,
      shouldContinue: () => true,
      stopReason: () => 'none' as const,
      setProgress: () => {},
      setCursor: () => {},
      getCursor: <T,>() => null as T | null,
      setStats: () => {},
      addStat: () => {},
      log: () => {},
    };
    return workflow.run(context);
  };

  /**
   * Reachability is now the agent's word for it. The container has no path to most of
   * these volumes -- WSL2 only surfaces lettered drives -- so "can I open this
   * directory?" is not a question it can ask. What it can do is check the pool parts
   * and volumes the agent last reported, which is a better question anyway: it
   * distinguishes "the disk dropped out of the pool" from "nobody has told me anything".
   */
  const seenAgent = () => {
    db.prepare(
      `INSERT INTO agents (hostname, agent_version, protocol_version, first_seen_at, last_report_at)
       VALUES ('tokyo-3', '1.0.0', 1, 'now', 'now')`,
    ).run();
  };
  const seenPart = (label: string, path: string, missing = 0) => {
    db.prepare(
      `INSERT INTO pool_parts (pool_id, part_id, name, volume_label, path, missing, last_seen_at)
       VALUES ('hdd', ?, ?, ?, ?, ?, 'now')`,
    ).run(`hdd:${label}`, label, label, path, missing);
  };

  it('is quiet while the agent can see every root', async () => {
    seenAgent();
    seenPart('DRIVEPOOL16', '\\\\?\\Volume{a}\\PoolPart.d304fce8');
    settings.update({
      catalog: {
        roots: [
          {
            id: 'r1',
            name: 'DRIVEPOOL16',
            hostPath: '\\\\?\\Volume{a}\\PoolPart.d304fce8',
            driveLabel: 'DRIVEPOOL16',
          },
        ],
      },
    });
    const result = await run();
    expect(result.stats!.unreachableRoots).toBe(0);
    expect(alerts.list().alerts.filter((alert) => alert.category === 'catalog')).toHaveLength(0);
  });

  it('raises a critical alert for a root the agent never reported', async () => {
    seenAgent();
    settings.update({
      catalog: { roots: [{ id: 'r1', name: 'HDD Pool', hostPath: 'J:\\\\', driveLabel: 'GONE' }] },
    });
    const result = await run();
    expect(result.stats!.unreachableRoots).toBe(1);

    const alert = alerts.list().alerts.find((entry) => entry.category === 'catalog')!;
    expect(alert.severity).toBe('critical');
    expect(alert.title).toContain('HDD Pool');
    expect(alert.detail).toContain('offline');
  });

  // DrivePool saying a part is missing is a stronger signal than silence: the disk was
  // in the pool and is not now.
  it('raises one for a pool part DrivePool reports as missing', async () => {
    seenAgent();
    seenPart('DRIVEPOOL16', '\\\\?\\Volume{a}\\PoolPart.d304fce8', 1);
    settings.update({
      catalog: {
        roots: [
          {
            id: 'r1',
            name: 'DRIVEPOOL16',
            hostPath: '\\\\?\\Volume{a}\\PoolPart.d304fce8',
            driveLabel: 'DRIVEPOOL16',
          },
        ],
      },
    });
    expect((await run()).stats!.unreachableRoots).toBe(1);
    expect(
      alerts.list().alerts.find((entry) => entry.category === 'catalog')!.detail,
    ).toContain('dropped out');
  });

  it('clears the alert once the disk comes back', async () => {
    seenAgent();
    settings.update({
      catalog: {
        roots: [
          {
            id: 'r1',
            name: 'DRIVEPOOL16',
            hostPath: '\\\\?\\Volume{a}\\PoolPart.d304fce8',
            driveLabel: 'DRIVEPOOL16',
          },
        ],
      },
    });
    await run();
    expect(alerts.list().alerts.some((alert) => alert.category === 'catalog')).toBe(true);

    seenPart('DRIVEPOOL16', '\\\\?\\Volume{a}\\PoolPart.d304fce8');
    await run();
    expect(alerts.list().alerts.some((alert) => alert.category === 'catalog')).toBe(false);
  });

  // A fresh install has no agent yet. Alerting on that would fire on every new
  // deployment, and the agent-freshness alert already covers a host that never checks in.
  it('says nothing at all before any agent has reported', async () => {
    settings.update({
      catalog: { roots: [{ id: 'r1', name: 'HDD Pool', hostPath: 'J:\\\\', driveLabel: 'X' }] },
    });
    expect((await run()).stats!.unreachableRoots).toBe(0);
    expect(alerts.list().alerts.filter((alert) => alert.category === 'catalog')).toHaveLength(0);
  });

  it('ignores roots the operator disabled', async () => {
    seenAgent();
    settings.update({
      catalog: { roots: [{ id: 'r1', name: 'Off', hostPath: 'H:\\\\', enabled: false }] },
    });
    expect((await run()).stats!.unreachableRoots).toBe(0);
  });
});
