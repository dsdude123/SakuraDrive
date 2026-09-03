/**
 * Moving the data directory onto the container's own filesystem, once, by itself.
 *
 * The database used to live on a bind mount under /mnt -- a Windows drive reached
 * through drvfs -- where SQLite is punishing, because every page the cache misses is a
 * round trip out to the Windows filesystem. Moving it is worth minutes of one-time
 * copying, but "run these three docker commands first" is not a deploy step anyone
 * driving Portainer can reasonably be asked for.
 *
 * So the container does it: the old location is mounted read-only alongside the new
 * one, and if the new one has no database while the old one does, the files are copied
 * across before anything opens them. It runs once -- afterwards the new location has a
 * database, so there is nothing to do -- and it never writes to the old location, so
 * putting the bind mount back is always available if something goes wrong.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { Logger } from '../logger.js';

export interface DataDirMigration {
  migrated: boolean;
  reason: string;
  files: string[];
  bytes: number;
}

/** The Kopia cache is rebuilt on demand and can be enormous; it is not worth copying. */
const SKIP_DIRECTORIES = new Set(['kopia-cache', 'kopia']);

function copyTree(from: string, to: string, onFile: (relative: string, bytes: number) => void): void {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRECTORIES.has(entry.name)) continue;
      copyTree(path.join(from, entry.name), path.join(to, entry.name), (nested, bytes) =>
        onFile(path.join(entry.name, nested), bytes),
      );
      continue;
    }
    if (!entry.isFile()) continue;
    const source = path.join(from, entry.name);
    fs.copyFileSync(source, path.join(to, entry.name));
    onFile(entry.name, fs.statSync(source).size);
  }
}

/**
 * Copy a previous data directory into this one, if this one is empty and that one is not.
 *
 * Deliberately conservative: the presence of a database in the destination means the
 * move has already happened (or this was always the location), and nothing is touched.
 */
export function migrateDataDir(options: {
  dataDir: string;
  databasePath: string;
  legacyDir: string;
  logger: Logger;
}): DataDirMigration {
  const { dataDir, databasePath, legacyDir, logger } = options;
  const none = (reason: string): DataDirMigration => ({ migrated: false, reason, files: [], bytes: 0 });

  if (!legacyDir) return none('no previous data directory is configured');
  if (path.resolve(legacyDir) === path.resolve(dataDir)) return none('the two directories are the same');
  if (fs.existsSync(databasePath)) return none('this data directory already has a database');

  const legacyDatabase = path.join(legacyDir, path.basename(databasePath));
  if (!fs.existsSync(legacyDatabase)) return none('the previous data directory has no database to copy');

  const files: string[] = [];
  let bytes = 0;
  logger.warn(
    { from: legacyDir, to: dataDir },
    'copying the previous data directory across; this happens once and can take several minutes on a slow mount',
  );

  try {
    copyTree(legacyDir, dataDir, (relative, size) => {
      files.push(relative);
      bytes += size;
      if (size > 64 * 1024 * 1024) {
        logger.info({ file: relative, mb: Math.round(size / 1024 / 1024) }, 'copied');
      }
    });
  } catch (error) {
    // A half-copied database is worse than none: remove it so the next start tries
    // again rather than opening something truncated.
    try {
      if (fs.existsSync(databasePath)) fs.rmSync(databasePath);
    } catch {
      /* nothing better to do */
    }
    logger.error({ error, from: legacyDir }, 'could not copy the previous data directory');
    throw error;
  }

  logger.warn(
    { files: files.length, mb: Math.round(bytes / 1024 / 1024), from: legacyDir },
    'copied the previous data directory. The old one was not modified and can be removed once this looks right.',
  );
  return { migrated: true, reason: 'copied', files, bytes };
}
