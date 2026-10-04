/**
 * The single outbound path to origin servers (TDD 6.4, NFR-SEC-005, LLD-ERR retry policy).
 * No other code calls `fetch` against an origin. It
 * - sends requests only to the registered scheme, host and port (callers give a path, never a
 *   URL, so there is nothing to point elsewhere);
 * - uses `redirect: 'manual'`, follows same-origin redirects at most 3 times, and refuses any
 *   redirect to another host, port or scheme with `REDIRECT_REFUSED`;
 * - applies a per-call timeout, and retries idempotent GETs on transient failures.
 */
import { ProviderError } from './errors';

export interface OriginRequestInit {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'HEAD';
  headers?: Record<string, string>;
  body?: string;
  /** Overrides the wrapper's default timeout for this call. */
  timeoutMs?: number;
}

/** `pathAndQuery` starts with `/` and is relative to the registered base URL (path prefix kept). */
export type OriginFetch = (pathAndQuery: string, init?: OriginRequestInit) => Promise<Response>;

export interface OriginFetchOptions {
  baseUrl: URL;
  /** The runtime `fetch`, or a test double. */
  fetchImpl: typeof fetch;
  /** Default 10 s for sync; probes and the play path pass 5 s (TDD 6.4). */
  timeoutMs?: number;
  /** Attempts for a GET (default 1: no retry). Writes are never retried. */
  maxAttempts?: number;
  sleep?: (ms: number) => Promise<void>;
}

const MAX_REDIRECTS = 3;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const RETRY_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

const realSleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

/** Joins a request path onto the base URL and checks the result is still on the base origin. */
export function resolveOriginUrl(baseUrl: URL, pathAndQuery: string): URL {
  if (
    !pathAndQuery.startsWith('/') ||
    pathAndQuery.startsWith('//') ||
    /[\\\s]/.test(pathAndQuery)
  ) {
    throw new ProviderError('PROTOCOL', 'Invalid origin request path.', false);
  }
  const prefix = baseUrl.pathname.replace(/\/+$/, '');
  const url = new URL(`${baseUrl.origin}${prefix}${pathAndQuery}`);
  if (url.origin !== baseUrl.origin) {
    throw new ProviderError('PROTOCOL', 'Invalid origin request path.', false);
  }
  return url;
}

/** Maps a non-success HTTP status to a provider error (no origin text in the message). */
export function statusError(status: number): ProviderError {
  if (status === 401 || status === 403)
    return new ProviderError('AUTH', 'The origin refused the credentials.', false);
  if (status === 404)
    return new ProviderError('NOT_FOUND', 'The origin has no such resource.', false);
  if (status === 408 || status === 429 || status >= 500) {
    return new ProviderError('UNAVAILABLE', `The origin answered with status ${status}.`, true);
  }
  return new ProviderError(
    'PROTOCOL',
    `The origin answered with unexpected status ${status}.`,
    false,
  );
}

function isTimeout(err: unknown): boolean {
  return err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
}

function backoffMs(attempt: number, retryAfter: string | null): number {
  const seconds = retryAfter === null ? NaN : Number(retryAfter);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(30_000, seconds * 1000);
  return Math.random() * Math.min(30_000, 500 * 2 ** attempt); // full jitter
}

export function createOriginFetch(options: OriginFetchOptions): OriginFetch {
  const { baseUrl, fetchImpl } = options;
  const sleep = options.sleep ?? realSleep;

  async function once(start: URL, init: OriginRequestInit): Promise<Response> {
    let url = start;
    let method = init.method ?? 'GET';
    let body = init.body;
    for (let hops = 0; ; hops++) {
      let res: Response;
      try {
        res = await fetchImpl(url, {
          method,
          redirect: 'manual',
          signal: AbortSignal.timeout(init.timeoutMs ?? options.timeoutMs ?? 10_000),
          ...(init.headers ? { headers: init.headers } : {}),
          ...(body === undefined ? {} : { body }),
        });
      } catch (err) {
        throw isTimeout(err)
          ? new ProviderError('TIMEOUT', 'The origin did not answer in time.')
          : new ProviderError('UNAVAILABLE', 'The origin could not be reached.');
      }
      if (!REDIRECT_STATUSES.has(res.status)) return res;
      await res.body?.cancel();
      const location = res.headers.get('location');
      let next: URL | null;
      try {
        next = location ? new URL(location, url) : null;
      } catch {
        next = null;
      }
      if (!next || next.origin !== baseUrl.origin) {
        throw new ProviderError(
          'REDIRECT_REFUSED',
          'The origin redirected to another address.',
          false,
        );
      }
      if (hops >= MAX_REDIRECTS) {
        throw new ProviderError('PROTOCOL', 'The origin redirected too many times.', false);
      }
      if (res.status !== 307 && res.status !== 308 && method !== 'GET' && method !== 'HEAD') {
        method = 'GET';
        body = undefined;
      }
      url = next;
    }
  }

  return async (pathAndQuery, init = {}) => {
    const start = resolveOriginUrl(baseUrl, pathAndQuery);
    const idempotent = (init.method ?? 'GET') === 'GET' || init.method === 'HEAD';
    const attempts = idempotent ? Math.max(1, options.maxAttempts ?? 1) : 1;
    for (let attempt = 0; ; attempt++) {
      const last = attempt >= attempts - 1;
      try {
        const res = await once(start, init);
        if (last || !RETRY_STATUSES.has(res.status)) return res;
        await res.body?.cancel();
        await sleep(backoffMs(attempt, res.headers.get('retry-after')));
      } catch (err) {
        if (last || !(err instanceof ProviderError) || !err.retryable) throw err;
        await sleep(backoffMs(attempt, null));
      }
    }
  };
}
