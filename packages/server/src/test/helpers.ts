import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentReport } from '@sakuradrive/shared';
import { openTestDatabase, type Db } from '../db/index.js';
import { createSilentLogger } from '../logger.js';
import { AgentService } from '../services/agent-service.js';
import { AlertService } from '../services/alert-service.js';
import { SettingsService } from '../services/settings-service.js';

export interface TestContext {
  db: Db;
  settings: SettingsService;
  alerts: AlertService;
  agents: AgentService;
  logger: ReturnType<typeof createSilentLogger>;
  close(): void;
}

export function createTestContext(): TestContext {
  const db = openTestDatabase();
  const logger = createSilentLogger();
  const settings = new SettingsService(db);
  const alerts = new AlertService(db);
  const agents = new AgentService({ db, settings, alerts, logger });
  return {
    db,
    settings,
    alerts,
    agents,
    logger,
    close: () => db.close(),
  };
}

/** A temporary directory that is removed when `dispose` is called. */
export function createTempDir(prefix = 'sakuradrive-test-'): { path: string; dispose(): void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return {
    path: dir,
    dispose: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

/** Write a file (creating parents) and optionally force its mtime. */
export function writeFile(root: string, relPath: string, content: string, mtimeMs?: number): string {
  const full = path.join(root, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  if (mtimeMs !== undefined) {
    const time = mtimeMs / 1000;
    fs.utimesSync(full, time, time);
  }
  return full;
}

export interface SmartAttributeInput {
  id: number;
  raw: number;
  value?: number;
  threshold?: number;
  name?: string;
}

export function smartAttribute(input: SmartAttributeInput) {
  return {
    id: input.id,
    name: input.name ?? `attr${input.id}`,
    value: input.value ?? 100,
    worst: input.value ?? 100,
    threshold: input.threshold ?? 0,
    raw: input.raw,
    rawString: String(input.raw),
    whenFailed: null,
    flags: null,
  };
}

/** A realistic report for a two-disk host, easy to tweak per test. */
export function buildAgentReport(overrides: Partial<AgentReport> = {}): AgentReport {
  return {
    protocolVersion: 1,
    agentVersion: '1.0.0',
    distributionVersion: '',
    hostname: 'NAS-01',
    collectedAt: new Date().toISOString(),
    intervalSeconds: 900,
    physicalDisks: [
      {
        deviceId: '\\\\.\\PHYSICALDRIVE3',
        friendlyName: 'WDC WD140EDGZ',
        model: 'WDC WD140EDGZ-11B1PA0',
        serialNumber: 'WD-ABC123',
        firmwareVersion: '85.00A85',
        sizeBytes: 14_000_519_643_136,
        mediaType: 'HDD',
        busType: 'SATA',
        healthStatus: 'Healthy',
        operationalStatus: 'OK',
        physicalLocation: null,
        adapterSerialNumber: null,
        temperatureC: 34,
      },
    ],
    volumes: [
      {
        volumeId: '\\\\?\\Volume{aaaa}\\',
        label: 'DRIVEPOOL27',
        driveLetter: 'E',
        path: 'E:\\',
        fileSystem: 'NTFS',
        fileSystemLabel: 'DRIVEPOOL27',
        sizeBytes: 14_000_000_000_000,
        freeBytes: 4_000_000_000_000,
        healthStatus: 'Healthy',
        operationalStatus: 'OK',
        dirty: false,
        physicalDiskIds: ['\\\\.\\PHYSICALDRIVE3'],
      },
    ],
    smart: [
      {
        deviceId: '\\\\.\\PHYSICALDRIVE3',
        serialNumber: 'WD-ABC123',
        model: 'WDC WD140EDGZ',
        firmware: '85.00A85',
        source: 'smartctl',
        smartSupported: true,
        smartEnabled: true,
        overallHealthPassed: true,
        temperatureC: 34,
        powerOnHours: 12_345,
        powerCycles: 42,
        rotationRate: 7200,
        protocol: 'ATA',
        attributes: [smartAttribute({ id: 5, raw: 0 }), smartAttribute({ id: 197, raw: 0 })],
        nvme: null,
        selfTest: null,
        rawJson: null,
      },
    ],
    pools: [
      {
        poolId: '{hdd-pool}',
        name: 'HDD Pool',
        driveLetter: 'P',
        sizeBytes: 100_000_000_000_000,
        freeBytes: 20_000_000_000_000,
        duplicatedBytes: null,
        unduplicatedBytes: null,
        parts: [
          {
            partId: 'part-1',
            name: 'DRIVEPOOL27',
            volumeId: '\\\\?\\Volume{aaaa}\\',
            volumeLabel: 'DRIVEPOOL27',
            driveLetter: 'E',
            path: 'E:\\',
            sizeBytes: 14_000_000_000_000,
            freeBytes: 4_000_000_000_000,
            usedBytes: 10_000_000_000_000,
            physicalDiskId: '\\\\.\\PHYSICALDRIVE3',
            missing: false,
            readOnly: false,
          },
        ],
      },
    ],
    duplication: [],
    performance: [],
    primoCache: null,
    errors: [],
    ...overrides,
  };
}
