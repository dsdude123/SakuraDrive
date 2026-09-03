/**
 * Process-level configuration.
 *
 * Deliberately tiny: the brief calls for minimal Docker configuration, so everything
 * an operator would plausibly want to change lives in the database and is edited from
 * the UI. Only things that must be known before the database exists are read from the
 * environment.
 */

import path from 'node:path';

export interface ServerConfig {
  /** Where the SQLite database, exports and temporary files live. */
  dataDir: string;
  databasePath: string;
  /** Directory containing the built web UI, served as static files. */
  webRoot: string;
  /**
   * Directory holding the Windows agent source that this server hands out.
   * Absent in an image built without it; the agent then simply never updates itself.
   */
  agentDistDir: string;
  /**
   * A previous data directory to copy across on first start, if this one is empty.
   * Set to the old bind mount when moving the database off a slow filesystem.
   */
  legacyDataDir: string;
  host: string;
  port: number;
  logLevel: string;
  /**
   * Escape hatch for a trusted LAN or for running behind an authenticating proxy.
   * The UI shows a banner when it is on.
   */
  disableAuth: boolean;
  /** Set in tests to keep background schedulers from starting. */
  disableBackgroundJobs: boolean;
  version: string;
}

function envString(name: string, fallback: string): string {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

function envBool(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

function envInt(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

export function loadConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  const dataDir = path.resolve(envString('SAKURADRIVE_DATA_DIR', '/data'));
  return {
    dataDir,
    databasePath: path.join(dataDir, 'sakuradrive.sqlite'),
    webRoot: path.resolve(envString('SAKURADRIVE_WEB_ROOT', path.join(process.cwd(), 'public'))),
    agentDistDir: path.resolve(
      envString('SAKURADRIVE_AGENT_DIST_DIR', path.join(process.cwd(), 'agent')),
    ),
    legacyDataDir: envString('SAKURADRIVE_LEGACY_DATA_DIR', ''),
    host: envString('SAKURADRIVE_HOST', '0.0.0.0'),
    port: envInt('PORT', 8080),
    logLevel: envString('SAKURADRIVE_LOG_LEVEL', 'info'),
    disableAuth: envBool('SAKURADRIVE_DISABLE_AUTH', false),
    disableBackgroundJobs: envBool('SAKURADRIVE_DISABLE_BACKGROUND_JOBS', false),
    version: envString('SAKURADRIVE_VERSION', '0.1.0'),
    ...overrides,
  };
}
