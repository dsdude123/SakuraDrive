/**
 * The agent, served from the server that talks to it.
 *
 * Keeping a copy of the agent on every Windows host and updating it by hand is how the
 * two drift apart: a parser fix lands here and the host keeps running last month's
 * script until somebody remembers to copy files over. So the image carries the agent
 * source, the server hands it out over the same authenticated channel the agent already
 * uses, and the agent replaces itself when the two no longer match.
 *
 * The manifest is the whole contract: a list of files with their SHA-256, and a version
 * derived from those hashes. Nothing here decides what "newer" means -- the agent
 * compares versions for equality, not order, so a rollback on the server is an update
 * on the host rather than something the host refuses.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export interface AgentDistFile {
  /** Path relative to the distribution root, always with forward slashes. */
  path: string;
  sha256: string;
  bytes: number;
}

export interface AgentDistManifest {
  /** Derived from the file hashes: changes exactly when the shipped files change. */
  version: string;
  /** The version the agent module declares for itself, for display. */
  agentVersion: string;
  protocolVersion: number;
  generatedAt: string;
  files: AgentDistFile[];
}

/**
 * Files that make up an installation.
 *
 * Extensions rather than a hard-coded list, so a new tool ships without a second place
 * to remember; `tests/` is excluded because it needs Pester and the fixtures it reads
 * are not shipped either.
 */
const DISTRIBUTABLE_EXTENSIONS = new Set(['.ps1', '.psm1', '.psd1', '.json']);
/** Dotted directories are skipped anyway, which covers the agent's own .previous. */
const EXCLUDED_DIRECTORIES = new Set(['tests', 'fixtures']);
/** A real configuration would never be in the image, but it carries a token if it were. */
const EXCLUDED_FILES = new Set(['agent.config.json']);

function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

/** Every distributable file under `directory`, relative and slash-separated. */
function listFiles(directory: string, prefix = ''): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }

  const found: string[] = [];
  for (const entry of entries) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (EXCLUDED_DIRECTORIES.has(entry.name) || entry.name.startsWith('.')) continue;
      found.push(...listFiles(path.join(directory, entry.name), relative));
      continue;
    }
    if (!entry.isFile()) continue;
    if (EXCLUDED_FILES.has(entry.name)) continue;
    if (!DISTRIBUTABLE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
    found.push(relative);
  }
  // Ordinal, not locale-aware: the manifest order feeds the version hash, and that must
  // not depend on the locale the server happens to be running under.
  return found.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** `$script:AgentVersion = '1.0.0'` out of the module, or a placeholder. */
function readAgentVersion(directory: string): string {
  try {
    const source = fs.readFileSync(path.join(directory, 'SakuraDrive.Agent.psm1'), 'utf8');
    return /\$script:AgentVersion\s*=\s*'([^']+)'/.exec(source)?.[1] ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

function readProtocolVersion(directory: string, fallback: number): number {
  try {
    const source = fs.readFileSync(path.join(directory, 'SakuraDrive.Agent.psm1'), 'utf8');
    const found = /\$script:ProtocolVersion\s*=\s*(\d+)/.exec(source)?.[1];
    return found ? Number(found) : fallback;
  } catch {
    return fallback;
  }
}

export interface AgentDistOptions {
  directory: string;
  protocolVersion: number;
}

export class AgentDistService {
  private readonly directory: string;
  private readonly protocolVersion: number;
  private cached: { signature: string; manifest: AgentDistManifest } | null = null;

  constructor(options: AgentDistOptions) {
    this.directory = path.resolve(options.directory);
    this.protocolVersion = options.protocolVersion;
  }

  /** Where the shipped agent source lives, for diagnostics. */
  get root(): string {
    return this.directory;
  }

  /** False when the image was built without the agent source. */
  available(): boolean {
    return fs.existsSync(path.join(this.directory, 'SakuraDriveAgent.ps1'));
  }

  /**
   * The manifest, recomputed when the files on disk change.
   *
   * Hashing seven small scripts is cheap enough to do on a size-and-mtime signature
   * rather than caching forever, which keeps a development server honest when a script
   * is edited under it.
   */
  manifest(): AgentDistManifest | null {
    if (!this.available()) return null;

    const names = listFiles(this.directory);
    const signature = names
      .map((name) => {
        const stat = fs.statSync(path.join(this.directory, name));
        return `${name}:${stat.size}:${stat.mtimeMs}`;
      })
      .join('\n');

    if (this.cached?.signature === signature) return this.cached.manifest;

    const files: AgentDistFile[] = names.map((name) => {
      const buffer = fs.readFileSync(path.join(this.directory, name));
      return { path: name, sha256: sha256(buffer), bytes: buffer.byteLength };
    });

    // The version is the hash of the hashes. No number to bump by hand, and two
    // servers built from the same commit agree without coordinating.
    const version = createHash('sha256')
      .update(files.map((file) => `${file.path}:${file.sha256}`).join('\n'))
      .digest('hex')
      .slice(0, 12);

    const manifest: AgentDistManifest = {
      version,
      agentVersion: readAgentVersion(this.directory),
      protocolVersion: readProtocolVersion(this.directory, this.protocolVersion),
      generatedAt: new Date().toISOString(),
      files,
    };
    this.cached = { signature, manifest };
    return manifest;
  }

  /**
   * One file's bytes, or null.
   *
   * The requested path is matched against the manifest rather than joined onto the
   * distribution root, so there is no traversal to defend against: a name that is not
   * in the manifest is simply not a file this serves.
   */
  read(requested: string): { file: AgentDistFile; buffer: Buffer } | null {
    const manifest = this.manifest();
    if (!manifest) return null;

    const normalised = String(requested ?? '').replace(/\\/g, '/');
    const file = manifest.files.find((candidate) => candidate.path === normalised);
    if (!file) return null;

    const buffer = fs.readFileSync(path.join(this.directory, ...file.path.split('/')));
    // A file edited between the manifest and the read would hand out bytes the agent
    // is about to reject. Recompute rather than serve a mismatch.
    return { file: { ...file, sha256: sha256(buffer), bytes: buffer.byteLength }, buffer };
  }
}
