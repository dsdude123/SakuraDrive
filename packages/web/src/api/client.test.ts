import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api, buildUrl } from './client.js';

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('buildUrl', () => {
  it('returns the path unchanged with no query', () => {
    expect(buildUrl('/api/drives')).toBe('/api/drives');
  });

  it('appends parameters and drops empty ones', () => {
    expect(buildUrl('/api/alerts', { state: 'open', category: undefined, search: '', limit: 20 })).toBe(
      '/api/alerts?state=open&limit=20',
    );
  });

  it('encodes values', () => {
    expect(buildUrl('/api/catalog/browse', { path: 'Media/My Movies' })).toContain(
      'path=Media%2FMy+Movies',
    );
  });

  it('keeps false and zero, which are meaningful', () => {
    expect(buildUrl('/x', { flag: false, offset: 0 })).toBe('/x?flag=false&offset=0');
  });
});

describe('api', () => {
  it('parses a JSON response', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ drives: [] }));
    await expect(api('/api/drives')).resolves.toEqual({ drives: [] });
  });

  it('sends a JSON body with the right header', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true }));
    await api('/api/settings', { method: 'PATCH', body: { general: { siteName: 'x' } } });
    const [, init] = fetchMock.mock.calls[0]!;
    expect(init.method).toBe('PATCH');
    expect(init.headers).toEqual({ 'content-type': 'application/json' });
    expect(JSON.parse(init.body as string)).toEqual({ general: { siteName: 'x' } });
  });

  it('sends no body or content-type for a GET', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}));
    await api('/api/drives');
    const [, init] = fetchMock.mock.calls[0]!;
    expect(init.body).toBeUndefined();
    expect(init.headers).toEqual({});
  });

  it('returns undefined for 204', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    await expect(api('/api/thing')).resolves.toBeUndefined();
  });

  it('throws an ApiError carrying the server message', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ error: 'cannot_start', message: 'Catalog scan is already running' }, 409),
    );
    await expect(api('/api/workflows/catalog.scan/start')).rejects.toMatchObject({
      name: 'ApiError',
      status: 409,
      code: 'cannot_start',
      message: 'Catalog scan is already running',
    });
  });

  it('flags a 401 so the app can show the sign-in screen', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'unauthorized', message: 'Sign in' }, 401));
    await expect(api('/api/drives')).rejects.toSatisfy(
      (error: unknown) => error instanceof ApiError && error.isUnauthorized,
    );
  });

  it('handles a non-JSON error body', async () => {
    fetchMock.mockResolvedValue(new Response('gateway timeout', { status: 504 }));
    await expect(api('/api/drives')).rejects.toMatchObject({
      status: 504,
      message: 'Request failed with status 504',
    });
  });

  it('propagates a network failure', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(api('/api/drives')).rejects.toThrow('Failed to fetch');
  });
});
