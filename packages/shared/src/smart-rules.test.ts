import { describe, expect, it } from 'vitest';
import type { SmartReport } from './agent-protocol.js';
import {
  attributeRaw,
  describeNvmeCriticalWarning,
  evaluatePerformance,
  evaluateSmart,
  evaluateVolume,
  maxSeverity,
} from './smart-rules.js';

function report(overrides: Partial<SmartReport> = {}): SmartReport {
  return {
    deviceId: '\\\\.\\PHYSICALDRIVE3',
    serialNumber: 'WD-ABC123',
    model: 'WDC WD140EDGZ',
    firmware: null,
    source: 'smartctl',
    smartSupported: true,
    smartEnabled: true,
    overallHealthPassed: true,
    temperatureC: 35,
    powerOnHours: 12345,
    powerCycles: 42,
    rotationRate: 7200,
    protocol: 'ATA',
    attributes: [],
    nvme: null,
    selfTest: null,
    rawJson: null,
    ...overrides,
  };
}

const attr = (id: number, raw: number, extra: Record<string, unknown> = {}) => ({
  id,
  name: `attr${id}`,
  value: 100,
  worst: 100,
  threshold: 0,
  raw,
  rawString: String(raw),
  whenFailed: null,
  flags: null,
  ...extra,
});

describe('maxSeverity', () => {
  it('picks the more severe of two levels', () => {
    expect(maxSeverity('info', 'warning')).toBe('warning');
    expect(maxSeverity('critical', 'warning')).toBe('critical');
    expect(maxSeverity('info', 'info')).toBe('info');
  });
});

describe('attributeRaw', () => {
  it('prefers the numeric raw value', () => {
    expect(attributeRaw(attr(5, 12))).toBe(12);
  });

  it('parses the leading number out of a composite raw string', () => {
    expect(attributeRaw(attr(194, Number.NaN, { raw: null, rawString: '34 (Min/Max 20/45)' }))).toBe(34);
  });

  it('returns null when there is nothing to parse', () => {
    expect(attributeRaw(undefined)).toBeNull();
    expect(attributeRaw(attr(5, Number.NaN, { raw: null, rawString: null }))).toBeNull();
  });
});

describe('evaluateSmart', () => {
  it('finds nothing wrong with a healthy drive', () => {
    expect(evaluateSmart({ report: report({ attributes: [attr(5, 0), attr(197, 0)] }) })).toEqual([]);
  });

  it('raises a critical finding when the drive fails its own health check', () => {
    const findings = evaluateSmart({ report: report({ overallHealthPassed: false }) });
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe('critical');
    expect(findings[0]!.key).toBe('smart.overall');
  });

  it('warns on a single pending sector and escalates past the critical count', () => {
    const warn = evaluateSmart({ report: report({ attributes: [attr(197, 1)] }) });
    expect(warn[0]!.severity).toBe('warning');
    const crit = evaluateSmart({ report: report({ attributes: [attr(197, 40)] }) });
    expect(crit[0]!.severity).toBe('critical');
  });

  it('escalates a rising counter even when it is below the critical threshold', () => {
    const findings = evaluateSmart({
      report: report({ attributes: [attr(5, 2)] }),
      previous: { attributes: [attr(5, 1)], nvme: null },
    });
    expect(findings[0]!.severity).toBe('critical');
    expect(findings[0]!.title).toContain('rising');
    expect(findings[0]!.previousValue).toBe(1);
  });

  it('does not escalate a counter that has been stable for years', () => {
    const findings = evaluateSmart({
      report: report({ attributes: [attr(5, 8)] }),
      previous: { attributes: [attr(5, 8)], nvme: null },
    });
    expect(findings[0]!.severity).toBe('warning');
    expect(findings[0]!.title).not.toContain('rising');
  });

  it('treats CRC errors as a warning because they usually mean a bad cable', () => {
    const findings = evaluateSmart({ report: report({ attributes: [attr(199, 5)] }) });
    expect(findings[0]!.severity).toBe('warning');
    expect(findings[0]!.detail).toContain('cable');
  });

  it('flags any attribute whose normalised value reached the manufacturer threshold', () => {
    const findings = evaluateSmart({
      report: report({ attributes: [attr(1, 0, { value: 5, threshold: 6 })] }),
    });
    expect(findings.some((f) => f.key === 'smart.threshold.1' && f.severity === 'critical')).toBe(true);
  });

  it('uses the drive label so the alert names the physical slot', () => {
    const findings = evaluateSmart({
      report: report({ attributes: [attr(197, 3)] }),
      label: 'DRIVEPOOL27',
    });
    expect(findings[0]!.title).toContain('DRIVEPOOL27');
  });

  it('applies temperature thresholds, falling back to attribute 194', () => {
    const warm = evaluateSmart({ report: report({ temperatureC: 52 }) });
    expect(warm.find((f) => f.key === 'smart.temperature')!.severity).toBe('warning');

    const hot = evaluateSmart({ report: report({ temperatureC: 65 }) });
    expect(hot.find((f) => f.key === 'smart.temperature')!.severity).toBe('critical');

    const fromAttribute = evaluateSmart({
      report: report({ temperatureC: null, attributes: [attr(194, 61)] }),
    });
    expect(fromAttribute.find((f) => f.key === 'smart.temperature')!.severity).toBe('critical');
  });

  it('respects overridden thresholds', () => {
    const findings = evaluateSmart({
      report: report({ temperatureC: 52 }),
      thresholds: { temperatureWarnC: 55, temperatureCritC: 65 },
    });
    expect(findings.find((f) => f.key === 'smart.temperature')).toBeUndefined();
  });

  it('reports a drive whose controller hides SMART as info, not a failure', () => {
    const findings = evaluateSmart({ report: report({ smartSupported: false }) });
    expect(findings[0]!.severity).toBe('info');
  });

  it('flags a failed self-test', () => {
    const findings = evaluateSmart({
      report: report({ selfTest: { status: 'Completed: read failure', failed: true, lastHours: 100, remainingPercent: 0 } }),
    });
    expect(findings.find((f) => f.key === 'smart.selftest')!.severity).toBe('critical');
  });

  describe('NVMe', () => {
    const nvme = (overrides: Record<string, number>) => ({
      availableSpare: 100,
      availableSpareThreshold: 10,
      percentageUsed: 5,
      mediaErrors: 0,
      errorLogEntries: 0,
      criticalWarning: 0,
      dataUnitsRead: 0,
      dataUnitsWritten: 0,
      unsafeShutdowns: 0,
      ...overrides,
    });

    it('is quiet for a healthy NVMe drive', () => {
      expect(evaluateSmart({ report: report({ nvme: nvme({}) }) })).toEqual([]);
    });

    it('raises critical when the controller sets a warning flag', () => {
      const findings = evaluateSmart({ report: report({ nvme: nvme({ criticalWarning: 0x04 }) }) });
      expect(findings[0]!.severity).toBe('critical');
      expect(findings[0]!.detail).toContain('reliability degraded');
    });

    it('raises critical when the spare pool reaches the drive threshold', () => {
      const findings = evaluateSmart({
        report: report({ nvme: nvme({ availableSpare: 9, availableSpareThreshold: 10 }) }),
      });
      expect(findings.find((f) => f.key === 'nvme.spare')!.severity).toBe('critical');
    });

    it('warns then escalates on endurance', () => {
      expect(
        evaluateSmart({ report: report({ nvme: nvme({ percentageUsed: 88 }) }) }).find(
          (f) => f.key === 'nvme.wear',
        )!.severity,
      ).toBe('warning');
      expect(
        evaluateSmart({ report: report({ nvme: nvme({ percentageUsed: 99 }) }) }).find(
          (f) => f.key === 'nvme.wear',
        )!.severity,
      ).toBe('critical');
    });

    it('warns on any media errors', () => {
      const findings = evaluateSmart({ report: report({ nvme: nvme({ mediaErrors: 3 }) }) });
      expect(findings.find((f) => f.key === 'nvme.media-errors')!.severity).toBe('warning');
    });
  });

  it('describes unknown critical warning bits without throwing', () => {
    expect(describeNvmeCriticalWarning(0x80)).toContain('unrecognised');
    expect(describeNvmeCriticalWarning(0x03)).toContain('spare capacity');
  });
});

describe('evaluateVolume', () => {
  it('is quiet for a healthy volume', () => {
    expect(
      evaluateVolume({
        label: 'DRIVEPOOL27',
        healthStatus: 'Healthy',
        dirty: false,
        sizeBytes: 1000,
        freeBytes: 500,
      }),
    ).toEqual([]);
  });

  it('treats the NTFS dirty bit as critical', () => {
    const findings = evaluateVolume({ label: 'DRIVEPOOL27', dirty: true });
    expect(findings[0]!.severity).toBe('critical');
    expect(findings[0]!.detail).toContain('chkdsk');
  });

  it('reports an unhealthy volume', () => {
    const findings = evaluateVolume({ label: 'SSDPOOL1', healthStatus: 'Unhealthy' });
    expect(findings[0]!.severity).toBe('critical');
  });

  it('applies free-space thresholds', () => {
    expect(
      evaluateVolume({ label: 'x', sizeBytes: 1000, freeBytes: 40 }).find(
        (f) => f.key === 'volume.free-space',
      )!.severity,
    ).toBe('warning');
    expect(
      evaluateVolume({ label: 'x', sizeBytes: 1000, freeBytes: 5 }).find(
        (f) => f.key === 'volume.free-space',
      )!.severity,
    ).toBe('critical');
  });

  it('ignores free space when capacity is unknown', () => {
    expect(evaluateVolume({ label: 'x', sizeBytes: 0, freeBytes: 0 })).toEqual([]);
  });
});

describe('evaluatePerformance', () => {
  const sample = (latency: number, queue = 0) => ({
    readLatencyMs: latency,
    writeLatencyMs: latency / 2,
    queueLength: queue,
  });

  it('needs a full window of samples before alerting', () => {
    expect(evaluatePerformance([sample(900), sample(900)], 'DRIVEPOOL27')).toEqual([]);
  });

  it('ignores a single slow sample among fast ones', () => {
    const findings = evaluatePerformance([sample(900), sample(2), sample(3)], 'DRIVEPOOL27');
    expect(findings).toEqual([]);
  });

  it('alerts when every sample in the window is slow', () => {
    const findings = evaluatePerformance([sample(600), sample(700), sample(800)], 'DRIVEPOOL27');
    expect(findings.find((f) => f.key === 'perf.latency')!.severity).toBe('critical');
    expect(findings[0]!.detail).toContain('locks up');
  });

  it('warns at the lower latency threshold', () => {
    const findings = evaluatePerformance([sample(150), sample(160), sample(170)], 'x');
    expect(findings.find((f) => f.key === 'perf.latency')!.severity).toBe('warning');
  });

  it('alerts on sustained queue depth', () => {
    const findings = evaluatePerformance([sample(1, 40), sample(1, 50), sample(1, 60)], 'x');
    expect(findings.find((f) => f.key === 'perf.queue')!.severity).toBe('critical');
  });

  it('only considers the most recent samples', () => {
    const samples = [sample(900), sample(900), sample(900), sample(1), sample(1), sample(1)];
    expect(evaluatePerformance(samples, 'x')).toEqual([]);
  });

  it('respects a custom window size', () => {
    const findings = evaluatePerformance([sample(600)], 'x', { consecutiveSamples: 1 });
    expect(findings).toHaveLength(1);
  });
});
