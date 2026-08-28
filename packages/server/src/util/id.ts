import { randomBytes, randomUUID } from 'node:crypto';

/** URL-safe opaque identifier used for settings entities (roots, rules, destinations). */
export function newId(prefix = ''): string {
  const id = randomUUID().replace(/-/g, '').slice(0, 16);
  return prefix ? `${prefix}_${id}` : id;
}

/** High-entropy secret used for agent tokens and session ids. */
export function newSecret(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}
