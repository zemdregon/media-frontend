/**
 * Catalog read API (T2.4, T2.9 and T2.10 read side; FR-CAT-002 to FR-CAT-006, FR-CAT-008,
 * FR-CAT-011, FR-CAT-012, NFR-REL-001). Every query goes through the BR-1 predicate in
 * `db/catalog.ts`, so this module never decides visibility itself. A resource the caller may not
 * see is `404 NOT_FOUND`, the same as one that does not exist (BR-1, NFR-SEC-002). Nothing here
 * calls an origin, so browse, search and detail work with every origin offline.
 */
import type { Context } from 'hono';
import type { z } from 'zod';
import type {
  BrowseQuery,
  CollectionCard,
  CollectionDetail,
  HomeResponse,
  ItemCard,
  ItemDetail,
  Page,
  PersonCard,
  ItemDetailWithCopies,
  PersonDetail,
  SearchResponse,
  VersionEntry,
} from '@cinewren/shared';
import { DEVICE_CAPS_HEADER } from '@cinewren/shared';
import {
  continueWatchingCards,
  DeviceCapsError,
  itemCopies,
  parseDeviceCapsHeader,
} from '../playback/progress';
import type { DeviceCapabilities } from '../providers/types';
import type { AppEnv } from '../api/context';
import { AppError } from '../api/errors';
import { currentUser } from '../auth/sessions';
import {
  browseCollections,
  browseItems,
  collectionMembers,
  collectionServerLabels,
  getVisibleCollection,
  getVisibleItem,
  getVisiblePerson,
  itemCast,
  itemCollections,
  personCredits,
  recentlyAdded,
  searchHits,
  visibleChildCount,
  visibleChildren,
  visibleVersions,
  type CollectionRow,
  type ItemCardRow,
  type PersonRow,
  type SearchKind,
  type Viewer,
} from '../db/catalog';
import { expectKey, isNumber, isString, openCursor, sealCursor } from './cursor';

const HOME_ROW_SIZE = 20;
/** BR-7: resume (and "Continue watching") starts above 60 s. */
const RESUME_FLOOR_MS = 60_000;
const CAST_SIZE = 12;
/** Longest token list sent to FTS5; more words add cost, not precision. */
const MAX_SEARCH_TOKENS = 8;

const notFound = () => new AppError('NOT_FOUND', 'Not found.');

export function viewerOf(c: Context<AppEnv>): Viewer {
  const u = currentUser(c);
  return { userId: u.userId, isOperator: u.role === 'operator' };
}

/** Validates query parameters with a shared zod schema (`VALIDATION_FAILED`, `details.fields`). */
export function parseQuery<S extends z.ZodType>(c: Context<AppEnv>, schema: S): z.output<S> {
  const result = schema.safeParse(c.req.query());
  if (!result.success) {
    const fields = [...new Set(result.error.issues.map((i) => i.path.join('.') || '(root)'))];
    throw new AppError('VALIDATION_FAILED', 'The request was invalid.', { fields });
  }
  return result.data;
}

// --- card mapping ---

const slug = (tag: string) => encodeURIComponent(tag);

function itemCard(row: ItemCardRow): ItemCard {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    year: row.year,
    seasonNumber: row.season_number,
    episodeNumber: row.episode_number,
    artworkUrl: row.poster_tag
      ? `/api/v1/artwork/${row.id}/poster?v=${slug(row.poster_tag)}`
      : null,
  };
}

function personCard(row: { id: string; name: string; poster_tag: string | null }): PersonCard {
  return {
    id: row.id,
    name: row.name,
    artworkUrl: row.poster_tag
      ? `/api/v1/artwork/people/${row.id}?v=${slug(row.poster_tag)}`
      : null,
  };
}

function collectionCard(row: CollectionRow, label: string | undefined): CollectionCard {
  return {
    id: row.id,
    name: row.name,
    artworkUrl: row.poster_tag
      ? `/api/v1/artwork/collections/${row.id}?v=${slug(row.poster_tag)}`
      : null,
    ...(label ? { serverLabel: label } : {}),
  };
}

/** Takes `limit + 1` rows and turns them into a page, sealing a cursor from the last kept row. */
async function toPage<R, T>(
  c: Context<AppEnv>,
  scope: string,
  rows: R[],
  limit: number,
  keyOf: (row: R) => unknown[],
  map: (rows: R[]) => Promise<T[]> | T[],
): Promise<Page<T>> {
  const more = rows.length > limit;
  const kept = more ? rows.slice(0, limit) : rows;
  const last = kept[kept.length - 1];
  return {
    items: await map(kept),
    nextCursor: more && last ? await sealCursor(c, scope, keyOf(last)) : null,
  };
}

// --- home (FR-CAT-008) ---

export async function home(c: Context<AppEnv>): Promise<HomeResponse> {
  const viewer = viewerOf(c);
  const [rows, resumable] = await Promise.all([
    recentlyAdded(c.env.DB, viewer, HOME_ROW_SIZE),
    // FR-CAT-008 (M3): resumable items, each card with its progress (ContinueWatchingCard).
    continueWatchingCards(c.env.DB, viewer, RESUME_FLOOR_MS, HOME_ROW_SIZE),
  ]);
  return { recentlyAdded: rows.map(itemCard), continueWatching: resumable };
}

// --- browse (FR-CAT-002, FR-CAT-003) ---

export async function browse(c: Context<AppEnv>, q: BrowseQuery): Promise<Page<ItemCard>> {
  const desc = (q.order ?? (q.sort === 'title' ? 'asc' : 'desc')) === 'desc';
  const scope = `items|${JSON.stringify([q.type, q.sort, desc, q.genre, q.yearFrom, q.yearTo, q.minHeight])}`;
  const key = expectKey<[string | number, string]>(await openCursor(c, scope, q.cursor), [
    (v): v is string | number => isString(v) || isNumber(v),
    isString,
  ]);
  const rows = await browseItems(c.env.DB, viewerOf(c), {
    type: q.type,
    sort: q.sort,
    desc,
    genre: q.genre,
    yearFrom: q.yearFrom,
    yearTo: q.yearTo,
    minHeight: q.minHeight,
    after: key,
    limit: q.limit + 1,
  });
  return toPage(
    c,
    scope,
    rows,
    q.limit,
    (r) => [r.sort_key, r.id],
    (kept) => kept.map(itemCard),
  );
}

// --- search (FR-CAT-004, FR-CAT-011, FR-CAT-012) ---

/**
 * An FTS5 MATCH expression from free text: letters and digits only (so no operator or quote can
 * be injected), each token quoted with a trailing `*` for prefix matching. Case and diacritics
 * are folded by the index tokenizer. Null when the text has no searchable token.
 */
export function ftsMatch(text: string): string | null {
  const tokens = (text.normalize('NFC').match(/[\p{L}\p{N}\p{M}]+/gu) ?? []).slice(
    0,
    MAX_SEARCH_TOKENS,
  );
  if (tokens.length === 0) return null;
  return `{name alt_name}:(${tokens.map((t) => `"${t}"*`).join(' ')})`;
}

const emptyPage = <T>(): Page<T> => ({ items: [], nextCursor: null });

async function searchGroup<T>(
  c: Context<AppEnv>,
  kind: SearchKind,
  match: string,
  cursor: string | undefined,
  limit: number,
  map: (rows: (ItemCardRow & PersonRow & CollectionRow)[]) => Promise<T[]> | T[],
): Promise<Page<T>> {
  const scope = `search|${kind}|${match}`;
  const key = expectKey<[number, string, string]>(await openCursor(c, scope, cursor), [
    isNumber,
    isString,
    isString,
  ]);
  const rows = (await searchHits<ItemCardRow & PersonRow & CollectionRow>(
    c.env.DB,
    viewerOf(c),
    kind,
    match,
    key ? { rank: key[0], name: key[1], id: key[2] } : undefined,
    limit + 1,
  )) as (ItemCardRow & PersonRow & CollectionRow & { rank: number; name_key: string })[];
  return toPage(c, scope, rows, limit, (r) => [r.rank, r.name_key, r.id], map);
}

async function searchCollections(
  c: Context<AppEnv>,
  match: string,
  cursor: string | undefined,
  limit: number,
): Promise<Page<CollectionCard>> {
  return searchGroup(c, 'collection', match, cursor, limit, async (rows) => {
    const labels = await collectionServerLabels(
      c.env.DB,
      viewerOf(c),
      rows.map((r) => r.id),
    );
    return rows.map((r) => collectionCard(r, labels.get(r.id)));
  });
}

export async function search(
  c: Context<AppEnv>,
  q: { q: string; kind?: SearchKind | undefined; cursor?: string | undefined; limit: number },
): Promise<Partial<SearchResponse>> {
  if (q.cursor !== undefined && q.kind === undefined) {
    throw new AppError('VALIDATION_FAILED', 'A cursor needs a kind.', { fields: ['cursor'] });
  }
  const match = ftsMatch(q.q);
  const titles = (kind: SearchKind | undefined) =>
    kind === undefined || kind === 'title'
      ? match
        ? searchGroup(c, 'title', match, q.cursor, q.limit, (rows) => rows.map(itemCard))
        : Promise.resolve(emptyPage<ItemCard>())
      : null;
  const people = (kind: SearchKind | undefined) =>
    kind === undefined || kind === 'person'
      ? match
        ? searchGroup(c, 'person', match, q.cursor, q.limit, (rows) => rows.map(personCard))
        : Promise.resolve(emptyPage<PersonCard>())
      : null;
  const collections = (kind: SearchKind | undefined) =>
    kind === undefined || kind === 'collection'
      ? match
        ? searchCollections(c, match, q.cursor, q.limit)
        : Promise.resolve(emptyPage<CollectionCard>())
      : null;

  // With `kind`, only that group is returned (and `cursor` pages it).
  const [t, p, col] = await Promise.all([titles(q.kind), people(q.kind), collections(q.kind)]);
  return {
    ...(t ? { titles: t } : {}),
    ...(p ? { people: p } : {}),
    ...(col ? { collections: col } : {}),
  };
}

// --- item detail (FR-CAT-005) ---

const HDR_SUFFIX: Record<string, string> = {
  none: '',
  hdr10: ' HDR',
  hdr10plus: ' HDR10+',
  hlg: ' HLG',
  dolby_vision: ' Dolby Vision',
};

/** "4K HDR", "1080p": a coarse label per visible version. */
export function versionLabel(height: number | null, hdr: string): string {
  const res =
    height === null
      ? 'Unknown'
      : height >= 2000
        ? '4K'
        : height >= 1400
          ? '1440p'
          : height >= 1000
            ? '1080p'
            : height >= 700
              ? '720p'
              : 'SD';
  return `${res}${HDR_SUFFIX[hdr] ?? ''}`;
}

function parseGenres(raw: string): string[] {
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? v.filter(isString) : [];
  } catch {
    return [];
  }
}

/** `X-Device-Caps` (FR-CAT-013): absent is fine, malformed is a validation error. */
function deviceCapsOf(c: Context<AppEnv>): DeviceCapabilities | null {
  try {
    return parseDeviceCapsHeader(c.req.header(DEVICE_CAPS_HEADER));
  } catch (err) {
    if (err instanceof DeviceCapsError) {
      throw new AppError('VALIDATION_FAILED', 'The request was invalid.', {
        fields: [DEVICE_CAPS_HEADER],
      });
    }
    throw err;
  }
}

export async function itemDetail(c: Context<AppEnv>, id: string): Promise<ItemDetailWithCopies> {
  const db = c.env.DB;
  const viewer = viewerOf(c);
  const caps = deviceCapsOf(c);
  const row = await getVisibleItem(db, viewer, id);
  if (!row) throw notFound();
  return {
    ...(await itemDetailBase(c, row)),
    copies: await itemCopies(db, viewer, row, caps),
  };
}

async function itemDetailBase(
  c: Context<AppEnv>,
  row: NonNullable<Awaited<ReturnType<typeof getVisibleItem>>>,
): Promise<ItemDetail> {
  const db = c.env.DB;
  const viewer = viewerOf(c);
  const id = row.id;
  const art = (tag: string | null, slot: string) =>
    tag ? `/api/v1/artwork/${row.id}/${slot}?v=${slug(tag)}` : null;
  const childType = row.type === 'series' ? 'season' : row.type === 'season' ? 'episode' : null;
  const [versions, childCount, cast, collections] = await Promise.all([
    visibleVersions(db, viewer, id),
    childType ? visibleChildCount(db, viewer, id) : Promise.resolve(0),
    itemCast(db, viewer, id, CAST_SIZE),
    itemCollections(db, viewer, id),
  ]);
  return {
    id: row.id,
    type: row.type,
    parentId: row.parent_visible === 1 ? row.parent_id : null,
    title: row.title,
    originalTitle: row.original_title,
    year: row.year,
    overview: row.overview,
    genres: parseGenres(row.genres),
    runtimeMs: row.runtime_ms,
    seasonNumber: row.season_number,
    episodeNumber: row.episode_number,
    artwork: {
      poster: art(row.poster_tag, 'poster'),
      backdrop: art(row.backdrop_tag, 'backdrop'),
      thumb: art(row.thumb_tag, 'thumb'),
    },
    versionsSummary: [...new Set(versions.map((v) => versionLabel(v.height, v.hdr)))],
    serverCount: row.server_count,
    progress:
      row.progress_position_ms === null
        ? null
        : { positionMs: row.progress_position_ms, watched: row.progress_watched === 1 },
    children: childType ? { type: childType, count: childCount } : null,
    cast: cast.map((m) => ({
      person: personCard({ id: m.person_id, name: m.name, poster_tag: m.poster_tag }),
      role: m.role,
      character: m.character,
    })),
    collections: collections.map((x) => ({ id: x.id, name: x.name })),
  };
}

export async function itemChildren(
  c: Context<AppEnv>,
  id: string,
  q: { cursor?: string | undefined; limit: number },
): Promise<Page<ItemCard>> {
  const viewer = viewerOf(c);
  if (!(await getVisibleItem(c.env.DB, viewer, id))) throw notFound();
  const scope = `children|${id}`;
  const key = expectKey<[number, number, string]>(await openCursor(c, scope, q.cursor), [
    isNumber,
    isNumber,
    isString,
  ]);
  const rows = await visibleChildren(c.env.DB, viewer, id, key, q.limit + 1);
  return toPage(
    c,
    scope,
    rows,
    q.limit,
    (r) => [r.season_key, r.episode_key, r.id],
    (kept) => kept.map(itemCard),
  );
}

export async function itemVersions(c: Context<AppEnv>, id: string): Promise<VersionEntry[]> {
  const viewer = viewerOf(c);
  if (!(await getVisibleItem(c.env.DB, viewer, id))) throw notFound();
  return (await visibleVersions(c.env.DB, viewer, id)).map((v) => ({
    sourceId: v.source_id,
    versionId: v.version_id,
    label: versionLabel(v.height, v.hdr),
    height: v.height,
    hdr: v.hdr,
    videoCodec: v.video_codec,
    serverName: v.server_name,
    serverStatus: v.server_status,
  }));
}

// --- people (FR-CAT-011) ---

export async function person(
  c: Context<AppEnv>,
  id: string,
  q: { cursor?: string | undefined; limit: number },
): Promise<PersonDetail> {
  const viewer = viewerOf(c);
  const row = await getVisiblePerson(c.env.DB, viewer, id);
  if (!row) throw notFound();
  const scope = `person|${id}`;
  const key = expectKey<[number, string, string, string]>(await openCursor(c, scope, q.cursor), [
    isNumber,
    isString,
    isString,
    isString,
  ]);
  const rows = await personCredits(c.env.DB, viewer, id, key, q.limit + 1);
  return {
    ...personCard(row),
    credits: await toPage(
      c,
      scope,
      rows,
      q.limit,
      (r) => [r.year_key, r.title_key, r.id, r.role],
      (kept) => kept.map((r) => ({ item: itemCard(r), role: r.role, character: r.character })),
    ),
  };
}

// --- collections (FR-CAT-012) ---

export async function collections(
  c: Context<AppEnv>,
  q: { cursor?: string | undefined; limit: number },
): Promise<Page<CollectionCard>> {
  const viewer = viewerOf(c);
  const scope = 'collections';
  const key = expectKey<[string, string]>(await openCursor(c, scope, q.cursor), [
    isString,
    isString,
  ]);
  const rows = await browseCollections(c.env.DB, viewer, key, q.limit + 1);
  return toPage(
    c,
    scope,
    rows,
    q.limit,
    (r) => [r.sort_name, r.id],
    async (kept) => {
      const labels = await collectionServerLabels(
        c.env.DB,
        viewer,
        kept.map((r) => r.id),
      );
      return kept.map((r) => collectionCard(r, labels.get(r.id)));
    },
  );
}

export async function collection(
  c: Context<AppEnv>,
  id: string,
  q: { cursor?: string | undefined; limit: number },
): Promise<CollectionDetail> {
  const viewer = viewerOf(c);
  const row = await getVisibleCollection(c.env.DB, viewer, id);
  if (!row) throw notFound();
  const scope = `collection|${id}`;
  const key = expectKey<[number, string, string]>(await openCursor(c, scope, q.cursor), [
    isNumber,
    isString,
    isString,
  ]);
  const rows = await collectionMembers(c.env.DB, viewer, id, key, q.limit + 1);
  const card = collectionCard(row, undefined);
  return {
    id: row.id,
    name: row.name,
    overview: row.overview,
    artworkUrl: card.artworkUrl,
    members: await toPage(
      c,
      scope,
      rows,
      q.limit,
      (r) => [r.year_key, r.title_key, r.id],
      (kept) => kept.map(itemCard),
    ),
  };
}
