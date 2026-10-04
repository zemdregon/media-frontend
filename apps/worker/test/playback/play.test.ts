// T3.2, T3.3, T3.5 and T3.6 (Worker side): the play endpoint, session lifecycle, progress, the
// copy table and the compliance checks, end to end through the API against stateful mock
// origins (FR-PLAY-001 to FR-PLAY-010, FR-PROG-001 to FR-PROG-004, FR-CAT-008, FR-CAT-013,
// BR-1, BR-5, BR-7, BR-9, NFR-SEC-001, NFR-SEC-002, NFR-COMP-001; ADR-0013).
//
// M3 exit check (b): "after the session ends, the mock origin rejects the stream credential" is
// covered for stop, unstarted expiry, idle expiry and replacement below.
import { must } from './util';
import type {
  ContinueWatchingCard,
  HomeResponse,
  ItemDetailWithCopies,
  PlaybackDescriptor,
  PlayRequest,
} from '@cinewren/shared';
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/api/app';
import { createPlaybackDeps } from '../../src/playback/deps';
import { sweepPlaybackSessions } from '../../src/playback/lifecycle';
import { encrypt, loadKeyring } from '../../src/vault/vault';
import { call, errorCode, json } from '../auth-harness';
import { resetAll, seedLibrary, seedUser, T0 } from '../catalog-seed';
import { MockOrigin, multiOriginFetch } from './mock-origin';

const db = env.DB;
const JF_HOST = 'jf.example.test';
const EMBY_HOST = 'emby.example.test';
const HOURS2 = 7_200_000;

type U = { id: string; cookie: string };
let op: U;
let alice: U;
let bob: U;
let jf: MockOrigin;
let emby: MockOrigin;
let app: ReturnType<typeof createApp>;
const descriptors: { d: PlaybackDescriptor; host: string }[] = [];

async function seedServer(id: string, type: 'jellyfin' | 'emby', host: string, status = 'active') {
  await db
    .prepare(
      `INSERT INTO servers (id, type, name, base_url, origin_server_id, priority, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)`,
    )
    .bind(id, type, `Server ${id}`, `https://${host}`, `origin-${id}`, status, T0, T0)
    .run();
  const sealed = await encrypt(
    await loadKeyring(env),
    'server_secret',
    id,
    JSON.stringify({ kind: 'password', username: 'cinewren-svc', password: 'pw-secret-value' }),
  );
  await db
    .prepare(
      'INSERT INTO server_credentials (server_id, key_version, secret_envelope, updated_at) VALUES (?, ?, ?, ?)',
    )
    .bind(id, sealed.keyVersion, sealed.envelope, T0)
    .run();
}

interface V {
  height: number;
  container?: string;
}

async function seedItem(i: {
  id: string;
  type?: 'movie' | 'series' | 'season' | 'episode';
  parent?: string;
  season?: number;
  episode?: number;
  runtimeMs?: number;
  sources: { server: string; library: string; v?: V }[];
}) {
  const type = i.type ?? 'movie';
  const stmts = [
    db
      .prepare(
        `INSERT INTO media_items (id, type, parent_id, title, sort_title, runtime_ms, season_number,
           episode_number, metadata_source_id, date_added, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        i.id,
        type,
        i.parent ?? null,
        `Title ${i.id}`,
        i.id,
        i.runtimeMs ?? null,
        i.season ?? null,
        i.episode ?? null,
        i.sources[0] ? `src-${i.id}-${i.sources[0].server}` : null,
        T0,
        T0,
        T0,
      ),
  ];
  for (const s of i.sources) {
    const sid = `src-${i.id}-${s.server}`;
    stmts.push(
      db
        .prepare(
          `INSERT INTO sources (id, server_id, library_id, provider_item_id, media_item_id, item_type, title,
             match_method, content_hash, status, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'new', 'h', 'present', ?)`,
        )
        .bind(sid, s.server, s.library, `prov-${i.id}-${s.server}`, i.id, type, i.id, T0),
      db
        .prepare(
          'INSERT OR IGNORE INTO item_availability (media_item_id, library_id) VALUES (?, ?)',
        )
        .bind(i.id, s.library),
    );
    if (s.v) {
      stmts.push(
        db
          .prepare(
            `INSERT INTO media_versions (id, source_id, provider_version_id, container, video_codec, width,
               height, hdr, runtime_ms, size_bytes, audio_tracks, subtitle_tracks)
             VALUES (?, ?, ?, ?, 'h264', ?, ?, 'none', ?, 1000, ?, ?)`,
          )
          .bind(
            `ver-${sid}`,
            sid,
            `pv-${i.id}-${s.server}`,
            s.v.container ?? 'mkv',
            Math.round((s.v.height * 16) / 9),
            s.v.height,
            i.runtimeMs ?? null,
            JSON.stringify([
              { index: 1, codec: 'aac', channels: 2, language: 'eng', title: null, default: true },
            ]),
            JSON.stringify([
              {
                index: 2,
                format: 'subrip',
                kind: 'text',
                language: 'eng',
                title: 'English',
                forced: false,
                default: false,
              },
            ]),
          ),
      );
    }
  }
  await db.batch(stmts);
}

beforeEach(async () => {
  await resetAll();
  await db.batch(
    [
      'DELETE FROM watch_progress',
      'DELETE FROM playback_sessions',
      'DELETE FROM stream_device_leases',
    ].map((s) => db.prepare(s)),
  );
  jf = new MockOrigin({ flavor: 'jellyfin', host: JF_HOST });
  emby = new MockOrigin({ flavor: 'emby', host: EMBY_HOST });
  app = createApp({ originFetch: multiOriginFetch([jf, emby]) });
  await seedServer('jf', 'jellyfin', JF_HOST);
  await seedServer('emby', 'emby', EMBY_HOST);
  await seedLibrary({ id: 'Ljf', serverId: 'jf' });
  await seedLibrary({ id: 'Lsecret', serverId: 'jf' });
  await seedLibrary({ id: 'Lemby', serverId: 'emby' });
  await seedLibrary({ id: 'Ltv', serverId: 'jf', kind: 'tv' });
  await seedItem({
    id: 'm-heat',
    runtimeMs: HOURS2,
    sources: [
      { server: 'jf', library: 'Ljf', v: { height: 1080 } },
      { server: 'emby', library: 'Lemby', v: { height: 720 } },
    ],
  });
  await seedItem({
    id: 'm-hidden',
    runtimeMs: HOURS2,
    sources: [{ server: 'jf', library: 'Lsecret', v: { height: 1080 } }],
  });
  await seedItem({ id: 's-show', type: 'series', sources: [{ server: 'jf', library: 'Ltv' }] });
  await seedItem({
    id: 'se-1',
    type: 'season',
    parent: 's-show',
    season: 1,
    sources: [{ server: 'jf', library: 'Ltv' }],
  });
  for (const n of [1, 2, 3]) {
    await seedItem({
      id: `ep-${n}`,
      type: 'episode',
      parent: 'se-1',
      season: 1,
      episode: n,
      runtimeMs: 40 * 60_000,
      sources: [{ server: 'jf', library: 'Ltv', v: { height: 1080 } }],
    });
  }
  op = await seedUser('op', 'operator');
  alice = await seedUser('alice', 'viewer', ['Ljf', 'Lemby', 'Ltv']);
  bob = await seedUser('bob', 'viewer');
});

const CHROME = {
  containers: ['mp4', 'webm'],
  video: [{ codec: 'h264' }, { codec: 'vp9' }],
  audio: ['aac', 'opus'],
  maxHeight: 1080,
  hdr: [],
  textSubtitles: ['vtt'],
  nativeHls: false,
  mse: true,
};

let keySeq = 0;
function playReq(u: U, body: Partial<PlayRequest> & { itemId: string }, key?: string) {
  return call('POST', '/api/v1/play', {
    app,
    cookie: u.cookie,
    body: { capabilities: CHROME, ...body },
    headers: { 'idempotency-key': key ?? `key-${++keySeq}-play` },
  });
}

async function playOk(u: U, body: Partial<PlayRequest> & { itemId: string }) {
  const res = await playReq(u, body);
  expect(res.status, await res.clone().text()).toBe(201);
  const d = await json<PlaybackDescriptor>(res);
  descriptors.push({ d, host: d.source.serverName === 'Server emby' ? EMBY_HOST : JF_HOST });
  return d;
}

function event(u: U, sessionId: string, body: Record<string, unknown>) {
  return call('POST', `/api/v1/play/${sessionId}/events`, { app, cookie: u.cookie, body });
}

const browserGet = (url: string) => multiOriginFetch([jf, emby])(url);

async function session(id: string) {
  return db
    .prepare(
      'SELECT status, credential_envelope, revoke_pending, end_reason, mode FROM playback_sessions WHERE id = ?',
    )
    .bind(id)
    .first<{
      status: string;
      credential_envelope: string | null;
      revoke_pending: number;
      end_reason: string | null;
      mode: string;
    }>();
}

function sweepAt(offsetMs: number) {
  return sweepPlaybackSessions(
    createPlaybackDeps(env, {
      fetchImpl: multiOriginFetch([jf, emby]),
      now: () => Date.now() + offsetMs,
    }),
  );
}

describe('POST /play: the descriptor (FR-PLAY-001, LLD-API)', () => {
  it('selects the Jellyfin copy, mints a per-session token and returns a token-gated HLS descriptor', async () => {
    const before = Date.now();
    const d = await playOk(alice, { itemId: 'm-heat' });
    expect(d.sessionId).toMatch(/^[0-9A-Z]{26}$/);
    expect(d.expiresAt).toBeGreaterThanOrEqual(before + 300_000);
    expect(d.expiresAt).toBeLessThan(Date.now() + 301_000);
    expect(d.item).toEqual({ id: 'm-heat', title: 'Title m-heat', runtimeMs: HOURS2 });
    expect(d.source).toMatchObject({ id: 'src-m-heat-jf', versionId: 'ver-src-m-heat-jf' });
    expect(d.source.label).toBe('1080p · H.264');
    expect(d.mode).toBe('direct_stream'); // Jellyfin: never direct_play (ADR-0013)
    expect(d.streamType).toBe('hls');
    const url = new URL(d.streamUrl);
    expect(url.host).toBe(JF_HOST);
    expect(url.searchParams.get('static')).toBeNull();
    const token = url.searchParams.get('ApiKey');
    expect(token).toBeTruthy();
    expect(jf.liveTokens()).toEqual([token]);
    // The token was minted under a DeviceId unique to this session.
    expect(jf.tokens.get(must(token))?.deviceId).toBe(`cinewren-ps-${d.sessionId}`);
    expect(d.audioTracks).toEqual([
      {
        index: 1,
        label: 'eng stereo (AAC)',
        language: 'eng',
        codec: 'aac',
        channels: 2,
        selected: true,
      },
    ]);
    expect(d.subtitleTracks).toHaveLength(1);
    expect(new URL(must(d.subtitleTracks[0]?.url)).host).toBe(JF_HOST);
    expect(d.subtitleTracks[0]).toMatchObject({ index: 2, kind: 'text', selected: false });
    expect(d.reasons).toEqual(['direct_stream_container', 'highest_playable_resolution']);
    expect(d.alternatives).toBe(1);
    expect(d.resume).toBeNull();
    expect((await browserGet(d.streamUrl)).status).toBe(200);
  });

  it('stores the session authorized with the credential sealed (never in clear, NFR-SEC-001)', async () => {
    const d = await playOk(alice, { itemId: 'm-heat' });
    const row = await session(d.sessionId);
    expect(row?.status).toBe('authorized');
    expect(row?.credential_envelope).toMatch(/^cw1\./);
    const token = new URL(d.streamUrl).searchParams.get('ApiKey') ?? '';
    const raw =
      JSON.stringify(await db.prepare('SELECT * FROM playback_sessions').all()) +
      JSON.stringify(await db.prepare('SELECT * FROM idempotency_keys').all());
    expect(raw).not.toContain(token);
    expect(raw).not.toContain('pw-secret-value');
  });

  it('offers resume from the stored position (FR-PROG-002, BR-7)', async () => {
    await call('PUT', '/api/v1/progress/m-heat', {
      app,
      cookie: alice.cookie,
      body: { positionMs: 125_000 },
    });
    const d = await playOk(alice, { itemId: 'm-heat' });
    expect(d.resume).toEqual({ positionMs: 125_000 });
    // A start event before the player seeks does not wipe the stored position.
    await event(alice, d.sessionId, { seq: 1, type: 'start', positionMs: 0 });
    const again = await playOk(alice, { itemId: 'm-heat' });
    expect(again.resume).toEqual({ positionMs: 125_000 });
  });

  it('requires an Idempotency-Key, replays the same descriptor and refuses a reused key', async () => {
    const noKey = await call('POST', '/api/v1/play', {
      app,
      cookie: alice.cookie,
      body: { itemId: 'm-heat', capabilities: CHROME },
    });
    expect(noKey.status).toBe(400);
    expect(await errorCode(noKey)).toBe('VALIDATION_FAILED');

    const first = await playReq(alice, { itemId: 'm-heat' }, 'retry-key-0001');
    expect(first.status).toBe(201);
    const auths = jf.calls.filter((c) => c.path === '/Users/AuthenticateByName').length;
    const again = await playReq(alice, { itemId: 'm-heat' }, 'retry-key-0001');
    expect(again.status).toBe(201);
    expect(await again.json()).toEqual(await first.json());
    // No second origin credential.
    expect(jf.calls.filter((c) => c.path === '/Users/AuthenticateByName').length).toBe(auths);

    const other = await playReq(
      alice,
      { itemId: 'm-heat', excludeSourceIds: ['x'] },
      'retry-key-0001',
    );
    expect(other.status).toBe(422);
    expect(await errorCode(other)).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('plays a series as its next episode (LLD-SEL nextEpisode)', async () => {
    const d1 = await playOk(alice, { itemId: 's-show' });
    expect(d1.item.id).toBe('ep-1');
    await call('PUT', '/api/v1/progress/ep-1', {
      app,
      cookie: alice.cookie,
      body: { watched: true },
    });
    const d2 = await playOk(alice, { itemId: 's-show' });
    expect(d2.item.id).toBe('ep-2');
  });
});

describe('BR-1 before anything (NFR-SEC-002): play cannot reach a library the caller was not granted', () => {
  it('answers 404 exactly like an unknown ID, and the origin is never contacted', async () => {
    const unknown = await playReq(alice, { itemId: 'does-not-exist' });
    expect(unknown.status).toBe(404);
    const ref = await json<{ error: { code: string; message: string } }>(unknown);
    for (const [u, item] of [
      [bob, 'm-heat'],
      [alice, 'm-hidden'],
      [bob, 's-show'],
      [bob, 'ep-1'],
    ] as const) {
      const res = await playReq(u, { itemId: item });
      expect(res.status, `${u.id} ${item}`).toBe(404);
      const body = await json<{ error: { code: string; message: string } }>(res);
      expect(body.error).toMatchObject({ code: ref.error.code, message: ref.error.message });
    }
    expect(jf.calls).toEqual([]);
    expect(emby.calls).toEqual([]);
  });

  it('a manual choice of a hidden source on a visible title is 404, not a stream', async () => {
    const res = await playReq(alice, {
      itemId: 'm-heat',
      preferences: { subtitle: { mode: 'off' }, sourceId: 'src-m-hidden-jf' },
    });
    expect(res.status).toBe(404);
    expect(jf.calls).toEqual([]);
  });

  it('operators see every enabled library (FR-USR-005)', async () => {
    const d = await playOk(op, { itemId: 'm-hidden' });
    expect(new URL(d.streamUrl).host).toBe(JF_HOST);
  });

  it("another user's session is 404 for events", async () => {
    const d = await playOk(alice, { itemId: 'm-heat' });
    const res = await event(bob, d.sessionId, { seq: 1, type: 'start', positionMs: 0 });
    expect(res.status).toBe(404);
    expect((await session(d.sessionId))?.status).toBe('authorized');
  });

  it('every play route needs a session', async () => {
    for (const [method, path] of [
      ['POST', '/api/v1/play'],
      ['POST', '/api/v1/play/x/events'],
      ['PUT', '/api/v1/progress/m-heat'],
      ['GET', '/api/v1/items/s-show/next-episode'],
    ] as const) {
      const res = await call(method, path, { app, body: method === 'GET' ? undefined : {} });
      expect(res.status, path).toBe(401);
    }
  });
});

describe('selection, failover and manual choice (BR-5, FR-PLAY-004, FR-PLAY-005)', () => {
  it('fails over to the next candidate when the selected origin is down, and revokes the failed attempt', async () => {
    jf.failItems.add('prov-m-heat-jf');
    const d = await playOk(alice, { itemId: 'm-heat' });
    expect(d.source.id).toBe('src-m-heat-emby');
    expect(new URL(d.streamUrl).host).toBe(EMBY_HOST);
    expect(d.reasons).toContain('failover');
    // The Jellyfin attempt left no live credential and a failed session.
    expect(jf.liveTokens()).toEqual([]);
    const failed = await db
      .prepare(
        "SELECT status, end_reason, credential_envelope FROM playback_sessions WHERE server_id = 'jf'",
      )
      .first<{ status: string; end_reason: string; credential_envelope: string | null }>();
    expect(failed).toEqual({
      status: 'failed',
      end_reason: 'negotiation_failed',
      credential_envelope: null,
    });
  });

  it('a replacement request excluding the failed source returns the next one, or NO_PLAYABLE_SOURCE', async () => {
    const first = await playOk(alice, { itemId: 'm-heat' });
    const next = await playOk(alice, {
      itemId: 'm-heat',
      excludeSourceIds: [first.source.id],
      replacesSessionId: first.sessionId,
    });
    expect(next.source.id).toBe('src-m-heat-emby');
    expect(next.reasons).toContain('failover');
    // The replaced session ended and its credential is dead at the origin (exit check b).
    expect((await session(first.sessionId))?.status).toBe('ended');
    expect((await browserGet(first.streamUrl)).status).toBe(401);

    const none = await playReq(alice, {
      itemId: 'm-heat',
      excludeSourceIds: ['src-m-heat-jf', 'src-m-heat-emby'],
    });
    expect(none.status).toBe(409);
    const body = await json<{ error: { code: string; details: { reason: string } } }>(none);
    expect(body.error.code).toBe('NO_PLAYABLE_SOURCE');
    expect(body.error.details.reason).toBe('none_available');
  });

  it('reports servers_unreachable when only unreachable servers hold the title', async () => {
    await db.prepare("UPDATE servers SET status = 'unreachable'").run();
    const res = await playReq(alice, { itemId: 'm-heat' });
    expect(res.status).toBe(409);
    expect((await json<{ error: { details: { reason: string } } }>(res)).error.details.reason).toBe(
      'servers_unreachable',
    );
    expect(jf.calls).toEqual([]);
  });

  it('a manual version choice plays exactly that version (user_selected)', async () => {
    const d = await playOk(alice, {
      itemId: 'm-heat',
      preferences: { subtitle: { mode: 'off' }, versionId: 'ver-src-m-heat-emby' },
    });
    expect(d.source.versionId).toBe('ver-src-m-heat-emby');
    expect(d.reasons).toContain('user_selected');
  });

  it('a stream URL on another host is refused (FR-PLAY-008) and the attempt revoked', async () => {
    const evil = multiOriginFetch([jf, emby]);
    const rewriting: typeof fetch = async (input, init) => {
      const res = await evil(input, init);
      const url = new URL(input instanceof Request ? input.url : input);
      if (!url.pathname.endsWith('/PlaybackInfo')) return res;
      const body = await res.json<{ MediaSources: { TranscodingUrl: string }[] }>();
      must(body.MediaSources[0]).TranscodingUrl = 'https://evil.example.net/videos/x/master.m3u8';
      return new Response(JSON.stringify(body), { status: 200 });
    };
    const evilApp = createApp({ originFetch: rewriting });
    const res = await call('POST', '/api/v1/play', {
      app: evilApp,
      cookie: alice.cookie,
      body: {
        itemId: 'm-heat',
        capabilities: CHROME,
        preferences: { subtitle: { mode: 'off' }, sourceId: 'src-m-heat-jf' },
      },
      headers: { 'idempotency-key': 'evil-key-0001' },
    });
    expect(res.status).toBe(502);
    expect(await errorCode(res)).toBe('ORIGIN_PROTOCOL');
    expect(jf.liveTokens()).toEqual([]);
  });
});

describe('session lifecycle (BR-9, FR-PLAY-009, LLD-TOKEN)', () => {
  it('start, progress, stop: telemetry to the origin, then stop is reported before the logout', async () => {
    const d = await playOk(alice, { itemId: 'm-heat' });
    expect((await event(alice, d.sessionId, { seq: 1, type: 'start', positionMs: 0 })).status).toBe(
      204,
    );
    expect((await session(d.sessionId))?.status).toBe('started');
    expect(
      (await event(alice, d.sessionId, { seq: 2, type: 'progress', positionMs: 120_000 })).status,
    ).toBe(204);
    // A duplicate or out-of-order event is acknowledged and ignored.
    expect(
      (await event(alice, d.sessionId, { seq: 2, type: 'progress', positionMs: 999_000 })).status,
    ).toBe(204);
    expect(
      (await event(alice, d.sessionId, { seq: 3, type: 'pause', positionMs: 130_000 })).status,
    ).toBe(204);
    const wp = await db
      .prepare(
        "SELECT position_ms, watched FROM watch_progress WHERE user_id = 'alice' AND media_item_id = 'm-heat'",
      )
      .first();
    expect(wp).toEqual({ position_ms: 130_000, watched: 0 });

    expect(
      (await event(alice, d.sessionId, { seq: 4, type: 'stop', positionMs: 140_000 })).status,
    ).toBe(204);
    expect(jf.telemetry.map((t) => t.path)).toEqual([
      '/Sessions/Playing',
      '/Sessions/Playing/Progress',
      '/Sessions/Playing/Progress',
      '/Sessions/Playing/Stopped',
    ]);
    expect(jf.telemetry[1]?.body).toMatchObject({
      PositionTicks: 1_200_000_000,
      PlayMethod: 'DirectStream',
    });
    expect(jf.telemetry[2]?.body).toMatchObject({ IsPaused: true, EventName: 'pause' });
    const order = jf.calls
      .map((c) => c.path)
      .filter((p) => p === '/Sessions/Playing/Stopped' || p === '/Sessions/Logout');
    expect(order).toEqual(['/Sessions/Playing/Stopped', '/Sessions/Logout']);

    // M3 exit check (b): the stream credential is dead at the origin once the session ended.
    const row = await session(d.sessionId);
    expect(row).toMatchObject({
      status: 'ended',
      end_reason: 'stop',
      credential_envelope: null,
      revoke_pending: 0,
    });
    expect((await browserGet(d.streamUrl)).status).toBe(401);
    expect((await browserGet(must(d.subtitleTracks[0]?.url))).status).toBe(401);
    expect(jf.liveTokens()).toEqual([]);

    const late = await event(alice, d.sessionId, { seq: 5, type: 'progress', positionMs: 150_000 });
    expect(late.status).toBe(410);
    expect(await errorCode(late)).toBe('SESSION_EXPIRED');
  });

  it('M3 exit check (b): an unstarted session expires after 5 min and the origin then rejects its token', async () => {
    const d = await playOk(alice, { itemId: 'm-heat' });
    expect((await browserGet(d.streamUrl)).status).toBe(200);
    const early = await sweepAt(4 * 60_000);
    expect(early.expired).toBe(0);
    expect((await browserGet(d.streamUrl)).status).toBe(200);
    const result = await sweepAt(6 * 60_000);
    expect(result).toMatchObject({ expired: 1, revoked: 1, pending: 0 });
    expect(await session(d.sessionId)).toMatchObject({
      status: 'expired',
      end_reason: 'not_started',
      credential_envelope: null,
    });
    expect((await browserGet(d.streamUrl)).status).toBe(401);
    const res = await event(alice, d.sessionId, { seq: 1, type: 'start', positionMs: 0 });
    expect(res.status).toBe(410);
  });

  it('an event after the 5-minute window expires the session on the spot', async () => {
    const d = await playOk(alice, { itemId: 'm-heat' });
    await db
      .prepare('UPDATE playback_sessions SET auth_expires_at = ? WHERE id = ?')
      .bind(Date.now() - 1, d.sessionId)
      .run();
    const res = await event(alice, d.sessionId, { seq: 1, type: 'start', positionMs: 0 });
    expect(res.status).toBe(410);
    expect((await browserGet(d.streamUrl)).status).toBe(401);
  });

  it('a started session silent for 4 h expires; stop is reported before the revoke', async () => {
    const d = await playOk(alice, { itemId: 'm-heat' });
    await event(alice, d.sessionId, { seq: 1, type: 'start', positionMs: 0 });
    await db
      .prepare('UPDATE playback_sessions SET last_progress_at = ? WHERE id = ?')
      .bind(Date.now() - 4 * 3_600_000 - 60_000, d.sessionId)
      .run();
    const result = await sweepAt(0);
    expect(result).toMatchObject({ expired: 1, revoked: 1 });
    expect((await session(d.sessionId))?.end_reason).toBe('idle');
    const order = jf.calls
      .map((c) => c.path)
      .filter((p) => p === '/Sessions/Playing/Stopped' || p === '/Sessions/Logout');
    expect(order).toEqual(['/Sessions/Playing/Stopped', '/Sessions/Logout']);
    expect((await browserGet(d.streamUrl)).status).toBe(401);
  });

  it('retries a revocation the origin could not take, on every sweep', async () => {
    const d = await playOk(alice, { itemId: 'm-heat' });
    await event(alice, d.sessionId, { seq: 1, type: 'start', positionMs: 0 });
    jf.down = true;
    expect((await event(alice, d.sessionId, { seq: 2, type: 'stop', positionMs: 10 })).status).toBe(
      204,
    );
    expect(await session(d.sessionId)).toMatchObject({ status: 'ended', revoke_pending: 1 });
    expect((await sweepAt(0)).pending).toBe(1);
    jf.down = false;
    expect((await browserGet(d.streamUrl)).status).toBe(200); // still live until revoked
    expect((await sweepAt(0)).revoked).toBe(1);
    expect(await session(d.sessionId)).toMatchObject({
      revoke_pending: 0,
      credential_envelope: null,
    });
    expect((await browserGet(d.streamUrl)).status).toBe(401);
  });

  it('a client error event fails the session and revokes it', async () => {
    const d = await playOk(alice, { itemId: 'm-heat' });
    expect(
      (
        await event(alice, d.sessionId, {
          seq: 1,
          type: 'error',
          positionMs: 0,
          errorCode: 'MEDIA_ERR',
        })
      ).status,
    ).toBe(204);
    expect(await session(d.sessionId)).toMatchObject({
      status: 'failed',
      end_reason: 'client_error',
    });
    expect((await browserGet(d.streamUrl)).status).toBe(401);
  });
});

describe('Emby: DeviceId pool and stop before revoke (ADR-0013 Emby amendment)', () => {
  const embyOnly = { subtitle: { mode: 'off' as const }, versionId: 'ver-src-m-heat-emby' };

  it('leases pool slots per session, reuses them after revocation, and carries api_key', async () => {
    const a = await playOk(alice, { itemId: 'm-heat', preferences: embyOnly });
    const b = await playOk(op, { itemId: 'm-heat', preferences: embyOnly });
    const devices = emby.calls
      .filter((c) => c.path === '/Users/AuthenticateByName')
      .map((c) => c.device);
    expect(devices).toEqual(['cinewren-ps-00', 'cinewren-ps-01']);
    expect(new URL(a.streamUrl).searchParams.get('api_key')).toBeTruthy();
    expect(new URL(a.streamUrl).searchParams.has('ApiKey')).toBe(false);
    expect(new URL(a.streamUrl).searchParams.get('api_key')).not.toBe(
      new URL(b.streamUrl).searchParams.get('api_key'),
    );

    await event(alice, a.sessionId, { seq: 1, type: 'start', positionMs: 0 });
    await event(alice, a.sessionId, { seq: 2, type: 'stop', positionMs: 5_000 });
    const order = emby.calls
      .map((c) => c.path)
      .filter((p) => p === '/Sessions/Playing/Stopped' || p === '/Sessions/Logout');
    expect(order).toEqual(['/Sessions/Playing/Stopped', '/Sessions/Logout']);
    expect((await browserGet(a.streamUrl)).status).toBe(401);
    const leases = await db
      .prepare('SELECT slot FROM stream_device_leases ORDER BY slot')
      .all<{ slot: number }>();
    expect(leases.results.map((r) => r.slot)).toEqual([1]);

    // Slot 00 is free again: a new token is minted on it (the old one was logged out).
    const c = await playOk(alice, { itemId: 'm-heat', preferences: embyOnly });
    expect(emby.calls.filter((x) => x.path === '/Users/AuthenticateByName').at(-1)?.device).toBe(
      'cinewren-ps-00',
    );
    expect(new URL(c.streamUrl).searchParams.get('api_key')).not.toBe(
      new URL(a.streamUrl).searchParams.get('api_key'),
    );
  });

  it('an HLS segment stops working once the stop is reported (segments carry no token on Emby)', async () => {
    const d = await playOk(alice, { itemId: 'm-heat', preferences: embyOnly });
    const ps = new URL(d.streamUrl).searchParams.get('PlaySessionId') ?? '';
    await event(alice, d.sessionId, { seq: 1, type: 'start', positionMs: 0 });
    const segment = `https://${EMBY_HOST}/videos/x/hls1/main/0.ts?PlaySessionId=${ps}`;
    expect((await browserGet(segment)).status).toBe(200);
    await event(alice, d.sessionId, { seq: 2, type: 'stop', positionMs: 1_000 });
    expect((await browserGet(segment)).status).toBe(404);
  });

  it('a full pool fails over (or fails) instead of sharing a DeviceId', async () => {
    const small = createApp({ originFetch: multiOriginFetch([jf, emby]) });
    await db
      .prepare(
        'INSERT INTO stream_device_leases (server_id, slot, session_id, leased_at) VALUES (?, ?, ?, ?)',
      )
      .bind('emby', 0, 'other', Date.now())
      .run();
    // Pool size is configurable; a size of 1 is already full.
    const res = await call('POST', '/api/v1/play', {
      app: small,
      cookie: alice.cookie,
      body: { itemId: 'm-heat', capabilities: CHROME, preferences: embyOnly },
      headers: { 'idempotency-key': 'pool-key-0001' },
      env: { STREAM_DEVICE_POOL_SIZE: '1' } as never,
    });
    expect(res.status).toBe(502);
    expect(await errorCode(res)).toBe('ORIGIN_UNAVAILABLE');
    expect(emby.calls.filter((c) => c.path === '/Users/AuthenticateByName')).toEqual([]);
  });

  it('recovers an orphaned lease (no session row): re-auth on the slot returns the token, then logout', async () => {
    // Simulate a crash between the mint and the session insert.
    const token = await emby
      .fetch(`https://${EMBY_HOST}/Users/AuthenticateByName`, {
        method: 'POST',
        headers: { authorization: 'MediaBrowser Client="Cinewren", DeviceId="cinewren-ps-00"' },
        body: '{}',
      })
      .then((r) => r.json<{ AccessToken: string }>())
      .then((b) => b.AccessToken);
    await db
      .prepare(
        'INSERT INTO stream_device_leases (server_id, slot, session_id, leased_at) VALUES (?, ?, ?, ?)',
      )
      .bind('emby', 0, 'crashed', Date.now() - 11 * 60_000)
      .run();
    const r = await sweepAt(0);
    expect(r.orphansRecovered).toBe(1);
    expect(emby.tokens.get(token)?.live).toBe(false);
    expect(
      (await db.prepare('SELECT COUNT(*) AS n FROM stream_device_leases').first<{ n: number }>())
        ?.n,
    ).toBe(0);
  });
});

describe('progress (FR-PROG-001 to FR-PROG-004, BR-7) and "Continue watching" (FR-CAT-008)', () => {
  it('reaching the BR-7 threshold through events marks the item watched and resets the position', async () => {
    const d = await playOk(alice, { itemId: 'm-heat' });
    await event(alice, d.sessionId, { seq: 1, type: 'start', positionMs: 0 });
    await event(alice, d.sessionId, {
      seq: 2,
      type: 'progress',
      positionMs: Math.round(HOURS2 * 0.91),
    });
    const wp = await db
      .prepare(
        "SELECT position_ms, watched, watched_at FROM watch_progress WHERE user_id = 'alice' AND media_item_id = 'm-heat'",
      )
      .first<{ position_ms: number; watched: number; watched_at: number | null }>();
    expect(wp?.position_ms).toBe(0);
    expect(wp?.watched).toBe(1);
    expect(wp?.watched_at).not.toBeNull();
  });

  it('PUT /progress marks watched and unwatched, sets a position, and honours an Idempotency-Key', async () => {
    const put = (body: unknown, headers: Record<string, string> = {}) =>
      call('PUT', '/api/v1/progress/m-heat', { app, cookie: alice.cookie, body, headers });
    let res = await put({ watched: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ positionMs: 0, watched: true });
    res = await put({ watched: false });
    expect(await res.json()).toEqual({ positionMs: 0, watched: false });
    res = await put({ positionMs: 300_000 }, { 'idempotency-key': 'progress-key-1' });
    expect(await res.json()).toEqual({ positionMs: 300_000, watched: false });
    res = await put({ positionMs: 300_000 }, { 'idempotency-key': 'progress-key-1' });
    expect(res.status).toBe(200);
    res = await put({ positionMs: 1 }, { 'idempotency-key': 'progress-key-1' });
    expect(res.status).toBe(422);
    expect((await put({ watched: true, positionMs: 3 })).status).toBe(400);
  });

  it('PUT /progress on a hidden item is 404 and on a series is 400', async () => {
    const hidden = await call('PUT', '/api/v1/progress/m-hidden', {
      app,
      cookie: alice.cookie,
      body: { watched: true },
    });
    expect(hidden.status).toBe(404);
    const series = await call('PUT', '/api/v1/progress/s-show', {
      app,
      cookie: alice.cookie,
      body: { watched: true },
    });
    expect(series.status).toBe(400);
  });

  it('home lists resumable visible items with their progress, newest first', async () => {
    const put = (u: U, item: string, body: unknown) =>
      call('PUT', `/api/v1/progress/${item}`, { app, cookie: u.cookie, body });
    await put(alice, 'm-heat', { positionMs: 600_000 });
    await put(alice, 'ep-2', { positionMs: 30_000 }); // below the 60 s resume floor
    await put(op, 'm-hidden', { positionMs: 600_000 });
    const home = await json<HomeResponse>(
      await call('GET', '/api/v1/home', { app, cookie: alice.cookie }),
    );
    const cw = home.continueWatching as ContinueWatchingCard[];
    expect(cw.map((c) => c.id)).toEqual(['m-heat']);
    expect(cw[0]?.progress).toEqual({ positionMs: 600_000, runtimeMs: HOURS2 });
    // A title the viewer may no longer see disappears from the row (BR-1).
    await db
      .prepare("DELETE FROM library_grants WHERE user_id = 'alice' AND library_id = 'Ljf'")
      .run();
    await db
      .prepare(
        "DELETE FROM item_availability WHERE media_item_id = 'm-heat' AND library_id = 'Lemby'",
      )
      .run();
    const after = await json<HomeResponse>(
      await call('GET', '/api/v1/home', { app, cookie: alice.cookie }),
    );
    expect(after.continueWatching).toEqual([]);
  });

  it('next episode: the first unwatched after the last watched; null for a movie; 404 when hidden', async () => {
    const next = async (u: U, id: string) =>
      call('GET', `/api/v1/items/${id}/next-episode`, { app, cookie: u.cookie });
    expect((await json<{ id: string }>(await next(alice, 's-show'))).id).toBe('ep-1');
    await call('PUT', '/api/v1/progress/ep-1', {
      app,
      cookie: alice.cookie,
      body: { watched: true },
    });
    expect((await json<{ id: string }>(await next(alice, 's-show'))).id).toBe('ep-2');
    await call('PUT', '/api/v1/progress/ep-3', {
      app,
      cookie: alice.cookie,
      body: { watched: true },
    });
    expect(await (await next(alice, 's-show')).json()).toBeNull();
    expect(await (await next(alice, 'm-heat')).json()).toBeNull();
    expect((await next(bob, 's-show')).status).toBe(404);
  });
});

describe('GET /items/{id}: the copy table (FR-CAT-013)', () => {
  const capsHeader = (caps: unknown) =>
    btoa(JSON.stringify(caps)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');

  it('lists each visible copy with predicted playability for X-Device-Caps, the selected one marked', async () => {
    const res = await call('GET', '/api/v1/items/m-heat', {
      app,
      cookie: alice.cookie,
      headers: { 'x-device-caps': capsHeader(CHROME) },
    });
    expect(res.status).toBe(200);
    const detail = await json<ItemDetailWithCopies>(res);
    expect(detail.copies.map((c) => [c.sourceId, c.selected, c.expectedPlayability])).toEqual([
      ['src-m-heat-jf', true, 'direct_play'],
      ['src-m-heat-emby', false, 'direct_play'],
    ]);
    expect(detail.copies[0]).toMatchObject({
      serverName: 'Server jf',
      serverStatus: 'active',
      resolution: { width: 1920, height: 1080, label: '1080p' },
      hdr: 'none',
      videoCodec: 'h264',
      container: 'mkv',
      audio: [{ codec: 'aac', channels: 2, language: 'eng' }],
      sizeBytes: 1000,
      reasons: ['direct_stream_container'],
    });
    // The same copy the play request picks.
    const d = await playOk(alice, { itemId: 'm-heat' });
    expect(d.source.id).toBe(detail.copies.find((c) => c.selected)?.sourceId);
  });

  it('marks copies on unreachable servers unavailable, and has null predictions without the header', async () => {
    await db.prepare("UPDATE servers SET status = 'unreachable' WHERE id = 'emby'").run();
    const withCaps = await json<ItemDetailWithCopies>(
      await call('GET', '/api/v1/items/m-heat', {
        app,
        cookie: alice.cookie,
        headers: { 'x-device-caps': capsHeader(CHROME) },
      }),
    );
    expect(withCaps.copies[1]).toMatchObject({
      expectedPlayability: 'unavailable',
      reasons: ['server_unreachable'],
    });
    const plain = await json<ItemDetailWithCopies>(
      await call('GET', '/api/v1/items/m-heat', { app, cookie: alice.cookie }),
    );
    expect(plain.copies.map((c) => c.expectedPlayability)).toEqual([null, null]);
    const series = await json<ItemDetailWithCopies>(
      await call('GET', '/api/v1/items/s-show', { app, cookie: alice.cookie }),
    );
    expect(series.copies).toEqual([]);
  });

  it("shows only the caller's visible copies and rejects a malformed header", async () => {
    const opView = await json<ItemDetailWithCopies>(
      await call('GET', '/api/v1/items/m-hidden', { app, cookie: op.cookie }),
    );
    expect(opView.copies).toHaveLength(1);
    expect(
      (await call('GET', '/api/v1/items/m-hidden', { app, cookie: alice.cookie })).status,
    ).toBe(404);
    const bad = await call('GET', '/api/v1/items/m-heat', {
      app,
      cookie: alice.cookie,
      headers: { 'x-device-caps': 'not json!' },
    });
    expect(bad.status).toBe(400);
  });
});

describe('T3.6 compliance (FR-PLAY-008, NFR-COMP-001, ADR-0002)', () => {
  it('every descriptor URL host equals the registered origin host of its server', async () => {
    descriptors.length = 0;
    await playOk(alice, { itemId: 'm-heat' });
    await playOk(alice, {
      itemId: 'm-heat',
      preferences: { subtitle: { mode: 'off' }, versionId: 'ver-src-m-heat-emby' },
    });
    await playOk(op, { itemId: 'm-hidden' });
    await playOk(alice, { itemId: 's-show' });
    const registered = await db
      .prepare('SELECT name, base_url FROM servers')
      .all<{ name: string; base_url: string }>();
    const hostOf = new Map(registered.results.map((s) => [s.name, new URL(s.base_url).host]));
    for (const { d } of descriptors) {
      const host = hostOf.get(d.source.serverName);
      expect(host).toBeTruthy();
      expect(new URL(d.streamUrl).host).toBe(host);
      for (const t of d.subtitleTracks) if (t.url) expect(new URL(t.url).host).toBe(host);
      expect(new URL(d.streamUrl).host).not.toContain('localhost');
    }
  });

  it('no Worker route proxies media: no stream-like routes, and play answers JSON only', async () => {
    const paths = createApp().routes.map((r) => r.path);
    for (const p of paths) {
      expect(p).not.toMatch(/stream|video|hls|m3u8|segment|subtitle|\.ts\b|media|vtt|original/i);
    }
    const res = await playReq(alice, { itemId: 'm-heat' });
    expect(res.headers.get('content-type')).toMatch(/^application\/json/);
    for (const probe of [
      '/api/v1/play/x/stream',
      '/api/v1/stream/m-heat',
      '/api/v1/videos/m-heat/master.m3u8',
    ]) {
      expect((await call('GET', probe, { app, cookie: alice.cookie })).status).toBe(404);
    }
  });
});
