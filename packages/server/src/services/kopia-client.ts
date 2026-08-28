import { spawn } from 'node:child_process';
import { normalizeRelPath } from '@sakuradrive/shared';
import type { Settings } from '@sakuradrive/shared';
import { JsonArrayStreamParser, safeParse } from '../util/json-stream.js';

export interface KopiaSnapshot {
  id: string;
  /** `user@host:path` as Kopia renders it. */
  source: string;
  host: string;
  userName: string;
  path: string;
  startTime: string;
  endTime: string | null;
  fileCount: number | null;
  totalSize: number | null;
  rootEntry: string | null;
}

export interface KopiaEntry {
  /** Path relative to the snapshot root, POSIX separators, no leading slash. */
  relPath: string;
  sizeBytes: number;
  mtimeMs: number | null;
  type: 'file' | 'directory' | 'other';
}

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Injected so the whole backup verification path can be tested without Kopia. */
export interface KopiaRunner {
  run(args: string[]): Promise<CommandResult>;
  /** Yields stdout in chunks so huge listings never sit in memory. */
  stream(args: string[]): AsyncIterable<string>;
}

export class KopiaNotAvailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KopiaNotAvailableError';
  }
}

export interface SpawnRunnerOptions {
  binary: string;
  configFile?: string;
  cacheDirectory?: string;
  password?: string;
  extraArgs?: string[];
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

/** Real runner: spawns the bundled `kopia` binary. */
export function createSpawnRunner(options: SpawnRunnerOptions): KopiaRunner {
  const baseArgs = (): string[] => {
    const args: string[] = [];
    if (options.configFile) args.push('--config-file', options.configFile);
    if (options.cacheDirectory) args.push('--cache-directory', options.cacheDirectory);
    args.push(...(options.extraArgs ?? []));
    return args;
  };

  const env = (): NodeJS.ProcessEnv => ({
    ...process.env,
    ...options.env,
    // Kopia reads the repository password from the environment, which keeps it out of
    // the process list where `ps` would expose it.
    ...(options.password ? { KOPIA_PASSWORD: options.password } : {}),
    KOPIA_CHECK_FOR_UPDATES: 'false',
  });

  return {
    async run(args) {
      return new Promise<CommandResult>((resolve, reject) => {
        const child = spawn(options.binary, [...baseArgs(), ...args], { env: env() });
        let stdout = '';
        let stderr = '';
        const timer = options.timeoutMs
          ? setTimeout(() => child.kill('SIGKILL'), options.timeoutMs)
          : null;
        child.stdout.on('data', (chunk: Buffer) => {
          stdout += chunk.toString('utf8');
        });
        child.stderr.on('data', (chunk: Buffer) => {
          stderr += chunk.toString('utf8');
        });
        child.on('error', (error) => {
          if (timer) clearTimeout(timer);
          reject(
            new KopiaNotAvailableError(
              `Could not run "${options.binary}": ${error.message}. Install Kopia in the container or point the setting at the right binary.`,
            ),
          );
        });
        child.on('close', (code) => {
          if (timer) clearTimeout(timer);
          resolve({ code: code ?? -1, stdout, stderr });
        });
      });
    },

    async *stream(args) {
      const child = spawn(options.binary, [...baseArgs(), ...args], { env: env() });
      const chunks: string[] = [];
      let done = false;
      let failure: Error | null = null;
      let notify: (() => void) | null = null;

      const wake = () => {
        notify?.();
        notify = null;
      };
      child.stdout.on('data', (chunk: Buffer) => {
        chunks.push(chunk.toString('utf8'));
        wake();
      });
      child.on('error', (error) => {
        failure = new KopiaNotAvailableError(`Could not run "${options.binary}": ${error.message}`);
        done = true;
        wake();
      });
      child.on('close', () => {
        done = true;
        wake();
      });

      for (;;) {
        if (chunks.length > 0) {
          yield chunks.shift()!;
          continue;
        }
        if (failure) throw failure;
        if (done) return;
        await new Promise<void>((resolve) => {
          notify = resolve;
        });
      }
    },
  };
}

/**
 * Thin wrapper over the Kopia CLI.
 *
 * Only read operations are used: SakuraDrive verifies that a backup contains what it
 * should, it never writes to or prunes the repository.
 */
export class KopiaClient {
  constructor(private readonly runner: KopiaRunner) {}

  async version(): Promise<string> {
    const result = await this.runner.run(['--version']);
    return result.stdout.trim() || result.stderr.trim();
  }

  /** Connect to an existing repository. Idempotent — reconnecting is harmless. */
  async connect(settings: Settings['backup']): Promise<{ ok: boolean; message: string }> {
    const repo = settings.repository;
    if (repo.type === 'existing') {
      const status = await this.status();
      return { ok: status.connected, message: status.message };
    }

    const args = ['repository', 'connect'];
    if (repo.type === 'b2') {
      args.push('b2', '--bucket', repo.bucket, '--key-id', repo.keyId, '--key', repo.key);
      if (repo.prefix) args.push('--prefix', repo.prefix);
    } else if (repo.type === 's3') {
      args.push('s3', '--bucket', repo.bucket, '--access-key', repo.keyId, '--secret-access-key', repo.key);
      if (repo.endpoint) args.push('--endpoint', repo.endpoint);
      if (repo.prefix) args.push('--prefix', repo.prefix);
    } else {
      args.push('filesystem', '--path', repo.path);
    }

    const result = await this.runner.run(args);
    if (result.code !== 0) {
      const message = (result.stderr || result.stdout).trim();
      // Already connected is a success as far as we are concerned.
      if (/already connected/i.test(message)) return { ok: true, message: 'Already connected' };
      return { ok: false, message: message || `kopia exited with code ${result.code}` };
    }
    return { ok: true, message: 'Connected' };
  }

  async status(): Promise<{ connected: boolean; message: string }> {
    const result = await this.runner.run(['repository', 'status', '--json']);
    if (result.code !== 0) {
      return { connected: false, message: (result.stderr || result.stdout).trim() };
    }
    const parsed = safeParse<Record<string, unknown>>(result.stdout, {});
    return {
      connected: true,
      message: typeof parsed.configFile === 'string' ? String(parsed.configFile) : 'Connected',
    };
  }

  async listSnapshots(source?: string): Promise<KopiaSnapshot[]> {
    const args = ['snapshot', 'list', '--json', '--all'];
    if (source) args.push(source);
    const result = await this.runner.run(args);
    if (result.code !== 0) {
      throw new Error((result.stderr || result.stdout).trim() || 'kopia snapshot list failed');
    }
    return parseSnapshotList(result.stdout);
  }

  /** The most recent completed snapshot for a source, or null. */
  async latestSnapshot(source: string): Promise<KopiaSnapshot | null> {
    const snapshots = await this.listSnapshots(source);
    const matching = snapshots
      .filter((snapshot) => matchesSource(snapshot, source))
      .sort((a, b) => Date.parse(b.startTime) - Date.parse(a.startTime));
    return matching[0] ?? null;
  }

  /**
   * Stream every file in a snapshot. `maxEntries` bounds the work on a repository far
   * larger than expected rather than running until the container is out of memory.
   */
  async *listEntries(
    snapshotIdOrRoot: string,
    options: { maxEntries?: number; signal?: AbortSignal } = {},
  ): AsyncGenerator<KopiaEntry> {
    const parser = new JsonArrayStreamParser();
    let emitted = 0;
    const max = options.maxEntries ?? Number.POSITIVE_INFINITY;

    for await (const chunk of this.runner.stream(['ls', '-l', '-r', '--json', snapshotIdOrRoot])) {
      if (options.signal?.aborted) return;
      for (const raw of parser.push(chunk)) {
        const entry = toEntry(raw);
        if (!entry) continue;
        yield entry;
        emitted += 1;
        if (emitted >= max) return;
      }
    }
    for (const raw of parser.flush()) {
      const entry = toEntry(raw);
      if (!entry) continue;
      yield entry;
      emitted += 1;
      if (emitted >= max) return;
    }
  }
}

/** Kopia renders a source as `user@host:path`. */
export function formatSource(snapshot: Pick<KopiaSnapshot, 'userName' | 'host' | 'path'>): string {
  return `${snapshot.userName}@${snapshot.host}:${snapshot.path}`;
}

export function matchesSource(snapshot: KopiaSnapshot, source: string): boolean {
  const wanted = source.trim().toLowerCase();
  if (wanted === '') return true;
  const candidates = [snapshot.source, formatSource(snapshot), snapshot.path];
  return candidates.some((candidate) => candidate.toLowerCase() === wanted);
}

export function parseSnapshotList(json: string): KopiaSnapshot[] {
  const parsed = safeParse<unknown>(json, []);
  const list = Array.isArray(parsed) ? parsed : [];
  const out: KopiaSnapshot[] = [];
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue;
    const record = raw as Record<string, unknown>;
    const sourceRecord = (record.source ?? {}) as Record<string, unknown>;
    const rootEntry = (record.rootEntry ?? {}) as Record<string, unknown>;
    const summary = (rootEntry.summ ?? {}) as Record<string, unknown>;
    const host = String(sourceRecord.host ?? '');
    const userName = String(sourceRecord.userName ?? '');
    const path = String(sourceRecord.path ?? '');
    out.push({
      id: String(record.id ?? ''),
      source: `${userName}@${host}:${path}`,
      host,
      userName,
      path,
      startTime: String(record.startTime ?? ''),
      endTime: record.endTime ? String(record.endTime) : null,
      fileCount: numberOrNull(summary.numFiles ?? summary.files),
      totalSize: numberOrNull(summary.size ?? summary.totalSize),
      rootEntry: rootEntry.obj ? String(rootEntry.obj) : null,
    });
  }
  return out;
}

function toEntry(raw: unknown): KopiaEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  const name = String(record.name ?? '');
  if (name === '') return null;
  const type = String(record.type ?? '');
  const kind: KopiaEntry['type'] = type === 'd' || type === 'directory' ? 'directory' : type === 'f' || type === 'file' ? 'file' : 'other';
  const mtimeRaw = record.mtime ?? record.modTime;
  const mtimeMs = typeof mtimeRaw === 'string' ? Date.parse(mtimeRaw) : null;
  return {
    relPath: normalizeRelPath(name),
    sizeBytes: numberOrNull(record.size) ?? 0,
    mtimeMs: Number.isFinite(mtimeMs) ? (mtimeMs as number) : null,
    type: kind,
  };
}

function numberOrNull(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
