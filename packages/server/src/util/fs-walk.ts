import type { Dirent } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { isSystemDirName, joinRelPath } from '@sakuradrive/shared';

export interface WalkedFile {
  /** Root-relative POSIX path, original casing preserved. */
  relPath: string;
  name: string;
  sizeBytes: number;
  mtimeMs: number;
  ctimeMs: number;
}

export interface DirectoryListing {
  files: WalkedFile[];
  /** Root-relative paths of subdirectories to visit. */
  directories: string[];
  errors: Array<{ relPath: string; message: string }>;
}

export interface ReadDirectoryOptions {
  /** Return false to skip a file. Receives the root-relative path. */
  includeFile?: (relPath: string) => boolean;
  /** Return true to skip a directory and everything under it. */
  excludeDirectory?: (relPath: string, name: string) => boolean;
  followSymlinks?: boolean;
  /** Skip Windows/DrivePool system directories. Defaults to true. */
  skipSystemDirs?: boolean;
}

/**
 * List one directory.
 *
 * Deliberately shallow: the scan workflow drives its own work list so it can be
 * paused at a directory boundary when the I/O window closes and resumed later from
 * exactly where it stopped. Entries are returned in a stable sorted order so two runs
 * over an unchanged tree do identical work.
 *
 * Per-entry errors (a file vanishing mid-scan, an ACL we cannot read) are collected
 * rather than thrown: one unreadable file must not abandon a multi-hour scan.
 */
export async function readDirectory(
  rootPath: string,
  relDir: string,
  options: ReadDirectoryOptions = {},
): Promise<DirectoryListing> {
  const {
    includeFile,
    excludeDirectory,
    followSymlinks = false,
    skipSystemDirs = true,
  } = options;

  const absolute = relDir === '' ? rootPath : path.join(rootPath, relDir);
  const listing: DirectoryListing = { files: [], directories: [], errors: [] };

  let entries: Dirent[];
  try {
    entries = await fs.readdir(absolute, { withFileTypes: true });
  } catch (error) {
    listing.errors.push({ relPath: relDir, message: errorMessage(error) });
    return listing;
  }

  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  for (const entry of entries) {
    const relPath = joinRelPath(relDir, entry.name);
    let isDirectory = entry.isDirectory();
    let isFile = entry.isFile();

    if (entry.isSymbolicLink()) {
      if (!followSymlinks) continue;
      try {
        const stat = await fs.stat(path.join(absolute, entry.name));
        isDirectory = stat.isDirectory();
        isFile = stat.isFile();
      } catch (error) {
        listing.errors.push({ relPath, message: errorMessage(error) });
        continue;
      }
    }

    if (isDirectory) {
      if (skipSystemDirs && isSystemDirName(entry.name)) continue;
      if (excludeDirectory?.(relPath, entry.name)) continue;
      listing.directories.push(relPath);
      continue;
    }

    if (!isFile) continue; // sockets, devices, junctions we cannot resolve
    if (includeFile && !includeFile(relPath)) continue;

    try {
      const stat = await fs.stat(path.join(absolute, entry.name));
      listing.files.push({
        relPath,
        name: entry.name,
        sizeBytes: stat.size,
        mtimeMs: Math.round(stat.mtimeMs),
        ctimeMs: Math.round(stat.ctimeMs),
      });
    } catch (error) {
      listing.errors.push({ relPath, message: errorMessage(error) });
    }
  }

  return listing;
}

/** Does this path exist and is it a directory we can read? */
export async function isReadableDirectory(target: string): Promise<boolean> {
  try {
    const stat = await fs.stat(target);
    if (!stat.isDirectory()) return false;
    await fs.readdir(target);
    return true;
  } catch {
    return false;
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
