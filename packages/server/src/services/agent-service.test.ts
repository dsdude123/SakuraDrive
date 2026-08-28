import { beforeEach, describe, expect, it } from 'vitest';
import { buildAgentReport, createTestContext, smartAttribute, type TestContext } from '../test/helpers.js';
import { mergeAttributeRules } from './agent-service.js';

let ctx: TestContext;

beforeEach(() => {
  ctx = createTestContext();
});

describe('ingest', () => {
  it('records the agent and its version', () => {
    ctx.agents.ingest(buildAgentReport());
    const agents = ctx.agents.listAgents();
    expect(agents).toHaveLength(1);
    expect(agents[0]!.hostname).toBe('NAS-01');
    expect(agents[0]!.agentVersion).toBe('1.0.0');
    expect(agents[0]!.reportCount).toBe(1);
    expect(agents[0]!.online).toBe(true);
  });

  it('counts repeat reports without duplicating the agent', () => {
    ctx.agents.ingest(buildAgentReport());
    ctx.agents.ingest(buildAgentReport());
    expect(ctx.agents.listAgents()[0]!.reportCount).toBe(2);
  });

  it('creates a drive keyed by serial number and attaches its volume label', () => {
    ctx.agents.ingest(buildAgentReport());
    const drives = ctx.agents.listDrives();
    expect(drives).toHaveLength(1);
    expect(drives[0]!.deviceKey).toBe('sn:WD-ABC123');
    // The label is how the operator finds the physical slot when a disk fails.
    expect(drives[0]!.labels).toEqual(['DRIVEPOOL27']);
    expect(drives[0]!.driveLetters).toEqual(['E']);
    expect(drives[0]!.poolNames).toEqual(['HDD Pool']);
  });

  it('keeps drive identity stable when Windows renumbers the device', () => {
    ctx.agents.ingest(buildAgentReport());
    const renumbered = buildAgentReport();
    renumbered.physicalDisks[0]!.deviceId = '\\\\.\\PHYSICALDRIVE9';
    renumbered.smart[0]!.deviceId = '\\\\.\\PHYSICALDRIVE9';
    renumbered.volumes[0]!.physicalDiskIds = ['\\\\.\\PHYSICALDRIVE9'];
    ctx.agents.ingest(renumbered);
    expect(ctx.agents.listDrives()).toHaveLength(1);
  });

  it('stores volumes and pools', () => {
    ctx.agents.ingest(buildAgentReport());
    expect(ctx.agents.listVolumes()[0]!.label).toBe('DRIVEPOOL27');
    const pools = ctx.agents.listPools();
    expect(pools).toHaveLength(1);
    expect(pools[0]!.parts).toHaveLength(1);
    expect(pools[0]!.parts[0]!.volumeLabel).toBe('DRIVEPOOL27');
    expect(pools[0]!.parts[0]!.deviceKey).toBe('sn:WD-ABC123');
  });

  it('raises no alerts for a healthy host', () => {
    const result = ctx.agents.ingest(buildAgentReport());
    expect(result.alertsRaised).toBe(0);
    expect(ctx.alerts.list().total).toBe(0);
  });

  it('surfaces collector errors as warnings without failing the report', () => {
    const result = ctx.agents.ingest(
      buildAgentReport({ errors: [{ collector: 'primocache', message: 'no CLI', detail: null }] }),
    );
    expect(result.warnings).toEqual(['primocache: no CLI']);
  });
});

describe('SMART evaluation', () => {
  it('raises an alert naming the drive label when a counter goes bad', () => {
    const report = buildAgentReport();
    report.smart[0]!.attributes = [smartAttribute({ id: 197, raw: 4 })];
    ctx.agents.ingest(report);

    const { alerts } = ctx.alerts.list();
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.title).toContain('DRIVEPOOL27');
    expect(alerts[0]!.category).toBe('smart');
    expect(alerts[0]!.context.serial).toBe('WD-ABC123');
  });

  it('escalates when the counter rises between reports', () => {
    const first = buildAgentReport();
    first.smart[0]!.attributes = [smartAttribute({ id: 5, raw: 1 })];
    ctx.agents.ingest(first);
    expect(ctx.alerts.list().alerts[0]!.severity).toBe('warning');

    const second = buildAgentReport();
    second.smart[0]!.attributes = [smartAttribute({ id: 5, raw: 2 })];
    ctx.agents.ingest(second);
    expect(ctx.alerts.list().alerts[0]!.severity).toBe('critical');
  });

  it('resolves the alert once the condition clears', () => {
    const bad = buildAgentReport();
    bad.smart[0]!.attributes = [smartAttribute({ id: 199, raw: 5 })];
    ctx.agents.ingest(bad);
    expect(ctx.alerts.list().total).toBe(1);

    // A replaced SATA cable resets the CRC counter reading.
    const good = buildAgentReport();
    good.smart[0]!.attributes = [smartAttribute({ id: 199, raw: 0 })];
    ctx.agents.ingest(good);
    expect(ctx.alerts.list().total).toBe(0);
    expect(ctx.alerts.list({ state: 'resolved' }).total).toBe(1);
  });

  it('does not clear another drive\'s alerts when one drive drops out of the report', () => {
    // Two failing drives, then a report that could only read one of them. The drive
    // that went missing must keep its alert: a monitor that reports a failing disk as
    // healthy because it could not see it is worse than no monitor at all.
    const both = buildAgentReport();
    both.physicalDisks.push({
      ...both.physicalDisks[0]!,
      deviceId: '\\\\.\\PHYSICALDRIVE4',
      serialNumber: 'WD-DEF456',
    });
    both.smart = [
      { ...both.smart[0]!, attributes: [smartAttribute({ id: 197, raw: 4 })] },
      {
        ...both.smart[0]!,
        deviceId: '\\\\.\\PHYSICALDRIVE4',
        serialNumber: 'WD-DEF456',
        attributes: [smartAttribute({ id: 197, raw: 6 })],
      },
    ];
    ctx.agents.ingest(both);
    expect(ctx.alerts.list().alerts.filter((a) => a.category === 'smart')).toHaveLength(2);

    // smartctl could not read the second drive this time round.
    const partial = { ...both, smart: [both.smart[0]!] };
    ctx.agents.ingest(partial);

    const keys = ctx.alerts.list().alerts.map((a) => a.dedupeKey);
    expect(keys).toContain('smart:sn:WD-ABC123:smart.attr.197');
    expect(keys).toContain('smart:sn:WD-DEF456:smart.attr.197');
  });

  it('still clears an alert for a drive the report did cover', () => {
    const bad = buildAgentReport();
    bad.smart[0]!.attributes = [smartAttribute({ id: 197, raw: 4 })];
    ctx.agents.ingest(bad);
    expect(ctx.alerts.list().total).toBe(1);

    const good = buildAgentReport();
    good.smart[0]!.attributes = [smartAttribute({ id: 197, raw: 0 })];
    ctx.agents.ingest(good);
    expect(ctx.alerts.list().total).toBe(0);
  });

  it('keeps a volume alert when that volume is absent from a later report', () => {
    const dirty = buildAgentReport();
    dirty.volumes[0]!.dirty = true;
    ctx.agents.ingest(dirty);
    expect(ctx.alerts.list().alerts.some((a) => a.category === 'volume')).toBe(true);

    ctx.agents.ingest(buildAgentReport({ volumes: [] }));
    expect(ctx.alerts.list().alerts.some((a) => a.category === 'volume')).toBe(true);
  });

  it('stores a snapshot and a sparse attribute history', () => {
    const first = buildAgentReport();
    first.smart[0]!.attributes = [smartAttribute({ id: 5, raw: 0 })];
    ctx.agents.ingest(first);
    ctx.agents.ingest(first); // identical: no new history row
    const second = buildAgentReport();
    second.smart[0]!.attributes = [smartAttribute({ id: 5, raw: 1 })];
    ctx.agents.ingest(second);

    const snapshots = ctx.db.prepare('SELECT COUNT(*) AS n FROM smart_snapshots').get() as { n: number };
    const history = ctx.db.prepare('SELECT COUNT(*) AS n FROM smart_attribute_history').get() as { n: number };
    expect(snapshots.n).toBe(3);
    expect(history.n).toBe(2);
  });

  it('records the drive severity for the drive list', () => {
    const report = buildAgentReport();
    report.smart[0]!.attributes = [smartAttribute({ id: 197, raw: 40 })];
    ctx.agents.ingest(report);
    expect(ctx.agents.listDrives()[0]!.severity).toBe('critical');
    expect(ctx.agents.listDrives()[0]!.openAlertCount).toBeGreaterThan(0);
  });

  it('applies the operator temperature threshold from settings', () => {
    ctx.settings.update({ smart: { temperatureWarnC: 30 } });
    ctx.agents.ingest(buildAgentReport()); // drive is 34°C
    expect(ctx.alerts.list().alerts.some((a) => a.title.includes('temperature'))).toBe(true);
  });
});

describe('volume evaluation', () => {
  it('raises a critical alert for the NTFS dirty bit', () => {
    const report = buildAgentReport();
    report.volumes[0]!.dirty = true;
    ctx.agents.ingest(report);
    const alert = ctx.alerts.list().alerts.find((a) => a.category === 'volume');
    expect(alert!.severity).toBe('critical');
    expect(alert!.detail).toContain('chkdsk');
  });

  it('warns when a volume is nearly full', () => {
    const report = buildAgentReport();
    report.volumes[0]!.freeBytes = 1_000_000;
    ctx.agents.ingest(report);
    expect(ctx.alerts.list().alerts.some((a) => a.title.includes('free'))).toBe(true);
  });
});

describe('pool parts', () => {
  it('raises a critical alert when DrivePool reports a missing part', () => {
    const report = buildAgentReport();
    report.pools[0]!.parts[0]!.missing = true;
    ctx.agents.ingest(report);
    const alert = ctx.alerts.list().alerts.find((a) => a.category === 'pool');
    expect(alert!.severity).toBe('critical');
    expect(alert!.title).toContain('DRIVEPOOL27');
    expect(alert!.detail).toContain('Disaster Recovery');
  });

  it('keeps a missing-part alert when the pool is absent from a later report', () => {
    // DrivePool's service being down must not look like the disk having come back.
    const missing = buildAgentReport();
    missing.pools[0]!.parts[0]!.missing = true;
    ctx.agents.ingest(missing);
    expect(ctx.alerts.list().alerts.some((a) => a.category === 'pool')).toBe(true);

    ctx.agents.ingest(buildAgentReport({ pools: [] }));
    expect(ctx.alerts.list().alerts.some((a) => a.category === 'pool')).toBe(true);
  });

  it('resolves once the part comes back', () => {
    const missing = buildAgentReport();
    missing.pools[0]!.parts[0]!.missing = true;
    ctx.agents.ingest(missing);
    ctx.agents.ingest(buildAgentReport());
    expect(ctx.alerts.list().alerts.filter((a) => a.category === 'pool')).toHaveLength(0);
  });
});

describe('performance monitoring', () => {
  const slowSample = {
    instance: '3 E:',
    deviceId: '\\\\.\\PHYSICALDRIVE3',
    readLatencyMs: 850,
    writeLatencyMs: 700,
    queueLength: 40,
    readBytesPerSec: 1000,
    writeBytesPerSec: 1000,
    readsPerSec: null,
    writesPerSec: null,
    idlePercent: 2,
    busyPercent: null,
    sampleSeconds: 5,
  };

  it('stores samples', () => {
    ctx.agents.ingest(buildAgentReport({ performance: [slowSample] }));
    const row = ctx.db.prepare('SELECT COUNT(*) AS n FROM performance_samples').get() as { n: number };
    expect(row.n).toBe(1);
  });

  it('needs sustained slowness before alerting, then alerts', () => {
    ctx.agents.ingest(buildAgentReport({ performance: [slowSample] }));
    ctx.agents.ingest(buildAgentReport({ performance: [slowSample] }));
    expect(ctx.alerts.list().alerts.filter((a) => a.category === 'performance')).toHaveLength(0);

    ctx.agents.ingest(buildAgentReport({ performance: [slowSample] }));
    const perfAlerts = ctx.alerts.list().alerts.filter((a) => a.category === 'performance');
    expect(perfAlerts.length).toBeGreaterThan(0);
    expect(perfAlerts.some((a) => a.title.includes('DRIVEPOOL27'))).toBe(true);
  });

  it('can be turned off entirely', () => {
    ctx.settings.update({ performance: { enabled: false } });
    for (let i = 0; i < 4; i += 1) ctx.agents.ingest(buildAgentReport({ performance: [slowSample] }));
    expect(ctx.alerts.list().alerts.filter((a) => a.category === 'performance')).toHaveLength(0);
  });
});

describe('PrimoCache', () => {
  it('stores the latest sample', () => {
    ctx.agents.ingest(
      buildAgentReport({
        primoCache: {
          available: true,
          version: '4.3.0',
          reason: null,
          caches: [
            {
              name: 'L2 SSD',
              level: 'L2',
              targetVolumes: ['E:'],
              cacheSizeBytes: 500_000_000_000,
              usedBytes: 400_000_000_000,
              readHitRate: 0.82,
              writeHitRate: 0.61,
              readHits: 100,
              readMisses: 20,
              writeHits: 50,
              writeMisses: 10,
              deferredWriteBytes: 1000,
              pendingWriteBlocks: 5,
              freeDeferredBlocks: 100,
            },
          ],
        },
      }),
    );
    const latest = ctx.agents.latestPrimoCache();
    expect(latest!.available).toBe(true);
    expect((latest!.data as { caches: unknown[] }).caches).toHaveLength(1);
  });

  it('records an unavailable PrimoCache without erroring', () => {
    ctx.agents.ingest(
      buildAgentReport({ primoCache: { available: false, reason: 'CLI not found', caches: [], version: null } }),
    );
    expect(ctx.agents.latestPrimoCache()!.available).toBe(false);
  });
});

describe('duplication sync', () => {
  it('imports DrivePool duplication settings as rules', () => {
    ctx.agents.ingest(
      buildAgentReport({
        duplication: [
          { poolId: '{hdd-pool}', path: '', level: 1 },
          { poolId: '{hdd-pool}', path: 'Media', level: 2 },
        ],
      }),
    );
    const rules = ctx.settings.get().duplication.rules;
    expect(rules).toHaveLength(2);
    expect(rules.every((rule) => rule.source === 'drivepool')).toBe(true);
    expect(rules.find((rule) => rule.path === 'Media')!.level).toBe(2);
  });

  it('never discards rules the operator entered by hand', () => {
    ctx.settings.update({
      duplication: {
        rules: [{ id: 'manual1', poolId: null, path: 'Archive', level: 3, source: 'manual', note: '' }],
      },
    });
    ctx.agents.ingest(
      buildAgentReport({ duplication: [{ poolId: '{hdd-pool}', path: 'Media', level: 2 }] }),
    );
    const rules = ctx.settings.get().duplication.rules;
    expect(rules.filter((rule) => rule.source === 'manual')).toHaveLength(1);
    expect(rules.filter((rule) => rule.source === 'drivepool')).toHaveLength(1);
  });

  it('replaces stale DrivePool rules rather than accumulating them', () => {
    const report = buildAgentReport({ duplication: [{ poolId: '{p}', path: 'Media', level: 2 }] });
    ctx.agents.ingest(report);
    ctx.agents.ingest(report);
    expect(ctx.settings.get().duplication.rules).toHaveLength(1);
  });

  it('can be disabled so the UI rules win', () => {
    ctx.settings.update({ duplication: { acceptAgentRules: false } });
    ctx.agents.ingest(buildAgentReport({ duplication: [{ poolId: '{p}', path: 'Media', level: 2 }] }));
    expect(ctx.settings.get().duplication.rules).toHaveLength(0);
  });
});

describe('agent freshness', () => {
  it('alerts when an agent stops reporting and clears when it returns', () => {
    ctx.agents.ingest(buildAgentReport());
    ctx.agents.checkAgentFreshness();
    expect(ctx.alerts.list().alerts.filter((a) => a.category === 'agent')).toHaveLength(0);

    ctx.db
      .prepare(`UPDATE agents SET last_report_at = '2000-01-01T00:00:00.000Z'`)
      .run();
    ctx.agents.checkAgentFreshness();
    const stale = ctx.alerts.list().alerts.find((a) => a.category === 'agent');
    expect(stale!.severity).toBe('warning');
    expect(stale!.title).toContain('NAS-01');

    ctx.agents.ingest(buildAgentReport());
    ctx.agents.checkAgentFreshness();
    expect(ctx.alerts.list().alerts.filter((a) => a.category === 'agent')).toHaveLength(0);
  });
});

describe('driveDetail', () => {
  it('returns the drive with its latest SMART data and history', () => {
    const report = buildAgentReport();
    report.smart[0]!.attributes = [smartAttribute({ id: 5, raw: 3 })];
    ctx.agents.ingest(report);
    const id = ctx.agents.listDrives()[0]!.id;
    const detail = ctx.agents.driveDetail(id);
    expect(detail.drive!.serialNumber).toBe('WD-ABC123');
    expect(detail.latestSmart!.attributes[0]!.id).toBe(5);
    expect(detail.history[0]!.attributeId).toBe(5);
  });
});

describe('prune', () => {
  it('removes time-series rows past their retention window', () => {
    ctx.agents.ingest(buildAgentReport({ performance: [{ instance: 'x', deviceId: null, readLatencyMs: 1, writeLatencyMs: 1, queueLength: 1, readBytesPerSec: null, writeBytesPerSec: null, readsPerSec: null, writesPerSec: null, idlePercent: null, busyPercent: null, sampleSeconds: null }] }));
    ctx.db.prepare(`UPDATE performance_samples SET collected_at = '2000-01-01T00:00:00.000Z'`).run();
    ctx.db.prepare(`UPDATE smart_snapshots SET collected_at = '2000-01-01T00:00:00.000Z'`).run();
    const pruned = ctx.agents.prune();
    expect(pruned.performance).toBe(1);
    expect(pruned.smart).toBeGreaterThan(0);
  });
});

describe('mergeAttributeRules', () => {
  it('returns the built-in rules when there are no overrides', () => {
    expect(mergeAttributeRules([]).find((rule) => rule.id === 197)!.critAbove).toBe(8);
  });

  it('applies an override', () => {
    const rules = mergeAttributeRules([
      { id: 197, warnAbove: 10, critAbove: 100, increaseSeverity: null, enabled: true },
    ]);
    const rule = rules.find((r) => r.id === 197)!;
    expect(rule.warnAbove).toBe(10);
    expect(rule.increaseSeverity).toBeNull();
    expect(rule.name).toBe('Current Pending Sectors');
  });

  it('removes a disabled attribute', () => {
    const rules = mergeAttributeRules([
      { id: 199, warnAbove: 0, critAbove: 0, increaseSeverity: null, enabled: false },
    ]);
    expect(rules.find((r) => r.id === 199)).toBeUndefined();
  });

  it('adds a rule for an attribute with no built-in default', () => {
    const rules = mergeAttributeRules([
      { id: 240, warnAbove: 5, critAbove: 10, increaseSeverity: 'warning', enabled: true },
    ]);
    expect(rules.find((r) => r.id === 240)!.critAbove).toBe(10);
  });
});
