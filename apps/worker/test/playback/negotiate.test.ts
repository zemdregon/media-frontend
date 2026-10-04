// T3.3: provider playback against the recorded T1.1 exchanges (FR-PLAY-001, FR-PLAY-006,
// FR-PLAY-007, FR-PLAY-009; ADR-0013; LLD-PROV). Files used: `auth_session_A`
// (per-session token mint), `playbackinfo_*`, `sessions_playing*` and `session_logout_A`, for
// Jellyfin 12.1 and Emby 4.10. Inline routes marked "synthetic" cover cases no recording has.
import { must } from './util';
import { describe, expect, it } from 'vitest';
import { embyProvider } from '../../src/providers/emby';
import { jellyfinProvider } from '../../src/providers/jellyfin';
import {
  deviceProfile,
  EMBY_FLAVOR,
  isVideoTranscode,
  JELLYFIN_FLAVOR,
} from '../../src/providers/mediabrowser-playback';
import { buildProviderContext } from '../../src/providers/registry';
import type {
  DeviceCapabilities,
  PlaybackProvider,
  SessionCredential,
} from '../../src/providers/types';
import { createFakeOrigin, type Fixture, type Route } from '../providers/fixture-fetch';

const CAPS: DeviceCapabilities = {
  containers: ['mp4', 'webm', 'hls'],
  video: [{ codec: 'h264' }, { codec: 'vp9' }],
  audio: ['aac', 'mp3', 'opus'],
  maxHeight: 1080,
  hdr: [],
  textSubtitles: ['vtt'],
  nativeHls: false,
  mse: true,
};

const BASES: Record<string, string> = {
  jellyfin: 'https://jellyfin.example.test',
  emby: 'https://emby.example.test',
};

function context(provider: 'jellyfin' | 'emby', routes: Route[]) {
  const origin = createFakeOrigin(provider, routes);
  const ctx = buildProviderContext({
    server: { id: 's1', type: provider, baseUrl: new URL(BASES[provider] ?? '') },
    secret: { kind: 'password', username: 'cinewren-svc', password: 'pw-123456' },
    fetchImpl: origin.fetch,
  });
  return { origin, ctx };
}

const JF_USER = '148dded263c74cb885d9819605d68044';
const EMBY_USER = '5c84ecbdbf494494a7fa03913ea2e020';

async function mint(
  provider: PlaybackProvider,
  ctx: ReturnType<typeof context>['ctx'],
  lease?: { slot: number },
): Promise<SessionCredential> {
  return provider.createSessionCredential(ctx, '01JSESSIONAAAAAAAAAAAAAAAA', lease);
}

describe('session credentials (ADR-0013)', () => {
  it('Jellyfin mints a per-session token under DeviceId cinewren-ps-<sessionId>', async () => {
    const { origin, ctx } = context('jellyfin', [{ fixture: 'auth_session_A.json' }]);
    const cred = await mint(jellyfinProvider, ctx);
    expect(cred).toEqual({
      kind: 'session_token',
      token: '<SESSION_TOKEN_A>',
      deviceId: 'cinewren-ps-01JSESSIONAAAAAAAAAAAAAAAA',
      accountId: JF_USER,
    });
    const auth = origin.calls[0]?.headers.get('authorization') ?? '';
    expect(auth).toContain('DeviceId="cinewren-ps-01JSESSIONAAAAAAAAAAAAAAAA"');
    expect(auth).not.toContain('Token=');
    expect(JSON.parse(origin.calls[0]?.body ?? '{}')).toEqual({
      Username: 'cinewren-svc',
      Pw: 'pw-123456',
    });
    expect(origin.unmatched).toEqual([]);
  });

  it('Emby mints under a pooled DeviceId and refuses to mint without a lease', async () => {
    const { origin, ctx } = context('emby', [{ fixture: 'auth_session_A.json' }]);
    expect(embyProvider.streamDevices).toBe('pooled');
    await expect(mint(embyProvider, ctx)).rejects.toMatchObject({ code: 'PROTOCOL' });
    const cred = await mint(embyProvider, ctx, { slot: 3 });
    expect(cred.deviceId).toBe('cinewren-ps-03');
    expect(cred.accountId).toBe(EMBY_USER);
    expect(origin.calls[0]?.headers.get('authorization')).toContain('DeviceId="cinewren-ps-03"');
  });

  it('never hands out a token of an administrator account', async () => {
    const { origin, ctx } = context('jellyfin', [
      {
        fixture: 'auth_session_A.json',
        mutate: (f: Fixture) => {
          const body = f.response.body as { User: { Policy: { IsAdministrator: boolean } } };
          body.User.Policy.IsAdministrator = true;
          return f;
        },
      },
      { fixture: 'session_logout_A.json' },
    ]);
    await expect(mint(jellyfinProvider, ctx)).rejects.toMatchObject({ code: 'AUTH' });
    expect(origin.calls.map((c) => c.url.pathname)).toEqual([
      '/Users/AuthenticateByName',
      '/Sessions/Logout',
    ]);
  });

  it('revokes with POST /Sessions/Logout sent with the session token itself', async () => {
    const { origin, ctx } = context('jellyfin', [{ fixture: 'session_logout_A.json' }]);
    await jellyfinProvider.revokeSessionCredential(ctx, {
      kind: 'session_token',
      token: 'tok-A',
      deviceId: 'cinewren-ps-x',
    });
    expect(origin.calls[0]?.headers.get('authorization')).toContain('Token="tok-A"');
  });

  it('treats a token the origin already rejects as revoked; other failures are errors', async () => {
    const synthetic401 = { method: 'POST', url: '/Sessions/Logout', status: 401 };
    const a = context('jellyfin', [synthetic401]);
    await expect(
      jellyfinProvider.revokeSessionCredential(a.ctx, { kind: 'session_token', token: 't' }),
    ).resolves.toBeUndefined();
    const synthetic503 = { method: 'POST', url: '/Sessions/Logout', status: 503 };
    const b = context('jellyfin', [synthetic503]);
    await expect(
      jellyfinProvider.revokeSessionCredential(b.ctx, { kind: 'session_token', token: 't' }),
    ).rejects.toMatchObject({ code: 'UNAVAILABLE' });
  });
});

const jfCred: SessionCredential = {
  kind: 'session_token',
  token: 'tok-session-1',
  deviceId: 'cinewren-ps-1',
  accountId: JF_USER,
};
const embyCred: SessionCredential = {
  kind: 'session_token',
  token: 'tok-session-2',
  deviceId: 'cinewren-ps-00',
  accountId: EMBY_USER,
};

describe('Jellyfin negotiation: token-gated HLS only (owner decision 2026-10-04)', () => {
  it('H.264 in MKV: an HLS remux (video copied), token carried as ApiKey', async () => {
    const { origin, ctx } = context('jellyfin', [{ fixture: 'playbackinfo_h264_mkv.json' }]);
    const s = await jellyfinProvider.negotiatePlayback(ctx, {
      providerItemId: 'ea7efa1224758f90a2a989d8cc93a42a',
      providerVersionId: 'ea7efa1224758f90a2a989d8cc93a42a',
      caps: CAPS,
      audioIndex: 1,
      subtitle: null,
      cred: jfCred,
    });
    expect(s.mode).toBe('direct_stream');
    expect(s.streamType).toBe('hls');
    const url = new URL(s.url);
    expect(url.host).toBe('jellyfin.example.test');
    expect(url.pathname).toBe('/videos/ea7efa12-2475-8f90-a2a9-89d8cc93a42a/master.m3u8');
    expect(url.searchParams.get('ApiKey')).toBe('tok-session-1');
    expect(url.searchParams.has('api_key')).toBe(false);
    expect(url.searchParams.get('static')).toBeNull();
    expect(JSON.parse(s.providerSessionRef ?? '{}')).toEqual({
      i: 'ea7efa1224758f90a2a989d8cc93a42a',
      m: 'ea7efa1224758f90a2a989d8cc93a42a',
      p: 'd60e0fdd0c5b447db9ac32f96e421ae7',
      pm: 'DirectStream',
    });
    // The request: direct play and progressive direct stream off, stream copy on.
    const body = JSON.parse(origin.calls[0]?.body ?? '{}') as Record<string, unknown>;
    expect(body).toMatchObject({
      UserId: JF_USER,
      MediaSourceId: 'ea7efa1224758f90a2a989d8cc93a42a',
      AudioStreamIndex: 1,
      SubtitleStreamIndex: -1,
      EnableDirectPlay: false,
      EnableDirectStream: false,
      EnableTranscoding: true,
      AllowVideoStreamCopy: true,
      AllowAudioStreamCopy: true,
    });
    expect((body.DeviceProfile as { DirectPlayProfiles: unknown[] }).DirectPlayProfiles).toEqual(
      [],
    );
    expect(origin.calls[0]?.headers.get('authorization')).toContain('Token="tok-session-1"');
  });

  it('HEVC in MKV with subtitles: a transcode, plus WebVTT URLs for both text tracks', async () => {
    const { ctx } = context('jellyfin', [{ fixture: 'playbackinfo_hevc_mkv_transcode.json' }]);
    const s = await jellyfinProvider.negotiatePlayback(ctx, {
      providerItemId: '25900aea80a228d02844e045bdd4213f',
      providerVersionId: '25900aea80a228d02844e045bdd4213f',
      caps: CAPS,
      cred: jfCred,
    });
    expect(s.mode).toBe('transcode');
    expect(s.streamType).toBe('hls');
    expect(Object.keys(s.subtitleUrls).sort()).toEqual(['0', '3']);
    const vtt = new URL(must(s.subtitleUrls[3]));
    expect(vtt.host).toBe('jellyfin.example.test');
    expect(vtt.pathname).toBe(
      '/Videos/25900aea-80a2-28d0-2844-e045bdd4213f/25900aea80a228d02844e045bdd4213f/Subtitles/3/0/Stream.vtt',
    );
    expect(vtt.searchParams.get('ApiKey')).toBe('tok-session-1');
  });

  it('a file the origin calls directly playable is still served as an HLS remux, never static=true', async () => {
    const { ctx } = context('jellyfin', [{ fixture: 'playbackinfo_mp4_directplay.json' }]);
    const s = await jellyfinProvider.negotiatePlayback(ctx, {
      providerItemId: '5bd7c114c62f47e8cd0dbaceb156ff8e',
      providerVersionId: '5bd7c114c62f47e8cd0dbaceb156ff8e',
      caps: CAPS,
      cred: jfCred,
    });
    expect(s.mode).toBe('direct_stream');
    expect(s.streamType).toBe('hls');
    const url = new URL(s.url);
    expect(url.pathname).toBe('/Videos/5bd7c114c62f47e8cd0dbaceb156ff8e/master.m3u8');
    expect(url.searchParams.get('static')).toBeNull();
    expect(url.searchParams.get('VideoCodec')).toBe('h264');
    expect(url.searchParams.get('AllowVideoStreamCopy')).toBe('true');
    expect(url.searchParams.get('PlaySessionId')).toBe('16bddaa06780454d828010c4c0cc710e');
    expect(url.searchParams.get('ApiKey')).toBe('tok-session-1');
  });

  it('refuses an origin answer that only offers an unauthenticated static stream (synthetic)', async () => {
    const { ctx } = context('jellyfin', [
      {
        method: 'POST',
        url: `/Items/abc/PlaybackInfo?UserId=${JF_USER}`,
        status: 200,
        body: {
          PlaySessionId: 'p1',
          MediaSources: [
            {
              Id: 'abc',
              SupportsTranscoding: true,
              TranscodingUrl: '/Videos/abc/stream.mkv?static=true&MediaSourceId=abc',
              TranscodingSubProtocol: 'http',
              MediaStreams: [],
            },
          ],
        },
      },
    ]);
    await expect(
      jellyfinProvider.negotiatePlayback(ctx, {
        providerItemId: 'abc',
        providerVersionId: 'abc',
        caps: CAPS,
        cred: jfCred,
      }),
    ).rejects.toMatchObject({ code: 'PROTOCOL' });
  });

  it('maps a missing item to NOT_FOUND and an origin outage to UNAVAILABLE (synthetic)', async () => {
    const path = `/Items/gone/PlaybackInfo?UserId=${JF_USER}`;
    const req = { providerItemId: 'gone', providerVersionId: 'gone', caps: CAPS, cred: jfCred };
    const a = context('jellyfin', [{ method: 'POST', url: path, status: 404 }]);
    await expect(jellyfinProvider.negotiatePlayback(a.ctx, req)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    const b = context('jellyfin', [{ method: 'POST', url: path, status: 503 }]);
    await expect(jellyfinProvider.negotiatePlayback(b.ctx, req)).rejects.toMatchObject({
      code: 'UNAVAILABLE',
      retryable: true,
    });
  });
});

describe('Emby negotiation', () => {
  it('MP4: direct play from DirectStreamUrl (token-gated original file), carrier api_key', async () => {
    const { origin, ctx } = context('emby', [{ fixture: 'playbackinfo_mp4_directplay.json' }]);
    const s = await embyProvider.negotiatePlayback(ctx, {
      providerItemId: '10',
      providerVersionId: 'mediasource_10',
      caps: CAPS,
      cred: embyCred,
    });
    expect(s.mode).toBe('direct_play');
    expect(s.streamType).toBe('progressive');
    const url = new URL(s.url);
    expect(url.host).toBe('emby.example.test');
    expect(url.pathname).toBe('/videos/10/original.mp4');
    expect(url.searchParams.get('api_key')).toBe('tok-session-2');
    expect(url.searchParams.has('ApiKey')).toBe(false);
    const body = JSON.parse(origin.calls[0]?.body ?? '{}') as Record<string, unknown>;
    expect(body.EnableDirectPlay).toBe(true);
    expect(
      (body.DeviceProfile as { DirectPlayProfiles: unknown[] }).DirectPlayProfiles.length,
    ).toBeGreaterThan(0);
  });

  it('H.264 in MKV: HLS with the video copied', async () => {
    const { ctx } = context('emby', [{ fixture: 'playbackinfo_h264_mkv.json' }]);
    const s = await embyProvider.negotiatePlayback(ctx, {
      providerItemId: '11',
      providerVersionId: 'mediasource_11',
      caps: CAPS,
      cred: embyCred,
    });
    expect(s).toMatchObject({ mode: 'direct_stream', streamType: 'hls' });
    expect(new URL(s.url).searchParams.get('api_key')).toBe('tok-session-2');
  });

  it('HEVC in MKV: a transcode (Emby names only the container, the codec change shows it)', async () => {
    const { ctx } = context('emby', [{ fixture: 'playbackinfo_hevc_mkv_transcode.json' }]);
    const s = await embyProvider.negotiatePlayback(ctx, {
      providerItemId: '12',
      providerVersionId: 'mediasource_12',
      caps: CAPS,
      cred: embyCred,
    });
    expect(s).toMatchObject({ mode: 'transcode', streamType: 'hls' });
    expect(Object.keys(s.subtitleUrls).sort()).toEqual(['2', '3']);
    expect(new URL(must(s.subtitleUrls[2])).pathname).toBe(
      '/Videos/12/mediasource_12/Subtitles/2/0/Stream.vtt',
    );
    expect(new URL(must(s.subtitleUrls[2])).searchParams.get('api_key')).toBe('tok-session-2');
  });
});

describe('telemetry (FR-PLAY-009)', () => {
  const ref = JSON.stringify({
    i: '5bd7c114c62f47e8cd0dbaceb156ff8e',
    m: '5bd7c114c62f47e8cd0dbaceb156ff8e',
    p: '16bddaa06780454d828010c4c0cc710e',
    pm: 'DirectStream',
  });
  const stream = {
    mode: 'direct_stream' as const,
    streamType: 'hls' as const,
    url: '',
    subtitleUrls: {},
    providerSessionRef: ref,
  };

  it('reports start, progress and stop to the recorded endpoints with the session token', async () => {
    const { origin, ctx } = context('jellyfin', [
      { fixture: 'sessions_playing.json' },
      { fixture: 'sessions_playing_progress.json' },
      { fixture: 'sessions_playing_stopped.json' },
    ]);
    await jellyfinProvider.reportPlayback(ctx, jfCred, { type: 'start', positionMs: 0, stream });
    await jellyfinProvider.reportPlayback(ctx, jfCred, {
      type: 'progress',
      positionMs: 5000,
      stream,
    });
    await jellyfinProvider.reportPlayback(ctx, jfCred, { type: 'stop', positionMs: 6000, stream });
    expect(origin.unmatched).toEqual([]);
    expect(origin.calls.map((c) => c.url.pathname)).toEqual([
      '/Sessions/Playing',
      '/Sessions/Playing/Progress',
      '/Sessions/Playing/Stopped',
    ]);
    const bodies = origin.calls.map((c) => JSON.parse(c.body ?? '{}') as Record<string, unknown>);
    expect(bodies[1]).toMatchObject({
      ItemId: '5bd7c114c62f47e8cd0dbaceb156ff8e',
      MediaSourceId: '5bd7c114c62f47e8cd0dbaceb156ff8e',
      PlaySessionId: '16bddaa06780454d828010c4c0cc710e',
      PositionTicks: 50_000_000,
      PlayMethod: 'DirectStream',
      EventName: 'timeupdate',
    });
    expect(bodies[2]?.PositionTicks).toBe(60_000_000);
    for (const c of origin.calls) {
      expect(c.headers.get('authorization')).toContain('Token="tok-session-1"');
    }
  });

  it('Emby stop goes to the same endpoint', async () => {
    const { origin, ctx } = context('emby', [{ fixture: 'sessions_playing_stopped.json' }]);
    await embyProvider.reportPlayback(ctx, embyCred, {
      type: 'stop',
      positionMs: 6000,
      stream: {
        ...stream,
        providerSessionRef: JSON.stringify({
          i: '10',
          m: 'mediasource_10',
          p: 'x',
          pm: 'DirectPlay',
        }),
      },
    });
    expect(origin.unmatched).toEqual([]);
  });
});

describe('device profile and mode detection (pure)', () => {
  it('Jellyfin gets no direct-play profiles; Emby gets one per file container', () => {
    const jf = deviceProfile(CAPS, JELLYFIN_FLAVOR);
    const em = deviceProfile(CAPS, EMBY_FLAVOR);
    expect(jf.DirectPlayProfiles).toEqual([]);
    expect(em.DirectPlayProfiles).toEqual([
      {
        Container: 'mp4,m4v,mov',
        Type: 'Video',
        VideoCodec: 'h264,vp9',
        AudioCodec: 'aac,mp3,opus',
      },
      { Container: 'webm', Type: 'Video', VideoCodec: 'h264,vp9', AudioCodec: 'aac,mp3,opus' },
    ]);
    expect(jf.TranscodingProfiles).toEqual([
      expect.objectContaining({
        Protocol: 'hls',
        Container: 'ts',
        VideoCodec: 'h264',
        AudioCodec: 'aac,mp3,opus',
      }),
    ]);
    expect(jf.SubtitleProfiles).toEqual(
      expect.arrayContaining([
        { Format: 'vtt', Method: 'External' },
        { Format: 'pgssub', Method: 'Encode' },
      ]),
    );
    expect(jf.CodecProfiles).toEqual([
      {
        Type: 'Video',
        Conditions: [{ Condition: 'LessThanEqual', Property: 'Height', Value: '1080' }],
      },
    ]);
  });

  it('HEVC-capable devices get an fMP4 HLS profile that can copy HEVC', () => {
    const p = deviceProfile(
      { ...CAPS, video: [{ codec: 'h264' }, { codec: 'h265' }] },
      JELLYFIN_FLAVOR,
    );
    expect(p.TranscodingProfiles).toEqual([
      expect.objectContaining({ Container: 'mp4', VideoCodec: 'h264,hevc' }),
    ]);
  });

  it('tells a remux from a video transcode', () => {
    const u = (q: string) => new URL(`https://o.test/videos/1/master.m3u8?${q}`);
    expect(
      isVideoTranscode(u('VideoCodec=h264&TranscodeReasons=ContainerNotSupported'), 'h264'),
    ).toBe(false);
    expect(
      isVideoTranscode(u('VideoCodec=h264&TranscodeReasons=AudioCodecNotSupported'), 'h264'),
    ).toBe(false);
    expect(
      isVideoTranscode(u('VideoCodec=h264&TranscodeReasons=VideoCodecNotSupported'), 'h264'),
    ).toBe(true);
    expect(
      isVideoTranscode(u('VideoCodec=h264&TranscodeReasons=ContainerNotSupported'), 'hevc'),
    ).toBe(true);
    expect(isVideoTranscode(u('VideoCodec=h264,hevc'), 'h265')).toBe(false);
  });
});
