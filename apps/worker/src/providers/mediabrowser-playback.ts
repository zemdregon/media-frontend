/**
 * Playback for the MediaBrowser family: Jellyfin and Emby share the API shape (LLD-PROV, spike
 * sections 3 and 4). Each adapter passes its flavor; nothing outside `providers/` imports this.
 *
 * Verified facts this module relies on (docs/spikes/2026-provider-spike.md):
 * - A per-session token is minted with `POST /Users/AuthenticateByName` under a DeviceId of our
 *   choosing, and revoked with `POST /Sessions/Logout` sent with that token.
 * - `POST /Items/{id}/PlaybackInfo?UserId=` with a DeviceProfile negotiates the stream.
 * - The browser-URL token carrier is `ApiKey=` on Jellyfin 12.1 and `api_key=` on Emby 4.10.
 * - Jellyfin serves `static=true` streams without authentication, so for Jellyfin only token-gated
 *   HLS is ever returned (owner decision 2026-10-04, ADR-0013); remux (copy codecs) is preferred.
 * - Telemetry is `POST /Sessions/Playing[/Progress|/Stopped]` with the session token.
 */
import { ProviderError } from './errors';
import { resolveOriginUrl, statusError } from './origin-fetch';
import type {
  DeviceCapabilities,
  NegotiatedStream,
  NegotiateRequest,
  PlaybackEvent,
  ProviderContext,
  SessionCredential,
} from './types';

export interface MediaBrowserFlavor {
  type: 'jellyfin' | 'emby';
  /** Query parameter that carries the session token in browser URLs. */
  tokenParam: 'ApiKey' | 'api_key';
  /** False for Jellyfin: its direct (static) streams cannot be revoked. */
  allowDirectPlay: boolean;
}

export const JELLYFIN_FLAVOR: MediaBrowserFlavor = {
  type: 'jellyfin',
  tokenParam: 'ApiKey',
  allowDirectPlay: false,
};
export const EMBY_FLAVOR: MediaBrowserFlavor = {
  type: 'emby',
  tokenParam: 'api_key',
  allowDirectPlay: true,
};

const CLIENT_VERSION = '0.0.1';
const TICKS_PER_MS = 10_000;
/** High enough that a 4K remux is never forced into a transcode by bitrate alone. */
const MAX_STREAMING_BITRATE = 140_000_000;

type Rec = Record<string, unknown>;
const asRec = (v: unknown): Rec | null =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Rec) : null;
const text = (v: unknown): string | undefined =>
  typeof v === 'string' && v !== '' ? v : undefined;
const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;

/** The DeviceId of a playback session: unique (Jellyfin) or a pool slot (Emby). */
export function streamDeviceId(sessionId: string, lease?: { slot: number }): string {
  return lease ? `cinewren-ps-${String(lease.slot).padStart(2, '0')}` : `cinewren-ps-${sessionId}`;
}

function authHeader(deviceId: string, token?: string): string {
  const base = `MediaBrowser Client="Cinewren", Device="Cinewren Playback", DeviceId="${deviceId}", Version="${CLIENT_VERSION}"`;
  return token === undefined ? base : `${base}, Token="${token}"`;
}

async function readJson(res: Response): Promise<Rec> {
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new ProviderError('PROTOCOL', 'The origin sent an unreadable response.', false);
  }
  const rec = asRec(body);
  if (!rec) throw new ProviderError('PROTOCOL', 'The origin sent an unexpected response.', false);
  return rec;
}

// --- session credential (FR-PLAY-007, ADR-0013) ---

export async function mintSessionToken(
  ctx: ProviderContext,
  deviceId: string,
): Promise<SessionCredential> {
  if (ctx.secret.kind !== 'password') {
    throw new ProviderError(
      'UNSUPPORTED',
      'This server type needs a username and password.',
      false,
    );
  }
  const res = await ctx.fetch('/Users/AuthenticateByName', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: authHeader(deviceId),
    },
    body: JSON.stringify({ Username: ctx.secret.username, Pw: ctx.secret.password }),
  });
  if (res.status === 400 || res.status === 401 || res.status === 403) {
    await res.body?.cancel();
    throw new ProviderError('AUTH', 'The origin refused the credentials.', false);
  }
  if (!res.ok) {
    await res.body?.cancel();
    throw statusError(res.status);
  }
  const body = await readJson(res);
  const user = asRec(body.User);
  const token = text(body.AccessToken);
  const accountId = text(user?.Id);
  if (!token || !accountId) {
    throw new ProviderError('PROTOCOL', 'The origin sent an unexpected sign-in response.', false);
  }
  // Defence in depth: never hand out a token of an administrator (ADR-0008, NFR-SEC-001).
  if (asRec(user?.Policy)?.IsAdministrator !== false) {
    await logoutToken(ctx, deviceId, token);
    throw new ProviderError('AUTH', 'The service account is not a restricted account.', false);
  }
  return { kind: 'session_token', token, deviceId, accountId };
}

async function logoutToken(ctx: ProviderContext, deviceId: string, token: string): Promise<void> {
  const res = await ctx.fetch('/Sessions/Logout', {
    method: 'POST',
    headers: { Accept: 'application/json', Authorization: authHeader(deviceId, token) },
  });
  await res.body?.cancel();
  // 401: the origin already rejects the token, which is the goal.
  if (res.ok || res.status === 401) return;
  throw statusError(res.status);
}

export function revokeSessionToken(ctx: ProviderContext, cred: SessionCredential): Promise<void> {
  return logoutToken(ctx, cred.deviceId ?? 'cinewren-ps-unknown', cred.token);
}

// --- device profile (pure; LLD-PROV "Mapping capabilities to a device profile") ---

const CODEC_ALIASES: Record<string, string> = {
  h265: 'hevc',
  hvc1: 'hevc',
  hev1: 'hevc',
  avc: 'h264',
  avc1: 'h264',
  av01: 'av1',
  vp09: 'vp9',
  'e-ac-3': 'eac3',
  'ac-3': 'ac3',
};

export function normalizeCodec(codec: string | null | undefined): string | undefined {
  if (!codec) return undefined;
  const c = codec.trim().toLowerCase();
  return CODEC_ALIASES[c] ?? c;
}

/** Codecs HLS can carry (TS for H.264, fMP4 for the rest). */
const HLS_VIDEO = ['h264', 'hevc', 'av1'];
const HLS_AUDIO = ['aac', 'mp3', 'ac3', 'eac3', 'opus', 'flac'];
const IMAGE_SUBTITLES = ['pgssub', 'pgs', 'dvdsub', 'dvbsub', 'vobsub', 'xsub'];
const TEXT_SUBTITLES = ['srt', 'subrip', 'ass', 'ssa', 'vtt', 'webvtt', 'mov_text', 'ttml'];

const FILE_CONTAINERS: Record<string, string> = {
  mp4: 'mp4,m4v,mov',
  webm: 'webm',
  mkv: 'mkv,matroska',
  ogg: 'ogg',
};

export function deviceProfile(caps: DeviceCapabilities, flavor: MediaBrowserFlavor): Rec {
  const video = [...new Set(caps.video.map((v) => normalizeCodec(v.codec) ?? ''))].filter(Boolean);
  const audio = [...new Set(caps.audio.map((a) => normalizeCodec(a) ?? ''))].filter(Boolean);
  const hlsVideo = HLS_VIDEO.filter((c) => video.includes(c));
  const hlsAudio = HLS_AUDIO.filter((c) => audio.includes(c));
  // H.264 and AAC are the baseline every HLS-capable browser decodes.
  const tVideo = hlsVideo.length ? hlsVideo : ['h264'];
  const tAudio = hlsAudio.length ? hlsAudio : ['aac'];
  const fmp4 = tVideo.some((c) => c !== 'h264');
  const directPlay = flavor.allowDirectPlay
    ? caps.containers
        .filter((c) => c !== 'hls')
        .map((c) => ({
          Container: FILE_CONTAINERS[c] ?? c,
          Type: 'Video',
          VideoCodec: video.join(','),
          AudioCodec: audio.join(','),
        }))
    : [];
  const codecProfiles: Rec[] = [];
  for (const v of caps.video) {
    if (v.maxHeight !== undefined) {
      codecProfiles.push({
        Type: 'Video',
        Codec: normalizeCodec(v.codec),
        Conditions: [
          { Condition: 'LessThanEqual', Property: 'Height', Value: String(v.maxHeight) },
        ],
      });
    }
  }
  if (caps.maxHeight !== undefined) {
    codecProfiles.push({
      Type: 'Video',
      Conditions: [
        { Condition: 'LessThanEqual', Property: 'Height', Value: String(caps.maxHeight) },
      ],
    });
  }
  return {
    Name: 'Cinewren browser',
    MaxStreamingBitrate: MAX_STREAMING_BITRATE,
    MaxStaticBitrate: MAX_STREAMING_BITRATE,
    DirectPlayProfiles: directPlay,
    TranscodingProfiles: [
      {
        Container: fmp4 ? 'mp4' : 'ts',
        Type: 'Video',
        VideoCodec: tVideo.join(','),
        AudioCodec: tAudio.join(','),
        Context: 'Streaming',
        Protocol: 'hls',
        MinSegments: 1,
        BreakOnNonKeyFrames: true,
      },
    ],
    ContainerProfiles: [],
    CodecProfiles: codecProfiles,
    SubtitleProfiles: [
      ...TEXT_SUBTITLES.map((f) => ({ Format: f, Method: 'External' })),
      { Format: 'vtt', Method: 'External' },
      ...IMAGE_SUBTITLES.map((f) => ({ Format: f, Method: 'Encode' })),
    ],
  };
}

// --- negotiation (FR-PLAY-001, FR-PLAY-006) ---

interface SessionRef {
  i: string;
  m: string;
  p: string;
  pm: 'DirectPlay' | 'DirectStream' | 'Transcode';
}

function encodeRef(ref: SessionRef): string {
  return JSON.stringify(ref);
}

function decodeRef(raw: string | undefined): SessionRef | null {
  if (!raw) return null;
  try {
    const r = asRec(JSON.parse(raw));
    const i = text(r?.i);
    const m = text(r?.m);
    const p = text(r?.p) ?? '';
    const pm = r?.pm;
    if (!i || !m || (pm !== 'DirectPlay' && pm !== 'DirectStream' && pm !== 'Transcode'))
      return null;
    return { i, m, p, pm };
  } catch {
    return null;
  }
}

/** True when the origin re-encodes the video (versus a remux with the video copied). */
export function isVideoTranscode(url: URL, sourceVideoCodec: string | undefined): boolean {
  const reasons = (url.searchParams.get('TranscodeReasons') ?? '').split(',').filter(Boolean);
  if (reasons.some((r) => /^(Video|Subtitle|Interlaced|Refframes|Anamorphic)/i.test(r))) {
    return true;
  }
  const target = (url.searchParams.get('VideoCodec') ?? '')
    .split(',')
    .map((c) => normalizeCodec(c))
    .filter(Boolean);
  const source = normalizeCodec(sourceVideoCodec);
  if (!source || target.length === 0 || target.includes('copy')) return false;
  return !target.includes(source);
}

/** An origin-relative URL from PlaybackInfo, made absolute with the session token carrier. */
function originUrl(
  ctx: ProviderContext,
  flavor: MediaBrowserFlavor,
  pathAndQuery: string,
  token: string,
): URL {
  const url = resolveOriginUrl(ctx.server.baseUrl, pathAndQuery);
  // Exactly one carrier, the one this provider accepts (spike row 1b).
  url.searchParams.delete('api_key');
  url.searchParams.delete('ApiKey');
  url.searchParams.delete('X-Emby-Token');
  url.searchParams.set(flavor.tokenParam, token);
  return url;
}

function isStaticStream(url: URL): boolean {
  return (
    /\/stream(\.[a-z0-9]+)?$/i.test(url.pathname) &&
    (url.searchParams.get('static') ?? url.searchParams.get('Static') ?? '').toLowerCase() ===
      'true'
  );
}

export async function negotiate(
  ctx: ProviderContext,
  flavor: MediaBrowserFlavor,
  req: NegotiateRequest,
): Promise<NegotiatedStream> {
  const { cred } = req;
  if (!cred.accountId) throw new ProviderError('PROTOCOL', 'Incomplete session credential.', false);
  const subtitleIndex = req.subtitle ? req.subtitle.index : -1;
  const body = {
    UserId: cred.accountId,
    DeviceProfile: deviceProfile(req.caps, flavor),
    MaxStreamingBitrate: MAX_STREAMING_BITRATE,
    StartTimeTicks: Math.max(0, Math.floor((req.startPositionMs ?? 0) * TICKS_PER_MS)),
    MediaSourceId: req.providerVersionId,
    ...(req.audioIndex === undefined ? {} : { AudioStreamIndex: req.audioIndex }),
    SubtitleStreamIndex: subtitleIndex,
    EnableDirectPlay: flavor.allowDirectPlay,
    // Progressive "direct stream" is off for both: Jellyfin's is not token-gated, and an MKV
    // remux is only playable in a browser as HLS. Remux happens inside HLS (stream copy).
    EnableDirectStream: false,
    EnableTranscoding: true,
    AllowVideoStreamCopy: true,
    AllowAudioStreamCopy: true,
    AutoOpenLiveStream: false,
  };
  const res = await ctx.fetch(
    `/Items/${encodeURIComponent(req.providerItemId)}/PlaybackInfo?UserId=${encodeURIComponent(cred.accountId)}`,
    {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: authHeader(cred.deviceId ?? 'cinewren-ps-unknown', cred.token),
      },
      body: JSON.stringify(body),
    },
  );
  if (!res.ok) {
    await res.body?.cancel();
    throw statusError(res.status);
  }
  const info = await readJson(res);
  const sources = Array.isArray(info.MediaSources) ? info.MediaSources.map(asRec) : [];
  const ms =
    sources.find((s) => s && text(s.Id) === req.providerVersionId) ??
    (sources.length === 1 ? sources[0] : null);
  if (!ms) throw new ProviderError('NOT_FOUND', 'The origin has no such version.', false);
  const mediaSourceId = text(ms.Id) ?? req.providerVersionId;
  const playSessionId = text(info.PlaySessionId) ?? '';
  const streams = Array.isArray(ms.MediaStreams)
    ? ms.MediaStreams.map(asRec).filter((s): s is Rec => s !== null)
    : [];
  const video = streams.find((s) => s.Type === 'Video');
  const sourceVideo = normalizeCodec(text(video?.Codec));
  const audioIndex = req.audioIndex ?? num(ms.DefaultAudioStreamIndex);
  const audioStream = streams.find((s) => s.Type === 'Audio' && num(s.Index) === audioIndex);

  const directUrl = text(ms.DirectStreamUrl);
  const transcodingUrl = text(ms.TranscodingUrl);
  let mode: NegotiatedStream['mode'];
  let streamType: NegotiatedStream['streamType'];
  let url: URL;
  if (
    flavor.allowDirectPlay &&
    ms.SupportsDirectPlay === true &&
    directUrl &&
    !/\.m3u8(\?|$)/i.test(directUrl) &&
    req.subtitle?.kind !== 'image'
  ) {
    // Emby: `/videos/{id}/original.{ext}?...&api_key=` is token-gated (verified T1.1).
    url = originUrl(ctx, flavor, directUrl, cred.token);
    mode = 'direct_play';
    streamType = 'progressive';
  } else {
    const hls = transcodingUrl ?? (directUrl && /\.m3u8(\?|$)/i.test(directUrl) ? directUrl : null);
    if (hls) {
      url = originUrl(ctx, flavor, hls, cred.token);
    } else if (ms.SupportsTranscoding !== false) {
      // The origin judged the file directly playable but direct play is not allowed (Jellyfin):
      // ask for the HLS remux explicitly, copying both streams.
      const sourceAudio = normalizeCodec(text(audioStream?.Codec));
      const caps = new Set(req.caps.audio.map((a) => normalizeCodec(a)));
      const q = new URLSearchParams({
        MediaSourceId: mediaSourceId,
        PlaySessionId: playSessionId,
        DeviceId: cred.deviceId ?? '',
        VideoCodec: sourceVideo && HLS_VIDEO.includes(sourceVideo) ? sourceVideo : 'h264',
        AudioCodec: sourceAudio && caps.has(sourceAudio) ? sourceAudio : 'aac',
        SegmentContainer: sourceVideo && sourceVideo !== 'h264' ? 'mp4' : 'ts',
        AllowVideoStreamCopy: 'true',
        AllowAudioStreamCopy: 'true',
        ...(audioIndex === undefined ? {} : { AudioStreamIndex: String(audioIndex) }),
        ...(req.subtitle?.kind === 'image'
          ? { SubtitleStreamIndex: String(req.subtitle.index), SubtitleMethod: 'Encode' }
          : {}),
      });
      url = originUrl(
        ctx,
        flavor,
        `/Videos/${encodeURIComponent(req.providerItemId)}/master.m3u8?${q.toString()}`,
        cred.token,
      );
    } else {
      throw new ProviderError('UNSUPPORTED', 'The origin offered no playable stream.', false);
    }
    streamType = 'hls';
    mode = isVideoTranscode(url, sourceVideo) ? 'transcode' : 'direct_stream';
  }
  if (!flavor.allowDirectPlay && (streamType !== 'hls' || isStaticStream(url))) {
    // Never hand out an unauthenticated static stream (ADR-0013 Jellyfin amendment).
    throw new ProviderError(
      'PROTOCOL',
      'The origin offered only an unauthenticated stream.',
      false,
    );
  }

  const subtitleUrls: Record<number, string> = {};
  for (const s of streams) {
    if (s.Type !== 'Subtitle' || s.IsTextSubtitleStream !== true) continue;
    const index = num(s.Index);
    if (index === undefined) continue;
    const delivery = text(s.DeliveryUrl);
    const path =
      delivery ??
      `/Videos/${encodeURIComponent(req.providerItemId)}/${encodeURIComponent(mediaSourceId)}/Subtitles/${index}/0/Stream.vtt`;
    subtitleUrls[index] = originUrl(ctx, flavor, path, cred.token).toString();
  }

  const ref: SessionRef = {
    i: req.providerItemId,
    m: mediaSourceId,
    p: playSessionId,
    pm:
      mode === 'direct_play'
        ? 'DirectPlay'
        : mode === 'direct_stream'
          ? 'DirectStream'
          : 'Transcode',
  };
  return {
    mode,
    streamType,
    url: url.toString(),
    subtitleUrls,
    providerSessionRef: encodeRef(ref),
  };
}

// --- telemetry (FR-PLAY-009) ---

const TELEMETRY_PATH = {
  start: '/Sessions/Playing',
  progress: '/Sessions/Playing/Progress',
  stop: '/Sessions/Playing/Stopped',
} as const;

export async function report(
  ctx: ProviderContext,
  cred: SessionCredential,
  ev: PlaybackEvent,
): Promise<void> {
  const ref = decodeRef(ev.stream.providerSessionRef);
  if (!ref) throw new ProviderError('PROTOCOL', 'No negotiated stream to report on.', false);
  const body = {
    ItemId: ref.i,
    MediaSourceId: ref.m,
    PlaySessionId: ref.p,
    PositionTicks: Math.max(0, Math.floor(ev.positionMs * TICKS_PER_MS)),
    PlayMethod: ref.pm,
    CanSeek: true,
    IsPaused: ev.paused === true,
    IsMuted: false,
    ...(ev.type === 'progress' ? { EventName: ev.paused ? 'pause' : 'timeupdate' } : {}),
  };
  const res = await ctx.fetch(TELEMETRY_PATH[ev.type], {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: authHeader(cred.deviceId ?? 'cinewren-ps-unknown', cred.token),
    },
    body: JSON.stringify(body),
  });
  await res.body?.cancel();
  if (!res.ok) throw statusError(res.status);
}
