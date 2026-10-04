/**
 * Progress, watched state, next episode and the catalog views built on them (FR-PROG-001 to
 * FR-PROG-004, FR-CAT-008, FR-CAT-013, BR-7). Every read goes through the BR-1 predicate.
 */
import type {
  ContinueWatchingCard,
  DeviceCapabilitiesPayload,
  ItemCard,
  ItemCopy,
} from '@cinewren/shared';
import { deviceCapabilitiesSchema } from '@cinewren/shared';
import type { Viewer } from '../db/catalog';
import {
  continueWatching as continueRows,
  getProgress,
  itemCardById,
  seriesEpisodes,
  upsertProgressStmt,
  visibleCandidates,
  type CandidateRow,
  type CardRow,
  type EpisodeRow,
} from '../db/playback';
import type { DeviceCapabilities } from '../providers/types';
import { copyTable, type AudioInfo, type Candidate, type SubtitleInfo } from './select';

// --- BR-7 ---

const FIVE_MIN = 5 * 60_000;
const FORTY_FIVE_MIN = 45 * 60_000;

/**
 * BR-7 *(proposed)*: watched at 90 % of the runtime, or, for items longer than 45 minutes, when
 * less than 5 minutes remain. Without a known runtime nothing is marked automatically.
 */
export function reachesWatched(positionMs: number, runtimeMs: number | null): boolean {
  if (runtimeMs === null || runtimeMs <= 0) return false;
  return (
    positionMs >= 0.9 * runtimeMs ||
    (runtimeMs > FORTY_FIVE_MIN && runtimeMs - positionMs < FIVE_MIN)
  );
}

/** BR-7: resume is offered above the floor (60 s) for an item that is not watched. */
export function resumePosition(
  row: { position_ms: number; watched: number } | null,
  floorMs: number,
): number | null {
  return row && row.watched === 0 && row.position_ms > floorMs ? row.position_ms : null;
}

/**
 * Applies a reported position (FR-PROG-001). Reaching the threshold marks the item watched and
 * resets the position to 0 (LLD-TOKEN); a watched item is never un-watched by a report, only by
 * the user (FR-PROG-003).
 */
export async function recordPosition(
  db: D1Database,
  input: {
    userId: string;
    itemId: string;
    positionMs: number;
    runtimeMs: number | null;
    sourceId: string | null;
    now: number;
  },
): Promise<{ positionMs: number; watched: boolean }> {
  const existing = await getProgress(db, input.userId, input.itemId);
  const runtime = input.runtimeMs ?? existing?.runtime_ms ?? null;
  const reached = reachesWatched(input.positionMs, runtime);
  const watched = reached || existing?.watched === 1;
  const positionMs = reached ? 0 : input.positionMs;
  await upsertProgressStmt(db, {
    userId: input.userId,
    itemId: input.itemId,
    positionMs,
    runtimeMs: runtime,
    watched,
    now: input.now,
    sourceId: input.sourceId,
  }).run();
  return { positionMs, watched };
}

/** Manual override (FR-PROG-003): watched or unwatched, or an explicit position. */
export async function setProgress(
  db: D1Database,
  input: {
    userId: string;
    itemId: string;
    runtimeMs: number | null;
    now: number;
    update: { watched: boolean } | { positionMs: number };
  },
): Promise<{ positionMs: number; watched: boolean }> {
  const existing = await getProgress(db, input.userId, input.itemId);
  let positionMs: number;
  let watched: boolean;
  if ('watched' in input.update) {
    watched = input.update.watched;
    positionMs = 0;
  } else {
    positionMs = input.update.positionMs;
    watched = existing?.watched === 1;
  }
  await upsertProgressStmt(db, {
    userId: input.userId,
    itemId: input.itemId,
    positionMs,
    runtimeMs: input.runtimeMs ?? existing?.runtime_ms ?? null,
    watched,
    now: input.now,
    sourceId: null,
  }).run();
  return { positionMs, watched };
}

// --- next episode (FR-PROG-004) ---

/**
 * The episode to watch next: the episode last touched if it is still in progress, else the first
 * unwatched episode after it. With no history, the first episode. Null when everything after the
 * last watched episode is watched.
 */
export function pickNextEpisode(episodes: EpisodeRow[]): string | null {
  if (episodes.length === 0) return null;
  let last = -1;
  for (const [i, e] of episodes.entries()) {
    if (e.updated_at === null) continue;
    const best = last >= 0 ? episodes[last] : undefined;
    if (!best || (best.updated_at ?? 0) < e.updated_at) last = i;
  }
  if (last < 0) return episodes[0]?.id ?? null;
  const current = episodes[last];
  if (current && current.watched !== 1 && (current.position_ms ?? 0) > 0) return current.id;
  for (let i = last + 1; i < episodes.length; i++) {
    const e = episodes[i];
    if (e && e.watched !== 1) return e.id;
  }
  return null;
}

export async function nextEpisodeId(
  db: D1Database,
  viewer: Viewer,
  seriesId: string,
): Promise<string | null> {
  return pickNextEpisode(await seriesEpisodes(db, viewer, seriesId));
}

export function firstEpisodeId(episodes: EpisodeRow[]): string | null {
  return episodes[0]?.id ?? null;
}

export function cardOf(row: CardRow): ItemCard {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    year: row.year,
    seasonNumber: row.season_number,
    episodeNumber: row.episode_number,
    artworkUrl: row.poster_tag
      ? `/api/v1/artwork/${row.id}/poster?v=${encodeURIComponent(row.poster_tag)}`
      : null,
  };
}

export async function nextEpisodeCard(
  db: D1Database,
  viewer: Viewer,
  seriesId: string,
): Promise<ItemCard | null> {
  const id = await nextEpisodeId(db, viewer, seriesId);
  const row = id ? await itemCardById(db, viewer, id) : null;
  return row ? cardOf(row) : null;
}

// --- continue watching (FR-CAT-008) ---

export async function continueWatchingCards(
  db: D1Database,
  viewer: Viewer,
  resumeFloorMs: number,
  limit: number,
): Promise<ContinueWatchingCard[]> {
  const rows = await continueRows(db, viewer, resumeFloorMs, limit);
  return rows.map((r) => ({
    ...cardOf(r),
    progress: { positionMs: r.position_ms, runtimeMs: r.runtime_ms },
  }));
}

// --- candidates (from D1 rows to selection input) ---

type Json = Record<string, unknown>;

function parseList(raw: string): Json[] {
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v)
      ? v.filter((x): x is Json => typeof x === 'object' && x !== null && !Array.isArray(x))
      : [];
  } catch {
    return [];
  }
}

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const int = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export function toCandidate(row: CandidateRow): Candidate {
  const audio: AudioInfo[] = parseList(row.audio_tracks).flatMap((a) => {
    const index = int(a.index);
    return index === null
      ? []
      : [
          {
            index,
            codec: str(a.codec),
            channels: int(a.channels),
            language: str(a.language),
            title: str(a.title),
            default: a.default === true,
          },
        ];
  });
  const subtitles: SubtitleInfo[] = parseList(row.subtitle_tracks).flatMap((s) => {
    const index = int(s.index);
    return index === null
      ? []
      : [
          {
            index,
            format: str(s.format),
            kind: s.kind === 'image' ? ('image' as const) : ('text' as const),
            language: str(s.language),
            title: str(s.title),
            forced: s.forced === true,
            default: s.default === true,
            external: s.external === true,
          },
        ];
  });
  return {
    sourceId: row.source_id,
    versionId: row.version_id,
    providerItemId: row.provider_item_id,
    providerVersionId: row.provider_version_id,
    serverId: row.server_id,
    serverName: row.server_name,
    serverType: row.server_type,
    serverStatus: row.server_status,
    priority: row.priority,
    latencyMs: row.last_latency_ms,
    container: row.container,
    videoCodec: row.video_codec,
    width: row.width,
    height: row.height,
    hdr: row.hdr,
    sizeBytes: row.size_bytes,
    runtimeMs: row.runtime_ms,
    audio,
    subtitles,
  };
}

// --- copy table (FR-CAT-013) ---

/** "4K", "1080p" and so on (the same buckets as the catalog's version labels). */
export function resolutionLabel(height: number | null): string {
  if (height === null) return 'Unknown';
  if (height >= 2000) return '4K';
  if (height >= 1400) return '1440p';
  if (height >= 1000) return '1080p';
  if (height >= 700) return '720p';
  return 'SD';
}

export class DeviceCapsError extends Error {
  override name = 'DeviceCapsError';
}

/** Decodes the `X-Device-Caps` header: base64url JSON of the capabilities, at most 2 KB. */
export function parseDeviceCapsHeader(raw: string | undefined): DeviceCapabilities | null {
  if (raw === undefined || raw.trim() === '') return null;
  if (raw.length > 2048 || !/^[A-Za-z0-9_-]+={0,2}$/.test(raw.trim())) {
    throw new DeviceCapsError('Invalid device capabilities.');
  }
  let parsed: unknown;
  try {
    const b64 = raw.trim().replaceAll('-', '+').replaceAll('_', '/');
    const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
    parsed = JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))));
  } catch {
    throw new DeviceCapsError('Invalid device capabilities.');
  }
  const result = deviceCapabilitiesSchema.safeParse(parsed);
  if (!result.success) throw new DeviceCapsError('Invalid device capabilities.');
  return toProviderCaps(result.data);
}

export function toProviderCaps(c: DeviceCapabilitiesPayload): DeviceCapabilities {
  return {
    containers: c.containers,
    video: c.video.map((v) => ({
      codec: v.codec,
      ...(v.maxLevel === undefined ? {} : { maxLevel: v.maxLevel }),
      ...(v.maxHeight === undefined ? {} : { maxHeight: v.maxHeight }),
    })),
    audio: c.audio,
    ...(c.maxWidth === undefined ? {} : { maxWidth: c.maxWidth }),
    ...(c.maxHeight === undefined ? {} : { maxHeight: c.maxHeight }),
    hdr: c.hdr,
    textSubtitles: c.textSubtitles,
    nativeHls: c.nativeHls,
    mse: c.mse,
  };
}

export async function itemCopies(
  db: D1Database,
  viewer: Viewer,
  item: { id: string; type: string },
  caps: DeviceCapabilities | null,
): Promise<ItemCopy[]> {
  if (item.type !== 'movie' && item.type !== 'episode') return [];
  const candidates = (await visibleCandidates(db, viewer, item.id)).map(toCandidate);
  return copyTable(candidates, caps).map((row) => ({
    sourceId: row.c.sourceId,
    versionId: row.c.versionId,
    serverName: row.c.serverName,
    serverType: row.c.serverType,
    serverStatus: row.c.serverStatus,
    resolution: {
      width: row.c.width,
      height: row.c.height,
      label: resolutionLabel(row.c.height),
    },
    hdr: row.c.hdr,
    videoCodec: row.c.videoCodec,
    container: row.c.container,
    audio: row.c.audio.map((a) => ({ codec: a.codec, channels: a.channels, language: a.language })),
    sizeBytes: row.c.sizeBytes,
    expectedPlayability: row.expectedPlayability,
    reasons: row.reasons,
    selected: row.selected,
  }));
}
