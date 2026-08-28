import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AlertService } from './alert-service.js';
import { openTestDatabase, type Db } from '../db/index.js';

let db: Db;
let alerts: AlertService;

beforeEach(() => {
  db = openTestDatabase();
  alerts = new AlertService(db);
});

const base = {
  dedupeKey: 'smart:sn:ABC:smart.attr.197',
  category: 'smart' as const,
  severity: 'warning' as const,
  title: 'DRIVEPOOL27: pending sectors = 1',
};

describe('raise', () => {
  it('creates a new alert', () => {
    const { alert, isNew } = alerts.raise({ ...base, detail: 'detail', context: { drive: 'X' } });
    expect(isNew).toBe(true);
    expect(alert.state).toBe('open');
    expect(alert.occurrences).toBe(1);
    expect(alert.context).toEqual({ drive: 'X' });
  });

  it('updates rather than duplicating a condition that is still true', () => {
    alerts.raise(base);
    const { alert, isNew, escalated } = alerts.raise(base);
    expect(isNew).toBe(false);
    expect(escalated).toBe(false);
    expect(alert.occurrences).toBe(2);
    expect(alerts.list({ state: 'any' }).total).toBe(1);
  });

  it('reports escalation when a condition gets worse', () => {
    alerts.raise(base);
    const { escalated, alert } = alerts.raise({ ...base, severity: 'critical' });
    expect(escalated).toBe(true);
    expect(alert.severity).toBe('critical');
  });

  it('does not report escalation when severity drops', () => {
    alerts.raise({ ...base, severity: 'critical' });
    const { escalated, alert } = alerts.raise({ ...base, severity: 'warning' });
    expect(escalated).toBe(false);
    expect(alert.severity).toBe('warning');
  });

  it('emits raised only for new or escalated conditions', () => {
    const listener = vi.fn();
    alerts.on('raised', listener);
    alerts.raise(base);
    alerts.raise(base);
    alerts.raise(base);
    expect(listener).toHaveBeenCalledTimes(1);
    alerts.raise({ ...base, severity: 'critical' });
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('keeps an acknowledged alert quiet until it gets worse', () => {
    const { alert } = alerts.raise(base);
    alerts.acknowledge(alert.id, 'admin');
    expect(alerts.raise(base).alert.state).toBe('acknowledged');
    expect(alerts.raise({ ...base, severity: 'critical' }).alert.state).toBe('open');
  });

  it('reopens a resolved alert when the condition returns', () => {
    alerts.raise(base);
    alerts.resolve(base.dedupeKey);
    const { alert, isNew } = alerts.raise(base);
    expect(alert.state).toBe('open');
    expect(alert.resolvedAt).toBeNull();
    expect(isNew).toBe(true);
  });
});

describe('resolve', () => {
  it('marks an alert resolved and emits', () => {
    const listener = vi.fn();
    alerts.on('resolved', listener);
    alerts.raise(base);
    const resolved = alerts.resolve(base.dedupeKey);
    expect(resolved!.state).toBe('resolved');
    expect(resolved!.resolvedAt).not.toBeNull();
    expect(listener).toHaveBeenCalledOnce();
  });

  it('is a no-op for an unknown or already resolved key', () => {
    expect(alerts.resolve('nope')).toBeNull();
    alerts.raise(base);
    alerts.resolve(base.dedupeKey);
    expect(alerts.resolve(base.dedupeKey)).toBeNull();
  });
});

describe('reconcile', () => {
  it('resolves alerts a collector no longer reports', () => {
    alerts.raise({ ...base, dedupeKey: 'smart:a:x' });
    alerts.raise({ ...base, dedupeKey: 'smart:b:x' });
    const resolved = alerts.reconcile('smart', ['smart:a:x']);
    expect(resolved.map((a) => a.dedupeKey)).toEqual(['smart:b:x']);
    expect(alerts.byKey('smart:a:x')!.state).toBe('open');
  });

  it('leaves other categories alone', () => {
    alerts.raise({ ...base, dedupeKey: 'backup:x', category: 'backup' });
    alerts.reconcile('smart', []);
    expect(alerts.byKey('backup:x')!.state).toBe('open');
  });

  it('can be limited to a key prefix so one drive does not clear another', () => {
    alerts.raise({ ...base, dedupeKey: 'smart:driveA:attr' });
    alerts.raise({ ...base, dedupeKey: 'smart:driveB:attr' });
    alerts.reconcile('smart', [], 'smart:driveA');
    expect(alerts.byKey('smart:driveA:attr')!.state).toBe('resolved');
    expect(alerts.byKey('smart:driveB:attr')!.state).toBe('open');
  });
});

describe('acknowledge', () => {
  it('records who acknowledged and when', () => {
    const { alert } = alerts.raise(base);
    const acked = alerts.acknowledge(alert.id, 'admin')!;
    expect(acked.state).toBe('acknowledged');
    expect(acked.acknowledgedBy).toBe('admin');
    expect(alerts.unacknowledge(alert.id)!.state).toBe('open');
  });

  it('cannot acknowledge a resolved alert', () => {
    const { alert } = alerts.raise(base);
    alerts.resolve(base.dedupeKey);
    expect(alerts.acknowledge(alert.id, 'admin')!.state).toBe('resolved');
  });
});

describe('list and counts', () => {
  beforeEach(() => {
    alerts.raise({ ...base, dedupeKey: 'a', severity: 'critical', title: 'Critical drive' });
    alerts.raise({ ...base, dedupeKey: 'b', severity: 'warning', title: 'Warm drive' });
    alerts.raise({ ...base, dedupeKey: 'c', severity: 'info', title: 'Info', category: 'backup' });
    alerts.raise({ ...base, dedupeKey: 'd', severity: 'warning', title: 'Resolved one' });
    alerts.resolve('d');
  });

  it('returns open alerts by default, worst first', () => {
    const { alerts: list, total } = alerts.list();
    expect(total).toBe(3);
    expect(list[0]!.severity).toBe('critical');
  });

  it('filters by category, severity and text', () => {
    expect(alerts.list({ category: 'backup' }).total).toBe(1);
    expect(alerts.list({ severity: 'warning' }).total).toBe(1);
    expect(alerts.list({ search: 'drive' }).total).toBe(2);
    expect(alerts.list({ state: 'resolved' }).total).toBe(1);
    expect(alerts.list({ state: 'any' }).total).toBe(4);
  });

  it('paginates', () => {
    expect(alerts.list({ limit: 2 }).alerts).toHaveLength(2);
    expect(alerts.list({ limit: 2, offset: 2 }).alerts).toHaveLength(1);
  });

  it('counts by severity and state', () => {
    const counts = alerts.counts();
    expect(counts.open).toBe(3);
    expect(counts.critical).toBe(1);
    expect(counts.warning).toBe(1);
    expect(counts.info).toBe(1);
  });
});

describe('history and retention', () => {
  it('records an event trail', () => {
    const { alert } = alerts.raise(base);
    alerts.raise({ ...base, severity: 'critical' });
    alerts.acknowledge(alert.id, 'admin');
    alerts.resolve(base.dedupeKey);
    const kinds = alerts.events(alert.id).map((event) => event.kind);
    expect(kinds).toContain('raised');
    expect(kinds).toContain('escalated');
    expect(kinds).toContain('acknowledged');
    expect(kinds).toContain('resolved');
  });

  it('prunes only old resolved alerts', () => {
    alerts.raise({ ...base, dedupeKey: 'old' });
    alerts.resolve('old');
    db.prepare(`UPDATE alerts SET resolved_at = '2000-01-01T00:00:00.000Z' WHERE dedupe_key = 'old'`).run();
    alerts.raise({ ...base, dedupeKey: 'fresh' });
    expect(alerts.prune(30)).toBe(1);
    expect(alerts.byKey('fresh')).not.toBeNull();
  });

  it('tracks notification bookkeeping', () => {
    const { alert } = alerts.raise(base);
    expect(alerts.lastNotified(alert.id).at).toBeNull();
    alerts.markNotified(alert.id, 'warning');
    const last = alerts.lastNotified(alert.id);
    expect(last.at).not.toBeNull();
    expect(last.severity).toBe('warning');
  });
});
