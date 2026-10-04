/**
 * A stateful fake Jellyfin or Emby origin (a fake `fetch`) for the playback integration tests.
 * It models the token behaviour the T1.1 spike verified (docs/spikes/2026-provider-spike.md §3):
 *
 * - `POST /Users/AuthenticateByName` mints a token per DeviceId. Jellyfin: a re-auth on the same
 *   DeviceId issues a new token and kills the old one. Emby: it returns the same token until that
 *   token is logged out.
 * - `POST /Sessions/Logout` revokes the calling token.
 * - Playlists, segments and direct files require a live token in the provider's carrier
 *   (`ApiKey=` on Jellyfin, `api_key=` on Emby) and answer 401 otherwise. Emby HLS segments are
 *   served while the transcode is alive (until a stop is reported), whatever the token.
 * - PlaybackInfo and telemetry require a live token in the `Authorization` header.
 *
 * Response shapes follow the recorded `playbackinfo_*` fixtures. Everything is synthetic.
 */
export type Flavor = 'jellyfin' | 'emby';

interface TokenState {
  deviceId: string;
  live: boolean;
}

export interface MockOriginOptions {
  flavor: Flavor;
  host: string;
  /** PlaybackInfo for these provider item IDs answers 503 (to test failover). */
  failItems?: Set<string>;
  /** Every request fails like a connection error. */
  down?: boolean;
}

export class MockOrigin {
  readonly flavor: Flavor;
  readonly host: string;
  readonly tokens = new Map<string, TokenState>();
  private readonly byDevice = new Map<string, string>();
  readonly calls: { method: string; path: string; device?: string }[] = [];
  readonly telemetry: { path: string; body: Record<string, unknown> }[] = [];
  /** Live transcodes by PlaySessionId (Emby segments outlive the token until stop). */
  readonly transcodes = new Set<string>();
  failItems: Set<string>;
  down: boolean;
  private seq = 0;

  constructor(opts: MockOriginOptions) {
    this.flavor = opts.flavor;
    this.host = opts.host;
    this.failItems = opts.failItems ?? new Set();
    this.down = opts.down ?? false;
  }

  get carrier(): string {
    return this.flavor === 'jellyfin' ? 'ApiKey' : 'api_key';
  }

  liveTokens(): string[] {
    return [...this.tokens.entries()].filter(([, s]) => s.live).map(([t]) => t);
  }

  private headerToken(headers: Headers): string | null {
    const m = /Token="([^"]+)"/.exec(headers.get('authorization') ?? '');
    return m?.[1] ?? null;
  }

  private deviceOf(headers: Headers): string | null {
    const m = /DeviceId="([^"]+)"/.exec(headers.get('authorization') ?? '');
    return m?.[1] ?? null;
  }

  private isLive(token: string | null): boolean {
    return token !== null && this.tokens.get(token)?.live === true;
  }

  readonly fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : input);
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers = new Headers(init?.headers);
    const device = this.deviceOf(headers) ?? undefined;
    this.calls.push({ method, path: url.pathname, ...(device ? { device } : {}) });
    if (this.down) return Promise.reject(new TypeError('Network connection lost.'));
    if (url.host !== this.host) return Promise.resolve(new Response(null, { status: 421 }));
    const body =
      typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    return Promise.resolve(this.handle(method, url, headers, body));
  };

  private json(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }

  private handle(
    method: string,
    url: URL,
    headers: Headers,
    body: Record<string, unknown>,
  ): Response {
    const path = url.pathname;
    if (method === 'POST' && path === '/Users/AuthenticateByName') {
      const device = this.deviceOf(headers);
      if (!device) return new Response(null, { status: 400 });
      const existing = this.byDevice.get(device);
      let token: string;
      if (this.flavor === 'emby' && existing && this.isLive(existing)) {
        token = existing; // Emby: same DeviceId, same token
      } else {
        if (existing) this.tokens.set(existing, { deviceId: device, live: false }); // Jellyfin
        token = `tok-${this.flavor}-${++this.seq}`;
        this.tokens.set(token, { deviceId: device, live: true });
        this.byDevice.set(device, token);
      }
      return this.json(200, {
        User: { Id: 'svc-user', Policy: { IsAdministrator: false, IsDisabled: false } },
        AccessToken: token,
        ServerId: 'origin-server',
      });
    }
    if (method === 'POST' && path === '/Sessions/Logout') {
      const token = this.headerToken(headers);
      if (!this.isLive(token) || token === null) return new Response(null, { status: 401 });
      this.tokens.set(token, { deviceId: this.tokens.get(token)?.deviceId ?? '', live: false });
      return new Response(null, { status: 204 });
    }
    const pi = /^\/Items\/([^/]+)\/PlaybackInfo$/.exec(path);
    if (method === 'POST' && pi) {
      const token = this.headerToken(headers);
      if (!this.isLive(token) || token === null) return new Response(null, { status: 401 });
      const itemId = decodeURIComponent(pi[1] ?? '');
      if (this.failItems.has(itemId)) return new Response(null, { status: 503 });
      const ms = typeof body.MediaSourceId === 'string' ? body.MediaSourceId : itemId;
      const playSession = `ps-${++this.seq}`;
      const device = this.deviceOf(headers) ?? '';
      const q = new URLSearchParams({
        DeviceId: device,
        MediaSourceId: ms,
        PlaySessionId: playSession,
        VideoCodec: 'h264',
        AudioCodec: 'aac',
        TranscodeReasons: 'ContainerNotSupported',
      });
      q.set(this.carrier, token);
      return this.json(200, {
        PlaySessionId: playSession,
        MediaSources: [
          {
            Id: ms,
            Container: 'mkv',
            SupportsDirectPlay: false,
            SupportsTranscoding: true,
            TranscodingUrl: `/videos/${itemId}/master.m3u8?${q.toString()}`,
            TranscodingSubProtocol: 'hls',
            DefaultAudioStreamIndex: 1,
            MediaStreams: [
              { Index: 0, Type: 'Video', Codec: 'h264', Height: 1080 },
              { Index: 1, Type: 'Audio', Codec: 'aac', Channels: 2, Language: 'eng' },
              {
                Index: 2,
                Type: 'Subtitle',
                Codec: 'subrip',
                Language: 'eng',
                IsTextSubtitleStream: true,
                DeliveryMethod: 'External',
                DeliveryUrl: `/Videos/${itemId}/${ms}/Subtitles/2/0/Stream.vtt?${this.carrier}=${token}`,
              },
            ],
          },
        ],
      });
    }
    const tele = /^\/Sessions\/Playing(\/Progress|\/Stopped)?$/.exec(path);
    if (method === 'POST' && tele) {
      if (!this.isLive(this.headerToken(headers))) return new Response(null, { status: 401 });
      this.telemetry.push({ path, body });
      const ps = typeof body.PlaySessionId === 'string' ? body.PlaySessionId : '';
      if (path === '/Sessions/Playing') this.transcodes.add(ps);
      if (path === '/Sessions/Playing/Stopped') this.transcodes.delete(ps);
      return new Response(null, { status: 204 });
    }
    if (
      method === 'GET' &&
      /\/(master|main)\.m3u8$|\/original\.[a-z0-9]+$|\/Stream\.vtt$/.test(path)
    ) {
      // The stream credential travels in the query string, as the browser sends it.
      if (!this.isLive(url.searchParams.get(this.carrier)))
        return new Response(null, { status: 401 });
      const ps = url.searchParams.get('PlaySessionId');
      if (ps && path.endsWith('.m3u8')) this.transcodes.add(ps);
      return new Response('#EXTM3U\n', { status: 200 });
    }
    if (method === 'GET' && /\/hls1\/main\/\d+\.ts$/.test(path)) {
      const ps = url.searchParams.get('PlaySessionId') ?? '';
      if (this.flavor === 'emby') {
        // Emby: segments carry only PlaySessionId and live as long as the transcode.
        return new Response(this.transcodes.has(ps) ? 'ts' : null, {
          status: this.transcodes.has(ps) ? 200 : 404,
        });
      }
      return new Response(null, {
        status: this.isLive(url.searchParams.get(this.carrier)) ? 200 : 401,
      });
    }
    return new Response(null, { status: 404 });
  }
}

/** Routes each request to the mock origin whose host it names. */
export function multiOriginFetch(origins: MockOrigin[]): typeof fetch {
  return (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    const origin = origins.find((o) => o.host === url.host);
    if (!origin) return Promise.reject(new TypeError(`No mock origin for ${url.host}`));
    return origin.fetch(input, init);
  };
}
