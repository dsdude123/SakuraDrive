import { describe, expect, it } from 'vitest';
import { isScheduleEmpty } from './schedule.js';
import {
  SECRET_PLACEHOLDER,
  defaultSettings,
  mergeSettings,
  parseSettings,
  redactSettings,
  settingsSchema,
} from './settings.js';

describe('defaultSettings', () => {
  it('produces a fully populated object from nothing', () => {
    const settings = defaultSettings();
    expect(settings.general.siteName).toBe('SakuraDrive');
    expect(settings.catalog.hashAlgorithm).toBe('sha256');
    expect(settings.catalog.roots).toEqual([]);
    expect(isScheduleEmpty(settings.schedule.heavyIo)).toBe(false);
    expect(settings.autoExport.redactSecrets).toBe(true);
  });

  it('excludes Windows and DrivePool system directories out of the box', () => {
    const globs = defaultSettings().catalog.globalExcludeGlobs;
    expect(globs).toContain('**/$RECYCLE.BIN/**');
    expect(globs).toContain('**/.covefs/**');
  });
});

describe('parseSettings', () => {
  it('fills in sections missing from an older bundle', () => {
    const settings = parseSettings({ general: { siteName: 'NAS' } });
    expect(settings.general.siteName).toBe('NAS');
    expect(settings.notifications.discord.enabled).toBe(false);
    expect(settings.backup.mode).toBe('disabled');
  });

  it('normalises a malformed schedule grid instead of rejecting it', () => {
    const settings = parseSettings({ schedule: { heavyIo: ['111'] } });
    expect(settings.schedule.heavyIo).toHaveLength(7);
    expect(settings.schedule.heavyIo[0]).toHaveLength(24);
  });

  it('rejects values outside the allowed range', () => {
    expect(() => settingsSchema.parse({ schedule: { hashConcurrency: 99 } })).toThrow();
    expect(() => settingsSchema.parse({ catalog: { hashAlgorithm: 'crc32' } })).toThrow();
    expect(() => settingsSchema.parse({ duplication: { defaultLevel: 0 } })).toThrow();
  });

  it('applies scan root defaults', () => {
    const settings = parseSettings({
      catalog: { roots: [{ id: 'r1', name: 'HDD Pool', containerPath: '/mnt/pools/hdd' }] },
    });
    const root = settings.catalog.roots[0]!;
    expect(root.kind).toBe('pool');
    expect(root.enabled).toBe(true);
    expect(root.hashEnabled).toBe(true);
    expect(root.excludeGlobs).toEqual([]);
  });
});

describe('redactSettings', () => {
  it('replaces every credential with a placeholder', () => {
    const settings = defaultSettings();
    settings.backup.password = 'hunter2';
    settings.backup.repository.key = 'b2-key';
    settings.backup.repository.keyId = 'b2-key-id';
    settings.notifications.discord.webhookUrl = 'https://discord.com/api/webhooks/1/abc';

    const redacted = redactSettings(settings);
    expect(redacted.backup.password).toBe(SECRET_PLACEHOLDER);
    expect(redacted.backup.repository.key).toBe(SECRET_PLACEHOLDER);
    expect(redacted.backup.repository.keyId).toBe(SECRET_PLACEHOLDER);
    expect(redacted.notifications.discord.webhookUrl).toBe(SECRET_PLACEHOLDER);
  });

  it('leaves non-secret settings untouched and does not mutate the input', () => {
    const settings = defaultSettings();
    settings.backup.password = 'hunter2';
    settings.backup.repository.bucket = 'nas-backups';
    const redacted = redactSettings(settings);
    expect(redacted.backup.repository.bucket).toBe('nas-backups');
    expect(settings.backup.password).toBe('hunter2');
  });

  it('leaves empty secrets empty rather than inventing a placeholder', () => {
    expect(redactSettings(defaultSettings()).backup.password).toBe('');
  });
});

describe('mergeSettings', () => {
  it('applies a partial patch without clobbering other sections', () => {
    const current = defaultSettings();
    const next = mergeSettings(current, { general: { siteName: 'Sakura NAS' } });
    expect(next.general.siteName).toBe('Sakura NAS');
    expect(next.general.timezone).toBe(current.general.timezone);
    expect(next.catalog.hashAlgorithm).toBe('sha256');
  });

  it('replaces arrays wholesale so deleting a root actually deletes it', () => {
    const current = parseSettings({
      catalog: {
        roots: [
          { id: 'a', name: 'A', containerPath: '/a' },
          { id: 'b', name: 'B', containerPath: '/b' },
        ],
      },
    });
    const next = mergeSettings(current, {
      catalog: { roots: [{ id: 'b', name: 'B', containerPath: '/b' }] },
    });
    expect(next.catalog.roots.map((r) => r.id)).toEqual(['b']);
  });

  it('keeps the stored secret when the UI submits the masked placeholder', () => {
    const current = defaultSettings();
    current.backup.password = 'hunter2';
    const next = mergeSettings(current, { backup: { password: SECRET_PLACEHOLDER } });
    expect(next.backup.password).toBe('hunter2');
  });

  it('accepts a genuine secret change', () => {
    const current = defaultSettings();
    current.backup.password = 'hunter2';
    const next = mergeSettings(current, { backup: { password: 'newsecret' } });
    expect(next.backup.password).toBe('newsecret');
  });

  it('validates the merged result', () => {
    expect(() => mergeSettings(defaultSettings(), { schedule: { hashConcurrency: 0 } })).toThrow();
  });

  it('does not mutate the settings it was given', () => {
    const current = defaultSettings();
    mergeSettings(current, { general: { siteName: 'Changed' } });
    expect(current.general.siteName).toBe('SakuraDrive');
  });
});
