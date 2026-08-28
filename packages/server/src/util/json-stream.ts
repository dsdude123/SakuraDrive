/**
 * Incremental parser for a stream of JSON objects inside a top-level array.
 *
 * `kopia ls --json` prints one large pretty-printed array. A repository holding a
 * hundred-terabyte pool can list millions of entries, which is far too much to buffer
 * and `JSON.parse` in one go, so entries are emitted as each top-level object closes.
 *
 * Only what the format actually produces is handled: an array of objects, with strings
 * that may contain braces and escapes.
 */
export class JsonArrayStreamParser {
  private buffer = '';
  /** How far into `buffer` the scanner has already looked. */
  private scanPos = 0;
  private depth = 0;
  private start = -1;
  private inString = false;
  private escaped = false;

  /** Feed a chunk; returns every complete object it contained. */
  push(chunk: string): unknown[] {
    this.buffer += chunk;
    const out: unknown[] = [];
    let i = this.scanPos;

    while (i < this.buffer.length) {
      const char = this.buffer[i]!;

      if (this.inString) {
        if (this.escaped) this.escaped = false;
        else if (char === '\\') this.escaped = true;
        else if (char === '"') this.inString = false;
        i += 1;
        continue;
      }

      if (char === '"') {
        this.inString = true;
        i += 1;
        continue;
      }

      if (char === '{') {
        if (this.depth === 0) this.start = i;
        this.depth += 1;
        i += 1;
        continue;
      }

      if (char === '}') {
        this.depth -= 1;
        if (this.depth <= 0 && this.start >= 0) {
          const text = this.buffer.slice(this.start, i + 1);
          try {
            out.push(JSON.parse(text));
          } catch {
            // A malformed object is skipped rather than aborting the whole listing.
          }
          // Consume everything up to and including this object so the buffer stays
          // bounded no matter how large the listing is.
          this.buffer = this.buffer.slice(i + 1);
          this.start = -1;
          this.depth = 0;
          i = 0;
          continue;
        }
        i += 1;
        continue;
      }

      i += 1;
    }

    this.scanPos = i;
    if (this.depth === 0 && this.start === -1) {
      // Nothing is pending: the scanned remainder is only separators and whitespace.
      this.buffer = '';
      this.scanPos = 0;
    }
    return out;
  }

  /** Objects still buffered when the stream ended (an unterminated object yields none). */
  flush(): unknown[] {
    const remaining = this.buffer.trim();
    this.buffer = '';
    this.scanPos = 0;
    this.depth = 0;
    this.start = -1;
    if (remaining === '' || !remaining.startsWith('{')) return [];
    try {
      const parsed = JSON.parse(remaining) as unknown;
      return [parsed];
    } catch {
      return [];
    }
  }
}

/** Parse a whole JSON document, returning `fallback` rather than throwing. */
export function safeParse<T>(text: string, fallback: T): T {
  try {
    const parsed = JSON.parse(text) as T;
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}
