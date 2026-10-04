/**
 * Jellyfin JSON to normalized types (LLD-PROV per-provider notes, spike sections 2 and 5).
 * Origin payloads are untrusted: every field is read defensively and unknown shapes are skipped
 * rather than thrown on, so one odd item cannot fail a whole sync page.
 */
import type {
  ArtworkKind,
  ArtworkRef,
  AudioTrack,
  HdrFormat,
  ItemType,
  NormalizedCredit,
  NormalizedItem,
  NormalizedVersion,
  SubtitleTrack,
} from './types';

type Rec = Record<string, unknown>;

export const asRec = (v: unknown): Rec | null =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Rec) : null;
const asArr = (v: unknown): unknown[] => (Array.isArray(v) ? (v as unknown[]) : []);
const asStr = (v: unknown): string | undefined =>
  typeof v === 'string' && v !== '' ? v : undefined;
const asNum = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;
const asTime = (v: unknown): number | undefined => {
  const s = asStr(v);
  if (!s) return undefined;
  const t = Date.parse(s);
  return Number.isNaN(t) ? undefined : t;
};

/** 1 tick = 100 ns. */
const ticksToMs = (v: unknown): number | undefined => {
  const n = asNum(v);
  return n === undefined ? undefined : Math.round(n / 10_000);
};

const ITEM_TYPES: Record<string, ItemType> = {
  Movie: 'movie',
  Series: 'series',
  Season: 'season',
  Episode: 'episode',
};

/** Billing-order credits are capped per item (LLD-PROV, proposed 40). */
export const MAX_CREDITS = 40;

function hdrOf(rangeType: string | undefined): HdrFormat {
  switch (rangeType) {
    case 'HDR10':
      return 'hdr10';
    case 'HDR10Plus':
      return 'hdr10plus';
    case 'HLG':
      return 'hlg';
    case undefined:
    case 'SDR':
    case 'Unknown':
    case 'DOVIInvalid':
      return 'none';
    default:
      return rangeType.startsWith('DOVI') ? 'dolby_vision' : 'none';
  }
}

function externalIds(providerIds: unknown): { tmdb?: string; imdb?: string; tvdb?: string } {
  // Key casing differs between Jellyfin and Emby and between items and persons (spike section 5).
  const out: { tmdb?: string; imdb?: string; tvdb?: string } = {};
  for (const [key, value] of Object.entries(asRec(providerIds) ?? {})) {
    const v = asStr(value);
    const k = key.toLowerCase();
    if (v && (k === 'tmdb' || k === 'imdb' || k === 'tvdb')) out[k] = v;
  }
  return out;
}

function normalizeVersion(source: Rec): NormalizedVersion | null {
  const id = asStr(source.Id);
  if (!id) return null;
  const streams: Rec[] = [];
  for (const entry of asArr(source.MediaStreams)) {
    const stream = asRec(entry);
    if (stream) streams.push(stream);
  }
  const video = streams.find((s) => s.Type === 'Video');
  const audio: AudioTrack[] = [];
  const subtitles: SubtitleTrack[] = [];
  for (const s of streams) {
    const index = asNum(s.Index);
    if (index === undefined) continue;
    const codec = asStr(s.Codec);
    const language = asStr(s.Language);
    const title = asStr(s.DisplayTitle);
    if (s.Type === 'Audio') {
      const channels = asNum(s.Channels);
      audio.push({
        index,
        ...(codec ? { codec } : {}),
        ...(language ? { language } : {}),
        ...(channels === undefined ? {} : { channels }),
        ...(title ? { title } : {}),
        isDefault: s.IsDefault === true,
      });
    } else if (s.Type === 'Subtitle') {
      subtitles.push({
        index,
        ...(codec ? { codec } : {}),
        ...(language ? { language } : {}),
        ...(title ? { title } : {}),
        kind: s.IsTextSubtitleStream === true ? 'text' : 'image',
        isForced: s.IsForced === true,
        isDefault: s.IsDefault === true,
        isExternal: s.IsExternal === true,
      });
    }
  }
  const container = asStr(source.Container);
  const videoCodec = asStr(video?.Codec);
  const videoProfile = asStr(video?.Profile);
  const width = asNum(video?.Width);
  const height = asNum(video?.Height);
  const bitrate = asNum(source.Bitrate);
  const runtimeMs = ticksToMs(source.RunTimeTicks);
  const sizeBytes = asNum(source.Size);
  return {
    providerVersionId: id,
    ...(container ? { container } : {}),
    ...(videoCodec ? { videoCodec } : {}),
    ...(videoProfile ? { videoProfile } : {}),
    ...(width === undefined ? {} : { width }),
    ...(height === undefined ? {} : { height }),
    hdr: hdrOf(asStr(video?.VideoRangeType)),
    ...(bitrate === undefined ? {} : { bitrate }),
    ...(runtimeMs === undefined ? {} : { runtimeMs }),
    ...(sizeBytes === undefined ? {} : { sizeBytes }),
    audio,
    subtitles,
  };
}

function creditRole(type: string | undefined): NormalizedCredit['role'] {
  switch (type) {
    case 'Actor':
    case 'GuestStar':
      return 'actor';
    case 'Director':
      return 'director';
    case 'Writer':
      return 'writer';
    case 'Producer':
      return 'producer';
    default:
      return 'other';
  }
}

function normalizeCredits(people: unknown): NormalizedCredit[] {
  const credits: NormalizedCredit[] = [];
  for (const entry of asArr(people)) {
    const p = asRec(entry);
    const id = asStr(p?.Id);
    const name = asStr(p?.Name);
    if (!p || !id || !name) continue;
    const character = asStr(p.Role);
    const tag = asStr(p.PrimaryImageTag);
    credits.push({
      person: {
        providerPersonId: id,
        name,
        // Jellyfin 12.1 returns no person ProviderIds in People[] (spike 2, row 4a); anything
        // it does report is kept, nothing is guessed.
        externalIds: (({ tmdb, imdb }) => ({
          ...(tmdb ? { tmdb } : {}),
          ...(imdb ? { imdb } : {}),
        }))(externalIds(p.ProviderIds)),
        ...(tag ? { artwork: { providerItemId: id, tag } } : {}),
      },
      role: creditRole(asStr(p.Type)),
      ...(character ? { character } : {}),
      order: credits.length,
    });
    if (credits.length >= MAX_CREDITS) break;
  }
  return credits;
}

function normalizeArtwork(raw: Rec, id: string): Partial<Record<ArtworkKind, ArtworkRef>> {
  const tags = asRec(raw.ImageTags) ?? {};
  const out: Partial<Record<ArtworkKind, ArtworkRef>> = {};
  const poster = asStr(tags.Primary);
  const thumb = asStr(tags.Thumb);
  const backdrop = asStr(asArr(raw.BackdropImageTags)[0]);
  if (poster) out.poster = { providerItemId: id, tag: poster };
  if (backdrop) out.backdrop = { providerItemId: id, tag: backdrop };
  if (thumb) out.thumb = { providerItemId: id, tag: thumb };
  return out;
}

/** Returns null for anything that is not a movie, series, season or episode. */
export function normalizeItem(value: unknown): NormalizedItem | null {
  const raw = asRec(value);
  if (!raw) return null;
  const type = ITEM_TYPES[asStr(raw.Type) ?? ''];
  const id = asStr(raw.Id);
  const title = asStr(raw.Name);
  if (!type || !id || !title) return null;

  const hasVersions = type === 'movie' || type === 'episode';
  const versions = hasVersions
    ? asArr(raw.MediaSources).flatMap((s) => {
        const v = normalizeVersion(asRec(s) ?? {});
        return v ? [v] : [];
      })
    : [];
  const parentId = asStr(raw.ParentId);
  const originalTitle = asStr(raw.OriginalTitle);
  const sortTitle = asStr(raw.SortName);
  const year = asNum(raw.ProductionYear);
  const overview = asStr(raw.Overview);
  const runtimeMs = ticksToMs(raw.RunTimeTicks);
  const index = asNum(raw.IndexNumber);
  const parentIndex = asNum(raw.ParentIndexNumber);
  const seasonNumber = type === 'season' ? index : type === 'episode' ? parentIndex : undefined;
  const episodeNumber = type === 'episode' ? index : undefined;
  const dateAdded = asTime(raw.DateCreated);
  const providerUpdatedAt = asTime(raw.DateLastSaved);
  return {
    providerItemId: id,
    ...(parentId ? { providerParentId: parentId } : {}),
    type,
    title,
    ...(originalTitle ? { originalTitle } : {}),
    ...(sortTitle ? { sortTitle } : {}),
    ...(year === undefined ? {} : { year }),
    ...(overview ? { overview } : {}),
    genres: asArr(raw.Genres).flatMap((g) => asStr(g) ?? []),
    ...(runtimeMs === undefined ? {} : { runtimeMs }),
    ...(seasonNumber === undefined ? {} : { seasonNumber }),
    ...(episodeNumber === undefined ? {} : { episodeNumber }),
    externalIds: externalIds(raw.ProviderIds),
    artwork: normalizeArtwork(raw, id),
    ...(dateAdded === undefined ? {} : { dateAdded }),
    ...(providerUpdatedAt === undefined ? {} : { providerUpdatedAt }),
    versions,
    credits: type === 'movie' || type === 'series' ? normalizeCredits(raw.People) : [],
  };
}
