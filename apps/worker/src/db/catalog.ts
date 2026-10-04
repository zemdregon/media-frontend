/**
 * D1 read queries for C-CAT (LLD-SCHEMA, LLD-API; FR-CAT-002 to FR-CAT-006, FR-CAT-008,
 * FR-CAT-011, FR-CAT-012). All catalog SQL lives here (TDD-D1) and every statement goes through
 * the one BR-1 predicate below, so a query cannot be written without it (FR-CAT-006).
 *
 * Parameter convention: `?1` is "the caller is an operator" (0 or 1) and `?2` is the caller's user
 * ID. Every statement built here binds those two first; further parameters come from `Params`.
 * Nothing here reads `server_credentials`, and nothing needs a reachable origin (NFR-REL-001).
 */
import type { ArtworkSlot, CatalogType, CreditRole } from '@cinewren/shared';

export interface Viewer {
  userId: string;
  isOperator: boolean;
}

/** Statuses whose sources are exposed to browsing. `unreachable` stays visible (NFR-REL-001). */
const EXPOSED = "('active','degraded','unreachable')";

/** Collects bound parameters after the two the BR-1 predicate uses. */
export class Params {
  readonly values: unknown[];
  constructor(viewer: Viewer) {
    this.values = [viewer.isOperator ? 1 : 0, viewer.userId];
  }
  /** Binds a value and returns its `?N` placeholder. */
  add(value: unknown): string {
    this.values.push(value);
    return `?${this.values.length}`;
  }
}

/**
 * The BR-1 predicate for a `media_items` row (LLD-SCHEMA): at least one present source, in an
 * enabled library, on an exposed server, and, for viewers, in a granted library. Operators see
 * every enabled library (FR-USR-005).
 */
export const visibleItem = (item: string): string =>
  `EXISTS (SELECT 1 FROM item_availability va
            JOIN libraries vl ON vl.id = va.library_id AND vl.enabled = 1
            JOIN servers vs ON vs.id = vl.server_id AND vs.status IN ${EXPOSED}
           WHERE va.media_item_id = ${item}.id
             AND (?1 = 1 OR EXISTS (SELECT 1 FROM library_grants vg
                                     WHERE vg.user_id = ?2 AND vg.library_id = va.library_id)))`;

/** The same rule for one `sources` row: counts, version lists and server lists (BR-1). */
export const visibleSource = (source: string): string =>
  `(${source}.status = 'present'
    AND EXISTS (SELECT 1 FROM libraries sl
                  JOIN servers ss ON ss.id = sl.server_id AND ss.status IN ${EXPOSED}
                 WHERE sl.id = ${source}.library_id AND sl.enabled = 1
                   AND (?1 = 1 OR EXISTS (SELECT 1 FROM library_grants sg
                                           WHERE sg.user_id = ?2 AND sg.library_id = sl.id))))`;

/** A person exists for the caller only through a credit on a visible title (BR-1, BR-10). */
export const visiblePerson = (person: string): string =>
  `EXISTS (SELECT 1 FROM credits pc JOIN media_items pi ON pi.id = pc.media_item_id
            WHERE pc.person_id = ${person}.id AND ${visibleItem('pi')})`;

/** A collection exists for the caller only through a visible member (BR-1, BR-10). */
export const visibleCollection = (collection: string): string =>
  `EXISTS (SELECT 1 FROM collection_provider_links cl
             JOIN collection_members cm ON cm.link_id = cl.id
             JOIN media_items ci ON ci.id = cm.media_item_id
            WHERE cl.collection_id = ${collection}.id AND ${visibleItem('ci')})`;

/** Sources of an item or, for series and seasons, of its descendants. */
const familySources = (item: string, src: string): string =>
  `(${src}.media_item_id = ${item}.id
    OR ${src}.media_item_id IN (SELECT ch.id FROM media_items ch WHERE ch.parent_id = ${item}.id)
    OR ${src}.media_item_id IN (SELECT ep.id FROM media_items ep
                                  JOIN media_items se ON se.id = ep.parent_id
                                 WHERE se.parent_id = ${item}.id))`;

// --- rows ---

export interface ItemCardRow {
  id: string;
  type: CatalogType;
  title: string;
  year: number | null;
  season_number: number | null;
  episode_number: number | null;
  poster_tag: string | null;
}

const CARD_COLUMNS = `i.id, i.type, i.title, i.year, i.season_number, i.episode_number,
  (SELECT json_extract(ms.artwork, '$.poster.tag') FROM sources ms
    WHERE ms.id = i.metadata_source_id) AS poster_tag`;

async function all<T>(db: D1Database, sql: string, values: unknown[]): Promise<T[]> {
  const { results } = await db
    .prepare(sql)
    .bind(...values)
    .all<T>();
  return results;
}

// --- browse and home (FR-CAT-002, FR-CAT-003, FR-CAT-008) ---

export interface BrowseFilter {
  type?: 'movie' | 'series' | undefined;
  sort: 'title' | 'year' | 'added';
  desc: boolean;
  genre?: string | undefined;
  yearFrom?: number | undefined;
  yearTo?: number | undefined;
  minHeight?: number | undefined;
  /** `[sortKey, id]` of the last row of the previous page. */
  after?: [string | number, string] | undefined;
  limit: number;
}

const SORT_KEY = { title: 'i.sort_title', year: 'COALESCE(i.year, 0)', added: 'i.date_added' };

export type BrowseRow = ItemCardRow & { sort_key: string | number };

export function browseItems(db: D1Database, viewer: Viewer, f: BrowseFilter): Promise<BrowseRow[]> {
  const p = new Params(viewer);
  const where = [
    f.type ? `i.type = ${p.add(f.type)}` : "i.type IN ('movie','series')",
    visibleItem('i'),
  ];
  if (f.genre !== undefined) {
    where.push(
      `EXISTS (SELECT 1 FROM json_each(i.genres) jg WHERE jg.value = ${p.add(f.genre)} COLLATE NOCASE)`,
    );
  }
  if (f.yearFrom !== undefined) where.push(`i.year >= ${p.add(f.yearFrom)}`);
  if (f.yearTo !== undefined) where.push(`i.year <= ${p.add(f.yearTo)}`);
  if (f.minHeight !== undefined) {
    // Visible versions only: a taller copy on a hidden source must not satisfy the filter (BR-1).
    where.push(
      `EXISTS (SELECT 1 FROM sources fs JOIN media_versions fv ON fv.source_id = fs.id
                WHERE ${familySources('i', 'fs')} AND ${visibleSource('fs')}
                  AND fv.height >= ${p.add(f.minHeight)})`,
    );
  }
  const key = SORT_KEY[f.sort];
  const dir = f.desc ? 'DESC' : 'ASC';
  if (f.after) {
    where.push(`(${key}, i.id) ${f.desc ? '<' : '>'} (${p.add(f.after[0])}, ${p.add(f.after[1])})`);
  }
  return all<BrowseRow>(
    db,
    `SELECT ${CARD_COLUMNS}, ${key} AS sort_key FROM media_items i
      WHERE ${where.join(' AND ')} ORDER BY ${key} ${dir}, i.id ${dir} LIMIT ${p.add(f.limit)}`,
    p.values,
  );
}

/** Newest visible movies and series by date added (FR-CAT-008). */
export function recentlyAdded(
  db: D1Database,
  viewer: Viewer,
  limit: number,
): Promise<ItemCardRow[]> {
  const p = new Params(viewer);
  return all<ItemCardRow>(
    db,
    `SELECT ${CARD_COLUMNS} FROM media_items i
      WHERE i.type IN ('movie','series') AND ${visibleItem('i')}
      ORDER BY i.date_added DESC, i.id DESC LIMIT ${p.add(limit)}`,
    p.values,
  );
}

// --- search (FR-CAT-004, FR-CAT-011, FR-CAT-012) ---

export interface SearchAfter {
  rank: number;
  name: string;
  id: string;
}

export type SearchKind = 'title' | 'person' | 'collection';

/**
 * FTS hits of one kind, joined with the visibility predicate inside the same statement, so a
 * hidden hit never occupies a slot of the page (LLD-SCHEMA FTS notes). `match` is built by
 * `ftsMatch` from quoted prefix tokens only.
 */
export function searchHits<T>(
  db: D1Database,
  viewer: Viewer,
  kind: SearchKind,
  match: string,
  after: SearchAfter | undefined,
  limit: number,
): Promise<(T & { rank: number; name_key: string })[]> {
  const p = new Params(viewer);
  const hits = `(SELECT entity_id, bm25(search_fts) AS rank FROM search_fts
                  WHERE search_fts MATCH ${p.add(`kind:${kind} AND ${match}`)}) f`;
  const entity =
    kind === 'title'
      ? { select: CARD_COLUMNS, from: 'media_items i', alias: 'i', name: 'i.title' }
      : kind === 'person'
        ? {
            select: `i.id, i.name, (SELECT json_extract(l.artwork, '$.poster.tag')
                       FROM person_provider_links l WHERE l.id = i.metadata_link_id) AS poster_tag`,
            from: 'people i',
            alias: 'i',
            name: 'i.name',
          }
        : {
            select: `i.id, i.name, (SELECT json_extract(l.artwork, '$.poster.tag')
                       FROM collection_provider_links l WHERE l.id = i.metadata_link_id) AS poster_tag`,
            from: 'collections i',
            alias: 'i',
            name: 'i.name',
          };
  const visible =
    kind === 'title'
      ? visibleItem('i')
      : kind === 'person'
        ? visiblePerson('i')
        : visibleCollection('i');
  const where = [visible];
  if (kind === 'title') where.unshift("i.type IN ('movie','series')");
  if (after) {
    where.push(
      `(f.rank, lower(${entity.name}), i.id) > (${p.add(after.rank)}, ${p.add(after.name)}, ${p.add(after.id)})`,
    );
  }
  return all(
    db,
    `SELECT ${entity.select}, f.rank AS rank, lower(${entity.name}) AS name_key
       FROM ${hits} JOIN ${entity.from} ON i.id = f.entity_id
      WHERE ${where.join(' AND ')}
      ORDER BY f.rank, lower(${entity.name}), i.id LIMIT ${p.add(limit)}`,
    p.values,
  );
}

// --- item detail (FR-CAT-005) ---

export interface ItemDetailRow {
  id: string;
  type: CatalogType;
  parent_id: string | null;
  parent_visible: number;
  title: string;
  original_title: string | null;
  year: number | null;
  overview: string | null;
  genres: string;
  runtime_ms: number | null;
  season_number: number | null;
  episode_number: number | null;
  poster_tag: string | null;
  backdrop_tag: string | null;
  thumb_tag: string | null;
  server_count: number;
  progress_position_ms: number | null;
  progress_watched: number | null;
}

/** The item, or null when it does not exist or the caller may not see it (404 either way). */
export async function getVisibleItem(
  db: D1Database,
  viewer: Viewer,
  id: string,
): Promise<ItemDetailRow | null> {
  const p = new Params(viewer);
  const idp = p.add(id);
  const rows = await all<ItemDetailRow>(
    db,
    `SELECT i.id, i.type, i.parent_id, i.title, i.original_title, i.year, i.overview, i.genres,
            i.runtime_ms, i.season_number, i.episode_number,
            CASE WHEN i.parent_id IS NOT NULL AND
                      (SELECT ${visibleItem('pp')} FROM media_items pp WHERE pp.id = i.parent_id)
                 THEN 1 ELSE 0 END AS parent_visible,
            json_extract(ms.artwork, '$.poster.tag') AS poster_tag,
            json_extract(ms.artwork, '$.backdrop.tag') AS backdrop_tag,
            json_extract(ms.artwork, '$.thumb.tag') AS thumb_tag,
            (SELECT COUNT(DISTINCT cs.server_id) FROM sources cs
              WHERE cs.media_item_id = i.id AND ${visibleSource('cs')}) AS server_count,
            wp.position_ms AS progress_position_ms, wp.watched AS progress_watched
       FROM media_items i
       LEFT JOIN sources ms ON ms.id = i.metadata_source_id
       LEFT JOIN watch_progress wp ON wp.media_item_id = i.id AND wp.user_id = ?2
      WHERE i.id = ${idp} AND ${visibleItem('i')}`,
    p.values,
  );
  return rows[0] ?? null;
}

export interface VersionRow {
  source_id: string;
  version_id: string;
  height: number | null;
  hdr: string;
  video_codec: string | null;
  server_name: string;
  server_status: string;
}

/** Visible versions of an item (or of a series' or season's descendants), best first. */
export function visibleVersions(
  db: D1Database,
  viewer: Viewer,
  itemId: string,
): Promise<VersionRow[]> {
  const p = new Params(viewer);
  const idp = p.add(itemId);
  return all<VersionRow>(
    db,
    `SELECT fs.id AS source_id, fv.id AS version_id, fv.height, fv.hdr, fv.video_codec,
            sv.name AS server_name, sv.status AS server_status
       FROM media_items i
       JOIN sources fs ON ${familySources('i', 'fs')}
       JOIN media_versions fv ON fv.source_id = fs.id
       JOIN servers sv ON sv.id = fs.server_id
      WHERE i.id = ${idp} AND ${visibleSource('fs')}
      ORDER BY COALESCE(fv.height, 0) DESC, fv.hdr DESC, sv.priority DESC, fv.id`,
    p.values,
  );
}

export function visibleChildCount(
  db: D1Database,
  viewer: Viewer,
  parentId: string,
): Promise<number> {
  const p = new Params(viewer);
  return all<{ n: number }>(
    db,
    `SELECT COUNT(*) AS n FROM media_items i WHERE i.parent_id = ${p.add(parentId)} AND ${visibleItem('i')}`,
    p.values,
  ).then((r) => r[0]?.n ?? 0);
}

export type ChildRow = ItemCardRow & { season_key: number; episode_key: number };

export function visibleChildren(
  db: D1Database,
  viewer: Viewer,
  parentId: string,
  after: [number, number, string] | undefined,
  limit: number,
): Promise<ChildRow[]> {
  const p = new Params(viewer);
  const where = [`i.parent_id = ${p.add(parentId)}`, visibleItem('i')];
  if (after) {
    where.push(
      `(COALESCE(i.season_number, 0), COALESCE(i.episode_number, 0), i.id) > (${p.add(after[0])}, ${p.add(after[1])}, ${p.add(after[2])})`,
    );
  }
  return all<ChildRow>(
    db,
    `SELECT ${CARD_COLUMNS}, COALESCE(i.season_number, 0) AS season_key,
            COALESCE(i.episode_number, 0) AS episode_key
       FROM media_items i WHERE ${where.join(' AND ')}
      ORDER BY season_key, episode_key, i.id LIMIT ${p.add(limit)}`,
    p.values,
  );
}

export interface CastRow {
  person_id: string;
  name: string;
  poster_tag: string | null;
  role: CreditRole;
  character: string | null;
}

/** Billing-ordered cast of a visible item; each person therefore has a visible credit. */
export function itemCast(
  db: D1Database,
  viewer: Viewer,
  itemId: string,
  limit: number,
): Promise<CastRow[]> {
  const p = new Params(viewer);
  return all<CastRow>(
    db,
    `SELECT pe.id AS person_id, pe.name, cr.role, MIN(cr.character) AS character,
            (SELECT json_extract(l.artwork, '$.poster.tag') FROM person_provider_links l
              WHERE l.id = pe.metadata_link_id) AS poster_tag
       FROM credits cr JOIN people pe ON pe.id = cr.person_id
      WHERE cr.media_item_id = ${p.add(itemId)}
      GROUP BY pe.id, cr.role
      ORDER BY MIN(cr.sort_order), pe.name, pe.id LIMIT ${p.add(limit)}`,
    p.values,
  );
}

export function itemCollections(
  db: D1Database,
  viewer: Viewer,
  itemId: string,
): Promise<{ id: string; name: string }[]> {
  const p = new Params(viewer);
  return all(
    db,
    `SELECT DISTINCT c.id, c.name, c.sort_name FROM collection_members cm
       JOIN collection_provider_links cl ON cl.id = cm.link_id
       JOIN collections c ON c.id = cl.collection_id
      WHERE cm.media_item_id = ${p.add(itemId)} ORDER BY c.sort_name, c.id`,
    p.values,
  );
}

// --- people (FR-CAT-011) ---

export interface PersonRow {
  id: string;
  name: string;
  poster_tag: string | null;
}

export async function getVisiblePerson(
  db: D1Database,
  viewer: Viewer,
  id: string,
): Promise<PersonRow | null> {
  const p = new Params(viewer);
  const rows = await all<PersonRow>(
    db,
    `SELECT i.id, i.name, (SELECT json_extract(l.artwork, '$.poster.tag')
              FROM person_provider_links l WHERE l.id = i.metadata_link_id) AS poster_tag
       FROM people i WHERE i.id = ${p.add(id)} AND ${visiblePerson('i')}`,
    p.values,
  );
  return rows[0] ?? null;
}

export type CreditRowOut = ItemCardRow & {
  role: CreditRole;
  character: string | null;
  year_key: number;
  title_key: string;
};

/**
 * Credits on visible titles, year descending then title. The same person, title and role from
 * several servers is one row. Keyset order is `(-year, sort_title, id, role)`, all ascending.
 */
export function personCredits(
  db: D1Database,
  viewer: Viewer,
  personId: string,
  after: [number, string, string, string] | undefined,
  limit: number,
): Promise<CreditRowOut[]> {
  const p = new Params(viewer);
  const having: string[] = [];
  if (after) {
    having.push(
      `(-COALESCE(i.year, 0), i.sort_title, i.id, cr.role) > (${p.add(after[0])}, ${p.add(after[1])}, ${p.add(after[2])}, ${p.add(after[3])})`,
    );
  }
  return all<CreditRowOut>(
    db,
    `SELECT ${CARD_COLUMNS}, cr.role, MIN(cr.character) AS character,
            -COALESCE(i.year, 0) AS year_key, i.sort_title AS title_key
       FROM credits cr JOIN media_items i ON i.id = cr.media_item_id
      WHERE cr.person_id = ${p.add(personId)} AND ${visibleItem('i')}
      GROUP BY i.id, cr.role
     ${having.length ? `HAVING ${having.join(' AND ')}` : ''}
      ORDER BY year_key, i.sort_title, i.id, cr.role LIMIT ${p.add(limit)}`,
    p.values,
  );
}

// --- collections (FR-CAT-012) ---

export interface CollectionRow {
  id: string;
  name: string;
  overview: string | null;
  sort_name: string;
  poster_tag: string | null;
}

const COLLECTION_COLUMNS = `i.id, i.name, i.overview, i.sort_name,
  (SELECT json_extract(l.artwork, '$.poster.tag') FROM collection_provider_links l
    WHERE l.id = i.metadata_link_id) AS poster_tag`;

export function browseCollections(
  db: D1Database,
  viewer: Viewer,
  after: [string, string] | undefined,
  limit: number,
): Promise<CollectionRow[]> {
  const p = new Params(viewer);
  const where = [visibleCollection('i')];
  if (after) where.push(`(i.sort_name, i.id) > (${p.add(after[0])}, ${p.add(after[1])})`);
  return all<CollectionRow>(
    db,
    `SELECT ${COLLECTION_COLUMNS} FROM collections i WHERE ${where.join(' AND ')}
      ORDER BY i.sort_name, i.id LIMIT ${p.add(limit)}`,
    p.values,
  );
}

export async function getVisibleCollection(
  db: D1Database,
  viewer: Viewer,
  id: string,
): Promise<CollectionRow | null> {
  const p = new Params(viewer);
  const rows = await all<CollectionRow>(
    db,
    `SELECT ${COLLECTION_COLUMNS} FROM collections i
      WHERE i.id = ${p.add(id)} AND ${visibleCollection('i')}`,
    p.values,
  );
  return rows[0] ?? null;
}

export type MemberRow = ItemCardRow & { year_key: number; title_key: string };

/** Union of the members over the merged provider collections, visible only, year ascending. */
export function collectionMembers(
  db: D1Database,
  viewer: Viewer,
  collectionId: string,
  after: [number, string, string] | undefined,
  limit: number,
): Promise<MemberRow[]> {
  const p = new Params(viewer);
  const where = [
    `i.id IN (SELECT cm.media_item_id FROM collection_members cm
                JOIN collection_provider_links cl ON cl.id = cm.link_id
               WHERE cl.collection_id = ${p.add(collectionId)})`,
    visibleItem('i'),
  ];
  if (after) {
    where.push(
      `(COALESCE(i.year, 0), i.sort_title, i.id) > (${p.add(after[0])}, ${p.add(after[1])}, ${p.add(after[2])})`,
    );
  }
  return all<MemberRow>(
    db,
    `SELECT ${CARD_COLUMNS}, COALESCE(i.year, 0) AS year_key, i.sort_title AS title_key
       FROM media_items i WHERE ${where.join(' AND ')}
      ORDER BY year_key, i.sort_title, i.id LIMIT ${p.add(limit)}`,
    p.values,
  );
}

/**
 * Server labels for collections that share a name with another collection the caller can see
 * (ADR-0015). The label is a server the caller can reach through a visible member, never a
 * server they cannot see.
 */
export async function collectionServerLabels(
  db: D1Database,
  viewer: Viewer,
  ids: string[],
): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const p = new Params(viewer);
  const list = p.add(JSON.stringify(ids));
  const rows = await all<{ id: string; label: string | null }>(
    db,
    `SELECT i.id, (SELECT MIN(sv.name) FROM collection_provider_links cl
                     JOIN collection_members cm ON cm.link_id = cl.id
                     JOIN item_availability va ON va.media_item_id = cm.media_item_id
                     JOIN libraries vl ON vl.id = va.library_id AND vl.enabled = 1
                     JOIN servers sv ON sv.id = vl.server_id AND sv.status IN ${EXPOSED}
                    WHERE cl.collection_id = i.id
                      AND (?1 = 1 OR EXISTS (SELECT 1 FROM library_grants vg
                                              WHERE vg.user_id = ?2 AND vg.library_id = va.library_id))
                  ) AS label
       FROM collections i
      WHERE i.id IN (SELECT value FROM json_each(${list}))
        AND EXISTS (SELECT 1 FROM collections o
                     WHERE o.id <> i.id AND lower(o.name) = lower(i.name) AND ${visibleCollection('o')})`,
    p.values,
  );
  return new Map(rows.flatMap((r) => (r.label ? [[r.id, r.label] as const] : [])));
}

// --- artwork (FR-CAT-009, ADR-0012) ---

export interface ArtworkCandidate {
  provider_id: string;
  tag: string;
  server_id: string;
}

/**
 * Visible sources of an item that carry artwork of `slot`, preferred first: the metadata source,
 * then higher server priority, then ID. Origin identity only: no URL, no credential.
 */
export function itemArtworkCandidates(
  db: D1Database,
  viewer: Viewer,
  itemId: string,
  slot: ArtworkSlot,
): Promise<ArtworkCandidate[]> {
  const p = new Params(viewer);
  const idp = p.add(itemId);
  const path = p.add(`$.${slot}.tag`);
  return all<ArtworkCandidate>(
    db,
    `SELECT s.provider_item_id AS provider_id, json_extract(s.artwork, ${path}) AS tag, s.server_id
       FROM media_items i JOIN sources s ON s.media_item_id = i.id
       JOIN servers sv ON sv.id = s.server_id
      WHERE i.id = ${idp} AND ${visibleItem('i')} AND ${visibleSource('s')}
        AND json_extract(s.artwork, ${path}) IS NOT NULL
      ORDER BY (s.id = i.metadata_source_id) DESC, sv.priority DESC, s.id LIMIT 5`,
    p.values,
  );
}

/** Links of a visible person or collection on exposed servers that carry a portrait or art. */
export function entityArtworkCandidates(
  db: D1Database,
  viewer: Viewer,
  kind: 'person' | 'collection',
  id: string,
): Promise<ArtworkCandidate[]> {
  const p = new Params(viewer);
  const idp = p.add(id);
  const person = kind === 'person';
  return all<ArtworkCandidate>(
    db,
    `SELECT ${person ? 'l.provider_person_id' : 'l.provider_collection_id'} AS provider_id,
            json_extract(l.artwork, '$.poster.tag') AS tag, l.server_id
       FROM ${person ? 'people' : 'collections'} e
       JOIN ${person ? 'person_provider_links' : 'collection_provider_links'} l
         ON l.${person ? 'person_id' : 'collection_id'} = e.id
       JOIN servers sv ON sv.id = l.server_id AND sv.status IN ${EXPOSED}
      WHERE e.id = ${idp} AND ${person ? visiblePerson('e') : visibleCollection('e')}
        AND json_extract(l.artwork, '$.poster.tag') IS NOT NULL
      ORDER BY (l.id = e.metadata_link_id) DESC, sv.priority DESC, l.id LIMIT 5`,
    p.values,
  );
}
