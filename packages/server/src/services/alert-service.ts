import { EventEmitter } from 'node:events';
import type { Alert, AlertCategory, AlertState, Severity } from '@sakuradrive/shared';
import { fromJson, nowIso, toJson, type Db } from '../db/index.js';

export interface RaiseAlertInput {
  dedupeKey: string;
  category: AlertCategory;
  severity: Severity;
  title: string;
  detail?: string;
  context?: Record<string, unknown>;
}

export interface AlertQuery {
  state?: AlertState | 'any';
  category?: AlertCategory;
  severity?: Severity;
  search?: string;
  limit?: number;
  offset?: number;
}

interface AlertRow {
  id: number;
  dedupe_key: string;
  category: string;
  severity: string;
  title: string;
  detail: string;
  context_json: string;
  state: string;
  first_seen_at: string;
  last_seen_at: string;
  resolved_at: string | null;
  acknowledged_at: string | null;
  acknowledged_by: string | null;
  notified_at: string | null;
  notified_severity: string | null;
  occurrences: number;
}

function toAlert(row: AlertRow): Alert {
  return {
    id: row.id,
    dedupeKey: row.dedupe_key,
    category: row.category as AlertCategory,
    severity: row.severity as Severity,
    title: row.title,
    detail: row.detail,
    context: fromJson<Record<string, unknown>>(row.context_json, {}),
    state: row.state as AlertState,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    resolvedAt: row.resolved_at,
    acknowledgedAt: row.acknowledged_at,
    acknowledgedBy: row.acknowledged_by,
    notifiedAt: row.notified_at,
    occurrences: row.occurrences,
  };
}

/**
 * Central alert store.
 *
 * Alerts are conditions, not events: raising the same `dedupeKey` twice updates the
 * existing row rather than creating a second one, so a drive with a pending sector
 * produces one alert that stays open until the condition clears — not one per poll.
 *
 * Emits `raised` (new alert, or an existing one that got worse) and `resolved`, which
 * the notifier subscribes to.
 */
export class AlertService extends EventEmitter {
  constructor(private readonly db: Db) {
    super();
  }

  /** Create or refresh an alert. Returns the alert and whether it is newly notable. */
  raise(input: RaiseAlertInput): { alert: Alert; isNew: boolean; escalated: boolean } {
    const now = nowIso();
    const detail = input.detail ?? '';
    const context = toJson(input.context ?? {});

    const existing = this.db
      .prepare<[string], AlertRow>('SELECT * FROM alerts WHERE dedupe_key = ?')
      .get(input.dedupeKey);

    if (!existing) {
      const info = this.db
        .prepare(
          `INSERT INTO alerts
             (dedupe_key, category, severity, title, detail, context_json, state, first_seen_at, last_seen_at, occurrences)
           VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?, 1)`,
        )
        .run(
          input.dedupeKey,
          input.category,
          input.severity,
          input.title,
          detail,
          context,
          now,
          now,
        );
      const alert = this.byId(Number(info.lastInsertRowid))!;
      this.addEvent(alert.id, 'raised', input.severity, input.title);
      this.emit('raised', alert, { isNew: true, escalated: false });
      return { alert, isNew: true, escalated: false };
    }

    const wasResolved = existing.state === 'resolved';
    const escalated = severityRank(input.severity) > severityRank(existing.severity as Severity);
    // Re-opening or worsening makes the alert notable again; an acknowledged alert
    // stays acknowledged while its severity is unchanged so acking actually silences it.
    const nextState: AlertState = wasResolved
      ? 'open'
      : escalated && existing.state === 'acknowledged'
        ? 'open'
        : (existing.state as AlertState);

    this.db
      .prepare(
        `UPDATE alerts
            SET severity = ?, title = ?, detail = ?, context_json = ?, state = ?,
                last_seen_at = ?, occurrences = occurrences + 1,
                resolved_at = CASE WHEN ? = 'resolved' THEN resolved_at ELSE NULL END,
                acknowledged_at = CASE WHEN ? = 'acknowledged' THEN acknowledged_at ELSE NULL END,
                acknowledged_by = CASE WHEN ? = 'acknowledged' THEN acknowledged_by ELSE NULL END
          WHERE id = ?`,
      )
      .run(
        input.severity,
        input.title,
        detail,
        context,
        nextState,
        now,
        nextState,
        nextState,
        nextState,
        existing.id,
      );

    const alert = this.byId(existing.id)!;
    if (wasResolved || escalated) {
      this.addEvent(alert.id, wasResolved ? 'reopened' : 'escalated', input.severity, input.title);
      this.emit('raised', alert, { isNew: wasResolved, escalated });
    }
    return { alert, isNew: wasResolved, escalated };
  }

  /** Mark an alert resolved. Safe to call for a key that was never raised. */
  resolve(dedupeKey: string, message = 'Condition cleared'): Alert | null {
    const existing = this.db
      .prepare<[string], AlertRow>('SELECT * FROM alerts WHERE dedupe_key = ?')
      .get(dedupeKey);
    if (!existing || existing.state === 'resolved') return null;
    const now = nowIso();
    this.db
      .prepare(`UPDATE alerts SET state = 'resolved', resolved_at = ?, last_seen_at = ? WHERE id = ?`)
      .run(now, now, existing.id);
    const alert = this.byId(existing.id)!;
    this.addEvent(alert.id, 'resolved', alert.severity, message);
    this.emit('resolved', alert);
    return alert;
  }

  /**
   * Resolve every open alert in `category` whose key is not in `activeKeys`.
   *
   * This is how a collector says "these are all the problems I can see right now":
   * anything it previously reported and no longer reports has cleared.
   */
  reconcile(category: AlertCategory, activeKeys: Iterable<string>, keyPrefix?: string): Alert[] {
    const active = new Set(activeKeys);
    const rows = this.db
      .prepare<[string], AlertRow>(
        `SELECT * FROM alerts WHERE category = ? AND state != 'resolved'`,
      )
      .all(category);
    const resolved: Alert[] = [];
    for (const row of rows) {
      if (active.has(row.dedupe_key)) continue;
      if (keyPrefix && !row.dedupe_key.startsWith(keyPrefix)) continue;
      const alert = this.resolve(row.dedupe_key);
      if (alert) resolved.push(alert);
    }
    return resolved;
  }

  acknowledge(id: number, by: string): Alert | null {
    const now = nowIso();
    this.db
      .prepare(
        `UPDATE alerts SET state = 'acknowledged', acknowledged_at = ?, acknowledged_by = ?
          WHERE id = ? AND state = 'open'`,
      )
      .run(now, by, id);
    const alert = this.byId(id);
    if (alert) this.addEvent(id, 'acknowledged', alert.severity, `Acknowledged by ${by}`);
    return alert;
  }

  unacknowledge(id: number): Alert | null {
    this.db
      .prepare(
        `UPDATE alerts SET state = 'open', acknowledged_at = NULL, acknowledged_by = NULL
          WHERE id = ? AND state = 'acknowledged'`,
      )
      .run(id);
    return this.byId(id);
  }

  byId(id: number): Alert | null {
    const row = this.db.prepare<[number], AlertRow>('SELECT * FROM alerts WHERE id = ?').get(id);
    return row ? toAlert(row) : null;
  }

  byKey(dedupeKey: string): Alert | null {
    const row = this.db
      .prepare<[string], AlertRow>('SELECT * FROM alerts WHERE dedupe_key = ?')
      .get(dedupeKey);
    return row ? toAlert(row) : null;
  }

  list(query: AlertQuery = {}): { alerts: Alert[]; total: number } {
    const where: string[] = [];
    const params: unknown[] = [];
    const state = query.state ?? 'open';
    if (state === 'open') where.push(`state IN ('open', 'acknowledged')`);
    else if (state !== 'any') {
      where.push('state = ?');
      params.push(state);
    }
    if (query.category) {
      where.push('category = ?');
      params.push(query.category);
    }
    if (query.severity) {
      where.push('severity = ?');
      params.push(query.severity);
    }
    if (query.search) {
      where.push('(title LIKE ? OR detail LIKE ?)');
      params.push(`%${query.search}%`, `%${query.search}%`);
    }
    const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const total = (
      this.db.prepare<unknown[], { n: number }>(`SELECT COUNT(*) AS n FROM alerts ${clause}`).get(
        ...params,
      ) ?? { n: 0 }
    ).n;
    const rows = this.db
      .prepare<unknown[], AlertRow>(
        `SELECT * FROM alerts ${clause}
          ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END,
                   last_seen_at DESC
          LIMIT ? OFFSET ?`,
      )
      .all(...params, Math.min(query.limit ?? 100, 500), query.offset ?? 0);
    return { alerts: rows.map(toAlert), total };
  }

  counts(): { open: number; critical: number; warning: number; info: number; acknowledged: number } {
    const row = this.db
      .prepare<[], { open: number; critical: number; warning: number; info: number; acknowledged: number }>(
        `SELECT
           SUM(CASE WHEN state = 'open' THEN 1 ELSE 0 END) AS open,
           SUM(CASE WHEN state != 'resolved' AND severity = 'critical' THEN 1 ELSE 0 END) AS critical,
           SUM(CASE WHEN state != 'resolved' AND severity = 'warning' THEN 1 ELSE 0 END) AS warning,
           SUM(CASE WHEN state != 'resolved' AND severity = 'info' THEN 1 ELSE 0 END) AS info,
           SUM(CASE WHEN state = 'acknowledged' THEN 1 ELSE 0 END) AS acknowledged
         FROM alerts`,
      )
      .get();
    return {
      open: row?.open ?? 0,
      critical: row?.critical ?? 0,
      warning: row?.warning ?? 0,
      info: row?.info ?? 0,
      acknowledged: row?.acknowledged ?? 0,
    };
  }

  events(alertId: number, limit = 50) {
    return this.db
      .prepare<[number, number], { at: string; kind: string; severity: string | null; message: string }>(
        'SELECT at, kind, severity, message FROM alert_events WHERE alert_id = ? ORDER BY at DESC LIMIT ?',
      )
      .all(alertId, limit);
  }

  markNotified(id: number, severity: Severity): void {
    this.db
      .prepare('UPDATE alerts SET notified_at = ?, notified_severity = ? WHERE id = ?')
      .run(nowIso(), severity, id);
  }

  /** When was this alert last notified at this severity or worse? */
  lastNotified(id: number): { at: string | null; severity: Severity | null } {
    const row = this.db
      .prepare<[number], { notified_at: string | null; notified_severity: string | null }>(
        'SELECT notified_at, notified_severity FROM alerts WHERE id = ?',
      )
      .get(id);
    return {
      at: row?.notified_at ?? null,
      severity: (row?.notified_severity as Severity | null) ?? null,
    };
  }

  /** Delete resolved alerts older than the retention window. */
  prune(olderThanDays: number): number {
    const cutoff = new Date(Date.now() - olderThanDays * 86_400_000).toISOString();
    const info = this.db
      .prepare(`DELETE FROM alerts WHERE state = 'resolved' AND resolved_at < ?`)
      .run(cutoff);
    return info.changes;
  }

  private addEvent(alertId: number, kind: string, severity: Severity, message: string): void {
    this.db
      .prepare('INSERT INTO alert_events (alert_id, at, kind, severity, message) VALUES (?, ?, ?, ?, ?)')
      .run(alertId, nowIso(), kind, severity, message);
  }
}

function severityRank(severity: Severity): number {
  return severity === 'critical' ? 2 : severity === 'warning' ? 1 : 0;
}
