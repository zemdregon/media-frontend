import { useCallback, useEffect, useEffectEvent, useState } from 'react';
import type { Page } from '@cinewren/shared';
import { ApiError } from '../api-client';

export type Loaded<T> =
  | { status: 'loading' }
  | { status: 'error'; message: string; code: string }
  | { status: 'ready'; data: T };

export function errorMessage(err: unknown): string {
  return err instanceof ApiError ? err.message : 'Something went wrong. Try again.';
}

/**
 * Runs `fn` on mount and whenever `key` changes; `reload` runs it again. A result belongs to the
 * key it was started for, so a changed key shows "loading" at once and stale results are dropped.
 */
export function useLoad<T>(
  fn: () => Promise<T>,
  key: string,
): { state: Loaded<T>; reload: () => void } {
  const [tick, setTick] = useState(0);
  const id = `${key}#${String(tick)}`;
  const [result, setResult] = useState<{ id: string; value: Loaded<T> } | null>(null);
  const run = useEffectEvent(fn);

  useEffect(() => {
    let live = true;
    run().then(
      (data) => {
        if (live) setResult({ id, value: { status: 'ready', data } });
      },
      (err: unknown) => {
        if (live) {
          setResult({
            id,
            value: {
              status: 'error',
              message: errorMessage(err),
              code: err instanceof ApiError ? err.code : 'INTERNAL',
            },
          });
        }
      },
    );
    return () => {
      live = false;
    };
  }, [id]);

  const reload = useCallback(() => {
    setTick((t) => t + 1);
  }, []);
  const state: Loaded<T> = result?.id === id ? result.value : { status: 'loading' };
  return { state, reload };
}

/** A first page plus "load more" pages, restarted whenever `key` changes. */
export function usePagedLoad<T>(
  fetchPage: (cursor: string | null) => Promise<Page<T>>,
  key: string,
) {
  const { state, reload } = useLoad(() => fetchPage(null), key);
  const [extra, setExtra] = useState<{ base: Page<T>; items: T[]; cursor: string | null } | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);

  const base = state.status === 'ready' ? state.data : null;
  const own = base !== null && extra?.base === base ? extra : null;
  const items = base ? [...base.items, ...(own?.items ?? [])] : [];
  const cursor = base ? (own ? own.cursor : base.nextCursor) : null;

  const loadMore = async () => {
    if (!base || !cursor) return;
    setBusy(true);
    setMoreError(null);
    try {
      const page = await fetchPage(cursor);
      setExtra({ base, items: [...(own?.items ?? []), ...page.items], cursor: page.nextCursor });
    } catch (err) {
      setMoreError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return { state, reload, items, cursor, loadMore, busy, moreError };
}
