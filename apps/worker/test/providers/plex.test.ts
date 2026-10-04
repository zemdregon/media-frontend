// T4.2: the Plex adapter against the T1.1 recordings. The shared contract suite runs first; the
// rest covers Plex-specific behaviour: the admin probe, paging phases, credits, collections,
// artwork, and the playback half behind its `playbackVerified` flag (B-3).
import { describe, expect, it } from 'vitest';
import { createPlexProvider, plexProvider } from '../../src/providers/plex';
import { buildProviderContext } from '../../src/providers/registry';
import type { NegotiatedStream, ProviderContext, ServerSecret } from '../../src/providers/types';
import {
  BASE,
  MOVIES,
  SHOWS,
  TOKEN,
  detailP9,
  happy,
  identity,
  notPlexIdentity,
  oldVersionIdentity,
  prefsAllowed,
  prefsRefused,
  rejectedToken,
  sections,
  sinceRoute,
  unknownItem,
} from './plex-routes';
import { runProviderContract } from './contract';
import {
  createFakeOrigin,
  loadFixture,
  type Fixture,
  type InlineRoute,
  type Route,
} from './fixture-fetch';

runProviderContract({
  name: 'Plex 1.43',
  provider: plexProvider,
  type: 'plex',
  fixtureDir: 'plex',
  baseUrl: BASE,
  secret: { kind: 'token', token: TOKEN },
  happy,
  expected: {
    originServerId: '<PLEX_MACHINE_ID>',
    version: '1.43.4.10903',
    libraries: [
      { providerLibraryId: MOVIES, name: 'Movies', kind: 'movies' },
      { providerLibraryId: SHOWS, name: 'Shows', kind: 'tv' },
    ],
    paged: { libraryId: MOVIES, pageSize: 2, total: 3, pages: 2 },
    since: {
      libraryId: MOVIES,
      since: 1791097146 * 1000,
      routes: [sinceRoute()],
      count: 1,
    },
    item: {
      id: '1',
      title: 'His Girl Friday',
      externalIds: { imdb: 'tt0032599', tmdb: '3085', tvdb: '8213' },
      minCredits: 5,
    },
    unknownItem: { id: 'does-not-exist', routes: [unknownItem] },
  },
  failures: {
    badCredentials: [identity, rejectedToken],
    adminAccount: [identity, sections, prefsAllowed],
    notAServer: [notPlexIdentity],
    versionTooOld: [oldVersionIdentity, sections, prefsRefused],
  },
});

function context(routes: Route[], secret: ServerSecret = { kind: 'token', token: TOKEN }) {
  const origin = createFakeOrigin('plex', routes);
  const ctx = buildProviderContext({
    server: { id: 's1', type: 'plex', baseUrl: new URL(BASE) },
    secret,
    fetchImpl: origin.fetch,
  });
  return { ctx, origin };
}

describe('Plex validation (IR-005, ADR-0008, owner decision 2026-10-04)', () => {
  it('sends the identity request without a token, then the token as a header only', async () => {
    const { ctx, origin } = context(happy);
    await plexProvider.validate(ctx);
    const [first, ...rest] = origin.calls;
    expect(first?.url.pathname).toBe('/identity');
    expect(first?.headers.get('x-plex-token')).toBeNull();
    expect(first?.headers.get('accept')).toBe('application/json');
    for (const call of rest) {
      expect(call.headers.get('x-plex-token')).toBe(TOKEN);
      expect(call.url.search).not.toContain(TOKEN);
    }
  });

  it('refuses a token that is accepted on an admin-only endpoint (owner token)', async () => {
    const { ctx } = context([identity, sections, prefsAllowed]);
    expect(await plexProvider.validate(ctx)).toEqual({
      ok: false,
      check: 'credentials',
      reason: 'admin_account',
    });
  });

  it('refuses when admin status cannot be confirmed (neither 200 nor 401/403)', async () => {
    const unclear: InlineRoute = { method: 'GET', url: '/:/prefs', status: 404 };
    const { ctx } = context([identity, sections, unclear]);
    expect(await plexProvider.validate(ctx)).toEqual({
      ok: false,
      check: 'credentials',
      reason: 'admin_status_unknown',
    });
  });

  it('accepts only a token credential, and sends nothing but the identity request otherwise', async () => {
    const { ctx, origin } = context(happy, { kind: 'password', username: 'u', password: 'p' });
    expect(await plexProvider.validate(ctx)).toEqual({
      ok: false,
      check: 'credentials',
      reason: 'unsupported_credential',
    });
    expect(origin.calls.map((c) => c.url.pathname)).toEqual(['/identity']);
  });

  it('refuses a version below 1.43 with the minimum named', async () => {
    const { ctx } = context([oldVersionIdentity, sections, prefsRefused]);
    expect(await plexProvider.validate(ctx)).toEqual({
      ok: false,
      check: 'version',
      reason: 'version_too_old',
      minimumVersion: '1.43',
    });
  });
});

describe('Plex catalog normalization (FR-SYNC-003, FR-SYNC-008)', () => {
  it('normalizes a movie page: external IDs, versions, timestamps in ms, artwork', async () => {
    const { ctx } = context(happy);
    const page = await plexProvider.listItems(ctx, { libraryId: MOVIES, pageSize: 2 });
    expect(page.nextCursor).toBe('0:2');
    const [hgf] = page.items;
    expect(hgf).toMatchObject({
      providerItemId: '1',
      type: 'movie',
      title: 'His Girl Friday',
      year: 1940,
      genres: ['Comedy', 'Drama'],
      externalIds: { imdb: 'tt0032599', tmdb: '3085', tvdb: '8213' },
      runtimeMs: 12000,
      providerUpdatedAt: 1791097146 * 1000,
      dateAdded: 1791096320 * 1000,
      artwork: {
        poster: { providerItemId: '1', tag: '1791097146' },
        backdrop: { providerItemId: '1', tag: '1791097146' },
      },
    });
    expect(hgf?.versions[0]).toMatchObject({
      providerVersionId: '1',
      container: 'mp4',
      videoCodec: 'h264',
      width: 1280,
      height: 720,
      hdr: 'none',
      bitrate: 140_000,
      sizeBytes: 209804,
    });
  });

  it('applies the incremental filter as updatedAt> in Unix seconds', async () => {
    const { ctx, origin } = context([sinceRoute()]);
    await plexProvider.listItems(ctx, { libraryId: MOVIES, pageSize: 50, since: 1791097146_999 });
    expect(origin.calls[0]?.url.searchParams.get('updatedAt>')).toBe('1791097146');
  });

  it('keeps a person local when the list response has no tagKey, and global when it has', async () => {
    const { ctx } = context(happy);
    const listed = (await plexProvider.listItems(ctx, { libraryId: MOVIES, pageSize: 2 })).items[0];
    expect(listed?.credits[0]?.person.providerPersonId).toBe('name:Cary Grant');

    const full = await plexProvider.getItem(ctx, '1');
    const walter = full?.credits.find((c) => c.person.name === 'Cary Grant');
    expect(walter).toMatchObject({
      role: 'actor',
      character: 'Walter Burns',
      person: { providerPersonId: '5d7768254de0ee001fcc84ba', externalIds: {} },
    });
    const director = full?.credits.find((c) => c.role === 'director');
    expect(director?.person).toMatchObject({
      name: 'Howard Hawks',
      providerPersonId: '5d776826151a60001f24a77e',
    });
    expect(full?.credits.some((c) => c.role === 'writer')).toBe(true);
    expect(full?.credits.some((c) => c.role === 'producer')).toBe(true);
    expect(full?.credits.length).toBeLessThanOrEqual(40);
    expect(full?.credits.map((c) => c.order)).toEqual(full?.credits.map((_, i) => i));
  });

  it('reads audio and subtitle tracks by stream ID, marking sidecars external', async () => {
    const { ctx } = context([detailP9]);
    const item = await plexProvider.getItem(ctx, '3');
    const version = item?.versions[0];
    expect(version).toMatchObject({ videoCodec: 'hevc', container: 'mkv' });
    expect(version?.audio).toEqual([
      {
        index: 44,
        codec: 'aac',
        language: 'en',
        channels: 1,
        title: 'English (AAC Mono)',
        isDefault: true,
      },
    ]);
    expect(version?.subtitles.map((s) => [s.index, s.kind, s.isExternal])).toEqual([
      [45, 'text', false],
      [46, 'text', true],
    ]);
  });

  it('lists a show section as shows, then seasons, then episodes through one cursor chain', async () => {
    const emptyShows: InlineRoute = {
      method: 'GET',
      url: `/library/sections/${SHOWS}/all?includeGuids=1&X-Plex-Container-Start=0&X-Plex-Container-Size=50`,
      status: 200,
      body: {
        MediaContainer: { size: 0, totalSize: 0, offset: 0, viewGroup: 'show', Metadata: [] },
      },
    };
    const emptySeasons: InlineRoute = {
      method: 'GET',
      url: `/library/sections/${SHOWS}/all?includeGuids=1&type=3&X-Plex-Container-Start=0&X-Plex-Container-Size=50`,
      status: 200,
      body: {
        MediaContainer: { size: 0, totalSize: 0, offset: 0, viewGroup: 'season', Metadata: [] },
      },
    };
    const episodes: Route = {
      fixture: 'items_tv_episodes.json',
      mutate: (f: Fixture) => {
        f.request.path += '&X-Plex-Container-Start=0&X-Plex-Container-Size=50';
        return f;
      },
    };
    const { ctx } = context([emptyShows, emptySeasons, episodes]);
    const cursors: (string | null)[] = [];
    let cursor: string | undefined;
    const seen: string[] = [];
    do {
      const page = await plexProvider.listItems(ctx, {
        libraryId: SHOWS,
        pageSize: 50,
        ...(cursor === undefined ? {} : { cursor }),
      });
      cursors.push(page.nextCursor);
      seen.push(...page.items.map((i) => `${i.type}:${i.providerItemId}`));
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined);
    expect(cursors).toEqual(['1:0', '2:0', null]);
    expect(seen).toEqual(['episode:17', 'episode:18']);
    const { ctx: ctx2 } = context([emptyShows, emptySeasons, episodes]);
    const episode = (
      await plexProvider.listItems(ctx2, { libraryId: SHOWS, pageSize: 50, cursor: '2:0' })
    ).items[0];
    expect(episode).toMatchObject({
      type: 'episode',
      providerParentId: '16',
      seasonNumber: 1,
      episodeNumber: 1,
      externalIds: { imdb: 'tt0565972', tmdb: '260236', tvdb: '95535' },
    });
    // The episode's `art` belongs to its show, so only its own image is referenced.
    expect(episode?.artwork.backdrop).toBeUndefined();
    expect(episode?.artwork.poster).toEqual({ providerItemId: '17', tag: '1791097150' });
  });

  it('lists collections with their members and no invented external ID', async () => {
    const noShowCollections: InlineRoute = {
      method: 'GET',
      url: `/library/sections/${SHOWS}/collections?includeGuids=1`,
      status: 200,
      body: { MediaContainer: { size: 0 } },
    };
    const { ctx } = context([
      sections,
      { fixture: 'collections.json' },
      { fixture: 'collection_children.json' },
      noShowCollections,
    ]);
    const out = await plexProvider.listCollections(ctx, { pageSize: 10 });
    expect(out.nextCursor).toBeNull();
    expect(out.collections).toEqual([
      {
        providerCollectionId: '20',
        name: 'Cinewren Spike Horror Collection',
        externalIds: {},
        artwork: {},
        memberProviderItemIds: ['3', '2'],
        providerUpdatedAt: 1791097650 * 1000,
      },
    ]);
  });
});

describe('Plex artwork (FR-CAT-009)', () => {
  it('builds an on-host image request with the token in a header, not the URL', () => {
    const { ctx } = context([]);
    const req = plexProvider.getArtworkRequest(
      ctx,
      { providerItemId: '1', tag: '1791097146' },
      'poster',
    );
    expect(req.url).toBe(`${BASE}/library/metadata/1/thumb/1791097146`);
    expect(req.headers.get('x-plex-token')).toBe(TOKEN);
    expect(
      plexProvider.getArtworkRequest(ctx, { providerItemId: '1', tag: '5' }, 'backdrop').url,
    ).toBe(`${BASE}/library/metadata/1/art/5`);
  });
});

// --- playback half (B-3): unverified in the shipped provider, tested with the flag on ---

const verified = createPlexProvider({ playbackVerified: true });

describe('Plex playback is gated until B-3 verifies the managed-user token model', () => {
  it('ships unverified, and refuses to issue a credential or negotiate', async () => {
    expect(plexProvider.playbackVerified).toBe(false);
    const { ctx, origin } = context([]);
    await expect(plexProvider.createSessionCredential(ctx, 'sess')).rejects.toMatchObject({
      code: 'UNSUPPORTED',
    });
    await expect(
      plexProvider.negotiatePlayback(ctx, {
        providerItemId: '1',
        providerVersionId: '1',
        caps: caps(),
        cred: { kind: 'shared_restricted', token: TOKEN },
      }),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED' });
    expect(origin.calls).toHaveLength(0);
  });

  it('issues the managed user token as shared_restricted after re-checking it is not admin', async () => {
    const { ctx, origin } = context([prefsRefused]);
    const cred = await verified.createSessionCredential(ctx, 'sess');
    expect(cred).toEqual({
      kind: 'shared_restricted',
      token: TOKEN,
      deviceId: 'cinewren-svc-main',
    });
    expect(origin.calls.map((c) => c.url.pathname)).toEqual(['/:/prefs']);
    await expect(verified.revokeSessionCredential(ctx, cred)).resolves.toBeUndefined();
  });

  it('never issues a token that has gained admin rights, nor an unconfirmed one', async () => {
    for (const prefs of [
      prefsAllowed,
      { method: 'GET', url: '/:/prefs', status: 500 } as InlineRoute,
    ]) {
      const { ctx } = context([prefs]);
      await expect(verified.createSessionCredential(ctx, 'sess')).rejects.toMatchObject({
        code: 'AUTH',
      });
    }
  });

  it('refuses a password credential', async () => {
    const { ctx } = context([], { kind: 'password', username: 'u', password: 'p' });
    await expect(verified.createSessionCredential(ctx, 'sess')).rejects.toMatchObject({
      code: 'UNSUPPORTED',
    });
  });
});

function caps() {
  return {
    containers: ['mp4', 'webm'],
    video: [{ codec: 'h264' }, { codec: 'vp9' }],
    audio: ['aac', 'mp3'],
    maxWidth: 1920,
    maxHeight: 1080,
    hdr: [],
    textSubtitles: ['vtt'],
    nativeHls: false,
    mse: true,
  };
}

/** A fetch double: the recorded metadata and decision bodies, and a log of what was asked. */
function playbackContext(decide?: (decision: Fixture) => Fixture) {
  const calls: URL[] = [];
  const headers: Headers[] = [];
  const decision = decide
    ? decide(structuredClone(loadFixture('plex', 'transcode_decision_hevc.json')))
    : loadFixture('plex', 'transcode_decision_hevc.json');
  const meta = loadFixture('plex', 'metadata_p9.json');
  const fetchImpl = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    calls.push(url);
    headers.push(new Headers(init?.headers));
    const body = url.pathname.startsWith('/library/metadata/')
      ? meta.response.body
      : url.pathname === '/video/:/transcode/universal/decision'
        ? decision.response.body
        : {};
    return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
  }) as typeof fetch;
  const ctx: ProviderContext = buildProviderContext({
    server: { id: 's1', type: 'plex', baseUrl: new URL(BASE) },
    secret: { kind: 'token', token: TOKEN },
    fetchImpl,
  });
  return { ctx, calls, headers };
}

const cred = { kind: 'shared_restricted', token: TOKEN } as const;

describe('Plex negotiation (FR-PLAY-001, spike 5a)', () => {
  it('turns the recorded HEVC decision into a token-carrying HLS transcode on the origin host', async () => {
    const { ctx, calls } = playbackContext();
    const stream = await verified.negotiatePlayback(ctx, {
      providerItemId: '3',
      providerVersionId: '3',
      caps: caps(),
      cred,
      startPositionMs: 65_000,
    });
    expect(stream).toMatchObject({ mode: 'transcode', streamType: 'hls', subtitleUrls: {} });
    const url = new URL(stream.url);
    expect(url.host).toBe(new URL(BASE).host);
    expect(url.pathname).toBe('/video/:/transcode/universal/start.m3u8');
    expect(url.searchParams.get('X-Plex-Token')).toBe(TOKEN);
    expect(url.searchParams.get('path')).toBe('/library/metadata/3');
    expect(url.searchParams.get('directPlay')).toBe('0');
    expect(url.searchParams.get('offset')).toBe('65');
    expect(url.searchParams.get('X-Plex-Client-Profile-Extra')).toContain(
      'add-direct-play-profile(type=videoProfile&container=mp4&videoCodec=h264,vp9&audioCodec=aac,mp3)',
    );
    // The reference names the item and session but holds no credential.
    expect(stream.providerSessionRef).toMatch(/^3\|12023\|cinewren-[0-9a-f-]+\|1$/);
    expect(stream.providerSessionRef).not.toContain(TOKEN);
    expect(calls.map((c) => c.pathname)).toEqual([
      '/library/metadata/3',
      '/video/:/transcode/universal/decision',
    ]);
  });

  it('is a direct stream when only audio needs conversion, and direct play when the origin allows', async () => {
    const copy = playbackContext((f) => {
      const [video] = partOf(f).Stream as Record<string, unknown>[];
      if (video) video.decision = 'copy';
      return f;
    });
    const remux = await verified.negotiatePlayback(copy.ctx, {
      providerItemId: '3',
      providerVersionId: '3',
      caps: caps(),
      cred,
    });
    expect(remux.mode).toBe('direct_stream');

    const direct = playbackContext((f) => {
      partOf(f).decision = 'directplay';
      return f;
    });
    const stream = await verified.negotiatePlayback(direct.ctx, {
      providerItemId: '3',
      providerVersionId: '3',
      caps: caps(),
      cred,
    });
    expect(stream.mode).toBe('direct_play');
    expect(stream.streamType).toBe('progressive');
    expect(stream.url).toBe(`${BASE}/library/parts/3/1791096331/file.mkv?X-Plex-Token=${TOKEN}`);
  });

  it('burns in an image subtitle and refuses an unknown version', async () => {
    const { ctx, calls } = playbackContext();
    await verified.negotiatePlayback(ctx, {
      providerItemId: '3',
      providerVersionId: '3',
      caps: caps(),
      cred,
      audioIndex: 44,
      subtitle: { index: 45, kind: 'image' },
    });
    const decisionUrl = calls[1] ?? new URL(BASE);
    expect(decisionUrl.searchParams.get('subtitles')).toBe('burn');
    expect(decisionUrl.searchParams.get('subtitleStreamID')).toBe('45');
    expect(decisionUrl.searchParams.get('audioStreamID')).toBe('44');
    await expect(
      verified.negotiatePlayback(playbackContext().ctx, {
        providerItemId: '3',
        providerVersionId: '999',
        caps: caps(),
        cred,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

function partOf(f: Fixture): Record<string, unknown> {
  const mc = (f.response.body as { MediaContainer: { Metadata: Record<string, unknown>[] } })
    .MediaContainer;
  const part = (
    ((mc.Metadata[0]?.Media as Record<string, unknown>[] | undefined)?.[0]?.Part ?? []) as Record<
      string,
      unknown
    >[]
  )[0];
  if (!part) throw new Error('fixture has no part');
  return part;
}

describe('Plex telemetry (FR-PLAY-009, spike 7)', () => {
  const stream = (hls: boolean): NegotiatedStream => ({
    mode: hls ? 'transcode' : 'direct_play',
    streamType: hls ? 'hls' : 'progressive',
    url: '',
    subtitleUrls: {},
    providerSessionRef: `1|12000|cinewren-tl|${hls ? 1 : 0}`,
  });
  const clientId = { 'X-Plex-Client-Identifier': 'cinewren-svc-main' };

  it('reports playing and stopped through /:/timeline with the token in a header', async () => {
    const { ctx, origin } = context([
      { fixture: 'timeline_playing_5000.json', overrideParams: clientId },
      { fixture: 'timeline_stopped_6000.json', overrideParams: clientId },
    ]);
    await plexProvider.reportPlayback(ctx, cred, {
      type: 'progress',
      positionMs: 5000,
      stream: stream(false),
    });
    await plexProvider.reportPlayback(ctx, cred, {
      type: 'stop',
      positionMs: 6000,
      stream: stream(false),
    });
    expect(origin.unmatched).toEqual([]);
    expect(origin.calls).toHaveLength(2);
    expect(origin.calls[0]?.headers.get('x-plex-token')).toBe(TOKEN);
    expect(origin.calls[0]?.headers.get('x-plex-session-identifier')).toBe('cinewren-tl');
    expect(origin.calls[0]?.url.search).not.toContain(TOKEN);
  });

  it('ends the HLS transcode on stop, after the stopped timeline (spike: segments are anonymous)', async () => {
    const stopRoute: InlineRoute = {
      method: 'GET',
      url: '/video/:/transcode/universal/stop?session=cinewren-tl',
      status: 200,
    };
    const { ctx, origin } = context([
      { fixture: 'timeline_stopped_6000.json', overrideParams: clientId },
      stopRoute,
    ]);
    await plexProvider.reportPlayback(ctx, cred, {
      type: 'stop',
      positionMs: 6000,
      stream: stream(true),
    });
    expect(origin.calls.map((c) => c.url.pathname)).toEqual([
      '/:/timeline',
      '/video/:/transcode/universal/stop',
    ]);
  });

  it('rejects an event with no session reference', async () => {
    const { ctx } = context([]);
    await expect(
      plexProvider.reportPlayback(ctx, cred, {
        type: 'start',
        positionMs: 0,
        stream: { mode: 'transcode', streamType: 'hls', url: '', subtitleUrls: {} },
      }),
    ).rejects.toMatchObject({ code: 'PROTOCOL' });
  });
});
