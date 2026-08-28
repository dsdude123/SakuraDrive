import { describe, expect, it } from 'vitest';
import { JsonArrayStreamParser, safeParse } from './json-stream.js';

function parseAll(chunks: string[]): unknown[] {
  const parser = new JsonArrayStreamParser();
  const out: unknown[] = [];
  for (const chunk of chunks) out.push(...parser.push(chunk));
  out.push(...parser.flush());
  return out;
}

describe('JsonArrayStreamParser', () => {
  it('parses a compact array in one chunk', () => {
    expect(parseAll(['[{"a":1},{"a":2}]'])).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it('parses a pretty-printed array, which is what kopia emits', () => {
    const text = `[
  {
    "name": "Media/Movies/a.mkv",
    "size": 1234
  },
  {
    "name": "Media/Movies/b.mkv",
    "size": 5678
  }
]`;
    expect(parseAll([text])).toEqual([
      { name: 'Media/Movies/a.mkv', size: 1234 },
      { name: 'Media/Movies/b.mkv', size: 5678 },
    ]);
  });

  it('emits objects as they complete across arbitrary chunk boundaries', () => {
    const text = '[{"a":1},{"a":2},{"a":3}]';
    for (const size of [1, 2, 3, 5, 7, 11]) {
      const chunks: string[] = [];
      for (let i = 0; i < text.length; i += size) chunks.push(text.slice(i, i + size));
      expect(parseAll(chunks), `chunk size ${size}`).toEqual([{ a: 1 }, { a: 2 }, { a: 3 }]);
    }
  });

  it('handles braces and escaped quotes inside strings', () => {
    expect(parseAll(['[{"name":"a{b}c"},{"name":"say \\"hi\\""}]'])).toEqual([
      { name: 'a{b}c' },
      { name: 'say "hi"' },
    ]);
  });

  it('handles nested objects', () => {
    expect(parseAll(['[{"summ":{"size":5},"name":"x"}]'])).toEqual([
      { summ: { size: 5 }, name: 'x' },
    ]);
  });

  it('parses newline-delimited objects with no enclosing array', () => {
    expect(parseAll(['{"a":1}\n{"a":2}\n'])).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it('returns nothing for an empty array', () => {
    expect(parseAll(['[]'])).toEqual([]);
    expect(parseAll([''])).toEqual([]);
  });

  it('skips a malformed object instead of aborting the listing', () => {
    // The second object has a trailing comma, which JSON.parse rejects.
    const result = parseAll(['[{"a":1},{"a":2,},{"a":3}]']);
    expect(result).toEqual([{ a: 1 }, { a: 3 }]);
  });

  it('does not let the buffer grow without bound', () => {
    const parser = new JsonArrayStreamParser();
    parser.push('[');
    for (let i = 0; i < 1000; i += 1) parser.push(`{"a":${i}},`);
    // @ts-expect-error reaching into the private buffer is the point of this check
    expect(parser.buffer.length).toBeLessThan(100);
  });
});

describe('safeParse', () => {
  it('returns the fallback for invalid JSON', () => {
    expect(safeParse('not json', { a: 1 })).toEqual({ a: 1 });
    expect(safeParse('null', 'fallback')).toBe('fallback');
    expect(safeParse('{"a":2}', { a: 1 })).toEqual({ a: 2 });
  });
});
