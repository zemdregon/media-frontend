/**
 * The play request, session events and manual progress (WF-5, WF-6; FR-PLAY-001 to FR-PLAY-010,
 * FR-PROG-001 to FR-PROG-003, BR-1, BR-5, BR-7, BR-9; LLD-SEL, LLD-TOKEN, LLD-API).
 *
 * Order of a play request:
 *  1. BR-1 first: the item and every candidate come from the visibility predicate. Origins do not
 *     enforce library grants on stream or PlaybackInfo endpoints (ADR-0013 amendment), so this is
 *     the only gate between a viewer and a library they were not granted.
 *  2. BR-5 selection (pure, `select.ts`).
 *  3. Per candidate, at most two (LLD-SEL): lease a DeviceId (pooled providers), mint the
 *     session credential, insert the session row, negotiate with the device profile, check that
 *     every URL is on the registered origin host (FR-PLAY-008).
 *  4. The descriptor: the stream URL carries only the session credential (FR-PLAY-007).
 */
import type {
  AudioTrackEntry,
  PlaybackDescriptor,
  ProgressResponse,
  ReasonCode,
  SubtitleTrackEntry,
} from '@cinewren/shared';
import type { z } from 'zod';
import type { playRequestSchema, playbackEventSchema } from '@cinewren/shared';
import { AppError } from '../api/errors';
import type { Viewer } from '../db/catalog';
import { recordOriginFailure } from '../health/probe';
import {
  acceptEvent,
  acceptFinalEvent,
  endSession,
  getPlaybackServer,
  getProgress,
  getUserSession,
  getVisiblePlayItem,
  insertSession,
  leaseDeviceSlot,
  releaseLease,
  seriesEpisodes,
  setNegotiated,
  sourceStillVisible,
  visibleCandidates,
  type PlayableItemRow,
  type SessionRow,
} from '../db/playback';
import { ProviderError } from '../providers/errors';
import { getPlaybackProvider } from '../providers/registry';
import type { NegotiatedStream, SessionCredential } from '../providers/types';
import { originError } from '../servers/service';
import type { PlaybackDeps } from './deps';
import {
  endAndRevoke,
  openCredential,
  openPlayback,
  PlaybackUnavailableError,
  revokeSession,
  sealCredential,
} from './lifecycle';
import {
  firstEpisodeId,
  pickNextEpisode,
  recordPosition,
  resolutionLabel,
  resumePosition,
  setProgress,
  toCandidate,
  toProviderCaps,
} from './progress';
import { reasonsFor, selectCandidates, type Ranked } from './select';

export type PlayInput = z.output<typeof playRequestSchema>;
export type EventInput = z.output<typeof playbackEventSchema>;

const notFound = () => new AppError('NOT_FOUND', 'Not found.');

/** FR-PLAY-008: every URL handed to the browser is on the registered origin's own host. */
export function onOriginHost(url: string, baseUrl: URL): boolean {
  try {
    const u = new URL(url);
    return u.protocol === baseUrl.protocol && u.host === baseUrl.host;
  } catch {
    return false;
  }
}

const CODEC_LABEL: Record<string, string> = {
  h264: 'H.264',
  hevc: 'HEVC',
  h265: 'HEVC',
  av1: 'AV1',
  vp9: 'VP9',
  mpeg2video: 'MPEG-2',
};

function sourceLabel(r: Ranked): string {
  const hdr = r.c.hdr === 'none' ? '' : ` ${r.c.hdr === 'dolby_vision' ? 'Dolby Vision' : 'HDR'}`;
  const codec = r.c.videoCodec
    ? (CODEC_LABEL[r.c.videoCodec.toLowerCase()] ?? r.c.videoCodec.toUpperCase())
    : null;
  return `${resolutionLabel(r.c.height)}${hdr}${codec ? ` · ${codec}` : ''}`;
}

function audioLabel(a: Ranked['c']['audio'][number]): string {
  if (a.title) return a.title;
  const ch =
    a.channels === null
      ? ''
      : a.channels >= 6
        ? ` ${a.channels - 1}.1`
        : a.channels === 2
          ? ' stereo'
          : a.channels === 1
            ? ' mono'
            : '';
  const codec = a.codec ? ` (${a.codec.toUpperCase()})` : '';
  return `${a.language ?? 'Unknown'}${ch}${codec}`.trim();
}

function tracksOf(
  r: Ranked,
  stream: NegotiatedStream,
): { audio: AudioTrackEntry[]; subtitles: SubtitleTrackEntry[] } {
  return {
    audio: r.c.audio.map((a) => ({
      index: a.index,
      label: audioLabel(a),
      language: a.language,
      codec: a.codec,
      channels: a.channels,
      selected: r.audio?.index === a.index,
    })),
    subtitles: r.c.subtitles.map((s) => ({
      index: s.index,
      label: s.title ?? s.language ?? `Track ${s.index}`,
      language: s.language,
      kind: s.kind,
      forced: s.forced,
      url: s.kind === 'text' ? (stream.subtitleUrls[s.index] ?? null) : null,
      selected: r.subtitle?.index === s.index,
    })),
  };
}

/** Resolves a series (or season) to the episode to play (LLD-SEL: `nextEpisode`). */
async function playTarget(
  deps: PlaybackDeps,
  viewer: Viewer,
  item: PlayableItemRow,
): Promise<PlayableItemRow> {
  if (item.type === 'movie' || item.type === 'episode') return item;
  let seriesId = item.id;
  if (item.type === 'season') {
    const parent = item.parent_id
      ? await getVisiblePlayItem(deps.db, viewer, item.parent_id)
      : null;
    if (!parent)
      throw new AppError('NO_PLAYABLE_SOURCE', 'Nothing here can be played right now.', {
        reason: 'none_available',
      });
    seriesId = parent.id;
  }
  const episodes = await seriesEpisodes(deps.db, viewer, seriesId);
  const id = pickNextEpisode(episodes) ?? firstEpisodeId(episodes);
  const target = id ? await getVisiblePlayItem(deps.db, viewer, id) : null;
  if (!target) {
    throw new AppError('NO_PLAYABLE_SOURCE', 'Nothing here can be played right now.', {
      reason: 'none_available',
    });
  }
  return target;
}

interface Attempt {
  sessionId: string;
  stream: NegotiatedStream;
  authExpiresAt: number;
}

/** One candidate: lease, mint, insert, negotiate, verify. Cleans up after itself on failure. */
async function attempt(
  deps: PlaybackDeps,
  viewer: Viewer,
  item: PlayableItemRow,
  r: Ranked,
  input: PlayInput,
): Promise<Attempt> {
  const { db } = deps;
  const server = await getPlaybackServer(db, r.c.serverId);
  if (!server) throw new PlaybackUnavailableError('The server is gone.');
  const opened = await openPlayback(deps, server);
  const { provider, ctx, keyring } = opened;
  const sessionId = deps.newId();
  const now = deps.now();
  let lease: { slot: number } | undefined;
  if (provider.streamDevices === 'pooled') {
    const slot = await leaseDeviceSlot(db, server.id, sessionId, deps.config.devicePoolSize, now);
    if (slot === null) {
      deps.logger.error('playback.device_pool_exhausted', { server_id: server.id });
      throw new ProviderError('UNAVAILABLE', 'No stream device is free on this server.');
    }
    lease = { slot };
  }
  let cred: SessionCredential;
  try {
    cred = await provider.createSessionCredential(ctx, sessionId, lease);
  } catch (err) {
    if (lease) await releaseLease(db, sessionId);
    throw err;
  }
  const authExpiresAt = now + deps.config.authTtlMs;
  await insertSession(db, {
    id: sessionId,
    userId: viewer.userId,
    itemId: item.id,
    sourceId: r.c.sourceId,
    serverId: server.id,
    versionId: r.c.versionId,
    mode: r.mode,
    credentialEnvelope: await sealCredential(keyring, sessionId, cred),
    replacesSessionId: input.replacesSessionId ?? null,
    decision: JSON.stringify({ predicted: r.mode, keys: r.keys }),
    now,
    authExpiresAt,
  });
  try {
    const stream = await provider.negotiatePlayback(ctx, {
      providerItemId: r.c.providerItemId,
      providerVersionId: r.c.providerVersionId,
      caps: toProviderCaps(input.capabilities),
      audioIndex: r.audio?.index,
      subtitle: r.subtitle ? { index: r.subtitle.index, kind: r.subtitle.kind } : null,
      startPositionMs: input.startPositionMs ?? undefined,
      cred,
    });
    const base = ctx.server.baseUrl;
    if (
      !onOriginHost(stream.url, base) ||
      Object.values(stream.subtitleUrls).some((u) => !onOriginHost(u, base))
    ) {
      throw new ProviderError('PROTOCOL', 'The origin offered a stream on another host.', false);
    }
    await setNegotiated(
      db,
      sessionId,
      stream.mode,
      stream.providerSessionRef ?? null,
      JSON.stringify({ predicted: r.mode, actual: stream.mode, keys: r.keys }),
    );
    return { sessionId, stream, authExpiresAt };
  } catch (err) {
    const row = await getUserSession(db, viewer.userId, sessionId);
    if (row) await endAndRevoke(deps, row, 'failed', 'negotiation_failed');
    throw err;
  }
}

/**
 * The play-outcome counter event (NFR-OBS-002, TDD §6.2 `play.decision`): one line per play
 * request with its outcome and, when a source was chosen, the selected mode. Session-level
 * outcomes are queryable from D1 (`GET /admin/metrics`).
 */
function countPlay(
  deps: PlaybackDeps,
  outcome: 'ok' | 'no_source' | 'origin_failed',
  fields: Record<string, unknown>,
): void {
  deps.logger.info('play.decision', { metric: 'play.outcome', outcome, ...fields });
}

export async function play(
  deps: PlaybackDeps,
  viewer: Viewer,
  input: PlayInput,
): Promise<PlaybackDescriptor> {
  const { db } = deps;
  // 1. BR-1 before anything else: a hidden item is indistinguishable from a missing one.
  const requested = await getVisiblePlayItem(db, viewer, input.itemId);
  if (!requested) throw notFound();
  const item = await playTarget(deps, viewer, requested);

  // A replacement (FR-PLAY-004): the old session is ended and revoked first.
  if (input.replacesSessionId) {
    const old = await getUserSession(db, viewer.userId, input.replacesSessionId);
    if (old && (old.status === 'authorized' || old.status === 'started')) {
      await endAndRevoke(deps, old, 'ended', 'replaced');
    }
  }

  // 2. BR-5 over the visible candidates that have a playback adapter.
  const visible = (await visibleCandidates(db, viewer, item.id))
    .map(toCandidate)
    .filter((c) => getPlaybackProvider(c.serverType) !== null);
  const prefs = input.preferences;
  const outcome = selectCandidates(
    visible,
    toProviderCaps(input.capabilities),
    prefs,
    input.excludeSourceIds,
  );
  if (!outcome.ok) {
    countPlay(deps, 'no_source', {
      reason: outcome.error === 'not_found' ? 'not_found' : outcome.reason,
    });
    if (outcome.error === 'not_found') throw notFound();
    throw new AppError('NO_PLAYABLE_SOURCE', 'No copy of this title can be played right now.', {
      reason: outcome.reason,
    });
  }

  // 3. Negotiate, failing over to the next candidate on origin trouble (FR-PLAY-004).
  let lastError: unknown = null;
  const tries = outcome.ranked.slice(0, deps.config.maxAttempts);
  for (const [i, r] of tries.entries()) {
    let result: Attempt;
    try {
      result = await attempt(deps, viewer, item, r, input);
    } catch (err) {
      const retryable =
        (err instanceof ProviderError && err.retryable) || err instanceof PlaybackUnavailableError;
      if (!retryable) throw err instanceof ProviderError ? originError(err) : err;
      deps.logger.warn('playback.candidate_failed', {
        server_id: r.c.serverId,
        source_id: r.c.sourceId,
        code: err instanceof ProviderError ? err.code : 'UNAVAILABLE',
      });
      lastError = err;
      // LLD-SYNC: a play-time origin failure counts toward the server's health at once.
      await recordOriginFailure(deps, r.c.serverId).catch((e: unknown) => {
        deps.logger.error('probe.record_failed', { server_id: r.c.serverId, error: e });
      });
      continue;
    }
    // 4. The descriptor.
    const progress = await getProgress(db, viewer.userId, item.id);
    const resume = resumePosition(progress, deps.config.resumeFloorMs);
    const reasons: ReasonCode[] = reasonsFor(r, {
      ranked: outcome.ranked,
      maxHeight: outcome.maxHeight,
      manual: outcome.manual,
      failedBefore: i > 0 || outcome.excluded,
      actualMode: result.stream.mode,
    });
    const tracks = tracksOf(r, result.stream);
    countPlay(deps, 'ok', {
      mode: result.stream.mode,
      predicted_mode: r.mode,
      server_id: r.c.serverId,
      source_id: r.c.sourceId,
      candidates: outcome.ranked.length,
      failover: i > 0,
    });
    return {
      sessionId: result.sessionId,
      expiresAt: result.authExpiresAt,
      item: { id: item.id, title: item.title, runtimeMs: item.runtime_ms ?? r.c.runtimeMs },
      source: {
        id: r.c.sourceId,
        versionId: r.c.versionId,
        serverName: r.c.serverName,
        label: sourceLabel(r),
      },
      mode: result.stream.mode,
      streamUrl: result.stream.url,
      streamType: result.stream.streamType,
      audioTracks: tracks.audio,
      subtitleTracks: tracks.subtitles,
      resume: resume === null ? null : { positionMs: resume },
      reasons,
      alternatives: outcome.ranked.length - 1,
    };
  }
  countPlay(deps, 'origin_failed', { candidates: tries.length });
  if (lastError instanceof ProviderError) throw originError(lastError);
  throw new AppError('ORIGIN_UNAVAILABLE', 'The server could not be reached.');
}

// --- session events (WF-6, FR-PLAY-009, BR-9) ---

function streamOf(s: SessionRow): NegotiatedStream | null {
  if (!s.provider_session_ref) return null;
  return {
    mode: s.mode,
    streamType: s.mode === 'direct_play' ? 'progressive' : 'hls',
    url: '',
    subtitleUrls: {},
    providerSessionRef: s.provider_session_ref,
  };
}

const sessionExpired = () =>
  new AppError('SESSION_EXPIRED', 'This playback session has ended. Start playback again.');

/**
 * Handles one client event. Returns work that must run after the response (telemetry, the
 * stop-then-revoke sequence); the route hands it to `waitUntil`.
 */
export async function handleEvent(
  deps: PlaybackDeps,
  viewer: Viewer,
  sessionId: string,
  ev: EventInput,
): Promise<(() => Promise<void>) | null> {
  const { db } = deps;
  const now = deps.now();
  const session = await getUserSession(db, viewer.userId, sessionId);
  if (!session) throw notFound();
  if (session.status !== 'authorized' && session.status !== 'started') throw sessionExpired();
  // BR-9 windows are enforced on the request too, not only by the sweep.
  const idleSince = session.last_progress_at ?? session.started_at ?? session.authorized_at;
  if (
    (session.status === 'authorized' && session.auth_expires_at < now) ||
    (session.status === 'started' && idleSince < now - deps.config.idleTimeoutMs)
  ) {
    await endAndRevoke(
      deps,
      session,
      'expired',
      session.status === 'authorized' ? 'not_started' : 'idle',
    );
    throw sessionExpired();
  }
  // BR-1 holds for the whole session, not only at play time (T5.8 SR-06): once the grant, the
  // library or the server is gone, keep-alive events must not keep the stream credential alive.
  if (!session.source_id || !(await sourceStillVisible(db, viewer, session.source_id))) {
    await endAndRevoke(deps, session, 'ended', 'access_revoked');
    throw sessionExpired();
  }

  const terminal = ev.type === 'stop' || ev.type === 'error';
  const accepted = terminal
    ? await acceptFinalEvent(db, sessionId, ev.seq, now)
    : await acceptEvent(db, sessionId, ev.seq, now);
  if (!accepted) {
    // A duplicate or out-of-order event is acknowledged and ignored, unless the session ended.
    const fresh = await getUserSession(db, viewer.userId, sessionId);
    if (fresh && fresh.status !== 'authorized' && fresh.status !== 'started') {
      throw sessionExpired();
    }
    return null;
  }

  // Progress for every positional report (FR-PROG-001), one row per user per canonical item.
  // `start` is not a report: the player may not have sought to the resume point yet, and
  // storing its position would wipe the stored one.
  if (session.media_item_id && ev.type !== 'error' && ev.type !== 'start') {
    const item = await getVisiblePlayItem(db, viewer, session.media_item_id);
    await recordPosition(db, {
      userId: viewer.userId,
      itemId: session.media_item_id,
      positionMs: ev.positionMs,
      runtimeMs: item?.runtime_ms ?? null,
      sourceId: session.source_id,
      now,
    });
  }

  if (terminal) {
    const to = ev.type === 'stop' ? 'ended' : 'failed';
    const won = await endSession(
      db,
      sessionId,
      to,
      ev.type === 'stop' ? 'stop' : 'client_error',
      now,
    );
    if (!won) return null;
    // Stop first, then logout (LLD-TOKEN), after the response.
    return async () => {
      await revokeSession(deps, session, ev.positionMs);
    };
  }

  const stream = streamOf(session);
  if (!stream || !session.server_id) return null;
  const serverId = session.server_id;
  const envelope = session.credential_envelope;
  // The first accepted event starts the session on the origin too; later ones are progress.
  const type = session.status === 'authorized' ? 'start' : 'progress';
  return async () => {
    try {
      const server = await getPlaybackServer(db, serverId);
      if (!server || !envelope) return;
      const opened = await openPlayback(deps, server);
      const cred = await openCredential(opened.keyring, sessionId, envelope);
      if (!cred) return;
      await opened.provider.reportPlayback(opened.ctx, cred, {
        type,
        positionMs: ev.positionMs,
        stream,
        paused: ev.type === 'pause',
      });
    } catch (err) {
      // Telemetry is best effort (FR-PLAY-009); it never fails the user's playback.
      if (!(err instanceof ProviderError) && !(err instanceof PlaybackUnavailableError)) throw err;
      deps.logger.warn('playback.telemetry_failed', {
        session_id: sessionId,
        code: err instanceof ProviderError ? err.code : 'UNAVAILABLE',
      });
    }
  };
}

// --- manual progress (FR-PROG-003) ---

export async function putProgress(
  deps: PlaybackDeps,
  viewer: Viewer,
  itemId: string,
  update: { watched: boolean } | { positionMs: number },
): Promise<ProgressResponse> {
  const item = await getVisiblePlayItem(deps.db, viewer, itemId);
  if (!item) throw notFound();
  if (item.type !== 'movie' && item.type !== 'episode') {
    throw new AppError('VALIDATION_FAILED', 'Progress is kept for movies and episodes.', {
      fields: ['itemId'],
    });
  }
  return setProgress(deps.db, {
    userId: viewer.userId,
    itemId,
    runtimeMs: item.runtime_ms,
    now: deps.now(),
    update,
  });
}
