import { EventEmitter } from 'node:events';
import {
  defaultSettings,
  mergeSettings,
  parseSettings,
  redactSettings,
  type Settings,
} from '@sakuradrive/shared';
import { nowIso, type Db } from '../db/index.js';

/**
 * Settings live as one JSON document so the whole configuration can be exported,
 * imported and diffed atomically. The in-process cache keeps hot paths (the workflow
 * scheduler ticks every 30s, the catalog walker resolves excludes per directory) off
 * the database.
 */
export class SettingsService extends EventEmitter {
  private cache: Settings | null = null;

  constructor(private readonly db: Db) {
    super();
  }

  get(): Settings {
    if (this.cache) return this.cache;
    const row = this.db
      .prepare<[], { json: string }>('SELECT json FROM settings WHERE id = 1')
      .get();
    if (!row) {
      const initial = defaultSettings();
      this.write(initial);
      this.cache = initial;
      return initial;
    }
    try {
      this.cache = parseSettings(JSON.parse(row.json));
    } catch {
      // A corrupt or incompatible document must not stop the service from booting;
      // fall back to defaults and let the operator re-import.
      this.cache = defaultSettings();
    }
    return this.cache;
  }

  /** Settings with every credential masked — what the API returns to the browser. */
  getRedacted(): Settings {
    return redactSettings(this.get());
  }

  /** Apply a partial patch. Throws when the merged document fails validation. */
  update(patch: unknown): Settings {
    const current = this.get();
    const next = mergeSettings(current, patch);
    this.write(next);
    this.cache = next;
    this.emit('changed', next, current);
    return next;
  }

  /** Replace the whole document, used by import. */
  replace(settings: unknown): Settings {
    const previous = this.get();
    const next = parseSettings(settings);
    this.write(next);
    this.cache = next;
    this.emit('changed', next, previous);
    return next;
  }

  /** Drop the cache so a change made by another process (import) is picked up. */
  invalidate(): void {
    this.cache = null;
  }

  private write(settings: Settings): void {
    this.db
      .prepare(
        `INSERT INTO settings (id, json, updated_at) VALUES (1, ?, ?)
         ON CONFLICT(id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at`,
      )
      .run(JSON.stringify(settings), nowIso());
  }

  /** The scan root with this id, or undefined. */
  root(rootId: string) {
    return this.get().catalog.roots.find((root) => root.id === rootId);
  }

  enabledRoots() {
    return this.get().catalog.roots.filter((root) => root.enabled);
  }

  timezone(): string {
    return this.get().general.timezone || 'UTC';
  }
}
