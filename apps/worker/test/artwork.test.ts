// T2.5: artwork proxy with edge cache (FR-CAT-009, FR-CAT-006, ADR-0012, NFR-SEC-001,
// NFR-SEC-005). The origin is a fake `fetch`; no test touches the network.
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/api/app';
import { call, errorCode, json } from './auth-harness';
import { resetAll, seedWorld, type World } from './catalog-seed';

let w: World;

interface OriginCall {
  url: URL;
  headers: Headers;
}
let originCalls: OriginCall[] = [];
let respond: (url: URL) => Response = () => new Response('missing', { status: 404 });

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const png = () => new Response(PNG, { headers: { 'content-type': 'image/png' } });

const app = createApp({
  originFetch: (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    originCalls.push({ url, headers: new Headers(init?.headers) });
    return Promise.resolve(respond(url));
  },
});

// The edge cache outlives a test, so every test gets its own artwork tags (and so its own keys).
let run = 0;
const t = (tag: string) => `r${run}-${tag}`;

beforeEach(async () => {
  await resetAll();
  w = await seedWorld();
  run++;
  const prefix = `"tag":"r${run}-`;
  await env.DB.batch(
    ['sources', 'person_provider_links', 'collection_provider_links'].map((table) =>
      env.DB.prepare(`UPDATE ${table} SET artwork = REPLACE(artwork, '"tag":"', ?)`).bind(prefix),
    ),
  );
  originCalls = [];
  respond = () => new Response('missing', { status: 404 });
});

const get = (u: { cookie: string }, path: string) =>
  call('GET', `/api/v1/artwork${path}`, { cookie: u.cookie, app });

describe('serving artwork', () => {
  it('proxies the image with long-lived private cache headers and no origin detail', async () => {
    respond = (url) =>
      url.pathname.endsWith('/Images/Primary') ? png() : new Response(null, { status: 404 });
    const res = await get(w.alice, `/m-amelie/poster?v=${t('tagA')}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('cache-control')).toBe('private, max-age=604800, immutable');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG);
    // The origin was asked for the Alpha copy with the artwork tag.
    expect(originCalls).toHaveLength(1);
    expect(originCalls[0]?.url.href).toBe(
      `https://alpha.example.test/Items/prov-m-amelie-alpha/Images/Primary?tag=${t('tagA')}`,
    );
    // Nothing of the origin address, the account or its password reaches the browser.
    const everything = [...res.headers.entries()].flat().join(' ');
    expect(everything).not.toMatch(/example\.test|svc|pw-secret-value|authorization|location/i);
  });

  it('serves backdrops, and thumbs from the right slot', async () => {
    respond = (url) =>
      url.pathname.endsWith('/Images/Backdrop') ? png() : new Response(null, { status: 404 });
    expect((await get(w.op, `/m-amelie/backdrop?v=${t('bdA')}`)).status).toBe(200);
    expect(originCalls[0]?.url.pathname).toBe('/Items/prov-m-amelie-alpha/Images/Backdrop');
    expect((await get(w.op, '/m-amelie/thumb')).status).toBe(404); // no thumb art recorded
  });

  it('serves person and collection images, and refuses them to callers who cannot see the entity', async () => {
    respond = () => png();
    expect((await get(w.alice, `/people/p-evans?v=${t('face1')}`)).status).toBe(200);
    expect(originCalls[0]?.url.pathname).toBe('/Items/pp-p-evans/Images/Primary');
    expect((await get(w.carol, `/collections/c-duo?v=${t('cover1')}`)).status).toBe(200);
    expect(originCalls[1]?.url.pathname).toBe('/Items/pc-c-duo/Images/Primary');
    const hiddenPerson = await get(w.alice, `/people/p-hidden?v=${t('face2')}`);
    expect(hiddenPerson.status).toBe(404);
    expect((await get(w.bob, `/collections/c-duo?v=${t('cover1')}`)).status).toBe(404);
    expect(originCalls).toHaveLength(2);
  });

  it('rejects an unknown slot and treats unknown or hidden items alike', async () => {
    expect((await get(w.op, '/m-amelie/banner')).status).toBe(400);
    for (const id of ['nope', 'm-secret', 'm-gone']) {
      const res = await get(w.op, `/${id}/poster`);
      expect(res.status, id).toBe(404);
      expect(await errorCode(res), id).toBe('NOT_FOUND');
    }
    expect(originCalls).toHaveLength(0);
  });
});

describe('edge cache (ADR-0012)', () => {
  it('serves a repeat request from the cache without calling the origin', async () => {
    respond = () => png();
    expect((await get(w.alice, `/m-inter/poster?v=${t('tagI')}`)).status).toBe(404); // not visible to Alice
    expect((await get(w.carol, `/m-inter/poster?v=${t('tagI')}`)).status).toBe(200);
    expect(originCalls).toHaveLength(1);
    const again = await get(w.carol, `/m-inter/poster?v=${t('tagI')}`);
    expect(again.status).toBe(200);
    expect(new Uint8Array(await again.arrayBuffer())).toEqual(PNG);
    expect(again.headers.get('cache-control')).toBe('private, max-age=604800, immutable');
    expect(originCalls).toHaveLength(1);
  });

  it('checks permission before any cached response is served', async () => {
    respond = () => png();
    expect((await get(w.op, `/m-amelie/poster?v=${t('tagB')}`)).status).toBe(200); // fills the cache
    const before = originCalls.length;
    // Same URL, same cache key, but a viewer with no grant: refused, cache never consulted.
    expect((await get(w.bob, `/m-amelie/poster?v=${t('tagB')}`)).status).toBe(404);
    expect((await get(w.bob, `/m-amelie/poster?v=${t('tagA')}`)).status).toBe(404);
    // Revoking access after the image was cached stops it at once.
    expect((await get(w.alice, `/m-amelie/poster?v=${t('tagA')}`)).status).toBe(200);
    await call('PUT', '/api/v1/admin/users/alice/grants', {
      cookie: w.op.cookie,
      app,
      body: { libraryIds: [] },
    });
    expect((await get(w.alice, `/m-amelie/poster?v=${t('tagA')}`)).status).toBe(404);
    expect(originCalls.length).toBe(before + 1);
  });

  it('keeps serving cached art when the origin is down, and answers 502 for uncached art', async () => {
    respond = () => png();
    expect((await get(w.carol, `/m-inter/poster?v=${t('tagI')}`)).status).toBe(200);
    respond = () => {
      throw new TypeError('network down');
    };
    expect((await get(w.carol, `/m-inter/poster?v=${t('tagI')}`)).status).toBe(200);
    const uncached = await get(w.op, `/s-sev/poster?v=${t('tagSev')}`);
    expect(uncached.status).toBe(502);
    expect(await errorCode(uncached)).toBe('ORIGIN_UNAVAILABLE');
  });
});

describe('origin responses', () => {
  it('falls back to another visible source when the preferred one fails', async () => {
    respond = (url) =>
      url.hostname === 'alpha.example.test' ? new Response('boom', { status: 500 }) : png();
    // The operator sees both copies of Amélie; the Alpha poster tag is preferred but down.
    const res = await get(w.op, `/m-amelie/poster?v=${t('tagA-fallback-test')}`);
    expect(res.status).toBe(200);
    expect(originCalls.map((c) => c.url.hostname)).toEqual([
      'alpha.example.test',
      'bravo.example.test',
    ]);
  });

  it('refuses non-image and oversized responses without echoing them', async () => {
    respond = () =>
      new Response('<script>alert(1)</script>', { headers: { 'content-type': 'text/html' } });
    const html = await get(w.op, `/s-sev/poster?v=${t('tagSev')}`);
    expect(html.status).toBe(502);
    expect(JSON.stringify(await json(html))).not.toMatch(/script|example\.test/);

    respond = () =>
      new Response(new Uint8Array(10 * 1024 * 1024 + 1), {
        headers: { 'content-type': 'image/jpeg' },
      });
    expect((await get(w.op, `/s-sev/poster?v=${t('tagSev')}`)).status).toBe(502);
    respond = () =>
      new Response(null, { status: 200, headers: { 'content-type': 'image/svg+xml' } });
    expect((await get(w.op, `/s-sev/poster?v=${t('tagSev')}`)).status).toBe(502);
  });

  it('answers 404 when every origin says the image does not exist', async () => {
    respond = () => new Response(null, { status: 404 });
    const res = await get(w.op, `/m-inter/poster?v=${t('tagI-gone')}`);
    expect(res.status).toBe(404);
  });

  it('does not follow a redirect to another host', async () => {
    respond = () =>
      new Response(null, { status: 302, headers: { location: 'https://evil.test/x.png' } });
    const res = await get(w.op, `/s-sev/poster?v=${t('tagSev')}`);
    expect(res.status).toBe(502);
    expect(originCalls.every((c) => c.url.hostname.endsWith('.example.test'))).toBe(true);
  });
});
