/* eslint-disable @typescript-eslint/no-non-null-assertion -- test fixtures: the rows asserted on were just written */
// T2.1 (service-token cache), T2.9 and T2.10 adapter additions, and a full sync through the real
// Jellyfin adapter over the recorded T1.1 exchanges (no network).
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { jellyfinProvider } from '../../src/providers/jellyfin';
import { normalizeItem } from '../../src/providers/jellyfin-normalize';
import { buildProviderContext } from '../../src/providers/registry';
import { getSyncServer } from '../../src/db/sync';
import { openProviderContext } from '../../src/sync/deps';
import { createLogger } from '../../src/platform/logger';
import { decrypt, encrypt, loadKeyring } from '../../src/vault/vault';
import {
  createFakeOrigin,
  loadFixture,
  type FixtureRoute,
  type InlineRoute,
} from '../providers/fixture-fetch';
import {
  BASE,
  MOVIES,
  PAGING,
  USER_ID,
  auth,
  page0,
  page2,
  views,
} from '../providers/jellyfin-routes';
import { count, db, makeHarness, one, resetCatalog, rows, syncOnce } from './harness';

const boxsets: FixtureRoute = { fixture: 'boxsets.json', ignoreParams: PAGING };
const members: FixtureRoute = { fixture: 'boxset_members.json', ignoreParams: PAGING };
const quiet = createLogger({}, () => undefined);

function adapterCtx(routes: (FixtureRoute | InlineRoute)[]) {
  const origin = createFakeOrigin('jellyfin', routes);
  const ctx = buildProviderContext({
    server: { id: 's1', type: 'jellyfin', baseUrl: new URL(BASE) },
    secret: { kind: 'password', username: 'cinewren-svc', password: 'pw-123456' },
    fetchImpl: origin.fetch,
  });
  return { ctx, origin };
}

describe('Jellyfin adapter: inline People (T2.9)', () => {
  it('asks for People in paged listings', async () => {
    const { ctx, origin } = adapterCtx([auth, page0]);
    await jellyfinProvider.listItems(ctx, { libraryId: MOVIES, pageSize: 2 });
    const listing = origin.calls.find((c) => c.url.pathname === '/Items');
    expect(listing?.url.searchParams.get('Fields')?.split(',')).toContain('People');
    expect(origin.unmatched).toEqual([]);
  });

  it('turns the recorded inline People[] into credits in billing order, with no person IDs', () => {
    const body = loadFixture('jellyfin', 'items_page_with_people_field.json').response.body as {
      Items: unknown[];
    };
    const night = body.Items.map((i) => normalizeItem(i)).find(
      (i) => i?.title === 'Night of the Living Dead',
    );
    expect(
      night?.credits.map((c) => [c.person.name, c.role, c.character ?? null, c.order]),
    ).toEqual([
      ['Duane Jones', 'actor', 'Ben', 0],
      ["Judith O'Dea", 'actor', 'Barbara', 1],
      ['George A. Romero', 'director', null, 2],
      ['John A. Russo', 'writer', null, 3],
    ]);
    expect(night?.credits.every((c) => Object.keys(c.person.externalIds).length === 0)).toBe(true);
  });
});

describe('Jellyfin adapter: listCollections (T2.10)', () => {
  it("lists box sets with their members and falls back to the members' TmdbCollection ID", async () => {
    const { ctx, origin } = adapterCtx([auth, boxsets, members]);
    const page = await jellyfinProvider.listCollections(ctx, { pageSize: 25 });
    expect(page.nextCursor).toBeNull();
    expect(page.collections).toEqual([
      {
        providerCollectionId: '275b474076ee2847be682160e284766c',
        name: 'Cinewren Spike Horror Collection',
        externalIds: { tmdb: '900001' },
        artwork: {},
        memberProviderItemIds: [
          '25900aea80a228d02844e045bdd4213f',
          'ea7efa1224758f90a2a989d8cc93a42a',
        ],
      },
    ]);
    expect(origin.unmatched).toEqual([]);
  });

  it("prefers the box set's own TMDB ID over the fallback", async () => {
    const own: FixtureRoute = {
      ...boxsets,
      mutate: (f) => {
        (
          f.response.body as { Items: { ProviderIds: Record<string, string> }[] }
        ).Items[0]!.ProviderIds = { Tmdb: '555' };
        return f;
      },
    };
    const { ctx } = adapterCtx([auth, own, members]);
    expect(
      (await jellyfinProvider.listCollections(ctx, { pageSize: 25 })).collections[0]?.externalIds,
    ).toEqual({ tmdb: '555' });
  });

  it('gives no TMDB ID when the members disagree (synthetic: one member re-tagged)', async () => {
    const mixed: FixtureRoute = {
      ...members,
      mutate: (f) => {
        (
          f.response.body as { Items: { ProviderIds: Record<string, string> }[] }
        ).Items[1]!.ProviderIds.TmdbCollection = '900002';
        return f;
      },
    };
    const { ctx } = adapterCtx([auth, boxsets, mixed]);
    expect(
      (await jellyfinProvider.listCollections(ctx, { pageSize: 25 })).collections[0]?.externalIds,
    ).toEqual({});
  });

  it('pages box sets by offset', async () => {
    const twoSets: FixtureRoute = {
      ...boxsets,
      mutate: (f) => {
        const body = f.response.body as { TotalRecordCount: number };
        body.TotalRecordCount = 5; // synthetic: the origin has more box sets than this page returns
        return f;
      },
    };
    const { ctx } = adapterCtx([auth, twoSets, members]);
    expect((await jellyfinProvider.listCollections(ctx, { pageSize: 1 })).nextCursor).toBe('1');
  });
});

describe('T2.1 encrypted service-token cache (LLD-TOKEN)', () => {
  beforeEach(resetCatalog);

  async function seedJellyfin(id = 'J') {
    const keyring = await loadKeyring(env);
    const sealed = await encrypt(
      keyring,
      'server_secret',
      id,
      JSON.stringify({ kind: 'password', username: 'cinewren-svc', password: 'pw-123456' }),
    );
    const now = 1_700_000_000_000;
    await db.batch([
      db
        .prepare(
          "INSERT INTO servers (id, type, name, base_url, origin_server_id, status, priority, created_at, updated_at) VALUES (?, 'jellyfin', 'J', ?, 'e8a0c84738be4ea3a75540d3c5ea8225', 'active', 0, ?, ?)",
        )
        .bind(id, BASE, now, now),
      db
        .prepare(
          'INSERT INTO server_credentials (server_id, key_version, secret_envelope, updated_at) VALUES (?, ?, ?, ?)',
        )
        .bind(id, sealed.keyVersion, sealed.envelope, now),
      db
        .prepare(
          "INSERT INTO libraries (id, server_id, provider_library_id, name, kind, enabled) VALUES ('jl', ?, ?, 'Movies', 'movies', 1)",
        )
        .bind(id, MOVIES),
    ]);
    return keyring;
  }

  it('stores the derived token sealed, reuses it without signing in, and refreshes it once on a 401', async () => {
    const keyring = await seedJellyfin();
    const server = (await getSyncServer(db, 'J'))!;
    const first = createFakeOrigin('jellyfin', [auth, views]);
    const a = await openProviderContext(env, server, first.fetch, () => 1, quiet);
    expect(a.ctx.serviceToken).toBeUndefined();
    await jellyfinProvider.listLibraries(a.ctx);
    expect(first.calls.filter((c) => c.url.pathname === '/Users/AuthenticateByName')).toHaveLength(
      1,
    );

    const envelope =
      (
        await one<{ service_token_envelope: string }>(
          'SELECT service_token_envelope FROM server_credentials',
        )
      )?.service_token_envelope ?? '';
    expect(envelope).toMatch(/^cw1\./);
    expect(envelope).not.toContain('SERVICE_TOKEN');
    expect(await decrypt(keyring, 'service_token', 'J', envelope)).toContain(USER_ID);
    // Bound to its row and purpose: it does not decrypt for anything else.
    await expect(decrypt(keyring, 'server_secret', 'J', envelope)).rejects.toThrow();

    // A later context (another isolate) starts from the cache and makes no sign-in call.
    const second = createFakeOrigin('jellyfin', [views]);
    const b = await openProviderContext(env, server, second.fetch, () => 2, quiet);
    expect(b.ctx.serviceToken).toBeDefined();
    await jellyfinProvider.listLibraries(b.ctx);
    expect(second.calls.map((c) => c.url.pathname)).toEqual(['/UserViews']);

    // The origin answers 401: one re-authentication, and the cache holds the new token.
    const expired: InlineRoute = {
      method: 'GET',
      url: `/UserViews?userId=${USER_ID}`,
      status: 401,
    };
    const third = createFakeOrigin('jellyfin', [expired, auth]);
    const c = await openProviderContext(env, server, third.fetch, () => 3, quiet);
    await expect(jellyfinProvider.listLibraries(c.ctx)).rejects.toMatchObject({ code: 'AUTH' });
    expect(third.calls.filter((x) => x.url.pathname === '/Users/AuthenticateByName')).toHaveLength(
      1,
    );
    expect(
      (await one<{ updated_at: number }>('SELECT updated_at FROM server_credentials'))?.updated_at,
    ).toBe(3);
  });

  it('ignores an unreadable cache entry instead of failing the run', async () => {
    await seedJellyfin();
    await db
      .prepare(
        "UPDATE server_credentials SET service_token_envelope = 'cw1.1.AAAA.AAAAAAAAAAAAAAAAAAAAAAAA'",
      )
      .run();
    const server = (await getSyncServer(db, 'J'))!;
    const origin = createFakeOrigin('jellyfin', [auth, views]);
    const opened = await openProviderContext(env, server, origin.fetch, () => 1, quiet);
    expect(opened.ctx.serviceToken).toBeUndefined();
    expect(await jellyfinProvider.listLibraries(opened.ctx)).toHaveLength(2);
  });

  it('syncs a Jellyfin library end to end from the recorded exchanges, with collections', async () => {
    await seedJellyfin();
    const origin = createFakeOrigin('jellyfin', [auth, page0, page2, boxsets, members]);
    const h = makeHarness();
    h.deps.config.pageSize = 2;
    h.deps.openServer = (server) =>
      openProviderContext(env, server, origin.fetch, () => h.clock.now, quiet);
    const run = await syncOnce(h, 'J');
    expect(origin.unmatched).toEqual([]);
    expect(run.status).toBe('succeeded');
    expect(
      (await rows<{ title: string }>('SELECT title FROM media_items ORDER BY title')).map(
        (r) => r.title,
      ),
    ).toEqual(['His Girl Friday', 'Night of the Living Dead', 'Plan 9 from Outer Space']);
    expect(await count('media_versions')).toBeGreaterThanOrEqual(3);
    expect(await one('SELECT name, tmdb_collection_id FROM collection_provider_links')).toEqual({
      name: 'Cinewren Spike Horror Collection',
      tmdb_collection_id: '900001',
    });
    expect(await count('collection_members')).toBe(2);
    // The second run reuses the cached token: still exactly one sign-in in total.
    await syncOnce(h, 'J');
    expect(origin.calls.filter((c) => c.url.pathname === '/Users/AuthenticateByName')).toHaveLength(
      1,
    );
  });
});
