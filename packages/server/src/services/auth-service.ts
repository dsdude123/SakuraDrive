import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { AgentToken } from '@sakuradrive/shared';
import { nowIso, type Db } from '../db/index.js';
import { newSecret } from '../util/id.js';

const SCRYPT_KEYLEN = 64;
const SCRYPT_PARAMS = { N: 16_384, r: 8, p: 1 } as const;

/** `scrypt$N$r$p$salt$hash` — self-describing so parameters can change later. */
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const derived = scryptSync(password, salt, SCRYPT_KEYLEN, { ...SCRYPT_PARAMS });
  return [
    'scrypt',
    SCRYPT_PARAMS.N,
    SCRYPT_PARAMS.r,
    SCRYPT_PARAMS.p,
    salt.toString('base64'),
    derived.toString('base64'),
  ].join('$');
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, saltB64, hashB64] = parts;
  try {
    const salt = Buffer.from(saltB64!, 'base64');
    const expected = Buffer.from(hashB64!, 'base64');
    const derived = scryptSync(password, salt, expected.length, {
      N: Number(n),
      r: Number(r),
      p: Number(p),
    });
    return derived.length === expected.length && timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

/** Agent tokens are stored only as a SHA-256 digest; the plaintext is shown once. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export interface SessionUser {
  id: number;
  username: string;
}

export class AuthService {
  constructor(private readonly db: Db) {}

  /** True until the first account is created; the UI shows a setup screen. */
  needsSetup(): boolean {
    const row = this.db.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM users').get();
    return (row?.n ?? 0) === 0;
  }

  createUser(username: string, password: string): SessionUser {
    if (password.length < 8) {
      throw new Error('Password must be at least 8 characters long');
    }
    const info = this.db
      .prepare('INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)')
      .run(username, hashPassword(password), nowIso());
    return { id: Number(info.lastInsertRowid), username };
  }

  changePassword(userId: number, currentPassword: string, newPassword: string): void {
    const row = this.db
      .prepare<[number], { password_hash: string }>('SELECT password_hash FROM users WHERE id = ?')
      .get(userId);
    if (!row || !verifyPassword(currentPassword, row.password_hash)) {
      throw new Error('Current password is incorrect');
    }
    if (newPassword.length < 8) throw new Error('Password must be at least 8 characters long');
    this.db
      .prepare('UPDATE users SET password_hash = ? WHERE id = ?')
      .run(hashPassword(newPassword), userId);
    // Every other session becomes invalid, which is the point of changing a password.
    this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
  }

  login(username: string, password: string, sessionDays: number): { token: string; user: SessionUser } | null {
    const row = this.db
      .prepare<[string], { id: number; username: string; password_hash: string }>(
        'SELECT id, username, password_hash FROM users WHERE username = ?',
      )
      .get(username);
    if (!row || !verifyPassword(password, row.password_hash)) return null;

    const token = newSecret(32);
    const expires = new Date(Date.now() + sessionDays * 86_400_000).toISOString();
    this.db
      .prepare('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
      .run(hashToken(token), row.id, nowIso(), expires);
    this.db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(nowIso(), row.id);
    return { token, user: { id: row.id, username: row.username } };
  }

  resolveSession(token: string | undefined | null): SessionUser | null {
    if (!token) return null;
    const row = this.db
      .prepare<[string, string], { user_id: number; username: string }>(
        `SELECT s.user_id, u.username FROM sessions s
           JOIN users u ON u.id = s.user_id
          WHERE s.id = ? AND s.expires_at > ?`,
      )
      .get(hashToken(token), nowIso());
    return row ? { id: row.user_id, username: row.username } : null;
  }

  logout(token: string | undefined | null): void {
    if (!token) return;
    this.db.prepare('DELETE FROM sessions WHERE id = ?').run(hashToken(token));
  }

  pruneSessions(): number {
    return this.db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(nowIso()).changes;
  }

  /* ---------------------------------------------------------- agent tokens */

  createAgentToken(name: string): AgentToken {
    const token = newSecret(24);
    const prefix = token.slice(0, 8);
    const info = this.db
      .prepare('INSERT INTO agent_tokens (name, token_hash, prefix, created_at) VALUES (?, ?, ?, ?)')
      .run(name, hashToken(token), prefix, nowIso());
    return {
      id: Number(info.lastInsertRowid),
      name,
      createdAt: nowIso(),
      lastUsedAt: null,
      prefix,
      revokedAt: null,
      token,
    };
  }

  /** Validate an agent bearer token and record its use. */
  verifyAgentToken(token: string | undefined | null): { id: number; name: string } | null {
    if (!token) return null;
    const row = this.db
      .prepare<[string], { id: number; name: string }>(
        'SELECT id, name FROM agent_tokens WHERE token_hash = ? AND revoked_at IS NULL',
      )
      .get(hashToken(token));
    if (!row) return null;
    this.db.prepare('UPDATE agent_tokens SET last_used_at = ? WHERE id = ?').run(nowIso(), row.id);
    return row;
  }

  listAgentTokens(): AgentToken[] {
    return this.db
      .prepare<[], {
        id: number;
        name: string;
        prefix: string;
        created_at: string;
        last_used_at: string | null;
        revoked_at: string | null;
      }>('SELECT id, name, prefix, created_at, last_used_at, revoked_at FROM agent_tokens ORDER BY id DESC')
      .all()
      .map((row) => ({
        id: row.id,
        name: row.name,
        prefix: row.prefix,
        createdAt: row.created_at,
        lastUsedAt: row.last_used_at,
        revokedAt: row.revoked_at,
      }));
  }

  revokeAgentToken(id: number): void {
    this.db.prepare('UPDATE agent_tokens SET revoked_at = ? WHERE id = ?').run(nowIso(), id);
  }
}
