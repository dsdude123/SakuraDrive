import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fullSchedule } from '@sakuradrive/shared';
import { buildAgentReport, smartAttribute } from '../test/helpers.js';
import { createAppHarness, request, type AppHarness } from '../test/app-harness.js';

let h: AppHarness;

beforeEach(async () => {
  h = await createAppHarness();
});

afterEach(async () => {
  await h.close();
});

const json = (response: { body: string }) => JSON.parse(response.body) as Record<string, never>;

describe('health', () => {
  it('answers without authentication', async () => {
    const response = await h.app.inject({ method: 'GET', url: '/api/health' });
    expect(response.statusCode).toBe(200);
    expect(json(response).status).toBe('ok');
  });
});

describe('authentication', () => {
  it('reports that setup is needed on a fresh install', async () => {
    const response = await h.app.inject({ method: 'GET', url: '/api/auth/status' });
    expect(json(response).needsSetup).toBe(true);
  });

  it('creates the first account and signs in', async () => {
    const response = await h.app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      payload: { username: 'admin', password: 'correct horse battery' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['set-cookie']).toBeDefined();
    expect(json(response).user).toMatchObject({ username: 'admin' });
  });

  it('refuses a second setup', async () => {
    await h.signIn();
    const response = await h.app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      payload: { username: 'other', password: 'another password' },
    });
    expect(response.statusCode).toBe(409);
  });

  it('rejects a short password', async () => {
    const response = await h.app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      payload: { username: 'admin', password: 'short' },
    });
    expect(response.statusCode).toBe(400);
  });

  it('rejects bad credentials', async () => {
    await h.signIn();
    const response = await h.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'admin', password: 'wrong' },
    });
    expect(response.statusCode).toBe(401);
  });

  it('requires a session for protected endpoints once an account exists', async () => {
    await h.signIn();
    const anonymous = await h.app.inject({ method: 'GET', url: '/api/drives' });
    expect(anonymous.statusCode).toBe(401);
    const authenticated = await request(h, { method: 'GET', url: '/api/drives' });
    expect(authenticated.statusCode).toBe(200);
  });

  it('invalidates the session on logout', async () => {
    await h.signIn();
    await request(h, { method: 'POST', url: '/api/auth/logout' });
    expect((await request(h, { method: 'GET', url: '/api/drives' })).statusCode).toBe(401);
  });

  it('signs every session out when the password changes', async () => {
    await h.signIn();
    const response = await request(h, {
      method: 'POST',
      url: '/api/auth/password',
      payload: { currentPassword: 'correct horse battery', newPassword: 'a whole new password' },
    });
    expect(response.statusCode).toBe(200);
    expect((await request(h, { method: 'GET', url: '/api/drives' })).statusCode).toBe(401);
  });

  it('can be turned off entirely for a trusted LAN', async () => {
    const open = await createAppHarness({ disableAuth: true });
    try {
      expect((await open.app.inject({ method: 'GET', url: '/api/drives' })).statusCode).toBe(200);
    } finally {
      await open.close();
    }
  });
});

describe('agent reporting', () => {
  let token: string;

  beforeEach(async () => {
    await h.signIn();
    const response = await request(h, {
      method: 'POST',
      url: '/api/agents/tokens',
      payload: { name: 'NAS-01' },
    });
    token = (json(response).token as unknown as { token: string }).token;
  });

  it('issues a token whose plaintext is returned exactly once', async () => {
    expect(token).toBeTruthy();
    const list = json(await request(h, { method: 'GET', url: '/api/agents/tokens' }));
    expect((list.tokens as unknown as unknown[])[0]).not.toHaveProperty('token');
  });

  it('accepts a report with a valid bearer token', async () => {
    const response = await h.app.inject({
      method: 'POST',
      url: '/api/agent/report',
      headers: { authorization: `Bearer ${token}` },
      payload: buildAgentReport(),
    });
    expect(response.statusCode).toBe(200);
    expect(json(response).accepted).toBe(true);

    const drives = json(await request(h, { method: 'GET', url: '/api/drives' }));
    expect((drives.drives as unknown as unknown[])).toHaveLength(1);
  });

  it('rejects a report with no token', async () => {
    const response = await h.app.inject({
      method: 'POST',
      url: '/api/agent/report',
      payload: buildAgentReport(),
    });
    expect(response.statusCode).toBe(401);
  });

  it('rejects a report with a revoked token', async () => {
    const tokens = json(await request(h, { method: 'GET', url: '/api/agents/tokens' }));
    const id = (tokens.tokens as unknown as Array<{ id: number }>)[0]!.id;
    await request(h, { method: 'DELETE', url: `/api/agents/tokens/${id}` });
    const response = await h.app.inject({
      method: 'POST',
      url: '/api/agent/report',
      headers: { authorization: `Bearer ${token}` },
      payload: buildAgentReport(),
    });
    expect(response.statusCode).toBe(401);
  });

  it('rejects a malformed report with a useful error', async () => {
    const response = await h.app.inject({
      method: 'POST',
      url: '/api/agent/report',
      headers: { authorization: `Bearer ${token}` },
      payload: { nonsense: true },
    });
    expect(response.statusCode).toBe(400);
    expect(json(response).error).toBe('invalid_report');
  });

  it('warns about a protocol version mismatch without rejecting the data', async () => {
    const response = await h.app.inject({
      method: 'POST',
      url: '/api/agent/report',
      headers: { authorization: `Bearer ${token}` },
      payload: { ...buildAgentReport(), protocolVersion: 99 },
    });
    expect(response.statusCode).toBe(200);
    expect((json(response).warnings as unknown as string[])[0]).toContain('protocol');
  });
});

describe('alerts', () => {
  beforeEach(async () => {
    await h.signIn();
    const report = buildAgentReport();
    report.smart[0]!.attributes = [smartAttribute({ id: 197, raw: 4 })];
    h.services.agents.ingest(report);
  });

  it('lists open alerts with counts', async () => {
    const body = json(await request(h, { method: 'GET', url: '/api/alerts' }));
    expect(body.total).toBe(1);
    expect((body.counts as unknown as { open: number }).open).toBe(1);
  });

  it('acknowledges and un-acknowledges', async () => {
    const list = json(await request(h, { method: 'GET', url: '/api/alerts' }));
    const id = (list.alerts as unknown as Array<{ id: number }>)[0]!.id;

    const acked = json(
      await request(h, { method: 'POST', url: `/api/alerts/${id}/acknowledge` }),
    );
    expect((acked.alert as unknown as { state: string }).state).toBe('acknowledged');
    expect((acked.alert as unknown as { acknowledgedBy: string }).acknowledgedBy).toBe('admin');

    const unacked = json(
      await request(h, { method: 'POST', url: `/api/alerts/${id}/unacknowledge` }),
    );
    expect((unacked.alert as unknown as { state: string }).state).toBe('open');
  });

  it('resolves an alert by hand', async () => {
    const list = json(await request(h, { method: 'GET', url: '/api/alerts' }));
    const id = (list.alerts as unknown as Array<{ id: number }>)[0]!.id;
    const resolved = json(await request(h, { method: 'POST', url: `/api/alerts/${id}/resolve` }));
    expect((resolved.alert as unknown as { state: string }).state).toBe('resolved');
    expect(json(await request(h, { method: 'GET', url: '/api/alerts' })).total).toBe(0);
  });

  it('404s for an unknown alert', async () => {
    expect((await request(h, { method: 'GET', url: '/api/alerts/9999' })).statusCode).toBe(404);
  });
});

describe('settings', () => {
  beforeEach(() => h.signIn());

  it('returns settings with credentials masked', async () => {
    h.services.settings.update({ notifications: { discord: { webhookUrl: 'https://secret' } } });
    const body = json(await request(h, { method: 'GET', url: '/api/settings' }));
    const settings = body.settings as unknown as { notifications: { discord: { webhookUrl: string } } };
    expect(settings.notifications.discord.webhookUrl).toBe('__REDACTED__');
  });

  it('applies a patch and keeps the masked secret', async () => {
    h.services.settings.update({ backup: { password: 'hunter2' } });
    const response = await request(h, {
      method: 'PATCH',
      url: '/api/settings',
      payload: { general: { siteName: 'Sakura NAS' }, backup: { password: '__REDACTED__' } },
    });
    expect(response.statusCode).toBe(200);
    expect(h.services.settings.get().general.siteName).toBe('Sakura NAS');
    expect(h.services.settings.get().backup.password).toBe('hunter2');
  });

  it('rejects an invalid patch', async () => {
    const response = await request(h, {
      method: 'PATCH',
      url: '/api/settings',
      payload: { schedule: { hashConcurrency: 999 } },
    });
    expect(response.statusCode).toBe(400);
  });

  it('saves the schedule grid and describes it', async () => {
    const response = await request(h, {
      method: 'PUT',
      url: '/api/settings/schedule',
      payload: { heavyIo: fullSchedule() },
    });
    expect(response.statusCode).toBe(200);
    expect(json(response).hoursPerWeek).toBe(168);
  });

  it('normalises a malformed grid rather than rejecting it', async () => {
    const response = await request(h, {
      method: 'PUT',
      url: '/api/settings/schedule',
      payload: { heavyIo: ['1'] },
    });
    expect(response.statusCode).toBe(200);
    expect((json(response).heavyIo as unknown as string[])).toHaveLength(7);
  });

  // Configuring a root means picking a volume the agent has already found, not typing
  // a GUID and hoping. Nothing here can test a path itself: the container cannot reach
  // these volumes at all.
  it('offers the pool parts the agent reported, so a root can be picked not typed', async () => {
    await h.signIn();
    h.services.db
      .prepare(
        `INSERT INTO pool_parts (pool_id, part_id, name, volume_label, drive_letter, path, size_bytes, missing, last_seen_at)
         VALUES ('hdd', 'p1', 'DRIVEPOOL16', 'DRIVEPOOL16', NULL, '\\\\?\\Volume{a}\\PoolPart.d304fce8', 1000, 0, 'now')`,
      )
      .run();

    const body = json(await request(h, { method: 'GET', url: '/api/catalog/known-paths' }));
    const parts = body.poolParts as unknown as Array<{ label: string; hostPath: string; missing: boolean }>;
    expect(parts).toHaveLength(1);
    expect(parts[0]!.label).toBe('DRIVEPOOL16');
    expect(parts[0]!.hostPath).toContain('PoolPart.d304fce8');
    expect(parts[0]!.missing).toBe(false);
  });

  it('sends a Discord test message', async () => {
    h.services.settings.update({
      notifications: { discord: { enabled: true, webhookUrl: 'https://discord.test/hook' } },
    });
    const response = await request(h, { method: 'POST', url: '/api/settings/test-discord', payload: {} });
    expect(json(response).ok).toBe(true);
    expect(h.fetchMock).toHaveBeenCalledOnce();
  });

  it('refuses a Discord test with no webhook', async () => {
    const response = await request(h, { method: 'POST', url: '/api/settings/test-discord', payload: {} });
    expect(response.statusCode).toBe(400);
  });
});

describe('workflows', () => {
  beforeEach(() => h.signIn());

  it('lists every registered workflow with its window state', async () => {
    const body = json(await request(h, { method: 'GET', url: '/api/workflows' }));
    const workflows = body.workflows as unknown as Array<{ id: string; respectsSchedule: boolean }>;
    expect(workflows.map((w) => w.id)).toContain('catalog.scan');
    expect(workflows.find((w) => w.id === 'catalog.scan')!.respectsSchedule).toBe(true);
    expect(workflows.find((w) => w.id === 'export.backup')!.respectsSchedule).toBe(false);
  });

  it('starts a workflow on demand even outside the window', async () => {
    h.services.settings.update({ schedule: { heavyIo: ['0'.repeat(24)] } });
    const response = await request(h, {
      method: 'POST',
      url: '/api/workflows/catalog.scan/start',
      payload: { force: true },
    });
    expect(response.statusCode).toBe(200);
    await h.services.workflows.drain();
  });

  it('refuses to start an unknown workflow', async () => {
    const response = await request(h, {
      method: 'POST',
      url: '/api/workflows/nope.nope/start',
      payload: {},
    });
    expect(response.statusCode).toBe(409);
  });

  it('reports that a workflow is not running when asked to stop it', async () => {
    const response = await request(h, { method: 'POST', url: '/api/workflows/catalog.scan/stop' });
    expect(response.statusCode).toBe(409);
  });
});

describe('dashboard', () => {
  it('summarises every subsystem', async () => {
    await h.signIn();
    h.services.agents.ingest(buildAgentReport());
    const body = json(await request(h, { method: 'GET', url: '/api/dashboard' }));
    expect(body.drives).toMatchObject({ total: 1, healthy: 1 });
    expect(body.agents).toMatchObject({ total: 1, online: 1 });
    expect(body.catalog).toMatchObject({ files: 0 });
    expect(Array.isArray(body.workflows)).toBe(true);
    expect((body.pools as unknown as unknown[])).toHaveLength(1);
  });
});

describe('CSV exports', () => {
  it('renders the drive list as CSV', async () => {
    await h.signIn();
    h.services.agents.ingest(buildAgentReport());
    const response = await request(h, { method: 'GET', url: '/api/drives.csv' });
    expect(response.headers['content-type']).toContain('text/csv');
    expect(response.body).toContain('DRIVEPOOL27');
    expect(response.body.split('\r\n')[0]).toBe(
      'label,model,serial,size_bytes,media,bus,pools,temp_c,power_on_hours,severity,last_seen',
    );
  });
});

describe('not found', () => {
  it('returns JSON for an unknown API path', async () => {
    await h.signIn();
    const response = await request(h, { method: 'GET', url: '/api/nope' });
    expect(response.statusCode).toBe(404);
    expect(json(response).error).toBe('not_found');
  });
});

describe('removed catalog roots', () => {
  beforeEach(async () => {
    await h.signIn();
    await request(h, {
      method: 'PATCH',
      url: '/api/settings',
      payload: {
        catalog: { roots: [{ id: 'r1', name: 'Pool', hostPath: 'J:\\' }] },
      },
    });
    h.services.db
      .prepare(
        `INSERT INTO files (root_id, rel_path, path_key, dir_key, name, size_bytes, first_seen_at, last_seen_at)
         VALUES ('r1', 'Media/a.mkv', 'media/a.mkv', 'media', 'a.mkv', 100, 'now', 'now')`,
      )
      .run();
  });

  it('keeps the catalog when a root is removed from settings', async () => {
    await request(h, { method: 'PATCH', url: '/api/settings', payload: { catalog: { roots: [] } } });
    expect(h.services.catalog.rootStats('r1').files).toBe(1);

    const orphaned = json(await request(h, { method: 'GET', url: '/api/catalog/orphaned' }));
    expect((orphaned.roots as unknown as Array<{ rootId: string }>)[0]!.rootId).toBe('r1');
  });

  it('purges only when asked, and only for a root that is really gone', async () => {
    const inUse = await request(h, { method: 'DELETE', url: '/api/catalog/roots/r1/data' });
    expect(inUse.statusCode).toBe(409);
    expect(h.services.catalog.rootStats('r1').files).toBe(1);

    await request(h, { method: 'PATCH', url: '/api/settings', payload: { catalog: { roots: [] } } });
    const purged = await request(h, { method: 'DELETE', url: '/api/catalog/roots/r1/data' });
    expect(purged.statusCode).toBe(200);
    expect(json(purged).removed).toBe(1);
    expect(h.services.catalog.rootStats('r1').files).toBe(0);
  });
});

describe('disaster recovery report', () => {
  /** A pool whose two parts both sit on physical disk 4 — duplication protecting nothing. */
  async function configureSharedDiskPool(): Promise<void> {
    await h.signIn();
    h.services.settings.update({
      catalog: {
        roots: [
          {
            id: 'part27',
            name: 'DRIVEPOOL27',
            kind: 'poolpart',
            poolId: 'hdd',
            hostPath: 'E:\\',
            driveLabel: 'DRIVEPOOL27',
          },
          {
            id: 'part28',
            name: 'DRIVEPOOL28',
            kind: 'poolpart',
            poolId: 'hdd',
            hostPath: 'F:\\',
            driveLabel: 'DRIVEPOOL28',
          },
        ],
      },
    });
    for (const label of ['DRIVEPOOL27', 'DRIVEPOOL28']) {
      h.services.db
        .prepare(
          `INSERT INTO pool_parts (pool_id, part_id, name, volume_label, device_key, last_seen_at)
           VALUES ('hdd', ?, ?, ?, 'disk-4', 'now')`,
        )
        .run(`hdd:${label}`, label, label);
    }
    for (const rootId of ['part27', 'part28']) {
      h.services.db
        .prepare(
          `INSERT INTO files (root_id, rel_path, path_key, dir_key, name, size_bytes, mtime_ms,
                              duplication_level, first_seen_at, last_seen_at)
           VALUES (?, 'Media/dup.mkv', 'media/dup.mkv', 'media', 'dup.mkv', 100, 1, 2, 'now', 'now')`,
        )
        .run(rootId);
    }
  }

  it('counts a copy on the same physical disk as lost, not as protection', async () => {
    await configureSharedDiskPool();
    const body = json(await request(h, { method: 'GET', url: '/api/dr/impact?rootId=part27' }));
    const impact = body.impact as unknown as { unrecoverableFiles: number; duplicatedFiles: number };

    expect(impact.unrecoverableFiles).toBe(1);
    expect(impact.duplicatedFiles).toBe(0);
    expect(body.sharedDiskRoots).toEqual([{ id: 'part28', name: 'DRIVEPOOL28' }]);
    // Nothing is left to compare against: both parts die with the one disk.
    expect(body.siblingRoots).toEqual([]);
    expect(body.precise).toBe(true);
  });

  it('counts a copy on another physical disk as surviving', async () => {
    await configureSharedDiskPool();
    h.services.db
      .prepare(`UPDATE pool_parts SET device_key = 'disk-9' WHERE volume_label = 'DRIVEPOOL28'`)
      .run();

    const body = json(await request(h, { method: 'GET', url: '/api/dr/impact?rootId=part27' }));
    const impact = body.impact as unknown as { unrecoverableFiles: number; duplicatedFiles: number };

    expect(impact.unrecoverableFiles).toBe(0);
    expect(impact.duplicatedFiles).toBe(1);
    expect(body.sharedDiskRoots).toEqual([]);
    expect(body.siblingRoots).toEqual([{ id: 'part28', name: 'DRIVEPOOL28' }]);
  });
});
