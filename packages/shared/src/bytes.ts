/** Human-readable byte / duration / percentage formatting shared by API responses and the UI. */

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB'] as const;

/**
 * Format a byte count using binary multiples (1 KB = 1024 B), matching the way
 * Windows and StableBit DrivePool report capacity.
 */
export function formatBytes(bytes: number | bigint | null | undefined, fractionDigits = 1): string {
  if (bytes === null || bytes === undefined) return '—';
  const n = typeof bytes === 'bigint' ? Number(bytes) : bytes;
  if (!Number.isFinite(n)) return '—';
  const sign = n < 0 ? '-' : '';
  let value = Math.abs(n);
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = unit === 0 ? 0 : fractionDigits;
  return `${sign}${value.toFixed(digits)} ${UNITS[unit]}`;
}

/** Parse strings like "500GB", "1.5 TiB", "1024" into a byte count. Returns null when unparseable. */
export function parseBytes(input: string | number | null | undefined): number | null {
  if (input === null || input === undefined) return null;
  if (typeof input === 'number') return Number.isFinite(input) ? input : null;
  const match = /^\s*(-?\d+(?:\.\d+)?)\s*([kmgtpe]?)(i?)b?\s*$/i.exec(input);
  if (!match) return null;
  const value = Number(match[1]);
  const exponent = ['', 'k', 'm', 'g', 't', 'p', 'e'].indexOf((match[2] ?? '').toLowerCase());
  if (exponent < 0) return null;
  return Math.round(value * 1024 ** exponent);
}

export function formatDurationMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—';
  const abs = Math.abs(ms);
  if (abs < 1000) return `${Math.round(ms)}ms`;
  const seconds = Math.floor(abs / 1000);
  const parts: string[] = [];
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (minutes && parts.length < 2) parts.push(`${minutes}m`);
  if (secs && parts.length < 2) parts.push(`${secs}s`);
  return (ms < 0 ? '-' : '') + (parts.join(' ') || '0s');
}

/** Relative time such as "3 minutes ago" / "in 2 hours". */
export function formatRelative(iso: string | number | Date | null | undefined, now = Date.now()): string {
  if (iso === null || iso === undefined) return 'never';
  const then = iso instanceof Date ? iso.getTime() : typeof iso === 'number' ? iso : Date.parse(iso);
  if (!Number.isFinite(then)) return 'never';
  const delta = now - then;
  const suffix = delta >= 0 ? ' ago' : '';
  const prefix = delta < 0 ? 'in ' : '';
  if (Math.abs(delta) < 45_000) return delta >= 0 ? 'just now' : 'in a moment';
  return `${prefix}${formatDurationMs(Math.abs(delta))}${suffix}`;
}

export function formatPercent(value: number | null | undefined, fractionDigits = 0): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return `${(value * 100).toFixed(fractionDigits)}%`;
}

export function formatCount(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return value.toLocaleString('en-US');
}
