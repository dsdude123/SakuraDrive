import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import readline from 'node:readline';
import {
  EXPORT_FORMAT_VERSION,
  parseSettings,
  redactSettings,
  type ExportManifest,
  type ExportRecord,
  type Settings,
} from '@sakuradrive/shared';
import { nowIso, type Db } from '../db/index.js';
import type { Logger } from '../logger.js';
import type { SettingsService } from './settings-service.js';

/**
 * Tables carried in an export bundle, in dependency order so an import can replay them
 * without violating foreign keys.
 */
export const EXPORTABLE_TABLES = [
  'drives',
  'volumes',
  'pools',
  'pool_parts',
  'agents',
  'alerts',
  'catalog_runs',
  'files',
  'catalog_changes',
  'dir_stats',
  'bitrot_findings',
  'backup_runs',
  'backup_issues',
] as const;

export type ExportableTable = (typeof EXPORTABLE_TABLES)[number];

/** Tables only included when the operator asks for history as well as current state. */
const HISTORY_TABLES: ExportableTable[] = ['catalog_changes'];
const CATALOG_TABLES: ExportableTable[] = ['files', 'dir_stats', 'catalog_changes', 'catalog_runs'];
const SMART_TABLES = ['smart_snapshots', 'smart_attribute_history'] as const;
const PERFORMANCE_TABLES = ['performance_samples', 'primocache_samples'] as const;

export interface ExportOptions {
  includeCatalog?: boolean;
  includeHistory?: boolean;
  includeSmartHistory?: boolean;
  includePerformanceHistory?: boolean;
  redactSecrets?: boolean;
  trigger?: 'manual' | 'schedule';
  signal?: AbortSignal;
  onProgress?: (records: number, table: string) => void;
}

export interface ExportResult {
  filePath: string;
  fileName: string;
  sizeBytes: number;
  recordCount: number;
  checksum: string;
  manifest: ExportManifest;
}

export interface ImportOptions {
  /** `merge` keeps existing rows; `replace` clears each imported table first. */
  mode: 'merge' | 'replace';
  /** Import the settings document from the bundle. */
  importSettings?: boolean;
  signal?: AbortSignal;
}

export interface ImportResult {
  manifest: ExportManifest | null;
  imported: Record<string, number>;
  skipped: string[];
  settingsImported: boolean;
  warnings: string[];
}

export interface ExportServiceOptions {
  db: Db;
  settings: SettingsService;
  logger: Logger;
  dataDir: string;
  appVersion: string;
  hostname: string;
}

/**
 * Export and import of the entire application state.
 *
 * This is the feature that makes SakuraDrive a disaster-recovery tool rather than a
 * dashboard: the catalog is most valuable precisely when the machine holding it has
 * just lost a disk, so bundles are written somewhere else, automatically, on a
 * schedule, and can be read back into an empty install.
 *
 * The format is gzipped NDJSON — one JSON object per line, streamed in and out, so a
 * catalog of tens of millions of rows never has to fit in memory.
 */
export class ExportService {
  private readonly db: Db;
  private readonly settings: SettingsService;
  private readonly logger: Logger;
  private readonly dataDir: string;
  private readonly appVersion: string;
  private readonly hostname: string;

  constructor(options: ExportServiceOptions) {
    this.db = options.db;
    this.settings = options.settings;
    this.logger = options.logger;
    this.dataDir = options.dataDir;
    this.appVersion = options.appVersion;
    this.hostname = options.hostname;
  }

  get exportDir(): string {
    return path.join(this.dataDir, 'exports');
  }

  /** Write a bundle to `targetPath` (or a timestamped file in the data directory). */
  async export(targetPath?: string, options: ExportOptions = {}): Promise<ExportResult> {
    const config = this.settings.get();
    const includeCatalog = options.includeCatalog ?? true;
    const includeHistory = options.includeHistory ?? true;
    const includeSmart = options.includeSmartHistory ?? true;
    const includePerformance = options.includePerformanceHistory ?? false;
    const redact = options.redactSecrets ?? config.autoExport.redactSecrets;

    const tables: string[] = [];
    for (const table of EXPORTABLE_TABLES) {
      if (!includeCatalog && CATALOG_TABLES.includes(table)) continue;
      if (!includeHistory && HISTORY_TABLES.includes(table)) continue;
      tables.push(table);
    }
    if (includeSmart) tables.push(...SMART_TABLES);
    if (includePerformance) tables.push(...PERFORMANCE_TABLES);

    const fileName = targetPath
      ? path.basename(targetPath)
      : `sakuradrive-${new Date().toISOString().replace(/[:.]/g, '-')}.ndjson.gz`;
    const filePath = targetPath ?? path.join(this.exportDir, fileName);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });

    const counts: Record<string, number> = {};
    let recordCount = 0;
    const hash = createHash('sha256');

    const settingsDocument: Settings = redact ? redactSettings(config) : config;

    const self = this;
    async function* generate(): AsyncGenerator<string> {
      const manifest: ExportManifest = {
        format: 'sakuradrive-export',
        version: EXPORT_FORMAT_VERSION,
        createdAt: nowIso(),
        appVersion: self.appVersion,
        hostname: self.hostname,
        redactedSecrets: redact,
        tables: {},
        recordCount: 0,
      };
      yield `${JSON.stringify({ __manifest: manifest })}\n`;
      yield `${JSON.stringify({ __settings: settingsDocument })}\n`;

      for (const table of tables) {
        if (options.signal?.aborted) return;
        let tableCount = 0;
        const rows = self.db.prepare(`SELECT * FROM ${table}`).iterate() as Iterable<
          Record<string, unknown>
        >;
        for (const row of rows) {
          if (options.signal?.aborted) return;
          yield `${JSON.stringify({ t: table, r: row })}\n`;
          tableCount += 1;
          recordCount += 1;
          if (recordCount % 10_000 === 0) options.onProgress?.(recordCount, table);
        }
        counts[table] = tableCount;
        options.onProgress?.(recordCount, table);
      }
    }

    const source = Readable.from(generate());
    // The checksum covers the uncompressed stream so it can be verified after a
    // round-trip through any transport.
    const tap = new (await import('node:stream')).Transform({
      transform(chunk, _encoding, callback) {
        hash.update(chunk as Buffer);
        callback(null, chunk);
      },
    });

    await pipeline(source, tap, zlib.createGzip({ level: 6 }), fs.createWriteStream(filePath));

    const sizeBytes = fs.statSync(filePath).size;
    const checksum = hash.digest('hex');
    const manifest: ExportManifest = {
      format: 'sakuradrive-export',
      version: EXPORT_FORMAT_VERSION,
      createdAt: nowIso(),
      appVersion: this.appVersion,
      hostname: this.hostname,
      redactedSecrets: redact,
      tables: counts,
      recordCount,
    };

    return { filePath, fileName, sizeBytes, recordCount, checksum, manifest };
  }

  /** Read a bundle back. Streams, so a huge catalog imports without buffering. */
  async import(filePath: string, options: ImportOptions): Promise<ImportResult> {
    const result: ImportResult = {
      manifest: null,
      imported: {},
      skipped: [],
      settingsImported: false,
      warnings: [],
    };

    const knownTables = new Set(
      this.db
        .prepare<[], { name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all()
        .map((row) => row.name),
    );
    const columnsByTable = new Map<string, Set<string>>();
    const statements = new Map<string, ReturnType<Db['prepare']>>();
    const clearedTables = new Set<string>();

    const stream = fs.createReadStream(filePath);
    const input = filePath.endsWith('.gz') ? stream.pipe(zlib.createGunzip()) : stream;
    const lines = readline.createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });

    let batch: Array<{ table: string; row: Record<string, unknown> }> = [];
    const flush = () => {
      if (batch.length === 0) return;
      this.db.transaction(() => {
        for (const { table, row } of batch) {
          const statement = statements.get(table);
          if (!statement) continue;
          const columns = columnsByTable.get(table)!;
          const values: Record<string, unknown> = {};
          for (const column of columns) values[column] = row[column] ?? null;
          try {
            statement.run(values);
          } catch (error) {
            result.warnings.push(
              `${table}: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
      })();
      batch = [];
    };

    try {
      for await (const line of lines) {
        if (options.signal?.aborted) break;
        const trimmed = line.trim();
        if (trimmed === '') continue;

        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(trimmed) as Record<string, unknown>;
        } catch {
          result.warnings.push('Skipped an unparseable line');
          continue;
        }

        if (parsed.__manifest) {
          result.manifest = parsed.__manifest as ExportManifest;
          if (result.manifest.format !== 'sakuradrive-export') {
            throw new Error('This file is not a SakuraDrive export bundle');
          }
          if (result.manifest.version > EXPORT_FORMAT_VERSION) {
            throw new Error(
              `Bundle format version ${result.manifest.version} is newer than this build understands (${EXPORT_FORMAT_VERSION}). Upgrade SakuraDrive first.`,
            );
          }
          continue;
        }

        if (parsed.__settings) {
          if (options.importSettings) {
            this.settings.replace(parseSettings(parsed.__settings));
            result.settingsImported = true;
          }
          continue;
        }

        const table = String(parsed.t ?? '');
        const row = (parsed.r ?? {}) as Record<string, unknown>;
        if (!knownTables.has(table)) {
          if (!result.skipped.includes(table)) result.skipped.push(table);
          continue;
        }

        if (!statements.has(table)) {
          const columns = new Set(
            (
              this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
            ).map((column) => column.name),
          );
          columnsByTable.set(table, columns);
          const columnList = [...columns];
          statements.set(
            table,
            this.db.prepare(
              `INSERT OR REPLACE INTO ${table} (${columnList.join(', ')})
               VALUES (${columnList.map((column) => `@${column}`).join(', ')})`,
            ),
          );
        }

        if (options.mode === 'replace' && !clearedTables.has(table)) {
          this.db.prepare(`DELETE FROM ${table}`).run();
          clearedTables.add(table);
        }

        batch.push({ table, row });
        result.imported[table] = (result.imported[table] ?? 0) + 1;
        if (batch.length >= 1000) flush();
      }
      flush();
    } finally {
      lines.close();
      input.destroy?.();
      stream.destroy();
    }

    this.settings.invalidate();
    return result;
  }

  /** Read only the manifest, for the import preview screen. */
  async inspect(filePath: string): Promise<ExportManifest | null> {
    const stream = fs.createReadStream(filePath);
    const input = filePath.endsWith('.gz') ? stream.pipe(zlib.createGunzip()) : stream;
    const lines = readline.createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });
    try {
      for await (const line of lines) {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        if (parsed.__manifest) return parsed.__manifest as ExportManifest;
        return null;
      }
    } catch {
      return null;
    } finally {
      lines.close();
      input.destroy?.();
      stream.destroy();
    }
    return null;
  }

  /** Count the records in a bundle. Used to verify a freshly written export. */
  async verifyBundle(filePath: string): Promise<{ ok: boolean; recordCount: number; error?: string }> {
    try {
      const stream = fs.createReadStream(filePath);
      const input = filePath.endsWith('.gz') ? stream.pipe(zlib.createGunzip()) : stream;
      const lines = readline.createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });
      let records = 0;
      let sawManifest = false;
      for await (const line of lines) {
        if (line.trim() === '') continue;
        const parsed = JSON.parse(line) as Record<string, unknown>;
        if (parsed.__manifest) {
          sawManifest = true;
          continue;
        }
        if (parsed.__settings) continue;
        records += 1;
      }
      lines.close();
      stream.destroy();
      if (!sawManifest) return { ok: false, recordCount: records, error: 'No manifest in bundle' };
      return { ok: true, recordCount: records };
    } catch (error) {
      return {
        ok: false,
        recordCount: 0,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /* --------------------------------------------------------------- records */

  recordExport(input: {
    fileName: string;
    destinationId: string | null;
    destinationPath: string | null;
    sizeBytes: number;
    recordCount: number;
    checksum: string;
    trigger: 'manual' | 'schedule';
    verified: boolean;
    error?: string | null;
  }): number {
    const info = this.db
      .prepare(
        `INSERT INTO export_records
           (created_at, file_name, destination_id, destination_path, size_bytes, record_count, checksum, trigger, verified, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        nowIso(),
        input.fileName,
        input.destinationId,
        input.destinationPath,
        input.sizeBytes,
        input.recordCount,
        input.checksum,
        input.trigger,
        input.verified ? 1 : 0,
        input.error ?? null,
      );
    return Number(info.lastInsertRowid);
  }

  listExports(limit = 50): ExportRecord[] {
    return this.db
      .prepare<[number], {
        id: number; created_at: string; file_name: string; destination_id: string | null;
        destination_path: string | null; size_bytes: number; record_count: number;
        checksum: string; trigger: string; verified: number; error: string | null;
      }>('SELECT * FROM export_records ORDER BY id DESC LIMIT ?')
      .all(limit)
      .map((row) => ({
        id: row.id,
        createdAt: row.created_at,
        fileName: row.file_name,
        destinationId: row.destination_id,
        destinationPath: row.destination_path,
        sizeBytes: row.size_bytes,
        recordCount: row.record_count,
        checksum: row.checksum,
        trigger: row.trigger as 'manual' | 'schedule',
        verified: row.verified !== 0,
        error: row.error,
      }));
  }

  lastExportAt(): string | null {
    const row = this.db
      .prepare<[], { created_at: string }>(
        'SELECT created_at FROM export_records WHERE error IS NULL ORDER BY id DESC LIMIT 1',
      )
      .get();
    return row?.created_at ?? null;
  }

  /** Delete bundles beyond the retention count in a destination directory. */
  pruneDestination(destinationPath: string, retain: number): string[] {
    if (!fs.existsSync(destinationPath)) return [];
    const bundles = fs
      .readdirSync(destinationPath)
      .filter((name) => name.startsWith('sakuradrive-') && name.endsWith('.ndjson.gz'))
      .map((name) => ({ name, mtime: fs.statSync(path.join(destinationPath, name)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    const removed: string[] = [];
    for (const bundle of bundles.slice(retain)) {
      try {
        fs.rmSync(path.join(destinationPath, bundle.name));
        removed.push(bundle.name);
      } catch (error) {
        this.logger.warn({ error, file: bundle.name }, 'could not prune old export');
      }
    }
    return removed;
  }
}
