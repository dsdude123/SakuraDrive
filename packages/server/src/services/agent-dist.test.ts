import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentDistService } from './agent-dist.js';

/** The repository's real agent directory: what a built image would carry. */
const REPO_AGENT_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../agent',
);

const temporaryDirectories: string[] = [];

function makeDirectory(files: Record<string, string>): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sakuradrive-dist-'));
  temporaryDirectories.push(directory);
  for (const [name, content] of Object.entries(files)) {
    const full = path.join(directory, name);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return directory;
}

function service(directory: string): AgentDistService {
  return new AgentDistService({ directory, protocolVersion: 1 });
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('the manifest', () => {
  it('lists every script with the hash of its bytes', () => {
    const directory = makeDirectory({
      'SakuraDriveAgent.ps1': 'Write-Host hello\n',
      'SakuraDrive.Agent.psm1': "$script:AgentVersion = '2.3.4'\n$script:ProtocolVersion = 7\n",
      'agent.config.example.json': '{}\n',
    });

    const manifest = service(directory).manifest()!;
    expect(manifest.files.map((file) => file.path)).toEqual([
      'SakuraDrive.Agent.psm1',
      'SakuraDriveAgent.ps1',
      'agent.config.example.json',
    ]);

    const entry = manifest.files.find((file) => file.path === 'SakuraDriveAgent.ps1')!;
    expect(entry.sha256).toBe(createHash('sha256').update('Write-Host hello\n').digest('hex'));
    expect(entry.bytes).toBe('Write-Host hello\n'.length);
  });

  it('reads the version and protocol the module declares for itself', () => {
    const directory = makeDirectory({
      'SakuraDriveAgent.ps1': 'x\n',
      'SakuraDrive.Agent.psm1': "$script:AgentVersion = '2.3.4'\n$script:ProtocolVersion = 7\n",
    });
    const manifest = service(directory).manifest()!;
    expect(manifest.agentVersion).toBe('2.3.4');
    expect(manifest.protocolVersion).toBe(7);
  });

  // The version is what an agent compares against; it has to move when, and only when,
  // the files do. Otherwise a fix is deployed and every host ignores it.
  it('gives the same version to the same files and a different one to changed files', () => {
    const files = { 'SakuraDriveAgent.ps1': 'one\n', 'SakuraDrive.Agent.psm1': 'two\n' };
    const first = service(makeDirectory(files)).manifest()!;
    const second = service(makeDirectory(files)).manifest()!;
    expect(second.version).toBe(first.version);

    const changed = service(
      makeDirectory({ ...files, 'SakuraDriveAgent.ps1': 'one changed\n' }),
    ).manifest()!;
    expect(changed.version).not.toBe(first.version);
  });

  // A rename with identical content is still a different installation.
  it('changes version when a file is renamed but its content is not', () => {
    const first = service(
      makeDirectory({ 'SakuraDriveAgent.ps1': 'x\n', 'tools/One.ps1': 'y\n' }),
    ).manifest()!;
    const second = service(
      makeDirectory({ 'SakuraDriveAgent.ps1': 'x\n', 'tools/Two.ps1': 'y\n' }),
    ).manifest()!;
    expect(second.version).not.toBe(first.version);
  });

  it('recomputes when a file changes underneath it', () => {
    const directory = makeDirectory({ 'SakuraDriveAgent.ps1': 'first\n' });
    const dist = service(directory);
    const before = dist.manifest()!.version;

    const target = path.join(directory, 'SakuraDriveAgent.ps1');
    fs.writeFileSync(target, 'second\n');
    fs.utimesSync(target, new Date(Date.now() + 5_000), new Date(Date.now() + 5_000));

    expect(dist.manifest()!.version).not.toBe(before);
  });

  it('carries tools in subdirectories, with forward slashes', () => {
    const directory = makeDirectory({
      'SakuraDriveAgent.ps1': 'x\n',
      'tools/Set-PoolDiskMountPoints.ps1': 'y\n',
    });
    expect(service(directory).manifest()!.files.map((file) => file.path)).toContain(
      'tools/Set-PoolDiskMountPoints.ps1',
    );
  });

  // Pester and its fixtures are not shipped, so shipping the tests would only give a
  // host files it cannot run.
  it('leaves out the tests, and anything that is not a script or a config', () => {
    const directory = makeDirectory({
      'SakuraDriveAgent.ps1': 'x\n',
      'tests/Agent.Tests.ps1': 'y\n',
      'README.md': 'z\n',
    });
    expect(service(directory).manifest()!.files.map((file) => file.path)).toEqual([
      'SakuraDriveAgent.ps1',
    ]);
  });

  // It would never be in the image, but it holds a token if it ever were.
  it('never offers an agent configuration', () => {
    const directory = makeDirectory({
      'SakuraDriveAgent.ps1': 'x\n',
      'agent.config.json': '{"Token":"secret"}',
    });
    const dist = service(directory);
    expect(dist.manifest()!.files.map((file) => file.path)).toEqual(['SakuraDriveAgent.ps1']);
    expect(dist.read('agent.config.json')).toBeNull();
  });

  it('reports nothing at all when the image was built without the agent source', () => {
    const dist = service(path.join(os.tmpdir(), 'sakuradrive-nothing-here'));
    expect(dist.available()).toBe(false);
    expect(dist.manifest()).toBeNull();
    expect(dist.read('SakuraDriveAgent.ps1')).toBeNull();
  });
});

describe('reading a file', () => {
  it('hands back the exact bytes the manifest hashed', () => {
    const directory = makeDirectory({ 'SakuraDriveAgent.ps1': 'Write-Host hello\n' });
    const dist = service(directory);
    const manifest = dist.manifest()!;
    const found = dist.read('SakuraDriveAgent.ps1')!;

    expect(found.buffer.toString()).toBe('Write-Host hello\n');
    expect(found.file.sha256).toBe(manifest.files[0]!.sha256);
  });

  it('accepts a backslash path, because that is how Windows spells it', () => {
    const directory = makeDirectory({
      'SakuraDriveAgent.ps1': 'x\n',
      'tools/Set-PoolDiskMountPoints.ps1': 'mount\n',
    });
    expect(service(directory).read('tools\\Set-PoolDiskMountPoints.ps1')!.buffer.toString()).toBe(
      'mount\n',
    );
  });

  // The name is matched against the manifest rather than joined onto a directory, so
  // there is no path to traverse out of.
  it.each([
    '../../../etc/passwd',
    '..\\..\\windows\\win.ini',
    '/etc/passwd',
    'tools/../../secret.ps1',
    './SakuraDriveAgent.ps1',
    '',
  ])('refuses %s', (requested) => {
    const directory = makeDirectory({ 'SakuraDriveAgent.ps1': 'x\n' });
    fs.writeFileSync(path.join(directory, '..', 'secret.ps1'), 'secret\n');
    expect(service(directory).read(requested)).toBeNull();
  });
});

/**
 * The agent decides what to copy from its own list; the server decides what to serve
 * from what is on disk. A file added to one and not the other would install on a fresh
 * host and never reach an existing one, or the reverse -- so the two lists are compared
 * here rather than left to agree by hand.
 */
describe('the shipped agent', () => {
  const distributionFilesFromModule = (): string[] => {
    const source = fs.readFileSync(path.join(REPO_AGENT_DIR, 'SakuraDrive.Agent.psm1'), 'utf8');
    const body = /function Get-AgentDistributionFile \{[\s\S]*?\n {4}@\(([\s\S]*?)\n {4}\)/.exec(
      source,
    );
    if (!body) throw new Error('Get-AgentDistributionFile is not shaped as expected any more');
    return [...body[1]!.matchAll(/'([^']+)'/g)].map((match) => match[1]!).sort();
  };

  it('serves exactly the files the agent installs', () => {
    const manifest = service(REPO_AGENT_DIR).manifest()!;
    expect(manifest.files.map((file) => file.path).sort()).toEqual(distributionFilesFromModule());
  });

  it('includes the bootstrap script an operator downloads by hand', () => {
    const manifest = service(REPO_AGENT_DIR).manifest()!;
    expect(manifest.files.map((file) => file.path)).toContain('Bootstrap-SakuraDriveAgent.ps1');
  });

  it('declares the agent version out of the module rather than guessing', () => {
    const manifest = service(REPO_AGENT_DIR).manifest()!;
    expect(manifest.agentVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(manifest.protocolVersion).toBe(1);
  });
});
