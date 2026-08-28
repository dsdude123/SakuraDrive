import type { Alert, Severity } from '@sakuradrive/shared';
import { fromJson, nowIso, toJson, type Db } from '../db/index.js';
import type { Logger } from '../logger.js';
import type { AlertService } from './alert-service.js';
import type { SettingsService } from './settings-service.js';

/** Discord embed colours: sakura pink for info, amber for warning, red for critical. */
const SEVERITY_COLOUR: Record<Severity, number> = {
  info: 0xf7a8c4,
  warning: 0xe8a13a,
  critical: 0xe4485d,
};

const SEVERITY_LABEL: Record<Severity, string> = {
  info: 'Info',
  warning: 'Warning',
  critical: 'Critical',
};

export interface DiscordEmbed {
  title: string;
  description?: string;
  color: number;
  timestamp?: string;
  fields?: Array<{ name: string; value: string; inline?: boolean }>;
  footer?: { text: string };
}

export interface DiscordPayload {
  username?: string;
  content?: string;
  embeds: DiscordEmbed[];
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface NotifierOptions {
  db: Db;
  settings: SettingsService;
  alerts: AlertService;
  logger: Logger;
  /** Injected in tests. */
  fetchImpl?: FetchLike;
  now?: () => Date;
}

/**
 * Discord webhook delivery.
 *
 * Messages go through an outbox table rather than being posted inline, so a Discord
 * outage or a rate limit delays notifications instead of dropping them, and a burst of
 * alerts (a controller dropping eight drives at once) collapses into one message.
 */
export class DiscordNotifier {
  private readonly db: Db;
  private readonly settings: SettingsService;
  private readonly alerts: AlertService;
  private readonly logger: Logger;
  private readonly fetchImpl: FetchLike;
  private readonly now: () => Date;
  private timer: NodeJS.Timeout | null = null;

  constructor(options: NotifierOptions) {
    this.db = options.db;
    this.settings = options.settings;
    this.alerts = options.alerts;
    this.logger = options.logger;
    this.fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));
    this.now = options.now ?? (() => new Date());
  }

  /** Subscribe to the alert service so raised/resolved alerts become notifications. */
  attach(): void {
    this.alerts.on('raised', (alert: Alert) => this.onAlertRaised(alert));
    this.alerts.on('resolved', (alert: Alert) => this.onAlertResolved(alert));
  }

  start(intervalMs = 10_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.flush().catch((error) => this.logger.error({ error }, 'notification flush failed'));
    }, intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private config() {
    return this.settings.get().notifications.discord;
  }

  private meetsThreshold(severity: Severity): boolean {
    const min = this.config().minSeverity;
    const rank = (value: Severity) => (value === 'critical' ? 2 : value === 'warning' ? 1 : 0);
    return rank(severity) >= rank(min);
  }

  onAlertRaised(alert: Alert): void {
    const config = this.config();
    if (!config.enabled || !config.webhookUrl) return;
    if (!this.meetsThreshold(alert.severity)) return;

    // Suppress a repeat notification for a condition already announced recently,
    // unless it has become more severe since.
    const last = this.alerts.lastNotified(alert.id);
    if (last.at && config.renotifyAfterHours > 0) {
      const ageHours = (this.now().getTime() - Date.parse(last.at)) / 3_600_000;
      const worse = severityRank(alert.severity) > severityRank(last.severity ?? 'info');
      if (!worse && ageHours < config.renotifyAfterHours) return;
    }

    this.enqueue('discord', alert.id, {
      kind: 'alert',
      severity: alert.severity,
      title: alert.title,
      detail: alert.detail,
      category: alert.category,
      context: alert.context,
      firstSeenAt: alert.firstSeenAt,
      occurrences: alert.occurrences,
    });
    this.alerts.markNotified(alert.id, alert.severity);
  }

  onAlertResolved(alert: Alert): void {
    const config = this.config();
    if (!config.enabled || !config.webhookUrl || !config.notifyOnResolved) return;
    // Only announce the clearing of something that was announced in the first place.
    if (!this.alerts.lastNotified(alert.id).at) return;
    this.enqueue('discord', alert.id, {
      kind: 'resolved',
      severity: alert.severity,
      title: alert.title,
      detail: alert.detail,
      category: alert.category,
      context: alert.context,
    });
  }

  /** Non-alert message, e.g. a workflow failure or a manual test. */
  notifyMessage(title: string, detail: string, severity: Severity = 'info'): void {
    const config = this.config();
    if (!config.enabled || !config.webhookUrl) return;
    this.enqueue('discord', null, { kind: 'message', title, detail, severity, category: 'system' });
  }

  private enqueue(channel: string, alertId: number | null, payload: Record<string, unknown>): void {
    const config = this.config();
    const sendAfter = new Date(
      this.now().getTime() + config.batchWindowSeconds * 1000,
    ).toISOString();
    this.db
      .prepare(
        `INSERT INTO notifications (channel, alert_id, payload_json, created_at, send_after)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(channel, alertId, toJson(payload), nowIso(), sendAfter);
  }

  /** Send everything that is due. Returns the number of webhook posts made. */
  async flush(): Promise<number> {
    const config = this.config();
    if (!config.enabled || !config.webhookUrl) return 0;

    const due = this.db
      .prepare<[string], { id: number; payload_json: string; attempts: number }>(
        `SELECT id, payload_json, attempts FROM notifications
          WHERE status = 'pending' AND send_after <= ? AND channel = 'discord'
          ORDER BY id LIMIT 25`,
      )
      .all(this.now().toISOString());
    if (due.length === 0) return 0;

    const payloads = due.map((row) =>
      fromJson<Record<string, unknown>>(row.payload_json, { title: 'Alert' }),
    );
    const message = buildDiscordMessage(payloads, config);

    try {
      const response = await this.fetchImpl(config.webhookUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(message),
      });
      if (response.status === 429) {
        // Respect Discord's own backoff rather than hammering the webhook.
        const retryAfter = Number(response.headers.get('retry-after') ?? '5');
        const retryAt = new Date(this.now().getTime() + retryAfter * 1000).toISOString();
        this.markRetry(due.map((row) => row.id), retryAt, 'rate limited');
        return 0;
      }
      if (!response.ok) {
        const body = await safeText(response);
        this.markRetry(
          due.map((row) => row.id),
          new Date(this.now().getTime() + 60_000).toISOString(),
          `HTTP ${response.status}: ${body.slice(0, 200)}`,
        );
        return 0;
      }
      const sentAt = nowIso();
      const mark = this.db.prepare(
        `UPDATE notifications SET status = 'sent', sent_at = ?, attempts = attempts + 1 WHERE id = ?`,
      );
      this.db.transaction(() => {
        for (const row of due) mark.run(sentAt, row.id);
      })();
      return 1;
    } catch (error) {
      this.markRetry(
        due.map((row) => row.id),
        new Date(this.now().getTime() + 60_000).toISOString(),
        error instanceof Error ? error.message : String(error),
      );
      return 0;
    }
  }

  private markRetry(ids: number[], retryAt: string, error: string): void {
    const update = this.db.prepare(
      `UPDATE notifications
          SET attempts = attempts + 1,
              last_error = ?,
              send_after = ?,
              status = CASE WHEN attempts + 1 >= 8 THEN 'failed' ELSE 'pending' END
        WHERE id = ?`,
    );
    this.db.transaction(() => {
      for (const id of ids) update.run(error, retryAt, id);
    })();
    this.logger.warn({ error, count: ids.length }, 'discord notification deferred');
  }

  /** Post a test message immediately, bypassing the outbox. Used by the settings page. */
  async sendTest(webhookUrl: string, username: string): Promise<{ ok: boolean; error?: string }> {
    try {
      const response = await this.fetchImpl(webhookUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          username: username || 'SakuraDrive',
          embeds: [
            {
              title: '🌸 SakuraDrive test notification',
              description:
                'If you can read this, alerts from your NAS will reach this channel.',
              color: SEVERITY_COLOUR.info,
              timestamp: this.now().toISOString(),
            },
          ],
        } satisfies DiscordPayload),
      });
      if (!response.ok) {
        return { ok: false, error: `HTTP ${response.status}: ${await safeText(response)}` };
      }
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  pendingCount(): number {
    const row = this.db
      .prepare<[], { n: number }>(`SELECT COUNT(*) AS n FROM notifications WHERE status = 'pending'`)
      .get();
    return row?.n ?? 0;
  }
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

function severityRank(severity: Severity): number {
  return severity === 'critical' ? 2 : severity === 'warning' ? 1 : 0;
}

export interface DiscordConfigLike {
  username: string;
  mentionOnCritical: string;
}

/** Build one Discord message from a batch of queued notifications. */
export function buildDiscordMessage(
  payloads: Array<Record<string, unknown>>,
  config: DiscordConfigLike,
): DiscordPayload {
  // Discord allows 10 embeds per message; anything beyond that is summarised.
  const shown = payloads.slice(0, 9);
  const overflow = payloads.length - shown.length;

  const embeds: DiscordEmbed[] = shown.map((payload) => {
    const severity = (payload.severity as Severity) ?? 'info';
    const resolved = payload.kind === 'resolved';
    const fields: Array<{ name: string; value: string; inline?: boolean }> = [];
    const context = (payload.context as Record<string, unknown>) ?? {};
    for (const [key, value] of Object.entries(context).slice(0, 6)) {
      if (value === null || value === undefined || value === '') continue;
      fields.push({ name: key, value: String(value).slice(0, 1000), inline: true });
    }
    return {
      title: `${resolved ? '✅ Resolved' : severityEmoji(severity)} ${String(payload.title ?? 'Alert')}`.slice(
        0,
        250,
      ),
      description: String(payload.detail ?? '').slice(0, 3800) || undefined,
      color: resolved ? 0x4caf7d : SEVERITY_COLOUR[severity],
      timestamp: new Date().toISOString(),
      fields: fields.length > 0 ? fields : undefined,
      footer: {
        text: `SakuraDrive · ${String(payload.category ?? 'system')} · ${
          resolved ? 'resolved' : SEVERITY_LABEL[severity]
        }`,
      },
    };
  });

  if (overflow > 0) {
    embeds.push({
      title: `…and ${overflow} more alert${overflow === 1 ? '' : 's'}`,
      description: 'Open the SakuraDrive alerts page for the full list.',
      color: SEVERITY_COLOUR.warning,
    });
  }

  const hasCritical = payloads.some(
    (payload) => payload.severity === 'critical' && payload.kind !== 'resolved',
  );
  const content =
    hasCritical && config.mentionOnCritical ? config.mentionOnCritical.slice(0, 200) : undefined;

  return {
    username: config.username || 'SakuraDrive',
    ...(content ? { content } : {}),
    embeds,
  };
}

function severityEmoji(severity: Severity): string {
  return severity === 'critical' ? '🔴' : severity === 'warning' ? '🟠' : '🔵';
}
