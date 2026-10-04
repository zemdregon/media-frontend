// T1.4: the Jellyfin adapter against the T1.1 recordings. The shared contract suite runs first;
// the rest covers Jellyfin-specific behaviour (auth header form, token refresh, normalization).
import { describe, expect, it } from 'vitest';
import { jellyfinProvider } from '../../src/providers/jellyfin';
import { buildProviderContext } from '../../src/providers/registry';
import {
  BASE,
  MOVIES,
  SHOWS,
  USER_ID,
  adminAuth,
  auth,
  detail,
  happy,
  logout,
  notJellyfinInfo,
  oldVersionInfo,
  page0,
  page2,
  publicInfo,
  rejectedSignIn,
  sinceRoute,
  tvAll,
  unknownItem,
  views,
  withBody,
} from './jellyfin-routes';
import { runProviderContract } from './contract';
import { createFakeOrigin, loadFixture, type InlineRoute, type Route } from './fixture-fetch';

runProviderContract({
  name: 'Jellyfin 12.1',
  provider: jellyfinProvider,
  type: 'jellyfin',
  fixtureDir: 'jellyfin',
  baseUrl: BASE,
  secret: { kind: 'password', username: 'cinewren-svc', password: 'correct horse battery staple' },
  happy,
  expected: {
    originServerId: 'e8a0c84738be4ea3a75540d3c5ea8225',
    version: '12.1.0',
    libraries: [
      { providerLibraryId: MOVIES, name: 'Movies', kind: 'movies' },
      { providerLibraryId: SHOWS, name: 'Shows', kind: 'tv' },
    ],
    paged: { libraryId: MOVIES, pageSize: 2, total: 3, pages: 2 },
    since: {
      libraryId: MOVIES,
      since: Date.parse('2026-10-04T07:03:24.000Z'),
      routes: [publicInfo, auth, sinceRoute],
      count: 1,
    },
    item: {
      id: 'ea7efa1224758f90a2a989d8cc93a42a',
      title: 'Night of the Living Dead',
      externalIds: { imdb: 'tt0063350', tmdb: '10331' },
      minCredits: 4,
    },
    unknownItem: { id: 'does-not-exist', routes: [unknownItem] },
  },
  failures: {
    badCredentials: [publicInfo, rejectedSignIn],
    adminAccount: [publicInfo, adminAuth, logout],
    notAServer: [notJellyfinInfo],
    versionTooOld: [oldVersionInfo, auth],
  },
});

function context(routes: Route[], serviceToken?: string) {
  const origin = createFakeOrigin('jellyfin', routes);
  const refreshed: string[] = [];
  const ctx = buildProviderContext({
    server: { id: 's1', type: 'jellyfin', baseUrl: new URL(BASE) },
    secret: { kind: 'password', username: 'cinewren-svc', password: 'pw-123456' },
    fetchImpl: origin.fetch,
  });
  ctx.serviceToken = serviceToken;
  ctx.onTokenRefresh = (t) => {
    refreshed.push(t);
    return Promise.resolve();
  };
  return { ctx, origin, refreshed };
}

describe('Jellyfin authentication (spike rows 1a, 1b)', () => {
  it('signs in with AuthenticateByName and sends the token in the MediaBrowser Authorization header', async () => {
    const { ctx, origin, refreshed } = context([auth, views]);
    await jellyfinProvider.listLibraries(ctx);
    const [signIn, listing] = origin.calls;
    expect(signIn?.method).toBe('POST');
    expect(signIn?.url.pathname).toBe('/Users/AuthenticateByName');
    expect(JSON.parse(signIn?.body ?? '{}')).toEqual({
      Username: 'cinewren-svc',
      Pw: 'pw-123456',
    });
    const header = listing?.headers.get('authorization') ?? '';
    expect(header).toMatch(/^MediaBrowser Client="Cinewren", .*Token="<SERVICE_TOKEN>"$/);
    // 12.1 rejects these carriers; the adapter must not use them.
    for (const call of origin.calls) {
      expect(call.headers.has('x-emby-token')).toBe(false);
      expect(call.headers.has('x-emby-authorization')).toBe(false);
      expect(call.url.searchParams.has('api_key')).toBe(false);
    }
    expect(refreshed).toHaveLength(1);
  });

  it('reuses a cached token without signing in again', async () => {
    const { ctx, origin } = context([views], `${USER_ID}:cached-token`);
    await jellyfinProvider.listLibraries(ctx);
    expect(origin.calls.map((c) => c.url.pathname)).toEqual(['/UserViews']);
    expect(origin.calls[0]?.headers.get('authorization')).toContain('Token="cached-token"');
  });

  it('refreshes the token exactly once on a 401, then fails with AUTH', async () => {
    const expired: InlineRoute = {
      method: 'GET',
      url: `/UserViews?userId=${USER_ID}`,
      status: 401,
    };
    const { ctx, origin } = context([auth, expired], `${USER_ID}:stale`);
    await expect(jellyfinProvider.listLibraries(ctx)).rejects.toMatchObject({ code: 'AUTH' });
    expect(origin.calls.map((c) => `${c.method} ${c.url.pathname}`)).toEqual([
      'GET /UserViews',
      'POST /Users/AuthenticateByName',
      'GET /UserViews',
    ]);
  });

  it('refuses a token-only secret: Jellyfin needs a username and password', async () => {
    const { ctx } = context([publicInfo]);
    ctx.secret = { kind: 'token', token: 'x' };
    expect(await jellyfinProvider.validate(ctx)).toEqual({
      ok: false,
      check: 'credentials',
      reason: 'unsupported_credential',
    });
  });

  it('treats an unknown admin status as a failure rather than assuming non-admin', async () => {
    const { ctx } = context([
      publicInfo,
      {
        fixture: 'auth_svc.json',
        mutate: withBody((b) => {
          delete ((b.User as Record<string, unknown>).Policy as Record<string, unknown>)
            .IsAdministrator;
        }),
      },
      logout,
    ]);
    expect(await jellyfinProvider.validate(ctx)).toMatchObject({
      ok: false,
      check: 'credentials',
      reason: 'admin_status_unknown',
    });
  });

  it('logs the refused admin session out and does not leave the token cached', async () => {
    const { ctx, origin, refreshed } = context([publicInfo, adminAuth, logout]);
    await jellyfinProvider.validate(ctx);
    expect(origin.calls.at(-1)?.url.pathname).toBe('/Sessions/Logout');
    expect(ctx.serviceToken).toBeUndefined();
    expect(refreshed).toEqual([]);
  });
});

describe('Jellyfin item normalization (spike rows 3d, 4a; LLD-PROV)', () => {
  it('maps media versions, tracks and ProviderIds for a movie with a muxed and a sidecar subtitle', async () => {
    const { ctx } = context([auth, page0, page2]);
    const first = await jellyfinProvider.listItems(ctx, { libraryId: MOVIES, pageSize: 2 });
    const second = await jellyfinProvider.listItems(ctx, {
      libraryId: MOVIES,
      pageSize: 2,
      cursor: first.nextCursor ?? '',
    });
    const plan9 = second.items.find((i) => i.title === 'Plan 9 from Outer Space');
    expect(plan9).toMatchObject({
      type: 'movie',
      year: 1957,
      externalIds: { imdb: 'tt0052077', tmdb: '10513' },
      genres: ['Science Fiction'],
      runtimeMs: 12_023,
    });
    expect(plan9?.versions).toHaveLength(1);
    const version = plan9?.versions[0];
    expect(version).toMatchObject({
      providerVersionId: '25900aea80a228d02844e045bdd4213f',
      container: 'mkv',
      videoCodec: 'hevc',
      height: 1080,
      width: 1920,
      hdr: 'none',
      sizeBytes: 201_767,
    });
    expect(version?.audio).toEqual([
      expect.objectContaining({ index: 2, codec: 'aac', channels: 1 }),
    ]);
    expect(version?.subtitles.map((s) => [s.index, s.kind, s.isExternal])).toEqual([
      [0, 'text', true],
      [3, 'text', false],
    ]);
  });

  it('maps a TV library: series, seasons and episodes with their positions', async () => {
    const { ctx } = context([auth, tvAll]);
    const page = await jellyfinProvider.listItems(ctx, { libraryId: SHOWS, pageSize: 50 });
    const ofType = (type: string) => page.items.filter((i) => i.type === type);
    const byType = {
      series: ofType('series'),
      season: ofType('season'),
      episode: ofType('episode'),
    };
    expect(byType.series[0]).toMatchObject({
      title: 'Dragnet',
      year: 1951,
      externalIds: { imdb: 'tt0043194', tvdb: '70843' },
      versions: [],
    });
    expect(byType.season[0]).toMatchObject({ seasonNumber: 1, versions: [] });
    const episodes = byType.episode;
    expect(episodes.map((e) => [e.seasonNumber, e.episodeNumber])).toEqual([
      [1, 1],
      [1, 2],
    ]);
    expect(episodes.every((e) => e.versions.length === 1 && e.credits.length === 0)).toBe(true);
    expect(episodes[0]?.providerParentId).toBe(byType.season[0]?.providerItemId);
  });

  it('returns credits in billing order with roles and characters, and no invented person IDs', async () => {
    const { ctx } = context([auth, detail]);
    const item = await jellyfinProvider.getItem(ctx, 'ea7efa1224758f90a2a989d8cc93a42a');
    expect(item?.credits.map((c) => [c.order, c.person.name, c.role, c.character])).toEqual([
      [0, 'Duane Jones', 'actor', 'Ben'],
      [1, "Judith O'Dea", 'actor', 'Barbara'],
      [2, 'George A. Romero', 'director', undefined],
      [3, 'John A. Russo', 'writer', undefined],
    ]);
    expect(item?.credits.every((c) => Object.keys(c.person.externalIds).length === 0)).toBe(true);
    expect(item?.artwork.poster).toEqual({
      providerItemId: 'ea7efa1224758f90a2a989d8cc93a42a',
      tag: 'b66ca575b92c4b2d19099e0b6848c277',
    });
  });

  it('requests the incremental filter as MinDateLastSaved in ISO 8601 UTC', async () => {
    const { ctx, origin } = context([auth, sinceRoute]);
    await jellyfinProvider.listItems(ctx, {
      libraryId: MOVIES,
      pageSize: 10,
      since: Date.parse('2026-10-04T07:03:24.000Z'),
    });
    expect(origin.calls.at(-1)?.url.searchParams.get('MinDateLastSaved')).toBe(
      '2026-10-04T07:03:24.000Z',
    );
  });

  it('keeps the recorded fixtures honest: the since recording returns one item', () => {
    const f = loadFixture('jellyfin', 'items_changed_since_MinDateLastSaved.json');
    expect((f.response.body as { TotalRecordCount: number }).TotalRecordCount).toBe(1);
  });
});

describe('Jellyfin adapter scope', () => {
  it('leaves playback to M3: the methods refuse rather than guess (owner decision 2026-10-04: always token-gated HLS)', async () => {
    const { ctx } = context([]);
    await expect(jellyfinProvider.createSessionCredential(ctx, 'sess')).rejects.toMatchObject({
      code: 'UNSUPPORTED',
    });
  });

  it('builds unauthenticated artwork requests on the registered host', () => {
    const { ctx } = context([]);
    const req = jellyfinProvider.getArtworkRequest(
      ctx,
      { providerItemId: 'abc', tag: 't1' },
      'poster',
    );
    expect(req.url).toBe(`${BASE}/Items/abc/Images/Primary?tag=t1`);
    expect(req.headers.has('authorization')).toBe(false);
  });
});
