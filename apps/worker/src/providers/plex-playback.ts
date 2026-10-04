/**
 * Plex playback (IR-005, FR-PLAY-001, FR-PLAY-007, FR-PLAY-009; ADR-0013, Plex amendment).
 * Verified against Plex Media Server 1.43.4 with an owner token only: the managed-user token model
 * is NOT verified (B-3), so the adapter ships with `playbackVerified: false` and selection never
 * reaches this code. It exists, and is tested with the flag on, so B-3 is a flag flip plus the
 * checks listed in the Plex adapter header.
 *
 * - Credential: the managed user's own token, `shared_restricted` (one token for all sessions, so
 *   revoking is a no-op and the token can be rotated only by the owner on plex.tv). Owner tokens
 *   and owner-derived transient tokens (`/security/token?type=delegation`) are never used: the
 *   spike showed they carry admin rights. Before each issue the token is re-probed for admin
 *   rights, so a managed user promoted later is refused.
 * - Negotiation: the universal transcode decision endpoint decides direct play, remux or
 *   transcode; HLS `start.m3u8` carries the token in the query. HLS child playlists and segments
 *   are anonymous by session path (spike), so `reportPlayback(stop)` ends the transcode.
 * - Subtitles: no WebVTT is offered. A sidecar arrives as raw SRT and embedded text tracks return
 *   501 (spike); Worker-side SRT to WebVTT conversion is later work. Image tracks are burned in.
 */
import { ProviderError } from './errors';
import { statusError } from './origin-fetch';
import type {
  DeviceCapabilities,
  NegotiatedStream,
  NegotiateRequest,
  PlaybackEvent,
  ProviderContext,
  SessionCredential,
} from './types';

/**
 * One stable client identifier: every new `X-Plex-Client-Identifier` registers a device on the
 * server (spike, Plex criterion 1), so sessions are told apart by the session identifier only.
 */
export const PLEX_CLIENT_ID = 'cinewren-svc-main';
const PRODUCT = 'Cinewren';
const CLIENT_VERSION = '0.0.1';

type Rec = Record<string, unknown>;
const asRec = (v: unknown): Rec | null =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Rec) : null;
const asArr = (v: unknown): unknown[] => (Array.isArray(v) ? (v as unknown[]) : []);
const recs = (v: unknown): Rec[] =>
  asArr(v).flatMap((x) => {
    const r = asRec(x);
    return r ? [r] : [];
  });
const asStr = (v: unknown): string | undefined =>
  typeof v === 'string' && v !== '' ? v : undefined;
const asId = (v: unknown): string | undefined =>
  typeof v === 'string' && v !== '' ? v : typeof v === 'number' ? String(v) : undefined;

export function plexHeaders(token: string | undefined, session?: string): Record<string, string> {
  return {
    Accept: 'application/json',
    'X-Plex-Client-Identifier': PLEX_CLIENT_ID,
    'X-Plex-Product': PRODUCT,
    'X-Plex-Version': CLIENT_VERSION,
    'X-Plex-Platform': 'Web',
    'X-Plex-Device': 'Cinewren',
    ...(session ? { 'X-Plex-Session-Identifier': session } : {}),
    ...(token ? { 'X-Plex-Token': token } : {}),
  };
}

function tokenOf(ctx: ProviderContext): string {
  if (ctx.secret.kind !== 'token') {
    throw new ProviderError('UNSUPPORTED', 'Plex needs the access token of a managed user.', false);
  }
  return ctx.secret.token;
}

// --- session credential (FR-PLAY-007, ADR-0013) ---

/**
 * True when the token can do something only an administrator can: `GET /:/prefs` (the spike's
 * owner-token finding). 401 and 403 mean a restricted user. Anything else is not a confirmation.
 */
export async function tokenIsAdmin(
  ctx: ProviderContext,
  token: string,
): Promise<boolean | 'unknown'> {
  const res = await ctx.fetch('/:/prefs', { headers: plexHeaders(token) });
  await res.body?.cancel();
  if (res.status === 200) return true;
  if (res.status === 401 || res.status === 403) return false;
  return 'unknown';
}

export async function issueManagedUserCredential(ctx: ProviderContext): Promise<SessionCredential> {
  const token = tokenOf(ctx);
  // Defence in depth (NFR-SEC-001): never hand a browser a token with admin rights.
  if ((await tokenIsAdmin(ctx, token)) !== false) {
    throw new ProviderError('AUTH', 'The Plex account is not a restricted account.', false);
  }
  return { kind: 'shared_restricted', token, deviceId: PLEX_CLIENT_ID };
}

// --- negotiation (FR-PLAY-001, FR-PLAY-006) ---

const CONTAINER_NAMES: Record<string, string> = { mkv: 'mkv', mp4: 'mp4', webm: 'webm' };

/** The `X-Plex-Client-Profile-Extra` value for these device capabilities (spike, transcode row). */
export function clientProfileExtra(caps: DeviceCapabilities): string {
  const video = caps.video.map((v) => v.codec).filter((c) => /^[a-z0-9]+$/.test(c));
  const audio = caps.audio.filter((c) => /^[a-z0-9]+$/.test(c));
  const parts: string[] = [];
  for (const container of caps.containers) {
    const name = CONTAINER_NAMES[container];
    if (!name || video.length === 0) continue;
    parts.push(
      `add-direct-play-profile(type=videoProfile&container=${name}&videoCodec=${video.join(',')}${
        audio.length > 0 ? `&audioCodec=${audio.join(',')}` : ''
      })`,
    );
  }
  const targetVideo = video.includes('h264') ? 'h264' : (video[0] ?? 'h264');
  const targetAudio = audio.includes('aac') ? 'aac' : (audio[0] ?? 'aac');
  parts.push(
    `add-transcode-target(type=videoProfile&context=streaming&protocol=hls&container=mpegts&videoCodec=${targetVideo}&audioCodec=${targetAudio})`,
  );
  return parts.join('+');
}

function originUrl(ctx: ProviderContext, pathAndQuery: string): string {
  const base = ctx.server.baseUrl;
  return `${base.origin}${base.pathname.replace(/\/+$/, '')}${pathAndQuery}`;
}

/** `ratingKey|durationMs|sessionId|transcode?`: opaque to callers, no credential inside. */
function encodeRef(ratingKey: string, durationMs: number, session: string, hls: boolean): string {
  return [ratingKey, String(durationMs), session, hls ? '1' : '0'].join('|');
}
function decodeRef(
  ref: string | undefined,
): { ratingKey: string; durationMs: number; session: string; hls: boolean } | null {
  const [ratingKey, duration, session, hls] = (ref ?? '').split('|');
  if (!ratingKey || !session || !/^\d+$/.test(duration ?? '')) return null;
  return { ratingKey, durationMs: Number(duration), session, hls: hls === '1' };
}

export async function negotiate(
  ctx: ProviderContext,
  req: NegotiateRequest,
): Promise<NegotiatedStream> {
  const token = req.cred.token;
  const id = req.providerItemId;
  const metaRes = await ctx.fetch(`/library/metadata/${encodeURIComponent(id)}`, {
    headers: plexHeaders(token),
  });
  if (!metaRes.ok) {
    await metaRes.body?.cancel();
    throw statusError(metaRes.status);
  }
  const meta = asRec(asRec(await metaRes.json().catch(() => null))?.MediaContainer);
  const item = asRec(asArr(meta?.Metadata)[0]);
  const medias = recs(item?.Media);
  const mediaIndex = medias.findIndex((m) => asId(m.id) === req.providerVersionId);
  const media = medias[mediaIndex];
  const part = asRec(asArr(media?.Part)[0]);
  const partKey = asStr(part?.key);
  if (!item || !media || !partKey) {
    throw new ProviderError('NOT_FOUND', 'The origin has no such version.', false);
  }
  const durationMs =
    typeof media.duration === 'number' && Number.isFinite(media.duration) ? media.duration : 0;

  const session = `cinewren-${crypto.randomUUID()}`;
  const burn = req.subtitle?.kind === 'image';
  const q = new URLSearchParams({
    path: `/library/metadata/${id}`,
    mediaIndex: String(mediaIndex),
    partIndex: '0',
    protocol: 'hls',
    fastSeek: '1',
    directPlay: '1',
    directStream: '1',
    subtitleSize: '100',
    audioBoost: '100',
    location: 'wan',
    session,
    subtitles: burn ? 'burn' : 'none',
    copyts: '1',
    'X-Plex-Client-Identifier': PLEX_CLIENT_ID,
    'X-Plex-Session-Identifier': session,
    'X-Plex-Product': PRODUCT,
    'X-Plex-Platform': 'Chrome',
    'X-Plex-Client-Profile-Extra': clientProfileExtra(req.caps),
  });
  if (req.audioIndex !== undefined) q.set('audioStreamID', String(req.audioIndex));
  if (burn && req.subtitle) q.set('subtitleStreamID', String(req.subtitle.index));
  if (req.caps.maxWidth && req.caps.maxHeight) {
    q.set('videoResolution', `${req.caps.maxWidth}x${req.caps.maxHeight}`);
  }
  if (req.startPositionMs) q.set('offset', String(Math.floor(req.startPositionMs / 1000)));

  const decisionRes = await ctx.fetch(`/video/:/transcode/universal/decision?${q.toString()}`, {
    headers: plexHeaders(token, session),
  });
  if (!decisionRes.ok) {
    await decisionRes.body?.cancel();
    throw statusError(decisionRes.status);
  }
  const decided = asRec(asRec(await decisionRes.json().catch(() => null))?.MediaContainer);
  const decidedMedia = asRec(asArr(asRec(asArr(decided?.Metadata)[0])?.Media)[0]);
  const decidedPart = asRec(asArr(decidedMedia?.Part)[0]);
  const partDecision = asStr(decidedPart?.decision);
  if (!decidedPart || !partDecision) {
    throw new ProviderError('PROTOCOL', 'The origin sent an unexpected playback decision.', false);
  }

  if (partDecision === 'directplay') {
    const direct = new URLSearchParams({ 'X-Plex-Token': token });
    return {
      mode: 'direct_play',
      streamType: 'progressive',
      url: originUrl(ctx, `${partKey}?${direct.toString()}`),
      subtitleUrls: {},
      providerSessionRef: encodeRef(id, durationMs, session, false),
    };
  }
  const videoStream = recs(decidedPart.Stream).find(
    (s) => s.streamType === 1 || s.streamType === '1',
  );
  const mode = asStr(videoStream?.decision) === 'transcode' ? 'transcode' : 'direct_stream';
  q.set('directPlay', '0');
  q.set('X-Plex-Token', token);
  return {
    mode,
    streamType: 'hls',
    url: originUrl(ctx, `/video/:/transcode/universal/start.m3u8?${q.toString()}`),
    subtitleUrls: {},
    providerSessionRef: encodeRef(id, durationMs, session, true),
  };
}

// --- telemetry (FR-PLAY-009) ---

export async function report(
  ctx: ProviderContext,
  cred: SessionCredential,
  ev: PlaybackEvent,
): Promise<void> {
  const ref = decodeRef(ev.stream.providerSessionRef);
  if (!ref) throw new ProviderError('PROTOCOL', 'Missing playback session reference.', false);
  const state = ev.type === 'stop' ? 'stopped' : ev.paused ? 'paused' : 'playing';
  const time = String(Math.max(0, Math.round(ev.positionMs)));
  const q = new URLSearchParams({
    ratingKey: ref.ratingKey,
    key: `/library/metadata/${ref.ratingKey}`,
    state,
    time,
    duration: String(ref.durationMs),
    playbackTime: time,
    'X-Plex-Client-Identifier': PLEX_CLIENT_ID,
  });
  const res = await ctx.fetch(`/:/timeline?${q.toString()}`, {
    headers: plexHeaders(cred.token, ref.session),
  });
  await res.body?.cancel();
  if (!res.ok) throw statusError(res.status);
  if (ev.type === 'stop' && ref.hls) {
    // HLS child playlists and segments are anonymous by session path until the transcode stops
    // (spike), so the stop is what ends the stream.
    const stop = await ctx.fetch(
      `/video/:/transcode/universal/stop?session=${encodeURIComponent(ref.session)}`,
      { headers: plexHeaders(cred.token, ref.session) },
    );
    await stop.body?.cancel();
    if (!stop.ok && stop.status !== 404) throw statusError(stop.status);
  }
}
