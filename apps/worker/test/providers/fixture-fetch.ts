/**
 * Fixture-backed fake `fetch` for adapter tests (T1.2, NFR-MAINT-001). Every request is matched
 * on method + path + query against the *recorded request* inside a fixture file from
 * `test-fixtures/providers/<provider>/`, and answered with the recorded response. A request that
 * matches nothing is recorded in `unmatched` (the contract suite asserts it is empty) and fails.
 *
 * Matching ignores header values (they carry redacted placeholders) and compares queries as
 * sorted key/value pairs, so parameter order does not matter. Paging parameters differ between
 * recordings, so a route can name `ignoreParams`, or `overrideParams` to alias a recording that
 * was captured with a different value.
 */

export interface Fixture {
  request: { method: string; path: string; headers: Record<string, string>; body: unknown };
  response: { status: number; headers: Record<string, string>; body: unknown };
}

export interface FixtureRoute {
  /** File name inside the provider's fixture folder. */
  fixture: string;
  /** Query parameters removed from both the recording and the live request before comparing. */
  ignoreParams?: string[];
  /** Query parameters whose recorded value is replaced before comparing. */
  overrideParams?: Record<string, string>;
  /** Changes the recorded response, for example to flip `IsAdministrator`. */
  mutate?: (fixture: Fixture) => Fixture;
}

/** A synthetic response for a case no recording covers (clearly marked as such in the test). */
export interface InlineRoute {
  method: string;
  /** Path and query exactly as the adapter should request it. */
  url: string;
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

export type Route = FixtureRoute | InlineRoute;

export interface RecordedCall {
  method: string;
  url: URL;
  headers: Headers;
  body: string | undefined;
  redirect: string | undefined;
}

const raw = import.meta.glob('../../../../test-fixtures/providers/*/*.json', {
  eager: true,
  query: '?raw',
  import: 'default',
}) as Record<string, string>;

export function loadFixture(provider: string, name: string): Fixture {
  const entry = Object.entries(raw).find(([path]) => path.endsWith(`/${provider}/${name}`));
  if (!entry) throw new Error(`Missing fixture ${provider}/${name}`);
  return JSON.parse(entry[1]) as Fixture;
}

function key(
  method: string,
  pathAndQuery: string,
  ignore: string[],
  override: Record<string, string>,
) {
  const url = new URL(pathAndQuery, 'https://fixture.invalid');
  const pairs: string[] = [];
  for (const [k, v] of url.searchParams) {
    if (ignore.includes(k)) continue;
    pairs.push(`${k}=${k in override ? override[k] : v}`);
  }
  pairs.sort();
  return `${method.toUpperCase()} ${url.pathname}?${pairs.join('&')}`;
}

interface Entry {
  match: (method: string, pathAndQuery: string) => boolean;
  respond: () => Response;
}

function toResponse(status: number, headers: Record<string, string>, body: unknown): Response {
  const empty = body === null || body === undefined || status === 204;
  const payload = empty ? null : typeof body === 'string' ? body : JSON.stringify(body);
  return new Response(payload, { status, headers });
}

export interface FakeOrigin {
  fetch: typeof fetch;
  calls: RecordedCall[];
  /** Requests no route matched. Must stay empty. */
  unmatched: string[];
}

export interface FakeOriginOptions {
  /** Every request is answered with a 302 to this URL, to test redirect refusal. */
  redirectTo?: string;
  /** Every request fails like a refused connection or invalid certificate. */
  unreachable?: boolean;
}

export function createFakeOrigin(
  provider: string,
  routes: Route[],
  options: FakeOriginOptions = {},
): FakeOrigin {
  const calls: RecordedCall[] = [];
  const unmatched: string[] = [];
  const entries: Entry[] = routes.map((route) => {
    if ('fixture' in route) {
      const recorded = loadFixture(provider, route.fixture);
      const fixture = route.mutate ? route.mutate(structuredClone(recorded)) : recorded;
      const ignore = route.ignoreParams ?? [];
      const override = route.overrideParams ?? {};
      const expected = key(fixture.request.method, fixture.request.path, ignore, override);
      return {
        match: (method, pathAndQuery) => key(method, pathAndQuery, ignore, {}) === expected,
        respond: () =>
          toResponse(fixture.response.status, fixture.response.headers, fixture.response.body),
      };
    }
    const expected = key(route.method, route.url, [], {});
    return {
      match: (method, pathAndQuery) => key(method, pathAndQuery, [], {}) === expected,
      respond: () => toResponse(route.status, route.headers ?? {}, route.body),
    };
  });

  const fakeFetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : input);
    const method = (init?.method ?? 'GET').toUpperCase();
    calls.push({
      method,
      url,
      headers: new Headers(init?.headers),
      body: typeof init?.body === 'string' ? init.body : undefined,
      redirect: init?.redirect,
    });
    if (options.unreachable) return Promise.reject(new TypeError('Network connection lost.'));
    if (options.redirectTo) {
      return Promise.resolve(
        new Response(null, { status: 302, headers: { location: options.redirectTo } }),
      );
    }
    const entry = entries.find((e) => e.match(method, url.pathname + url.search));
    if (!entry) {
      unmatched.push(`${method} ${url.pathname}${url.search}`);
      return Promise.reject(new Error(`No fixture for ${method} ${url.pathname}${url.search}`));
    }
    return Promise.resolve(entry.respond());
  };
  return { fetch: fakeFetch, calls, unmatched };
}
