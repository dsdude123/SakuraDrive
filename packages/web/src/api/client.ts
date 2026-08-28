/**
 * Tiny fetch wrapper.
 *
 * Everything the UI does goes through here so that a 401 has one place to be handled
 * (the session expired — show the sign-in screen) and errors arrive as a consistent
 * shape rather than a mix of thrown TypeErrors and JSON bodies.
 */

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string = 'error',
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  get isUnauthorized(): boolean {
    return this.status === 401;
  }
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  signal?: AbortSignal;
  /** Query parameters; undefined and empty values are dropped. */
  query?: Record<string, string | number | boolean | undefined | null>;
}

export function buildUrl(path: string, query?: RequestOptions['query']): string {
  if (!query) return path;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    params.set(key, String(value));
  }
  const search = params.toString();
  return search ? `${path}?${search}` : path;
}

export async function api<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, signal, query } = options;
  const response = await fetch(buildUrl(path, query), {
    method,
    signal: signal ?? null,
    credentials: 'same-origin',
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = text;
    }
  }

  if (!response.ok) {
    const record = (payload ?? {}) as { message?: string; error?: string; details?: unknown };
    throw new ApiError(
      record.message ?? `Request failed with status ${response.status}`,
      response.status,
      record.error ?? 'error',
      record.details,
    );
  }

  return payload as T;
}

/** Upload a file with progress-free multipart, used by the import screen. */
export async function upload<T>(path: string, file: File, query?: RequestOptions['query']): Promise<T> {
  const form = new FormData();
  form.append('file', file);
  const response = await fetch(buildUrl(path, query), {
    method: 'POST',
    credentials: 'same-origin',
    body: form,
  });
  const text = await response.text();
  const payload = text ? (JSON.parse(text) as unknown) : null;
  if (!response.ok) {
    const record = (payload ?? {}) as { message?: string; error?: string };
    throw new ApiError(record.message ?? 'Upload failed', response.status, record.error ?? 'error');
  }
  return payload as T;
}
