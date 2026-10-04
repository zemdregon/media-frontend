/**
 * D1 reads and write statements for the derived catalog tables that sync maintains (C-SYNC,
 * C-MATCH; LLD-SCHEMA, TDD-D1). Catalog read routes live elsewhere; nothing here serves a viewer.
 *
 * Statements are returned unexecuted so a sync step can submit them as one `batch()`. Every
 * statement is idempotent (LLD-ERR): re-applying a page after an interrupted run is safe.
 *
 * Search index. `search_fts` rows are written by explicit rowid so a row can be replaced without
 * scanning the index: title rows use `media_items.rowid * 3`, person rows `people.rowid * 3 + 1`
 * and collection rows `collections.rowid * 3 + 2` (the three kinds share one rowid space).
 * Readers match on `kind`, `name` and `alt_name` and join by `entity_id`, never by rowid.
 */
import type { ItemType } from '../providers/types';
import type { ConflictFlag, ItemCandidate, Override, Scheme } from '../match/items';
import { SCHEMES } from '../match/items';
import type { CollectionCandidate, PersonCandidate, PersonLinkInfo } from '../match/people';

/** D1 allows 100 bound parameters per statement. */
export const MAX_BINDS = 90;

export function chunks<T>(list: readonly T[], size = MAX_BINDS): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

const marks = (n: number) => Array.from({ length: n }, () => '?').join(',');

// --- sources ---

export interface SourceRow {
  id: string;
  server_id: string;
  library_id: string;
  provider_item_id: string;
  provider_parent_id: string | null;
  media_item_id: string;
  item_type: ItemType;
  title: string;
  year: number | null;
  season_number: number | null;
  episode_number: number | null;
  external_ids: string;
  match_method: 'external_id' | 'episode_position' | 'new' | 'manual';
  content_hash: string;
  status: 'present' | 'missing';
  missing_since: number | null;
  last_seen_sync_id: string | null;
  meta: string;
}

const SOURCE_COLUMNS = `id, server_id, library_id, provider_item_id, provider_parent_id,
  media_item_id, item_type, title, year, season_number, episode_number, external_ids,
  match_method, content_hash, status, missing_since, last_seen_sync_id, meta`;

export async function getSourcesByProviderIds(
  db: D1Database,
  serverId: string,
  providerIds: string[],
): Promise<Map<string, SourceRow>> {
  const out = new Map<string, SourceRow>();
  for (const part of chunks(providerIds)) {
    const rows = await db
      .prepare(
        `SELECT ${SOURCE_COLUMNS} FROM sources
          WHERE server_id = ? AND provider_item_id IN (${marks(part.length)})`,
      )
      .bind(serverId, ...part)
      .all<SourceRow>();
    for (const r of rows.results) out.set(r.provider_item_id, r);
  }
  return out;
}

export function getSourceById(db: D1Database, id: string): Promise<SourceRow | null> {
  return db.prepare(`SELECT ${SOURCE_COLUMNS} FROM sources WHERE id = ?`).bind(id).first();
}

/** Child sources of a parent source (seasons of a series, episodes of a season). */
export function listChildSources(
  db: D1Database,
  serverId: string,
  parentProviderId: string,
): Promise<SourceRow[]> {
  return db
    .prepare(
      `SELECT ${SOURCE_COLUMNS} FROM sources WHERE server_id = ? AND provider_parent_id = ?
        ORDER BY id`,
    )
    .bind(serverId, parentProviderId)
    .all<SourceRow>()
    .then((r) => r.results);
}

/** Season and episode sources of a library whose item has no parent yet (parent seen later). */
export function listOrphanSources(db: D1Database, libraryId: string): Promise<SourceRow[]> {
  return db
    .prepare(
      `SELECT ${SOURCE_COLUMNS.split(',')
        .map((c) => `s.${c.trim()}`)
        .join(', ')}
         FROM sources s JOIN media_items i ON i.id = s.media_item_id
        WHERE s.library_id = ? AND s.item_type IN ('season','episode') AND i.parent_id IS NULL
          AND s.provider_parent_id IS NOT NULL ORDER BY s.id`,
    )
    .bind(libraryId)
    .all<SourceRow>()
    .then((r) => r.results);
}

export interface SourceWrite {
  id: string;
  serverId: string;
  libraryId: string;
  providerItemId: string;
  providerParentId: string | null;
  mediaItemId: string;
  type: ItemType;
  title: string;
  year: number | null;
  seasonNumber: number | null;
  episodeNumber: number | null;
  externalIds: string;
  matchMethod: SourceRow['match_method'];
  artwork: string;
  meta: string;
  syncId: string;
  dateAdded: number | null;
  now: number;
}

/**
 * Inserts or refreshes a source and marks it present. `content_hash` is deliberately not set on
 * update: it is committed last (`commitHashStmt`), so a run killed between the page's chunks
 * reprocesses the source instead of skipping it.
 */
export function upsertSourceStmt(db: D1Database, s: SourceWrite): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO sources (id, server_id, library_id, provider_item_id, provider_parent_id,
         media_item_id, item_type, title, year, season_number, episode_number, external_ids,
         match_method, artwork, content_hash, status, missing_since, last_seen_sync_id,
         date_added, updated_at, meta)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', 'present', NULL, ?, ?, ?, ?)
       ON CONFLICT (server_id, provider_item_id) DO UPDATE SET
         library_id = excluded.library_id, provider_parent_id = excluded.provider_parent_id,
         media_item_id = excluded.media_item_id, item_type = excluded.item_type,
         title = excluded.title, year = excluded.year, season_number = excluded.season_number,
         episode_number = excluded.episode_number, external_ids = excluded.external_ids,
         match_method = excluded.match_method, artwork = excluded.artwork,
         status = 'present', missing_since = NULL, last_seen_sync_id = excluded.last_seen_sync_id,
         date_added = excluded.date_added, updated_at = excluded.updated_at, meta = excluded.meta`,
    )
    .bind(
      s.id,
      s.serverId,
      s.libraryId,
      s.providerItemId,
      s.providerParentId,
      s.mediaItemId,
      s.type,
      s.title,
      s.year,
      s.seasonNumber,
      s.episodeNumber,
      s.externalIds,
      s.matchMethod,
      s.artwork,
      s.syncId,
      s.dateAdded,
      s.now,
      s.meta,
    );
}

export function commitHashStmt(
  db: D1Database,
  sourceId: string,
  hash: string,
): D1PreparedStatement {
  return db.prepare('UPDATE sources SET content_hash = ? WHERE id = ?').bind(hash, sourceId);
}

/** Bookkeeping for sources whose data did not change: seen in this run (FR-SYNC-004). */
export function touchSeenStmts(
  db: D1Database,
  serverId: string,
  providerIds: string[],
  syncId: string,
): D1PreparedStatement[] {
  return chunks(providerIds).map((part) =>
    db
      .prepare(
        `UPDATE sources SET last_seen_sync_id = ?
          WHERE server_id = ? AND provider_item_id IN (${marks(part.length)})`,
      )
      .bind(syncId, serverId, ...part),
  );
}

export interface VersionWrite {
  providerVersionId: string;
  container?: string | undefined;
  videoCodec?: string | undefined;
  videoProfile?: string | undefined;
  width?: number | undefined;
  height?: number | undefined;
  hdr: string;
  bitrate?: number | undefined;
  runtimeMs?: number | undefined;
  sizeBytes?: number | undefined;
  audioTracks: string;
  subtitleTracks: string;
}

/** Versions keyed by `(source_id, provider_version_id)`; versions the origin dropped are removed. */
export function versionStmts(
  db: D1Database,
  sourceId: string,
  versions: VersionWrite[],
  newId: () => string,
): D1PreparedStatement[] {
  const stmts: D1PreparedStatement[] = [];
  const ids = versions.map((v) => v.providerVersionId);
  stmts.push(
    ids.length === 0
      ? db.prepare('DELETE FROM media_versions WHERE source_id = ?').bind(sourceId)
      : db
          .prepare(
            `DELETE FROM media_versions WHERE source_id = ?
               AND provider_version_id NOT IN (${marks(ids.length)})`,
          )
          .bind(sourceId, ...ids),
  );
  for (const v of versions) {
    stmts.push(
      db
        .prepare(
          `INSERT INTO media_versions (id, source_id, provider_version_id, container, video_codec,
             video_profile, width, height, hdr, bitrate, runtime_ms, size_bytes, audio_tracks,
             subtitle_tracks)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (source_id, provider_version_id) DO UPDATE SET
             container = excluded.container, video_codec = excluded.video_codec,
             video_profile = excluded.video_profile, width = excluded.width,
             height = excluded.height, hdr = excluded.hdr, bitrate = excluded.bitrate,
             runtime_ms = excluded.runtime_ms, size_bytes = excluded.size_bytes,
             audio_tracks = excluded.audio_tracks, subtitle_tracks = excluded.subtitle_tracks`,
        )
        .bind(
          newId(),
          sourceId,
          v.providerVersionId,
          v.container ?? null,
          v.videoCodec ?? null,
          v.videoProfile ?? null,
          v.width ?? null,
          v.height ?? null,
          v.hdr,
          v.bitrate ?? null,
          v.runtimeMs ?? null,
          v.sizeBytes ?? null,
          v.audioTracks,
          v.subtitleTracks,
        ),
    );
  }
  return stmts;
}

// --- canonical items ---

export interface ItemRow {
  id: string;
  type: ItemType;
  parent_id: string | null;
  season_number: number | null;
  episode_number: number | null;
}

export function getItem(db: D1Database, id: string): Promise<ItemRow | null> {
  return db
    .prepare(
      'SELECT id, type, parent_id, season_number, episode_number FROM media_items WHERE id = ?',
    )
    .bind(id)
    .first<ItemRow>();
}

export function findChildItem(
  db: D1Database,
  parentId: string,
  type: 'season' | 'episode',
  number: number,
): Promise<string | null> {
  const column = type === 'season' ? 'season_number' : 'episode_number';
  return db
    .prepare(
      `SELECT id FROM media_items WHERE parent_id = ? AND type = ? AND ${column} = ? ORDER BY id LIMIT 1`,
    )
    .bind(parentId, type, number)
    .first<{ id: string }>()
    .then((r) => r?.id ?? null);
}

export function insertItemStmt(
  db: D1Database,
  i: {
    id: string;
    type: ItemType;
    parentId: string | null;
    title: string;
    sortTitle: string;
    year: number | null;
    seasonNumber: number | null;
    episodeNumber: number | null;
    dateAdded: number;
    now: number;
  },
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT OR IGNORE INTO media_items (id, type, parent_id, title, sort_title, year,
         season_number, episode_number, date_added, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      i.id,
      i.type,
      i.parentId,
      i.title,
      i.sortTitle,
      i.year,
      i.seasonNumber,
      i.episodeNumber,
      i.dateAdded,
      i.now,
      i.now,
    );
}

/** An orphaned season or episode item gets its parent and position once the parent is known. */
export function adoptItemStmt(
  db: D1Database,
  itemId: string,
  parentId: string,
  seasonNumber: number | null,
  episodeNumber: number | null,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE media_items SET parent_id = ?, season_number = COALESCE(?, season_number),
              episode_number = COALESCE(?, episode_number)
        WHERE id = ? AND parent_id IS NULL`,
    )
    .bind(parentId, seasonNumber, episodeNumber, itemId);
}

/**
 * Recomputes an item's derived fields from its present sources (LLD-MATCH): the displayed
 * metadata comes from the present source on the highest-priority server, then the most fields
 * filled, then the lowest ID; `best_height`, `has_hdr` and `date_added` aggregate over present
 * sources; `external_ids` aggregate every non-manual source (BR-3: a pinned source does not
 * contribute IDs). Also refreshes the item's title search row.
 */
export function recomputeItemStmts(
  db: D1Database,
  itemId: string,
  now: number,
): D1PreparedStatement[] {
  return [
    db.prepare('DELETE FROM external_ids WHERE media_item_id = ?').bind(itemId),
    db
      .prepare(
        `INSERT OR IGNORE INTO external_ids (media_item_id, item_type, scheme, value)
         SELECT i.id, i.type, j.key, j.value
           FROM media_items i
           JOIN sources s ON s.media_item_id = i.id AND s.match_method <> 'manual'
           JOIN json_each(s.external_ids) j
          WHERE i.id = ?1 AND j.value IS NOT NULL AND j.value <> ''
            AND ((i.type = 'movie' AND j.key IN ('tmdb','imdb'))
              OR (i.type IN ('series','episode') AND j.key IN ('tmdb','imdb','tvdb')))`,
      )
      .bind(itemId),
    db
      .prepare(
        `UPDATE media_items SET
           metadata_source_id = b.sid, title = b.title, sort_title = b.sort,
           original_title = b.orig, year = b.year, overview = b.overview, genres = b.genres,
           runtime_ms = b.runtime,
           best_height = (SELECT MAX(v.height) FROM media_versions v JOIN sources s ON s.id = v.source_id
                           WHERE s.media_item_id = media_items.id AND s.status = 'present'),
           has_hdr = COALESCE((SELECT MAX(v.hdr <> 'none') FROM media_versions v JOIN sources s ON s.id = v.source_id
                           WHERE s.media_item_id = media_items.id AND s.status = 'present'), 0),
           date_added = COALESCE((SELECT MIN(COALESCE(s.date_added, s.updated_at)) FROM sources s
                           WHERE s.media_item_id = media_items.id AND s.status = 'present'),
                                 media_items.date_added),
           updated_at = ?2
         FROM (SELECT s.id AS sid, s.title AS title,
                      COALESCE(json_extract(s.meta, '$.sort'), lower(s.title)) AS sort,
                      json_extract(s.meta, '$.originalTitle') AS orig, s.year AS year,
                      json_extract(s.meta, '$.overview') AS overview,
                      COALESCE(json_extract(s.meta, '$.genres'), '[]') AS genres,
                      json_extract(s.meta, '$.runtimeMs') AS runtime
                 FROM sources s JOIN servers sv ON sv.id = s.server_id
                WHERE s.media_item_id = ?1 AND s.status = 'present'
                ORDER BY sv.priority DESC,
                         ((json_extract(s.meta, '$.overview') IS NOT NULL) + (s.year IS NOT NULL)
                          + (s.artwork <> '{}')) DESC, s.id
                LIMIT 1) b
        WHERE media_items.id = ?1`,
      )
      .bind(itemId, now),
    ...titleSearchStmts(db, itemId),
  ];
}

function titleSearchStmts(db: D1Database, itemId: string): D1PreparedStatement[] {
  return [
    db
      .prepare(
        'DELETE FROM search_fts WHERE rowid = (SELECT rowid * 3 FROM media_items WHERE id = ?)',
      )
      .bind(itemId),
    db
      .prepare(
        `INSERT INTO search_fts (rowid, kind, entity_id, name, alt_name)
         SELECT rowid * 3, 'title', id, title, COALESCE(original_title, '')
           FROM media_items WHERE id = ? AND type IN ('movie','series')`,
      )
      .bind(itemId),
  ];
}

/** Removes `old` after its last source moved away: availability prune, then delete if sourceless. */
export function detachStmts(
  db: D1Database,
  oldItemId: string,
  libraryId: string,
  now: number,
): D1PreparedStatement[] {
  return [
    db
      .prepare(
        `DELETE FROM item_availability WHERE media_item_id = ? AND library_id = ?
           AND NOT EXISTS (SELECT 1 FROM sources s WHERE s.media_item_id = item_availability.media_item_id
                             AND s.library_id = item_availability.library_id AND s.status = 'present')`,
      )
      .bind(oldItemId, libraryId),
    ...deleteIfSourcelessStmts(db, oldItemId),
    ...recomputeItemStmts(db, oldItemId, now),
  ];
}

/** Deletes an item that has no sources and no child items (DR-005); its search row goes first. */
export function deleteIfSourcelessStmts(db: D1Database, itemId: string): D1PreparedStatement[] {
  const guard = `NOT EXISTS (SELECT 1 FROM sources s WHERE s.media_item_id = ?1)
                 AND NOT EXISTS (SELECT 1 FROM media_items c WHERE c.parent_id = ?1)`;
  return [
    db
      .prepare(
        `DELETE FROM search_fts WHERE rowid = (SELECT rowid * 3 FROM media_items WHERE id = ?1 AND ${guard})`,
      )
      .bind(itemId),
    db.prepare(`DELETE FROM media_items WHERE id = ?1 AND ${guard}`).bind(itemId),
  ];
}

export function availabilityStmt(
  db: D1Database,
  itemId: string,
  libraryId: string,
): D1PreparedStatement {
  return db
    .prepare('INSERT OR IGNORE INTO item_availability (media_item_id, library_id) VALUES (?, ?)')
    .bind(itemId, libraryId);
}

// --- item match lookups ---

/** Items sharing at least one `(scheme, value)` pair, with every ID each aggregates. */
export async function loadItemCandidates(
  db: D1Database,
  pairs: [Scheme, string][],
): Promise<ItemCandidate[]> {
  if (pairs.length === 0) return [];
  const where = pairs.map(() => '(scheme = ? AND value = ?)').join(' OR ');
  const rows = await db
    .prepare(
      `SELECT e.media_item_id, e.item_type, e.scheme, e.value FROM external_ids e
        WHERE e.media_item_id IN (SELECT media_item_id FROM external_ids WHERE ${where})
        ORDER BY e.media_item_id`,
    )
    .bind(...pairs.flat())
    .all<{ media_item_id: string; item_type: ItemType; scheme: Scheme; value: string }>();
  const byItem = new Map<string, ItemCandidate>();
  for (const r of rows.results) {
    let c = byItem.get(r.media_item_id);
    if (!c) {
      c = { itemId: r.media_item_id, type: r.item_type, ids: { tmdb: [], imdb: [], tvdb: [] } };
      byItem.set(r.media_item_id, c);
    }
    if (SCHEMES.includes(r.scheme)) c.ids[r.scheme].push(r.value);
  }
  return [...byItem.values()];
}

export async function loadItemParents(
  db: D1Database,
  itemIds: string[],
): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  for (const part of chunks(itemIds)) {
    const rows = await db
      .prepare(`SELECT id, parent_id FROM media_items WHERE id IN (${marks(part.length)})`)
      .bind(...part)
      .all<{ id: string; parent_id: string | null }>();
    for (const r of rows.results) out.set(r.id, r.parent_id);
  }
  return out;
}

export interface OverrideRow {
  provider_item_id: string;
  kind: 'pin' | 'separate';
  media_item_id: string | null;
  person_id: string | null;
  collection_id: string | null;
}

/** Overrides for one entity kind, keyed by the origin's ID (BR-3). */
export async function loadOverrides(
  db: D1Database,
  entityKind: 'item' | 'person' | 'collection',
  serverId: string,
  providerIds: string[],
): Promise<Map<string, Override>> {
  const out = new Map<string, Override>();
  for (const part of chunks(providerIds)) {
    const rows = await db
      .prepare(
        `SELECT provider_item_id, kind, media_item_id, person_id, collection_id
           FROM curation_overrides
          WHERE entity_kind = ? AND server_id = ? AND provider_item_id IN (${marks(part.length)})`,
      )
      .bind(entityKind, serverId, ...part)
      .all<OverrideRow>();
    for (const r of rows.results) {
      const target = r.media_item_id ?? r.person_id ?? r.collection_id;
      out.set(
        r.provider_item_id,
        r.kind === 'pin' && target ? { kind: 'pin', targetId: target } : { kind: 'separate' },
      );
    }
  }
  return out;
}

// --- conflicts ---

type ConflictSubject =
  | { kind: 'item'; sourceId: string; mediaItemId?: string | null }
  | { kind: 'person'; linkId: string }
  | { kind: 'collection'; linkId: string };

const SUBJECT_COLUMN = {
  item: 'source_id',
  person: 'person_link_id',
  collection: 'collection_link_id',
} as const;

/**
 * Opens (or refreshes) the conflict flag for a subject, unless the operator dismissed identical
 * details (LLD-MATCH `flag`). `id` is only used when no row exists yet.
 */
export function flagStmt(
  db: D1Database,
  id: string,
  subject: ConflictSubject,
  flag: ConflictFlag,
  now: number,
): D1PreparedStatement {
  const col = SUBJECT_COLUMN[subject.kind];
  const subjectId = subject.kind === 'item' ? subject.sourceId : subject.linkId;
  const details = JSON.stringify({
    candidates: flag.candidates.map((c) => ({
      [subject.kind === 'item'
        ? 'itemId'
        : subject.kind === 'person'
          ? 'personId'
          : 'collectionId']: c.id,
      sharedIds: c.sharedIds,
      conflictingIds: c.conflictingIds,
    })),
  });
  const mediaItemId =
    subject.kind === 'item' ? (subject.mediaItemId ?? flag.candidates[0]?.id ?? null) : null;
  return db
    .prepare(
      `INSERT INTO match_conflicts (id, entity_kind, ${col}, media_item_id, reason, details, status, detected_at)
       VALUES (?, ?, ?, ?, ?, ?, 'open', ?)
       ON CONFLICT (${col}) WHERE ${col} IS NOT NULL DO UPDATE SET
         reason = excluded.reason, details = excluded.details, media_item_id = excluded.media_item_id,
         status = 'open', detected_at = excluded.detected_at, resolved_at = NULL, resolved_by = NULL
       WHERE NOT (match_conflicts.status = 'dismissed' AND match_conflicts.details = excluded.details)`,
    )
    .bind(id, subject.kind, subjectId, mediaItemId, flag.reason, details, now);
}

/** A subject that now matches cleanly closes its own open flag (agent decision, see report). */
export function clearFlagStmt(
  db: D1Database,
  kind: 'item' | 'person' | 'collection',
  subjectId: string,
  now: number,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE match_conflicts SET status = 'resolved', resolved_at = ?
        WHERE ${SUBJECT_COLUMN[kind]} = ? AND status = 'open'`,
    )
    .bind(now, subjectId);
}

// --- people ---

export interface PersonLinkRow {
  id: string;
  person_id: string;
  server_id: string;
  provider_person_id: string;
  name: string;
  tmdb_id: string | null;
  imdb_id: string | null;
  artwork: string;
  match_method: string;
}

export async function getPersonLinks(
  db: D1Database,
  serverId: string,
  providerPersonIds: string[],
): Promise<Map<string, PersonLinkRow>> {
  const out = new Map<string, PersonLinkRow>();
  for (const part of chunks(providerPersonIds)) {
    const rows = await db
      .prepare(
        `SELECT id, person_id, server_id, provider_person_id, name, tmdb_id, imdb_id, artwork, match_method
           FROM person_provider_links WHERE server_id = ? AND provider_person_id IN (${marks(part.length)})`,
      )
      .bind(serverId, ...part)
      .all<PersonLinkRow>();
    for (const r of rows.results) out.set(r.provider_person_id, r);
  }
  return out;
}

interface CandidateLinkRow {
  person_id: string;
  metadata_link_id: string | null;
  link_id: string;
  server_id: string;
  provider_person_id: string;
  name: string;
  tmdb_id: string | null;
  imdb_id: string | null;
  priority: number;
}

function groupPersons(rows: CandidateLinkRow[]): PersonCandidate[] {
  const out = new Map<string, PersonCandidate>();
  for (const r of rows) {
    let c = out.get(r.person_id);
    if (!c) {
      c = { personId: r.person_id, metadataLinkId: r.metadata_link_id, links: [] };
      out.set(r.person_id, c);
    }
    const link: PersonLinkInfo = {
      linkId: r.link_id,
      serverId: r.server_id,
      providerPersonId: r.provider_person_id,
      name: r.name,
      tmdbId: r.tmdb_id,
      imdbId: r.imdb_id,
      serverPriority: r.priority,
    };
    c.links.push(link);
  }
  return [...out.values()];
}

const CANDIDATE_SELECT = `SELECT l.person_id, p.metadata_link_id, l.id AS link_id, l.server_id, l.provider_person_id,
  l.name, l.tmdb_id, l.imdb_id, s.priority
  FROM person_provider_links l JOIN servers s ON s.id = l.server_id
  JOIN people p ON p.id = l.person_id`;

export async function personCandidatesByIds(
  db: D1Database,
  tmdbId: string | null,
  imdbId: string | null,
): Promise<PersonCandidate[]> {
  const conds: string[] = [];
  const binds: string[] = [];
  if (tmdbId) {
    conds.push('tmdb_id = ?');
    binds.push(tmdbId);
  }
  if (imdbId) {
    conds.push('imdb_id = ?');
    binds.push(imdbId);
  }
  if (conds.length === 0) return [];
  const rows = await db
    .prepare(
      `${CANDIDATE_SELECT} WHERE l.person_id IN
         (SELECT person_id FROM person_provider_links WHERE ${conds.join(' OR ')}) ORDER BY l.id`,
    )
    .bind(...binds)
    .all<CandidateLinkRow>();
  return groupPersons(rows.results);
}

export async function personCandidatesByName(
  db: D1Database,
  key: string,
): Promise<PersonCandidate[]> {
  if (key === '') return [];
  const rows = await db
    .prepare(
      `${CANDIDATE_SELECT} WHERE l.person_id IN (SELECT id FROM people WHERE name_key = ?) ORDER BY l.id`,
    )
    .bind(key)
    .all<CandidateLinkRow>();
  return groupPersons(rows.results);
}

export async function loadPersonCandidate(
  db: D1Database,
  personId: string,
): Promise<PersonCandidate | null> {
  const rows = await db
    .prepare(`${CANDIDATE_SELECT} WHERE l.person_id = ? ORDER BY l.id`)
    .bind(personId)
    .all<CandidateLinkRow>();
  return groupPersons(rows.results)[0] ?? null;
}

export function getPersonMetadataLink(
  db: D1Database,
  personId: string,
): Promise<{ metadata_link_id: string | null } | null> {
  return db
    .prepare('SELECT metadata_link_id FROM people WHERE id = ?')
    .bind(personId)
    .first<{ metadata_link_id: string | null }>();
}

export function insertPersonStmt(
  db: D1Database,
  p: { id: string; name: string; sortName: string; nameKey: string; linkId: string; now: number },
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT OR IGNORE INTO people (id, name, sort_name, name_key, metadata_link_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(p.id, p.name, p.sortName, p.nameKey, p.linkId, p.now, p.now);
}

export function updatePersonStmt(
  db: D1Database,
  p: { id: string; name: string; sortName: string; nameKey: string; linkId: string; now: number },
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE people SET name = ?, sort_name = ?, name_key = ?, metadata_link_id = ?, updated_at = ?
        WHERE id = ?`,
    )
    .bind(p.name, p.sortName, p.nameKey, p.linkId, p.now, p.id);
}

export function upsertPersonLinkStmt(
  db: D1Database,
  l: {
    id: string;
    personId: string;
    serverId: string;
    providerPersonId: string;
    name: string;
    tmdbId: string | null;
    imdbId: string | null;
    artwork: string;
    matchMethod: 'external_id' | 'name' | 'new' | 'manual';
    now: number;
  },
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO person_provider_links (id, person_id, server_id, provider_person_id, name,
         tmdb_id, imdb_id, artwork, match_method, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (server_id, provider_person_id) DO UPDATE SET
         person_id = excluded.person_id, name = excluded.name, tmdb_id = excluded.tmdb_id,
         imdb_id = excluded.imdb_id, artwork = excluded.artwork,
         match_method = excluded.match_method, updated_at = excluded.updated_at`,
    )
    .bind(
      l.id,
      l.personId,
      l.serverId,
      l.providerPersonId,
      l.name,
      l.tmdbId,
      l.imdbId,
      l.artwork,
      l.matchMethod,
      l.now,
    );
}

/** Updates only the portrait reference, for a link whose identity did not change. */
export function updateLinkArtworkStmt(
  db: D1Database,
  linkId: string,
  artwork: string,
): D1PreparedStatement {
  return db
    .prepare('UPDATE person_provider_links SET artwork = ? WHERE id = ?')
    .bind(artwork, linkId);
}

export function rekeyCreditsStmt(
  db: D1Database,
  linkId: string,
  personId: string,
): D1PreparedStatement {
  return db.prepare('UPDATE credits SET person_id = ? WHERE link_id = ?').bind(personId, linkId);
}

export function replaceCreditsStmts(
  db: D1Database,
  sourceId: string,
  mediaItemId: string,
  credits: {
    linkId: string;
    personId: string;
    role: string;
    character: string | null;
    order: number;
  }[],
): D1PreparedStatement[] {
  return [
    db.prepare('DELETE FROM credits WHERE source_id = ?').bind(sourceId),
    ...credits.map((c) =>
      db
        .prepare(
          `INSERT OR REPLACE INTO credits (source_id, link_id, role, person_id, media_item_id, character, sort_order)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(sourceId, c.linkId, c.role, c.personId, mediaItemId, c.character, c.order),
    ),
  ];
}

/** Person search row (rowid*3+1). Written from the row itself so name and alt names stay in step. */
export function personSearchStmts(
  db: D1Database,
  personId: string,
  altNames: string,
): D1PreparedStatement[] {
  return [
    db
      .prepare(
        'DELETE FROM search_fts WHERE rowid = (SELECT rowid * 3 + 1 FROM people WHERE id = ?)',
      )
      .bind(personId),
    db
      .prepare(
        `INSERT INTO search_fts (rowid, kind, entity_id, name, alt_name)
         SELECT rowid * 3 + 1, 'person', id, name, ? FROM people WHERE id = ?`,
      )
      .bind(altNames, personId),
  ];
}

/** Deletes a person left without links, with its search row (DR-005). */
export function deletePersonIfLinklessStmts(
  db: D1Database,
  personId: string,
): D1PreparedStatement[] {
  const guard = 'NOT EXISTS (SELECT 1 FROM person_provider_links l WHERE l.person_id = ?1)';
  return [
    db
      .prepare(
        `DELETE FROM search_fts WHERE rowid = (SELECT rowid * 3 + 1 FROM people WHERE id = ?1 AND ${guard})`,
      )
      .bind(personId),
    db.prepare(`DELETE FROM people WHERE id = ?1 AND ${guard}`).bind(personId),
  ];
}

// --- collections ---

export interface CollectionLinkRow {
  id: string;
  collection_id: string;
  server_id: string;
  provider_collection_id: string;
  name: string;
  overview: string | null;
  tmdb_collection_id: string | null;
  artwork: string;
  match_method: string;
}

export function getCollectionLink(
  db: D1Database,
  serverId: string,
  providerCollectionId: string,
): Promise<CollectionLinkRow | null> {
  return db
    .prepare(
      `SELECT id, collection_id, server_id, provider_collection_id, name, overview,
              tmdb_collection_id, artwork, match_method
         FROM collection_provider_links WHERE server_id = ? AND provider_collection_id = ?`,
    )
    .bind(serverId, providerCollectionId)
    .first<CollectionLinkRow>();
}

export function listLinkMemberSourceIds(db: D1Database, linkId: string): Promise<string[]> {
  return db
    .prepare('SELECT source_id FROM collection_members WHERE link_id = ? ORDER BY source_id')
    .bind(linkId)
    .all<{ source_id: string }>()
    .then((r) => r.results.map((x) => x.source_id));
}

export async function collectionCandidatesByTmdb(
  db: D1Database,
  tmdbCollectionId: string,
): Promise<CollectionCandidate[]> {
  const rows = await db
    .prepare(
      `SELECT collection_id, tmdb_collection_id FROM collection_provider_links
        WHERE collection_id IN (SELECT collection_id FROM collection_provider_links WHERE tmdb_collection_id = ?)
          AND tmdb_collection_id IS NOT NULL`,
    )
    .bind(tmdbCollectionId)
    .all<{ collection_id: string; tmdb_collection_id: string }>();
  const out = new Map<string, CollectionCandidate>();
  for (const r of rows.results) {
    const c = out.get(r.collection_id) ?? { collectionId: r.collection_id, tmdbCollectionIds: [] };
    c.tmdbCollectionIds.push(r.tmdb_collection_id);
    out.set(r.collection_id, c);
  }
  return [...out.values()];
}

export function upsertCollectionLinkStmt(
  db: D1Database,
  l: {
    id: string;
    collectionId: string;
    serverId: string;
    providerCollectionId: string;
    name: string;
    overview: string | null;
    tmdbCollectionId: string | null;
    artwork: string;
    matchMethod: 'external_id' | 'new' | 'manual';
    syncId: string;
    now: number;
  },
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO collection_provider_links (id, collection_id, server_id, provider_collection_id,
         name, overview, tmdb_collection_id, artwork, match_method, last_seen_sync_id, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (server_id, provider_collection_id) DO UPDATE SET
         collection_id = excluded.collection_id, name = excluded.name, overview = excluded.overview,
         tmdb_collection_id = excluded.tmdb_collection_id, artwork = excluded.artwork,
         match_method = excluded.match_method, last_seen_sync_id = excluded.last_seen_sync_id,
         updated_at = excluded.updated_at`,
    )
    .bind(
      l.id,
      l.collectionId,
      l.serverId,
      l.providerCollectionId,
      l.name,
      l.overview,
      l.tmdbCollectionId,
      l.artwork,
      l.matchMethod,
      l.syncId,
      l.now,
    );
}

export function markLinkSeenStmt(
  db: D1Database,
  linkId: string,
  syncId: string,
): D1PreparedStatement {
  return db
    .prepare('UPDATE collection_provider_links SET last_seen_sync_id = ? WHERE id = ?')
    .bind(syncId, linkId);
}

export function replaceMembersStmts(
  db: D1Database,
  linkId: string,
  members: { sourceId: string; mediaItemId: string }[],
): D1PreparedStatement[] {
  return [
    db.prepare('DELETE FROM collection_members WHERE link_id = ?').bind(linkId),
    ...members.map((m) =>
      db
        .prepare(
          'INSERT OR IGNORE INTO collection_members (link_id, source_id, media_item_id) VALUES (?, ?, ?)',
        )
        .bind(linkId, m.sourceId, m.mediaItemId),
    ),
  ];
}

export function insertCollectionStmt(
  db: D1Database,
  c: {
    id: string;
    name: string;
    sortName: string;
    overview: string | null;
    linkId: string;
    now: number;
  },
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT OR IGNORE INTO collections (id, name, sort_name, overview, metadata_link_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(c.id, c.name, c.sortName, c.overview, c.linkId, c.now, c.now);
}

export function updateCollectionStmt(
  db: D1Database,
  c: {
    id: string;
    name: string;
    sortName: string;
    overview: string | null;
    linkId: string | null;
    now: number;
  },
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE collections SET name = ?, sort_name = ?, overview = ?, metadata_link_id = ?, updated_at = ?
        WHERE id = ?`,
    )
    .bind(c.name, c.sortName, c.overview, c.linkId, c.now, c.id);
}

export function collectionSearchStmts(
  db: D1Database,
  collectionId: string,
  altNames: string,
): D1PreparedStatement[] {
  return [
    db
      .prepare(
        'DELETE FROM search_fts WHERE rowid = (SELECT rowid * 3 + 2 FROM collections WHERE id = ?)',
      )
      .bind(collectionId),
    db
      .prepare(
        `INSERT INTO search_fts (rowid, kind, entity_id, name, alt_name)
         SELECT rowid * 3 + 2, 'collection', id, name, ? FROM collections WHERE id = ?`,
      )
      .bind(altNames, collectionId),
  ];
}

export interface CollectionLinkInfo {
  id: string;
  name: string;
  overview: string | null;
  priority: number;
}

export function listCollectionLinks(
  db: D1Database,
  collectionId: string,
): Promise<CollectionLinkInfo[]> {
  return db
    .prepare(
      `SELECT l.id, l.name, l.overview, s.priority FROM collection_provider_links l
         JOIN servers s ON s.id = l.server_id WHERE l.collection_id = ? ORDER BY s.priority DESC, l.id`,
    )
    .bind(collectionId)
    .all<CollectionLinkInfo>()
    .then((r) => r.results);
}

export function deleteCollectionIfLinklessStmts(
  db: D1Database,
  collectionId: string,
): D1PreparedStatement[] {
  const guard = 'NOT EXISTS (SELECT 1 FROM collection_provider_links l WHERE l.collection_id = ?1)';
  return [
    db
      .prepare(
        `DELETE FROM search_fts WHERE rowid = (SELECT rowid * 3 + 2 FROM collections WHERE id = ?1 AND ${guard})`,
      )
      .bind(collectionId),
    db.prepare(`DELETE FROM collections WHERE id = ?1 AND ${guard}`).bind(collectionId),
  ];
}
