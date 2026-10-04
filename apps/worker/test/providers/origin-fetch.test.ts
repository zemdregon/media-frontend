// TDD 6.4 / NFR-SEC-005: the single outbound path. Host pinning, redirects, timeouts, retries;
// and the base-URL policy (FR-SRV-007, LLD-PROV "URL policy").
import { describe, expect, it } from 'vitest';
import { createOriginFetch, resolveOriginUrl } from '../../src/providers/origin-fetch';
import { checkBaseUrl } from '../../src/providers/url-policy';
import { parseVersion, versionAtLeast } from '../../src/providers/version';

const BASE = new URL('https://media.example.test/jellyfin');

type Handler = (url: URL, init: RequestInit | undefined, n: number) => Response | Promise<Response>;

function wrapper(handler: Handler, extra: { maxAttempts?: number; timeoutMs?: number } = {}) {
  const seen: { url: URL; init: RequestInit | undefined }[] = [];
  const fetchImpl = ((input: URL, init?: RequestInit) => {
    seen.push({ url: input, init });
    return Promise.resolve(handler(input, init, seen.length));
  }) as unknown as typeof fetch;
  return {
    seen,
    fetch: createOriginFetch({
      baseUrl: BASE,
      fetchImpl,
      sleep: () => Promise.resolve(),
      ...extra,
    }),
  };
}

describe('resolveOriginUrl', () => {
  it('keeps the base path prefix and the query', () => {
    expect(resolveOriginUrl(BASE, '/Items?x=1').href).toBe(
      'https://media.example.test/jellyfin/Items?x=1',
    );
  });

  it.each(['Items', '//evil.example/x', '/\\evil.example', '/a b', 'https://evil.example/'])(
    'refuses %j so a request can never name another host',
    (path) => {
      expect(() => resolveOriginUrl(BASE, path)).toThrow(/Invalid origin request path/);
    },
  );
});

describe('originFetch redirects (NFR-SEC-005)', () => {
  it('refuses a redirect to another host and never requests it', async () => {
    const w = wrapper(
      () => new Response(null, { status: 302, headers: { location: 'https://evil.example/x' } }),
    );
    await expect(w.fetch('/a')).rejects.toMatchObject({
      code: 'REDIRECT_REFUSED',
      retryable: false,
    });
    expect(w.seen).toHaveLength(1);
  });

  it.each([
    ['another port', 'https://media.example.test:8443/a'],
    ['another scheme', 'http://media.example.test/a'],
    ['a protocol-relative URL to another host', '//evil.example/a'],
    ['a subdomain', 'https://cdn.media.example.test/a'],
  ])('refuses a redirect to %s', async (_n, location) => {
    const w = wrapper(() => new Response(null, { status: 301, headers: { location } }));
    await expect(w.fetch('/a')).rejects.toMatchObject({ code: 'REDIRECT_REFUSED' });
    expect(w.seen).toHaveLength(1);
  });

  it('refuses a redirect with no usable Location', async () => {
    const w = wrapper(() => new Response(null, { status: 302 }));
    await expect(w.fetch('/a')).rejects.toMatchObject({ code: 'REDIRECT_REFUSED' });
  });

  it('follows a same-origin redirect, at most 3 times', async () => {
    const ok = wrapper((url, _i, n) =>
      n < 3
        ? new Response(null, { status: 302, headers: { location: `/jellyfin/step${n}` } })
        : new Response('done'),
    );
    expect(await (await ok.fetch('/a')).text()).toBe('done');
    expect(ok.seen.map((s) => s.url.pathname)).toEqual([
      '/jellyfin/a',
      '/jellyfin/step1',
      '/jellyfin/step2',
    ]);

    const loop = wrapper(
      () => new Response(null, { status: 302, headers: { location: '/jellyfin/again' } }),
    );
    await expect(loop.fetch('/a')).rejects.toMatchObject({ code: 'PROTOCOL' });
    expect(loop.seen).toHaveLength(4);
  });

  it('always asks the runtime not to follow redirects itself', async () => {
    const w = wrapper(() => new Response('ok'));
    await w.fetch('/a');
    expect(w.seen[0]?.init?.redirect).toBe('manual');
  });

  it('turns a 302 on a POST into a GET without the body, but keeps method and body on a 307', async () => {
    const to302 = wrapper((_u, _i, n) =>
      n === 1
        ? new Response(null, { status: 302, headers: { location: '/jellyfin/b' } })
        : new Response('ok'),
    );
    await to302.fetch('/a', { method: 'POST', body: 'secret' });
    expect(to302.seen[1]?.init?.method).toBe('GET');
    expect(to302.seen[1]?.init?.body).toBeUndefined();

    const to307 = wrapper((_u, _i, n) =>
      n === 1
        ? new Response(null, { status: 307, headers: { location: '/jellyfin/b' } })
        : new Response('ok'),
    );
    await to307.fetch('/a', { method: 'POST', body: 'secret' });
    expect(to307.seen[1]?.init?.method).toBe('POST');
    expect(to307.seen[1]?.init?.body).toBe('secret');
  });
});

describe('originFetch errors and retries', () => {
  it('maps network failures to UNAVAILABLE and timeouts to TIMEOUT', async () => {
    const down = wrapper(() => Promise.reject(new TypeError('connection refused')));
    await expect(down.fetch('/a')).rejects.toMatchObject({ code: 'UNAVAILABLE', retryable: true });
    const slow = wrapper(() => {
      throw new DOMException('timed out', 'TimeoutError');
    });
    await expect(slow.fetch('/a')).rejects.toMatchObject({ code: 'TIMEOUT', retryable: true });
  });

  it('retries a GET on transient statuses and then succeeds', async () => {
    const w = wrapper((_u, _i, n) => new Response(null, { status: n < 3 ? 503 : 200 }), {
      maxAttempts: 5,
    });
    expect((await w.fetch('/a')).status).toBe(200);
    expect(w.seen).toHaveLength(3);
  });

  it('returns the last transient response once attempts run out', async () => {
    const w = wrapper(() => new Response(null, { status: 502 }), { maxAttempts: 2 });
    expect((await w.fetch('/a')).status).toBe(502);
    expect(w.seen).toHaveLength(2);
  });

  it('does not retry 4xx, and never retries a write', async () => {
    const notFound = wrapper(() => new Response(null, { status: 404 }), { maxAttempts: 5 });
    expect((await notFound.fetch('/a')).status).toBe(404);
    expect(notFound.seen).toHaveLength(1);
    const post = wrapper(() => new Response(null, { status: 503 }), { maxAttempts: 5 });
    expect((await post.fetch('/a', { method: 'POST', body: '{}' })).status).toBe(503);
    expect(post.seen).toHaveLength(1);
  });

  it('does not retry a refused redirect', async () => {
    const w = wrapper(
      () => new Response(null, { status: 302, headers: { location: 'https://evil.example/' } }),
      { maxAttempts: 5 },
    );
    await expect(w.fetch('/a')).rejects.toMatchObject({ code: 'REDIRECT_REFUSED' });
    expect(w.seen).toHaveLength(1);
  });
});

describe('checkBaseUrl (FR-SRV-007, LLD-PROV)', () => {
  const prod = { local: false, allowInsecure: false };
  const local = { local: true, allowInsecure: true };

  it('accepts a public https hostname and normalizes it', () => {
    for (const [raw, href] of [
      ['https://Media.Example.com', 'https://media.example.com/'],
      ['https://media.example.com/', 'https://media.example.com/'],
      ['https://media.example.com:8920/jellyfin/', 'https://media.example.com:8920/jellyfin'],
      ['  https://media.example.com/emby  ', 'https://media.example.com/emby'],
    ] as const) {
      const r = checkBaseUrl(raw, prod);
      expect(r).toMatchObject({ ok: true });
      expect(r.ok && r.baseUrl.href).toBe(href);
    }
  });

  it('rejects http:// with INSECURE_ORIGIN_URL unless the local flag is set', () => {
    expect(checkBaseUrl('http://media.example.com', prod)).toMatchObject({
      ok: false,
      code: 'INSECURE_ORIGIN_URL',
    });
    expect(checkBaseUrl('http://media.example.com', local)).toMatchObject({ ok: true });
  });

  it.each([
    ['an IPv4 literal', 'https://203.0.113.9', 'ip_literal'],
    ['a private IPv4 literal', 'https://192.168.1.10:8096', 'ip_literal'],
    ['an obfuscated IPv4 literal', 'https://0x7f.1', 'ip_literal'],
    ['a decimal IPv4 literal', 'https://2130706433', 'ip_literal'],
    ['an IPv6 literal', 'https://[::1]:8096', 'ip_literal'],
    ['the cloud metadata address', 'https://169.254.169.254', 'ip_literal'],
    ['localhost', 'https://localhost', 'internal_hostname'],
    ['localhost with a trailing dot', 'https://localhost.', 'internal_hostname'],
    ['a .localhost name', 'https://app.localhost', 'internal_hostname'],
    ['a .local name', 'https://nas.local', 'internal_hostname'],
    ['a .internal name', 'https://jellyfin.internal', 'internal_hostname'],
    ['a .home.arpa name', 'https://nas.home.arpa', 'internal_hostname'],
    ['a single-label name', 'https://nas', 'single_label_hostname'],
    ['userinfo', 'https://user:pass@media.example.com', 'userinfo'],
    ['a query string', 'https://media.example.com/?x=1', 'query_or_fragment'],
    ['a fragment', 'https://media.example.com/#x', 'query_or_fragment'],
  ])('refuses %s outside local mode with BLOCKED_ORIGIN_URL', (_n, raw, reason) => {
    expect(checkBaseUrl(raw, prod)).toEqual({ ok: false, code: 'BLOCKED_ORIGIN_URL', reason });
  });

  it('allows the same addresses in local mode, and still drops userinfo and query from what is stored', () => {
    for (const raw of [
      'https://192.168.1.10:8096',
      'https://localhost',
      'https://nas.local',
      'https://nas',
    ]) {
      expect(checkBaseUrl(raw, local)).toMatchObject({ ok: true });
    }
    const r = checkBaseUrl('https://u:p@nas.local/x/?q=1#f', local);
    expect(r.ok && r.baseUrl.href).toBe('https://nas.local/x');
  });

  it.each(['', 'not a url', 'media.example.com', 'ftp://media.example.com', 'javascript:alert(1)'])(
    'rejects %j as not a usable URL',
    (raw) => {
      expect(checkBaseUrl(raw, local)).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' });
    },
  );
});

describe('version parsing', () => {
  it('parses Jellyfin, Emby and Plex version strings', () => {
    expect(parseVersion('12.1.0')).toEqual([12, 1, 0]);
    expect(parseVersion('4.10.1.0')).toEqual([4, 10, 1, 0]);
    expect(parseVersion('1.43.4.10903-e5521bd8c')).toEqual([1, 43, 4, 10903]);
    expect(parseVersion('nightly')).toBeNull();
    expect(parseVersion('')).toBeNull();
  });

  it('compares numerically, not lexically', () => {
    expect(versionAtLeast([12, 1, 0], [12, 1])).toBe(true);
    expect(versionAtLeast([12, 10], [12, 1])).toBe(true);
    expect(versionAtLeast([13], [12, 1])).toBe(true);
    expect(versionAtLeast([12, 0, 9], [12, 1])).toBe(false);
    expect(versionAtLeast([10, 10, 7], [12, 1])).toBe(false);
    expect(versionAtLeast([9, 99], [10, 1])).toBe(false);
  });
});
