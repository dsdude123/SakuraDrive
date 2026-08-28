import { describe, expect, it, vi } from 'vitest';
import { defaultSettings } from '@sakuradrive/shared';
import {
  KopiaClient,
  formatSource,
  matchesSource,
  parseSnapshotList,
  type CommandResult,
  type KopiaRunner,
} from './kopia-client.js';

const SNAPSHOT_JSON = JSON.stringify([
  {
    id: 'k1',
    source: { host: 'NAS-01', userName: 'backup', path: 'P:\\Media' },
    startTime: '2024-03-01T02:00:00Z',
    endTime: '2024-03-01T03:00:00Z',
    rootEntry: { obj: 'kabc', summ: { size: 1000, numFiles: 12 } },
  },
  {
    id: 'k2',
    source: { host: 'NAS-01', userName: 'backup', path: 'P:\\Media' },
    startTime: '2024-03-05T02:00:00Z',
    endTime: '2024-03-05T03:00:00Z',
    rootEntry: { obj: 'kdef', summ: { size: 2000, numFiles: 20 } },
  },
]);

function makeRunner(overrides: Partial<KopiaRunner> = {}): KopiaRunner {
  return {
    run: vi.fn(async (): Promise<CommandResult> => ({ code: 0, stdout: '', stderr: '' })),
    // eslint-disable-next-line require-yield
    stream: vi.fn(async function* () {}),
    ...overrides,
  };
}

describe('parseSnapshotList', () => {
  it('parses kopia snapshot list output', () => {
    const snapshots = parseSnapshotList(SNAPSHOT_JSON);
    expect(snapshots).toHaveLength(2);
    expect(snapshots[0]).toMatchObject({
      id: 'k1',
      host: 'NAS-01',
      userName: 'backup',
      path: 'P:\\Media',
      fileCount: 12,
      totalSize: 1000,
      rootEntry: 'kabc',
    });
    expect(snapshots[0]!.source).toBe('backup@NAS-01:P:\\Media');
  });

  it('tolerates missing fields and invalid JSON', () => {
    expect(parseSnapshotList('not json')).toEqual([]);
    const partial = parseSnapshotList('[{"id":"x"}]');
    expect(partial[0]).toMatchObject({ id: 'x', fileCount: null, totalSize: null });
  });
});

describe('source matching', () => {
  const snapshot = parseSnapshotList(SNAPSHOT_JSON)[0]!;

  it('matches the rendered source, the path or an empty filter', () => {
    expect(matchesSource(snapshot, 'backup@NAS-01:P:\\Media')).toBe(true);
    expect(matchesSource(snapshot, 'P:\\Media')).toBe(true);
    expect(matchesSource(snapshot, '')).toBe(true);
    expect(matchesSource(snapshot, 'other@host:D:\\')).toBe(false);
  });

  it('is case-insensitive, because Windows paths are', () => {
    expect(matchesSource(snapshot, 'p:\\media')).toBe(true);
  });

  it('formats a source the way kopia does', () => {
    expect(formatSource({ userName: 'backup', host: 'NAS-01', path: 'P:\\Media' })).toBe(
      'backup@NAS-01:P:\\Media',
    );
  });
});

describe('KopiaClient', () => {
  it('returns the newest snapshot for a source', async () => {
    const runner = makeRunner({
      run: vi.fn(async () => ({ code: 0, stdout: SNAPSHOT_JSON, stderr: '' })),
    });
    const latest = await new KopiaClient(runner).latestSnapshot('P:\\Media');
    expect(latest!.id).toBe('k2');
  });

  it('returns null when nothing matches the source', async () => {
    const runner = makeRunner({
      run: vi.fn(async () => ({ code: 0, stdout: SNAPSHOT_JSON, stderr: '' })),
    });
    expect(await new KopiaClient(runner).latestSnapshot('Q:\\Nope')).toBeNull();
  });

  it('surfaces a CLI failure', async () => {
    const runner = makeRunner({
      run: vi.fn(async () => ({ code: 1, stdout: '', stderr: 'repository not connected' })),
    });
    await expect(new KopiaClient(runner).listSnapshots()).rejects.toThrow(/not connected/);
  });

  it('streams entries, skipping directories', async () => {
    const runner = makeRunner({
      stream: vi.fn(async function* () {
        yield '[{"name":"Media/a.mkv","type":"f","size":10,"mtime":"2024-03-01T00:00:00Z"},';
        yield '{"name":"Media","type":"d","size":0},';
        yield '{"name":"Media/b.mkv","type":"f","size":20}]';
      }),
    });
    const entries = [];
    for await (const entry of new KopiaClient(runner).listEntries('k2')) entries.push(entry);
    expect(entries.map((entry) => entry.relPath)).toEqual(['Media/a.mkv', 'Media', 'Media/b.mkv']);
    expect(entries[0]).toMatchObject({ sizeBytes: 10, type: 'file' });
    expect(entries[1]!.type).toBe('directory');
    expect(entries[2]!.mtimeMs).toBeNull();
  });

  it('stops at maxEntries', async () => {
    const runner = makeRunner({
      stream: vi.fn(async function* () {
        yield `[${Array.from({ length: 50 }, (_, i) => `{"name":"f${i}","type":"f","size":1}`).join(',')}]`;
      }),
    });
    const entries = [];
    for await (const entry of new KopiaClient(runner).listEntries('k2', { maxEntries: 5 })) {
      entries.push(entry);
    }
    expect(entries).toHaveLength(5);
  });

  it('builds the right connect arguments for Backblaze', async () => {
    const run = vi.fn(async () => ({ code: 0, stdout: '', stderr: '' }));
    const client = new KopiaClient(makeRunner({ run }));
    const settings = defaultSettings().backup;
    settings.repository = {
      type: 'b2',
      bucket: 'nas-backups',
      prefix: 'pool/',
      keyId: 'kid',
      key: 'secret',
      endpoint: '',
      path: '',
    };
    const result = await client.connect(settings);
    expect(result.ok).toBe(true);
    expect(run).toHaveBeenCalledWith([
      'repository',
      'connect',
      'b2',
      '--bucket',
      'nas-backups',
      '--key-id',
      'kid',
      '--key',
      'secret',
      '--prefix',
      'pool/',
    ]);
  });

  it('treats "already connected" as success', async () => {
    const client = new KopiaClient(
      makeRunner({ run: vi.fn(async () => ({ code: 1, stdout: '', stderr: 'already connected' })) }),
    );
    const result = await client.connect(defaultSettings().backup);
    expect(result.ok).toBe(true);
  });

  it('reports a connection failure with the CLI message', async () => {
    const client = new KopiaClient(
      makeRunner({ run: vi.fn(async () => ({ code: 1, stdout: '', stderr: 'invalid key' })) }),
    );
    const result = await client.connect(defaultSettings().backup);
    expect(result.ok).toBe(false);
    expect(result.message).toBe('invalid key');
  });
});
