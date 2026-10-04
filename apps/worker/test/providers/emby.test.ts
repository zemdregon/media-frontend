// T4.1: the Emby adapter against the T1.1 recordings (IR-004). The shared contract suite runs
// first; the rest covers what is Emby's own: auth carriers, library and item paths, the identity
// check without a ProductName, the 4.10 minimum, box sets and artwork.
import { describe, expect, it } from 'vitest';
import { embyProvider } from '../../src/providers/emby';
import { buildProviderContext } from '../../src/providers/registry';
import { withBody } from './jellyfin-routes';
import {
  BASE,
  MOVIES,
  SERVER_ID,
  USER_ID,
  adminAuth,
  auth,
  boxsetMembers,
  boxsets,
  detail,
  happy,
  logout,
  notEmbyInfo,
  oldVersionInfo,
  page0,
  page2,
  publicInfo,
  rejectedSignIn,
  sinceRoute,
  tvAll,
  unknownItem,
  views,
  SHOWS,
} from './emby-routes';
import { runProviderContract } from './contract';
import { createFakeOrigin, type InlineRoute, type Route } from './fixture-fetch';

runProviderContract({
  name: 'Emby 4.10',
  provider: embyProvider,
  type: 'emby',
  fixtureDir: 'emby',
  baseUrl: BASE,
  secret: { kind: 'password', username: 'cinewren-svc', password: 'correct horse battery staple' },
  happy,
  expected: {
    originServerId: SERVER_ID,
    version: '4.10.1.0',
    libraries: [
      { providerLibraryId: MOVIES, name: 'Movies', kind: 'movies' },
      { providerLibraryId: SHOWS, name: 'Shows', kind: 'tv' },
    ],
    paged: { libraryId: MOVIES, pageSize: 2, total: 3, pages: 2 },
    since: {
      libraryId: MOVIES,
      since: Date.parse('2026-10-04T07:03:52.000Z'),
      routes: [publicInfo, auth, sinceRoute],
      count: 1,
    },
    item: {
      id: '11',
      title: 'Night of the Living Dead',
      externalIds: { imdb: 'tt0063350', tmdb: '10331' },
      minCredits: 4,
    },
    unknownItem: { id: 'does-not-exist', routes: [unknownItem] },
  },
  failures: {
    badCredentials: [publicInfo, rejectedSignIn],
    adminAccount: [publicInfo, adminAuth, logout],
    notAServer: [notEmbyInfo],
    versionTooOld: [oldVersionInfo, auth],
  },
});

function context(routes: Route[], serviceToken?: string) {
  const origin = createFakeOrigin('emby', routes);
  const ctx = buildProviderContext({
    server: { id: 's1', type: 'emby', baseUrl: new URL(BASE) },
    secret: { kind: 'password', username: 'cinewren-svc', password: 'pw-123456' },
    fetchImpl: origin.fetch,
  });
  ctx.serviceToken = serviceToken;
  return { ctx, origin };
}

describe('Emby authentication and paths (spike rows 1a, 1b, 2)', () => {
  it('signs in with AuthenticateByName and sends the MediaBrowser Authorization header, never a query token', async () => {
    const { ctx, origin } = context([auth, views]);
    await embyProvider.listLibraries(ctx);
    const [signIn, listing] = origin.calls;
    expect(signIn?.url.pathname).toBe('/Users/AuthenticateByName');
    expect(listing?.headers.get('authorization')).toMatch(
      /^MediaBrowser Client="Cinewren", .*Token="<SERVICE_TOKEN>"$/,
    );
    for (const call of origin.calls) {
      expect(call.url.searchParams.has('api_key')).toBe(false);
      expect(call.url.searchParams.has('ApiKey')).toBe(false);
    }
  });

  it('lists libraries at /Users/{id}/Views (Emby has no /UserViews) and getItem under the user', async () => {
    const { ctx, origin } = context([auth, views, detail]);
    await embyProvider.listLibraries(ctx);
    await embyProvider.getItem(ctx, '11');
    expect(origin.calls.map((c) => c.url.pathname)).toEqual([
      '/Users/AuthenticateByName',
      `/Users/${USER_ID}/Views`,
      `/Users/${USER_ID}/Items/11`,
    ]);
  });

  it('refuses a token-only secret: Emby needs a username and password', async () => {
    const { ctx } = context([publicInfo]);
    ctx.secret = { kind: 'token', token: 'x' };
    expect(await embyProvider.validate(ctx)).toEqual({
      ok: false,
      check: 'credentials',
      reason: 'unsupported_credential',
    });
  });

  it('accepts the recorded identity answer, which has no ProductName, and rejects a Jellyfin one', async () => {
    const ok = context([publicInfo, auth]);
    expect(await embyProvider.validate(ok.ctx)).toMatchObject({ ok: true });
    const other = context([notEmbyInfo]);
    expect(await embyProvider.validate(other.ctx)).toMatchObject({
      ok: false,
      check: 'identity',
      reason: 'not_a_server',
    });
  });

  it('enforces the 4.10 minimum: 4.10.0.0 passes, 4.9.x fails and names the minimum', async () => {
    const at = (version: string): Route => ({
      fixture: 'system_info_public.json',
      mutate: withBody((b) => {
        b.Version = version;
      }),
    });
    expect(await embyProvider.validate(context([at('4.10.0.0'), auth]).ctx)).toMatchObject({
      ok: true,
      version: '4.10.0.0',
    });
    expect(await embyProvider.validate(context([at('4.9.3.0'), auth]).ctx)).toEqual({
      ok: false,
      check: 'version',
      reason: 'version_too_old',
      minimumVersion: '4.10',
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
    expect(await embyProvider.validate(ctx)).toMatchObject({
      ok: false,
      reason: 'admin_status_unknown',
    });
  });

  it('refreshes the token exactly once on a 401, then fails with AUTH', async () => {
    const expired: InlineRoute = {
      method: 'GET',
      url: `/Users/${USER_ID}/Views`,
      status: 401,
    };
    const { ctx, origin } = context([auth, expired], `${USER_ID}:stale`);
    await expect(embyProvider.listLibraries(ctx)).rejects.toMatchObject({ code: 'AUTH' });
    expect(origin.calls.map((c) => `${c.method} ${c.url.pathname}`)).toEqual([
      `GET /Users/${USER_ID}/Views`,
      'POST /Users/AuthenticateByName',
      `GET /Users/${USER_ID}/Views`,
    ]);
  });
});

describe('Emby catalog (spike rows 3, 4; LLD-PROV)', () => {
  it('requests the incremental filter as MinDateLastSaved and People inline', async () => {
    const { ctx, origin } = context([auth, sinceRoute]);
    await embyProvider.listItems(ctx, {
      libraryId: MOVIES,
      pageSize: 10,
      since: Date.parse('2026-10-04T07:03:52.000Z'),
    });
    const q = origin.calls.at(-1)?.url.searchParams;
    expect(q?.get('MinDateLastSaved')).toBe('2026-10-04T07:03:52.000Z');
    expect(q?.get('Fields')).toContain('People');
  });

  it('maps movies with a mixed-case ProviderIds key set, media version and runtime', async () => {
    const { ctx } = context([auth, page0, page2]);
    const first = await embyProvider.listItems(ctx, { libraryId: MOVIES, pageSize: 2 });
    const girlFriday = first.items.find((i) => i.providerItemId === '10');
    expect(girlFriday).toMatchObject({
      type: 'movie',
      title: 'His Girl Friday',
      year: 1940,
      externalIds: { tmdb: '3085', imdb: 'tt0032599' },
    });
    expect(girlFriday?.versions[0]).toMatchObject({
      providerVersionId: 'mediasource_10',
      container: 'mp4',
      videoCodec: 'h264',
    });
  });

  it('maps a TV library: series, season and episodes with their parents', async () => {
    const { ctx } = context([auth, tvAll]);
    const page = await embyProvider.listItems(ctx, { libraryId: SHOWS, pageSize: 50 });
    expect(page.items.map((i) => [i.type, i.providerItemId, i.providerParentId])).toEqual([
      ['series', '26', '6'],
      ['season', '27', '26'],
      ['episode', '28', '27'],
      ['episode', '29', '27'],
    ]);
  });

  it('lists box sets server-wide with their members and the Emby TMDB collection ID', async () => {
    const { ctx, origin } = context([auth, boxsets, boxsetMembers]);
    const page = await embyProvider.listCollections(ctx, { pageSize: 25 });
    expect(page.nextCursor).toBeNull();
    expect(page.collections).toHaveLength(1);
    expect(page.collections[0]).toMatchObject({
      providerCollectionId: '22',
      name: 'Cinewren Spike Horror Collection',
      externalIds: { tmdb: '900001' },
      memberProviderItemIds: ['12', '11'],
    });
    expect(origin.unmatched).toEqual([]);
  });

  it('builds artwork requests on the registered host, with the service token only in a header', () => {
    const none = context([]);
    const bare = embyProvider.getArtworkRequest(
      none.ctx,
      { providerItemId: '10', tag: 't1' },
      'poster',
    );
    expect(bare.url).toBe(`${BASE}/Items/10/Images/Primary?tag=t1`);
    expect(bare.headers.has('authorization')).toBe(false);

    const withToken = context([], `${USER_ID}:svc-token`);
    const req = embyProvider.getArtworkRequest(
      withToken.ctx,
      { providerItemId: '10', tag: 't1' },
      'backdrop',
    );
    expect(req.url).toBe(`${BASE}/Items/10/Images/Backdrop?tag=t1`);
    expect(req.url).not.toContain('svc-token');
    expect(req.headers.get('authorization')).toContain('Token="svc-token"');
  });
});

describe('Emby adapter scope', () => {
  it('uses a pooled DeviceId per stream session (playback: test/playback)', () => {
    expect(embyProvider.streamDevices).toBe('pooled');
  });
});
