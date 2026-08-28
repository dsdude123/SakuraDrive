import { describe, expect, it } from 'vitest';
import { AGENT_PROTOCOL_VERSION, agentReportSchema, deviceKey } from './agent-protocol.js';

const minimal = {
  hostname: 'NAS-01',
  collectedAt: '2024-03-05T09:30:00Z',
};

describe('agentReportSchema', () => {
  it('accepts a minimal report from an agent that could collect nothing', () => {
    const report = agentReportSchema.parse(minimal);
    expect(report.protocolVersion).toBe(AGENT_PROTOCOL_VERSION);
    expect(report.agentVersion).toBe('unknown');
    expect(report.physicalDisks).toEqual([]);
    expect(report.smart).toEqual([]);
    expect(report.errors).toEqual([]);
  });

  it('requires a hostname and a collection timestamp', () => {
    expect(() => agentReportSchema.parse({ collectedAt: '2024-03-05T09:30:00Z' })).toThrow();
    expect(() => agentReportSchema.parse({ hostname: '' , collectedAt: 'x' })).toThrow();
  });

  it('parses a full report', () => {
    const report = agentReportSchema.parse({
      ...minimal,
      agentVersion: '1.0.0',
      physicalDisks: [
        {
          deviceId: '\\\\.\\PHYSICALDRIVE3',
          serialNumber: 'WD-ABC123',
          model: 'WDC WD140EDGZ',
          sizeBytes: 14_000_519_643_136,
          mediaType: 'HDD',
          busType: 'SATA',
          healthStatus: 'Healthy',
        },
      ],
      volumes: [
        {
          volumeId: '\\\\?\\Volume{guid}\\',
          label: 'DRIVEPOOL27',
          driveLetter: 'E',
          fileSystem: 'NTFS',
          sizeBytes: 100,
          freeBytes: 50,
          dirty: false,
          physicalDiskIds: ['\\\\.\\PHYSICALDRIVE3'],
        },
      ],
      smart: [
        {
          deviceId: '\\\\.\\PHYSICALDRIVE3',
          source: 'smartctl',
          overallHealthPassed: true,
          attributes: [{ id: 5, name: 'Reallocated_Sector_Ct', value: 100, raw: 0 }],
        },
      ],
      pools: [
        {
          poolId: '{pool-guid}',
          name: 'HDD Pool',
          driveLetter: 'P',
          parts: [{ partId: 'p1', volumeLabel: 'DRIVEPOOL27', missing: false }],
        },
      ],
      duplication: [{ poolId: '{pool-guid}', path: 'Media', level: 2 }],
      performance: [{ instance: '3 E:', readLatencyMs: 4.2, queueLength: 0.3 }],
      primoCache: { available: true, caches: [{ name: 'L2 SSD', cacheSizeBytes: 500 }] },
      errors: [{ collector: 'primocache', message: 'no CLI found' }],
    });

    expect(report.physicalDisks[0]!.serialNumber).toBe('WD-ABC123');
    expect(report.volumes[0]!.label).toBe('DRIVEPOOL27');
    expect(report.smart[0]!.attributes[0]!.id).toBe(5);
    expect(report.pools[0]!.parts[0]!.volumeLabel).toBe('DRIVEPOOL27');
    expect(report.duplication[0]!.level).toBe(2);
    expect(report.primoCache!.caches[0]!.name).toBe('L2 SSD');
  });

  it('rejects a non-positive duplication level', () => {
    expect(() =>
      agentReportSchema.parse({ ...minimal, duplication: [{ path: 'Media', level: 0 }] }),
    ).toThrow();
  });

  it('tolerates nulls where the agent could not read a value', () => {
    const report = agentReportSchema.parse({
      ...minimal,
      smart: [{ deviceId: 'd', temperatureC: null, powerOnHours: null, attributes: [] }],
    });
    expect(report.smart[0]!.temperatureC).toBeNull();
    expect(report.smart[0]!.source).toBe('unknown');
  });
});

describe('deviceKey', () => {
  it('prefers the serial number, upper-cased', () => {
    expect(deviceKey({ serialNumber: 'wd-abc123', deviceId: 'x' })).toBe('sn:WD-ABC123');
  });

  it('falls back to the device id when there is no usable serial', () => {
    expect(deviceKey({ serialNumber: '', deviceId: '\\\\.\\PHYSICALDRIVE3' })).toBe(
      'dev:\\\\.\\PHYSICALDRIVE3',
    );
    expect(deviceKey({ serialNumber: 'unknown', deviceId: 'drive0' })).toBe('dev:DRIVE0');
  });

  it('is stable when nothing identifies the drive', () => {
    expect(deviceKey({})).toBe('dev:unknown');
  });
});
