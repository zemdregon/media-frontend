// T4.1: playback E2E (worker side) against an Emby fixture origin (IR-004, FR-PLAY-001,
// FR-PLAY-007, FR-PLAY-009, NFR-SEC-005; ADR-0013 Emby amendment). The origin answers PlaybackInfo
// with the recorded `playbackinfo_mp4_directplay.json` shape, so the stream is Emby's token-gated
// `DirectStreamUrl`. Flow: play, start, stop, revoke, then the origin rejects the credential.
import type { PlaybackDescriptor } from '@cinewren/shared';
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/api/app';
import { encrypt, loadKeyring } from '../../src/vault/vault';
import { call, json } from '../auth-harness';
import { resetAll, seedLibrary, seedUser, T0 } from '../catalog-seed';
import { MockOrigin } from './mock-origin';

const db = env.DB;
const HOST = 'emby.example.test';
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

let emby: MockOrigin;
let app: ReturnType<typeof createApp>;
let viewer: { id: string; cookie: string };

beforeEach(async () => {
  await resetAll();
  await db.batch(
    [
      'DELETE FROM watch_progress',
      'DELETE FROM playback_sessions',
      'DELETE FROM stream_device_leases',
    ].map((s) => db.prepare(s)),
  );
  emby = new MockOrigin({ flavor: 'emby', host: HOST, directPlay: true });
  app = createApp({ originFetch: emby.fetch });
  await db
    .prepare(
      `INSERT INTO servers (id, type, name, base_url, origin_server_id, priority, status, created_at, updated_at)
       VALUES ('emby', 'emby', 'Emby', ?, 'origin-emby', 0, 'active', ?, ?)`,
    )
    .bind(`https://${HOST}`, T0, T0)
    .run();
  const sealed = await encrypt(
    await loadKeyring(env),
    'server_secret',
    'emby',
    JSON.stringify({ kind: 'password', username: 'cinewren-svc', password: 'pw-secret-value' }),
  );
  await db
    .prepare(
      'INSERT INTO server_credentials (server_id, key_version, secret_envelope, updated_at) VALUES (?, ?, ?, ?)',
    )
    .bind('emby', sealed.keyVersion, sealed.envelope, T0)
    .run();
  await seedLibrary({ id: 'Lemby', serverId: 'emby' });
  await db.batch([
    db
      .prepare(
        `INSERT INTO media_items (id, type, title, sort_title, runtime_ms, metadata_source_id, date_added, created_at, updated_at)
         VALUES ('m-1', 'movie', 'His Girl Friday', 'his girl friday', 120000, 'src-m-1', ?, ?, ?)`,
      )
      .bind(T0, T0, T0),
    db
      .prepare(
        `INSERT INTO sources (id, server_id, library_id, provider_item_id, media_item_id, item_type, title,
           match_method, content_hash, status, updated_at)
         VALUES ('src-m-1', 'emby', 'Lemby', '10', 'm-1', 'movie', 'His Girl Friday', 'new', 'h', 'present', ?)`,
      )
      .bind(T0),
    db.prepare("INSERT INTO item_availability (media_item_id, library_id) VALUES ('m-1', 'Lemby')"),
    db
      .prepare(
        `INSERT INTO media_versions (id, source_id, provider_version_id, container, video_codec, width, height,
           hdr, runtime_ms, size_bytes, audio_tracks, subtitle_tracks)
         VALUES ('ver-1', 'src-m-1', 'mediasource_10', 'mp4', 'h264', 1280, 720, 'none', 120000, 209804, ?, '[]')`,
      )
      .bind(
        JSON.stringify([
          { index: 1, codec: 'aac', channels: 1, language: 'und', title: null, default: true },
        ]),
      ),
  ]);
  viewer = await seedUser('alice', 'viewer', ['Lemby']);
});

describe('Emby playback against a fixture origin (T4.1)', () => {
  it('play, stop, revoke: DirectStreamUrl stays on the origin host and dies with the session', async () => {
    const res = await call('POST', '/api/v1/play', {
      app,
      cookie: viewer.cookie,
      body: { itemId: 'm-1', capabilities: CHROME, preferences: { subtitle: { mode: 'off' } } },
      headers: { 'idempotency-key': 'emby-direct-0001' },
    });
    expect(res.status, await res.clone().text()).toBe(201);
    const d = await json<PlaybackDescriptor>(res);

    // The recorded DirectStreamUrl (`/videos/{id}/original.mp4?...&api_key=`) is made absolute on
    // the registered origin and carries the session token in Emby's carrier, not Jellyfin's.
    const url = new URL(d.streamUrl);
    expect(url.host).toBe(HOST);
    expect(url.protocol).toBe('https:');
    expect(url.pathname).toBe('/videos/10/original.mp4');
    expect(url.searchParams.get('api_key')).toBeTruthy();
    expect(url.searchParams.has('ApiKey')).toBe(false);
    expect(d.mode).toBe('direct_play');
    expect(emby.calls.every((c) => c.path !== '/Items/10/PlaybackInfo' || c.device)).toBe(true);
    expect(
      emby.calls.filter((c) => c.path === '/Users/AuthenticateByName').map((c) => c.device),
    ).toEqual(['cinewren-ps-00']);

    expect((await emby.fetch(d.streamUrl)).status).toBe(200);

    const event = (body: Record<string, unknown>) =>
      call('POST', `/api/v1/play/${d.sessionId}/events`, { app, cookie: viewer.cookie, body });
    expect((await event({ seq: 1, type: 'start', positionMs: 0 })).status).toBe(204);
    expect((await event({ seq: 2, type: 'stop', positionMs: 60_000 })).status).toBe(204);

    // Stop is reported before the revoke (LLD-TOKEN), then the origin rejects the credential.
    const order = emby.calls
      .map((c) => c.path)
      .filter((p) => p === '/Sessions/Playing/Stopped' || p === '/Sessions/Logout');
    expect(order).toEqual(['/Sessions/Playing/Stopped', '/Sessions/Logout']);
    expect(emby.telemetry[0]?.body).toMatchObject({
      ItemId: '10',
      MediaSourceId: 'mediasource_10',
    });
    expect((await emby.fetch(d.streamUrl)).status).toBe(401);
    expect(emby.liveTokens()).toEqual([]);
    const lease = await db.prepare('SELECT COUNT(*) AS n FROM stream_device_leases').first<{
      n: number;
    }>();
    expect(lease?.n).toBe(0);
  });
});
