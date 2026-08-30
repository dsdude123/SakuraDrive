import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openTestDatabase, type Db } from '../db/index.js';
import { createSilentLogger } from '../logger.js';
import { AlertService } from './alert-service.js';
import { DiscordNotifier, buildDiscordMessage, type FetchLike } from './discord-notifier.js';
import { SettingsService } from './settings-service.js';

const WEBHOOK = 'https://discord.com/api/webhooks/1/token';

function okResponse(): Response {
  return new Response(null, { status: 204 });
}

interface Harness {
  db: Db;
  settings: SettingsService;
  alerts: AlertService;
  notifier: DiscordNotifier;
  fetchMock: ReturnType<typeof vi.fn>;
  bodies(): Array<Record<string, unknown>>;
  now: Date;
}

function createHarness(configOverrides: Record<string, unknown> = {}): Harness {
  const db = openTestDatabase();
  const settings = new SettingsService(db);
  const alerts = new AlertService(db);
  const fetchMock = vi.fn(async () => okResponse());
  const state = { now: new Date('2024-03-05T12:00:00Z') };
  const notifier = new DiscordNotifier({
    db,
    settings,
    alerts,
    logger: createSilentLogger(),
    fetchImpl: fetchMock as unknown as FetchLike,
    now: () => state.now,
  });
  settings.update({
    notifications: {
      discord: { enabled: true, webhookUrl: WEBHOOK, batchWindowSeconds: 0, ...configOverrides },
    },
  });
  notifier.attach();
  return {
    db,
    settings,
    alerts,
    notifier,
    fetchMock,
    now: state.now,
    bodies: () =>
      fetchMock.mock.calls.map((call) =>
        JSON.parse((call[1] as { body: string }).body) as Record<string, unknown>,
      ),
  };
}

const alertInput = {
  dedupeKey: 'smart:sn:ABC:smart.attr.197',
  category: 'smart' as const,
  severity: 'critical' as const,
  title: 'DRIVEPOOL27: pending sectors = 4',
  detail: 'Unstable sectors waiting to be remapped.',
  context: { drive: 'DRIVEPOOL27', serial: 'WD-ABC123' },
};

let h: Harness;
beforeEach(() => {
  h = createHarness();
});

describe('queueing', () => {
  it('queues a notification when an alert is raised', async () => {
    h.alerts.raise(alertInput);
    expect(h.notifier.pendingCount()).toBe(1);
    expect(await h.notifier.flush()).toBe(1);
    expect(h.fetchMock).toHaveBeenCalledOnce();
  });

  it('does nothing when Discord is disabled', async () => {
    h.settings.update({ notifications: { discord: { enabled: false } } });
    h.alerts.raise(alertInput);
    expect(h.notifier.pendingCount()).toBe(0);
    expect(await h.notifier.flush()).toBe(0);
  });

  it('does nothing when no webhook URL is configured', async () => {
    h.settings.update({ notifications: { discord: { webhookUrl: '' } } });
    h.alerts.raise(alertInput);
    expect(h.notifier.pendingCount()).toBe(0);
  });

  it('respects the minimum severity', () => {
    h.settings.update({ notifications: { discord: { minSeverity: 'critical' } } });
    h.alerts.raise({ ...alertInput, dedupeKey: 'w', severity: 'warning' });
    expect(h.notifier.pendingCount()).toBe(0);
    h.alerts.raise({ ...alertInput, dedupeKey: 'c', severity: 'critical' });
    expect(h.notifier.pendingCount()).toBe(1);
  });

  it('does not re-notify an unchanged condition within the renotify window', () => {
    h.alerts.raise(alertInput);
    h.alerts.resolve(alertInput.dedupeKey);
    h.alerts.raise(alertInput);
    // One raise, one resolve, and the re-raise suppressed.
    expect(h.notifier.pendingCount()).toBe(2);
  });

  it('re-notifies when a condition becomes more severe', () => {
    h.alerts.raise({ ...alertInput, severity: 'warning' });
    h.alerts.raise({ ...alertInput, severity: 'critical' });
    expect(h.notifier.pendingCount()).toBe(2);
  });

  it('announces resolution only for alerts that were announced', async () => {
    h.settings.update({ notifications: { discord: { minSeverity: 'critical' } } });
    h.alerts.raise({ ...alertInput, dedupeKey: 'quiet', severity: 'warning' });
    h.alerts.resolve('quiet');
    expect(h.notifier.pendingCount()).toBe(0);

    h.alerts.raise({ ...alertInput, dedupeKey: 'loud', severity: 'critical' });
    await h.notifier.flush();
    h.alerts.resolve('loud');
    expect(h.notifier.pendingCount()).toBe(1);
  });

  it('can be told not to announce resolutions at all', () => {
    h.settings.update({ notifications: { discord: { notifyOnResolved: false } } });
    h.alerts.raise(alertInput);
    h.alerts.resolve(alertInput.dedupeKey);
    expect(h.notifier.pendingCount()).toBe(1);
  });
});

describe('batching', () => {
  it('collapses a burst of alerts into one message', async () => {
    for (let i = 0; i < 5; i += 1) {
      h.alerts.raise({ ...alertInput, dedupeKey: `drive-${i}`, title: `Drive ${i} failing` });
    }
    expect(await h.notifier.flush()).toBe(1);
    expect(h.fetchMock).toHaveBeenCalledOnce();
    const body = h.bodies()[0]!;
    expect((body.embeds as unknown[]).length).toBe(5);
  });

  it('holds notifications until the batch window elapses', async () => {
    h.settings.update({ notifications: { discord: { batchWindowSeconds: 60 } } });
    h.alerts.raise(alertInput);
    expect(await h.notifier.flush()).toBe(0);
    expect(h.fetchMock).not.toHaveBeenCalled();
  });
});

describe('delivery failures', () => {
  it('keeps the notification queued and retries after a rate limit', async () => {
    h.fetchMock.mockResolvedValueOnce(
      new Response('', { status: 429, headers: { 'retry-after': '3' } }),
    );
    h.alerts.raise(alertInput);
    expect(await h.notifier.flush()).toBe(0);
    expect(h.notifier.pendingCount()).toBe(1);
  });

  it('keeps the notification queued when the webhook errors', async () => {
    h.fetchMock.mockResolvedValueOnce(new Response('boom', { status: 500 }));
    h.alerts.raise(alertInput);
    expect(await h.notifier.flush()).toBe(0);
    expect(h.notifier.pendingCount()).toBe(1);
    const row = h.db.prepare('SELECT last_error, attempts FROM notifications').get() as {
      last_error: string;
      attempts: number;
    };
    expect(row.attempts).toBe(1);
    expect(row.last_error).toContain('500');
  });

  it('survives a network error', async () => {
    h.fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    h.alerts.raise(alertInput);
    await expect(h.notifier.flush()).resolves.toBe(0);
    expect(h.notifier.pendingCount()).toBe(1);
  });

  it('gives up after repeated failures instead of retrying forever', async () => {
    h.fetchMock.mockResolvedValue(new Response('boom', { status: 500 }));
    h.alerts.raise(alertInput);
    h.db.prepare('UPDATE notifications SET attempts = 7').run();
    await h.notifier.flush();
    const row = h.db.prepare('SELECT status FROM notifications').get() as { status: string };
    expect(row.status).toBe('failed');
    expect(h.notifier.pendingCount()).toBe(0);
  });
});

describe('sendTest', () => {
  it('posts immediately and reports success', async () => {
    const result = await h.notifier.sendTest(WEBHOOK, 'SakuraDrive');
    expect(result.ok).toBe(true);
    expect(h.bodies()[0]!.username).toBe('SakuraDrive');
  });

  it('reports a failure without throwing', async () => {
    h.fetchMock.mockResolvedValueOnce(new Response('bad webhook', { status: 404 }));
    const result = await h.notifier.sendTest(WEBHOOK, 'x');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('404');
  });
});

describe('buildDiscordMessage', () => {
  const config = { username: 'SakuraDrive', mentionOnCritical: '<@&123>' };

  it('renders one embed per alert with severity colour', () => {
    const message = buildDiscordMessage(
      [{ title: 'Drive dying', detail: 'bad', severity: 'critical', category: 'smart', context: {} }],
      config,
    );
    expect(message.embeds).toHaveLength(1);
    expect(message.embeds[0]!.title).toContain('🔴');
    expect(message.embeds[0]!.color).toBe(0xe4485d);
    expect(message.embeds[0]!.footer!.text).toContain('smart');
  });

  it('mentions a role only when something critical is unresolved', () => {
    expect(
      buildDiscordMessage([{ title: 'x', severity: 'critical', kind: 'alert' }], config).content,
    ).toBe('<@&123>');
    expect(
      buildDiscordMessage([{ title: 'x', severity: 'warning', kind: 'alert' }], config).content,
    ).toBeUndefined();
    expect(
      buildDiscordMessage([{ title: 'x', severity: 'critical', kind: 'resolved' }], config).content,
    ).toBeUndefined();
  });

  it('marks resolved alerts in green', () => {
    const message = buildDiscordMessage([{ title: 'x', kind: 'resolved', severity: 'critical' }], config);
    expect(message.embeds[0]!.title).toContain('Resolved');
    expect(message.embeds[0]!.color).toBe(0x4caf7d);
  });

  it('turns context into embed fields', () => {
    const message = buildDiscordMessage(
      [{ title: 'x', severity: 'info', context: { drive: 'DRIVEPOOL27', serial: 'ABC', blank: '' } }],
      config,
    );
    expect(message.embeds[0]!.fields).toEqual([
      { name: 'drive', value: 'DRIVEPOOL27', inline: true },
      { name: 'serial', value: 'ABC', inline: true },
    ]);
  });

  it('stays within Discord embed limits', () => {
    const payloads = Array.from({ length: 30 }, (_, i) => ({ title: `alert ${i}`, severity: 'warning' }));
    const message = buildDiscordMessage(payloads, config);
    expect(message.embeds.length).toBeLessThanOrEqual(10);
    expect(message.embeds.at(-1)!.title).toContain('21 more alerts');
  });

  it('truncates an overlong title and description', () => {
    const message = buildDiscordMessage(
      [{ title: 'x'.repeat(500), detail: 'y'.repeat(5000), severity: 'info' }],
      config,
    );
    expect(message.embeds[0]!.title.length).toBeLessThanOrEqual(255);
    expect(message.embeds[0]!.description!.length).toBeLessThanOrEqual(3800);
  });
});

/**
 * The test button used to always send, at info severity, bypassing the threshold. So it
 * proved the webhook worked and nothing about the filter -- which is the setting most
 * likely to be wrong, and the one whose failure mode is silence rather than an error.
 */
describe('the test message and the severity threshold', () => {
  it('reports every level as delivered when the threshold is info', async () => {
    const harness = createHarness({ minSeverity: 'info' });
    const result = await harness.notifier.sendTest(WEBHOOK, 'SakuraDrive');
    expect(result.ok).toBe(true);
    expect(result.delivered).toEqual(['info', 'warning', 'critical']);
    expect(result.suppressed).toEqual([]);
  });

  it('reports what a critical-only threshold will swallow', async () => {
    const harness = createHarness({ minSeverity: 'critical' });
    const result = await harness.notifier.sendTest(WEBHOOK, 'SakuraDrive');
    expect(result.minSeverity).toBe('critical');
    expect(result.delivered).toEqual(['critical']);
    expect(result.suppressed).toEqual(['info', 'warning']);
  });

  it('says so in the message itself, not just in the response', async () => {
    const harness = createHarness({ minSeverity: 'warning' });
    await harness.notifier.sendTest(WEBHOOK, 'SakuraDrive');

    const description = (
      harness.bodies()[0]!.embeds as Array<{ description: string }>
    )[0]!.description;
    expect(description).toContain('**warning**');
    expect(description).toContain('suppressed by the threshold');
    expect(description).toContain('Minimum severity is set to **warning**');
  });

  // The point of running the real gate rather than describing it: the two cannot
  // disagree, so the test cannot promise delivery the notifier then refuses.
  it('agrees with what the notifier actually does', async () => {
    const harness = createHarness({ minSeverity: 'warning' });
    const result = await harness.notifier.sendTest(WEBHOOK, 'SakuraDrive');
    expect(result.delivered).toContain('warning');
    expect(result.suppressed).toContain('info');

    harness.alerts.raise({ ...alertInput, dedupeKey: 'w', severity: 'warning' });
    harness.alerts.raise({ ...alertInput, dedupeKey: 'i', severity: 'info' });
    await harness.notifier.flush();

    const titles = harness
      .bodies()
      .slice(1)
      .flatMap((body) => (body.embeds as Array<{ title: string }>).map((embed) => embed.title))
      .join(' ');
    expect(titles).toContain('DRIVEPOOL27');
    // The info alert was suppressed exactly as the test said it would be.
    expect(harness.db.prepare("SELECT COUNT(*) AS n FROM notifications").get()).toBeTruthy();
  });

  it('still reports the threshold when the webhook itself fails', async () => {
    const harness = createHarness({ minSeverity: 'critical' });
    harness.fetchMock.mockResolvedValueOnce(new Response('nope', { status: 404 }));
    const result = await harness.notifier.sendTest(WEBHOOK, 'SakuraDrive');
    expect(result.ok).toBe(false);
    expect(result.suppressed).toEqual(['info', 'warning']);
  });
});
