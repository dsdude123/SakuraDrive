import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, api, type RequestOptions } from '../api/client.js';

export interface QueryState<T> {
  data: T | null;
  error: ApiError | null;
  loading: boolean;
  /** Re-fetch immediately, e.g. after a mutation. */
  refresh: () => void;
}

/**
 * Fetch-on-mount with optional polling.
 *
 * The dashboard and workflow pages need live numbers while a scan runs; polling keeps
 * that simple and avoids a websocket for what is a handful of small JSON documents.
 */
export function useQuery<T>(
  path: string | null,
  options: RequestOptions & { pollMs?: number; enabled?: boolean } = {},
): QueryState<T> {
  const { pollMs, enabled = true, ...requestOptions } = options;
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(enabled && path !== null);
  const [tick, setTick] = useState(0);

  // Serialise so an inline object literal does not restart the effect every render.
  const optionsKey = JSON.stringify(requestOptions);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (!enabled || path === null) {
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    let cancelled = false;

    const run = async () => {
      try {
        const result = await api<T>(path, {
          ...(JSON.parse(optionsKey) as RequestOptions),
          signal: controller.signal,
        });
        if (!cancelled && mounted.current) {
          setData(result);
          setError(null);
        }
      } catch (caught) {
        if (cancelled || controller.signal.aborted) return;
        if (mounted.current) {
          setError(caught instanceof ApiError ? caught : new ApiError(String(caught), 0));
        }
      } finally {
        if (!cancelled && mounted.current) setLoading(false);
      }
    };

    setLoading(true);
    void run();

    const timer = pollMs ? setInterval(() => void run(), pollMs) : null;
    return () => {
      cancelled = true;
      controller.abort();
      if (timer) clearInterval(timer);
    };
  }, [path, optionsKey, pollMs, enabled, tick]);

  const refresh = useCallback(() => setTick((value) => value + 1), []);
  return { data, error, loading, refresh };
}

export interface MutationState {
  busy: boolean;
  error: string | null;
  run: <T>(path: string, options?: RequestOptions) => Promise<T | null>;
  reset: () => void;
}

/** POST/PATCH helper that tracks in-flight state and surfaces the error message. */
export function useMutation(): MutationState {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(async <T,>(path: string, options: RequestOptions = {}) => {
    setBusy(true);
    setError(null);
    try {
      return await api<T>(path, { method: 'POST', ...options });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      return null;
    } finally {
      setBusy(false);
    }
  }, []);

  return { busy, error, run, reset: () => setError(null) };
}
