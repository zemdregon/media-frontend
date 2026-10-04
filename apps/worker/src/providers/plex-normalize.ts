/**
 * Plex JSON to normalized types (LLD-PROV per-provider notes, spike sections 2 and 5). Verified
 * against Plex Media Server 1.43.4 only. Origin payloads are untrusted: every field is read
 * defensively and unknown shapes are skipped rather than thrown on.
 *
 * Facts the recordings establish and this module relies on:
 * - `ratingKey` is the opaque item ID; `Guid[].id` is `imdb://`, `tmdb://` or `tvdb://` (only with
 *   `includeGuids=1`); timestamps are Unix seconds; `duration` is milliseconds; `Media.bitrate` is
 *   kilobits per second.
 * - Credits are `Role[]`, `Director[]`, `Writer[]` and `Producer[]`. Only the item *detail*
 *   response carries `tagKey` (a plex.tv global person key) and `id`; list responses carry the
 *   `tag` (name) alone.
 * - Collections carry no external GUID, so their `externalIds` stay empty.
 */
import { MAX_CREDITS } from './jellyfin-normalize';
import type {
  ArtworkKind,
  AudioTrack,
  HdrFormat,
  ItemType,
  NormalizedCollection,
  NormalizedCredit,
  NormalizedItem,
  NormalizedVersion,
  SubtitleTrack,
} from './types';

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
const asNum = (v: unknown): number | undefined => {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  return undefined;
};
/** Plex IDs arrive as strings in JSON, but numbers are accepted too. */
const asId = (v: unknown): string | undefined =>
  typeof v === 'string' && v !== '' ? v : typeof v === 'number' ? String(v) : undefined;
const seconds = (v: unknown): number | undefined => {
  const n = asNum(v);
  return n === undefined ? undefined : Math.round(n * 1000);
};

const ITEM_TYPES: Record<string, ItemType> = {
  movie: 'movie',
  show: 'series',
  season: 'season',
  episode: 'episode',
};

/** Credits from the detail response are capped like every adapter's (LLD-PROV). */
const MAX_ACTORS = 25;

export function plexExternalIds(guids: unknown): { tmdb?: string; imdb?: string; tvdb?: string } {
  const out: { tmdb?: string; imdb?: string; tvdb?: string } = {};
  for (const entry of asArr(guids)) {
    const id = asStr(asRec(entry)?.id);
    const match = id ? /^(tmdb|imdb|tvdb):\/\/(.+)$/.exec(id) : null;
    const scheme = match?.[1] as 'tmdb' | 'imdb' | 'tvdb' | undefined;
    const value = match?.[2];
    if (scheme && value && out[scheme] === undefined) out[scheme] = value;
  }
  return out;
}

function hdrOf(video: Rec | undefined): HdrFormat {
  if (!video) return 'none';
  if (video.DOVIPresent === true || video.DOVIPresent === 1) return 'dolby_vision';
  const trc = asStr(video.colorTrc)?.toLowerCase();
  if (trc === 'smpte2084') return 'hdr10';
  if (trc === 'arib-std-b67') return 'hlg';
  return 'none';
}

const IMAGE_SUBTITLE_CODECS = new Set([
  'pgs',
  'hdmv_pgs_subtitle',
  'dvd_subtitle',
  'dvdsub',
  'vobsub',
  'dvb_subtitle',
]);

function normalizeVersion(media: Rec): NormalizedVersion | null {
  const id = asId(media.id);
  if (!id) return null;
  const parts = recs(media.Part);
  const streams = recs(parts[0]?.Stream);
  const video = streams.find((s) => s.streamType === 1);
  const audio: AudioTrack[] = [];
  const subtitles: SubtitleTrack[] = [];
  for (const s of streams) {
    // The stream `id` is what Plex's `audioStreamID` and `subtitleStreamID` take, so it is the
    // track "index" here; it is unique within the media (the `index` field is absent on sidecars).
    const index = asNum(s.id);
    if (index === undefined) continue;
    const codec = asStr(s.codec);
    const language = asStr(s.languageTag) ?? asStr(s.languageCode);
    const title = asStr(s.displayTitle);
    if (s.streamType === 2) {
      const channels = asNum(s.channels);
      audio.push({
        index,
        ...(codec ? { codec } : {}),
        ...(language ? { language } : {}),
        ...(channels === undefined ? {} : { channels }),
        ...(title ? { title } : {}),
        isDefault: s.default === true || s.default === 1 || s.selected === true,
      });
    } else if (s.streamType === 3) {
      subtitles.push({
        index,
        ...(codec ? { codec } : {}),
        ...(language ? { language } : {}),
        ...(title ? { title } : {}),
        kind: codec && IMAGE_SUBTITLE_CODECS.has(codec.toLowerCase()) ? 'image' : 'text',
        isForced: s.forced === true || s.forced === 1,
        isDefault: s.default === true || s.default === 1,
        isExternal: asStr(s.key) !== undefined,
      });
    }
  }
  const sizes = parts.map((p) => asNum(p.size)).filter((n): n is number => n !== undefined);
  const container = asStr(media.container);
  const videoCodec = asStr(media.videoCodec);
  const videoProfile = asStr(media.videoProfile);
  const width = asNum(media.width);
  const height = asNum(media.height);
  const kbps = asNum(media.bitrate);
  const runtimeMs = asNum(media.duration);
  return {
    providerVersionId: id,
    ...(container ? { container } : {}),
    ...(videoCodec ? { videoCodec } : {}),
    ...(videoProfile ? { videoProfile } : {}),
    ...(width === undefined ? {} : { width }),
    ...(height === undefined ? {} : { height }),
    hdr: hdrOf(video),
    ...(kbps === undefined ? {} : { bitrate: Math.round(kbps * 1000) }),
    ...(runtimeMs === undefined ? {} : { runtimeMs }),
    ...(sizes.length > 0 ? { sizeBytes: sizes.reduce((a, b) => a + b, 0) } : {}),
    audio,
    subtitles,
  };
}

/**
 * Billing order: actors first (capped), then directors, writers and producers. A person's ID is
 * the plex.tv global `tagKey` when the response has one (detail responses), which can merge people
 * across Plex servers (ADR-0015). List responses lack it, so the ID falls back to the server-local
 * `id`, then to the name, prefixed so a fallback can never collide with a global key.
 */
function normalizeCredits(raw: Rec): NormalizedCredit[] {
  const credits: NormalizedCredit[] = [];
  const seen = new Set<string>();
  const add = (list: unknown, role: NormalizedCredit['role'], limit: number): void => {
    let added = 0;
    for (const entry of asArr(list)) {
      if (credits.length >= MAX_CREDITS || added >= limit) return;
      const tag = asRec(entry);
      const name = asStr(tag?.tag);
      if (!tag || !name) continue;
      const localId = asId(tag.id);
      const providerPersonId = asStr(tag.tagKey) ?? (localId ? `local:${localId}` : `name:${name}`);
      const character = role === 'actor' ? asStr(tag.role) : undefined;
      const dedupe = `${role}\u0000${providerPersonId}`;
      if (seen.has(dedupe)) continue;
      seen.add(dedupe);
      credits.push({
        person: { providerPersonId, name, externalIds: {} },
        role,
        ...(character ? { character } : {}),
        order: credits.length,
      });
      added++;
    }
  };
  add(raw.Role, 'actor', MAX_ACTORS);
  add(raw.Director, 'director', MAX_CREDITS);
  add(raw.Writer, 'writer', MAX_CREDITS);
  add(raw.Producer, 'producer', MAX_CREDITS);
  return credits;
}

/**
 * Only an image that belongs to the item itself is referenced: an episode's `art` points at its
 * show, and the origin request is built from the item's own ID.
 */
function artworkOf(
  raw: Rec,
  id: string,
  kinds: [ArtworkKind, 'thumb' | 'art'][],
): Partial<Record<ArtworkKind, { providerItemId: string; tag: string }>> {
  const out: Partial<Record<ArtworkKind, { providerItemId: string; tag: string }>> = {};
  for (const [kind, field] of kinds) {
    const match = /^\/library\/metadata\/(\d+)\/(thumb|art)\/(\d+)$/.exec(asStr(raw[field]) ?? '');
    if (match && match[1] === id && match[2] === field && match[3]) {
      out[kind] = { providerItemId: id, tag: match[3] };
    }
  }
  return out;
}

/** Returns null for anything that is not a movie, show, season or episode. */
export function normalizePlexItem(value: unknown): NormalizedItem | null {
  const raw = asRec(value);
  if (!raw) return null;
  const type = ITEM_TYPES[asStr(raw.type) ?? ''];
  const id = asId(raw.ratingKey);
  const title = asStr(raw.title);
  if (!type || !id || !title) return null;

  const versions =
    type === 'movie' || type === 'episode'
      ? asArr(raw.Media).flatMap((m) => {
          const v = normalizeVersion(asRec(m) ?? {});
          return v ? [v] : [];
        })
      : [];
  const parentId = asId(raw.parentRatingKey);
  const originalTitle = asStr(raw.originalTitle);
  const sortTitle = asStr(raw.titleSort);
  const year = asNum(raw.year);
  const overview = asStr(raw.summary);
  const runtimeMs = asNum(raw.duration);
  const index = asNum(raw.index);
  const parentIndex = asNum(raw.parentIndex);
  const seasonNumber = type === 'season' ? index : type === 'episode' ? parentIndex : undefined;
  const episodeNumber = type === 'episode' ? index : undefined;
  const dateAdded = seconds(raw.addedAt);
  const providerUpdatedAt = seconds(raw.updatedAt);
  return {
    providerItemId: id,
    ...(parentId ? { providerParentId: parentId } : {}),
    type,
    title,
    ...(originalTitle && originalTitle !== title ? { originalTitle } : {}),
    ...(sortTitle ? { sortTitle } : {}),
    ...(year === undefined ? {} : { year }),
    ...(overview ? { overview } : {}),
    genres: asArr(raw.Genre).flatMap((g) => asStr(asRec(g)?.tag) ?? []),
    ...(runtimeMs === undefined ? {} : { runtimeMs }),
    ...(seasonNumber === undefined ? {} : { seasonNumber }),
    ...(episodeNumber === undefined ? {} : { episodeNumber }),
    externalIds: plexExternalIds(raw.Guid),
    artwork: artworkOf(raw, id, [
      ['poster', 'thumb'],
      ['backdrop', 'art'],
    ]),
    ...(dateAdded === undefined ? {} : { dateAdded }),
    ...(providerUpdatedAt === undefined ? {} : { providerUpdatedAt }),
    versions,
    credits: type === 'movie' || type === 'series' ? normalizeCredits(raw) : [],
  };
}

/**
 * A collection with its member items. Plex collections have no external GUID, so the TMDB
 * collection ID is never set (ADR-0015 merges by it only when present). Collection artwork is a
 * server-generated composite on a different path, which `getArtworkRequest` does not build, so none
 * is referenced.
 */
export function normalizePlexCollection(
  value: unknown,
  members: unknown[],
): NormalizedCollection | null {
  const raw = asRec(value);
  const id = asId(raw?.ratingKey);
  const name = asStr(raw?.title);
  if (!raw || !id || !name) return null;
  const memberIds: string[] = [];
  for (const m of members) {
    const member = asRec(m);
    const memberId = asId(member?.ratingKey);
    const type = asStr(member?.type);
    if (!memberId || (type !== 'movie' && type !== 'show')) continue;
    if (!memberIds.includes(memberId)) memberIds.push(memberId);
  }
  const overview = asStr(raw.summary);
  const providerUpdatedAt = seconds(raw.updatedAt);
  return {
    providerCollectionId: id,
    name,
    ...(overview ? { overview } : {}),
    externalIds: {},
    artwork: {},
    memberProviderItemIds: memberIds,
    ...(providerUpdatedAt === undefined ? {} : { providerUpdatedAt }),
  };
}
