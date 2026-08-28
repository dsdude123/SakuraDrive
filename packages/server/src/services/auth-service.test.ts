import { beforeEach, describe, expect, it } from 'vitest';
import { openTestDatabase, type Db } from '../db/index.js';
import { AuthService, hashPassword, hashToken, verifyPassword } from './auth-service.js';

let db: Db;
let auth: AuthService;

beforeEach(() => {
  db = openTestDatabase();
  auth = new AuthService(db);
});

describe('password hashing', () => {
  it('produces a self-describing scrypt hash', () => {
    const hash = hashPassword('correct horse battery');
    expect(hash.startsWith('scrypt$')).toBe(true);
    expect(hash.split('$')).toHaveLength(6);
  });

  it('salts, so the same password hashes differently each time', () => {
    expect(hashPassword('same')).not.toBe(hashPassword('same'));
  });

  it('verifies the right password and rejects the wrong one', () => {
    const hash = hashPassword('correct horse battery');
    expect(verifyPassword('correct horse battery', hash)).toBe(true);
    expect(verifyPassword('wrong', hash)).toBe(false);
  });

  it('rejects a malformed stored hash instead of throwing', () => {
    expect(verifyPassword('x', 'garbage')).toBe(false);
    expect(verifyPassword('x', 'scrypt$a$b$c$d$e')).toBe(false);
  });
});

describe('accounts and sessions', () => {
  it('reports that setup is needed until an account exists', () => {
    expect(auth.needsSetup()).toBe(true);
    auth.createUser('admin', 'correct horse battery');
    expect(auth.needsSetup()).toBe(false);
  });

  it('refuses a short password', () => {
    expect(() => auth.createUser('admin', 'short')).toThrow(/at least 8/);
  });

  it('signs in and resolves the session', () => {
    auth.createUser('admin', 'correct horse battery');
    const session = auth.login('admin', 'correct horse battery', 30)!;
    expect(session.user.username).toBe('admin');
    expect(auth.resolveSession(session.token)).toMatchObject({ username: 'admin' });
  });

  it('stores only the hash of a session token', () => {
    auth.createUser('admin', 'correct horse battery');
    const session = auth.login('admin', 'correct horse battery', 30)!;
    const row = db.prepare('SELECT id FROM sessions').get() as { id: string };
    expect(row.id).toBe(hashToken(session.token));
    expect(row.id).not.toBe(session.token);
  });

  it('rejects a bad password or an unknown user', () => {
    auth.createUser('admin', 'correct horse battery');
    expect(auth.login('admin', 'nope', 30)).toBeNull();
    expect(auth.login('nobody', 'correct horse battery', 30)).toBeNull();
  });

  it('rejects an unknown, empty or expired session', () => {
    expect(auth.resolveSession(undefined)).toBeNull();
    expect(auth.resolveSession('made up')).toBeNull();

    auth.createUser('admin', 'correct horse battery');
    const session = auth.login('admin', 'correct horse battery', 30)!;
    db.prepare(`UPDATE sessions SET expires_at = '2000-01-01T00:00:00.000Z'`).run();
    expect(auth.resolveSession(session.token)).toBeNull();
  });

  it('logs out one session without touching the others', () => {
    auth.createUser('admin', 'correct horse battery');
    const first = auth.login('admin', 'correct horse battery', 30)!;
    const second = auth.login('admin', 'correct horse battery', 30)!;
    auth.logout(first.token);
    expect(auth.resolveSession(first.token)).toBeNull();
    expect(auth.resolveSession(second.token)).not.toBeNull();
  });

  it('invalidates every session when the password changes', () => {
    const user = auth.createUser('admin', 'correct horse battery');
    const session = auth.login('admin', 'correct horse battery', 30)!;
    auth.changePassword(user.id, 'correct horse battery', 'a whole new password');
    expect(auth.resolveSession(session.token)).toBeNull();
    expect(auth.login('admin', 'a whole new password', 30)).not.toBeNull();
  });

  it('refuses a password change with the wrong current password', () => {
    const user = auth.createUser('admin', 'correct horse battery');
    expect(() => auth.changePassword(user.id, 'wrong', 'a whole new password')).toThrow(/incorrect/i);
  });

  it('prunes expired sessions', () => {
    auth.createUser('admin', 'correct horse battery');
    auth.login('admin', 'correct horse battery', 30);
    db.prepare(`UPDATE sessions SET expires_at = '2000-01-01T00:00:00.000Z'`).run();
    expect(auth.pruneSessions()).toBe(1);
  });
});

describe('agent tokens', () => {
  it('returns the plaintext once and stores only the hash', () => {
    const token = auth.createAgentToken('NAS-01');
    expect(token.token).toBeTruthy();
    const row = db.prepare('SELECT token_hash, prefix FROM agent_tokens').get() as {
      token_hash: string;
      prefix: string;
    };
    expect(row.token_hash).toBe(hashToken(token.token!));
    expect(token.token!.startsWith(row.prefix)).toBe(true);
    expect(auth.listAgentTokens()[0]!.token).toBeUndefined();
  });

  it('verifies a token and records its last use', () => {
    const token = auth.createAgentToken('NAS-01');
    expect(auth.verifyAgentToken(token.token)).toMatchObject({ name: 'NAS-01' });
    expect(auth.listAgentTokens()[0]!.lastUsedAt).not.toBeNull();
  });

  it('rejects an unknown or empty token', () => {
    expect(auth.verifyAgentToken('nope')).toBeNull();
    expect(auth.verifyAgentToken(undefined)).toBeNull();
  });

  it('rejects a revoked token', () => {
    const token = auth.createAgentToken('NAS-01');
    auth.revokeAgentToken(token.id);
    expect(auth.verifyAgentToken(token.token)).toBeNull();
    expect(auth.listAgentTokens()[0]!.revokedAt).not.toBeNull();
  });
});
