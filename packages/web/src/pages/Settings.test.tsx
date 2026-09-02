import { describe, expect, it } from 'vitest';
import { installCommand } from './Settings.js';

/**
 * The one thing an operator copies out of the interface and runs as administrator on
 * the NAS. If it is wrong, the agent never gets installed at all -- and it is not the
 * kind of wrong that shows up anywhere but on the host.
 */
describe('the install command', () => {
  const command = (origin: string, token: string | null = 'tok-123') =>
    installCommand(origin, 'Bootstrap-SakuraDriveAgent.ps1', token);

  it('points at this server and carries the token', () => {
    const text = command('http://nas.local:8099');
    expect(text).toContain("$Server = 'http://nas.local:8099'");
    expect(text).toContain("$Token = 'tok-123'");
    expect(text).toContain('/api/agent/dist/file?path=Bootstrap-SakuraDriveAgent.ps1');
    expect(text).toContain('Authorization = "Bearer $Token"');
  });

  it('passes the server and token on to the script it downloaded', () => {
    expect(command('http://nas.local:8099')).toContain('& $b -ServerUrl $Server -Token $Token');
  });

  // Windows PowerShell 5.1 does not negotiate TLS 1.2 on its own, and the failure looks
  // like the server being unreachable rather than like a protocol problem.
  it('negotiates TLS 1.2 when the server is on https, and not otherwise', () => {
    expect(command('https://nas.local:8443')).toContain('SecurityProtocolType]::Tls12');
    expect(command('http://nas.local:8099')).not.toContain('Tls12');
  });

  // Downloading to a file and running it, rather than piping the response into iex:
  // nothing runs before the bootstrap has checked it against the published hashes.
  it('downloads to a file rather than piping a response into the shell', () => {
    const text = command('http://nas.local:8099');
    expect(text).toContain('-OutFile $b');
    expect(text).not.toMatch(/\|\s*iex/i);
    expect(text).not.toContain('Invoke-Expression');
  });

  it('shows where the token goes before one has been created', () => {
    expect(command('http://nas.local:8099', null)).toContain("$Token = 'PASTE-TOKEN-HERE'");
  });

  it('is one line per step, so a half-copied command does not half-run', () => {
    expect(command('http://nas.local:8099').split('\n')).toHaveLength(4);
  });
});
