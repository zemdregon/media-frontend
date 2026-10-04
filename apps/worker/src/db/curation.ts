/**
 * D1 reads and statements for operator curation (C-MATCH, LLD-MATCH "Curation operations";
 * FR-CAT-007, FR-CAT-010, BR-3). Statements are returned unexecuted so the service can submit a
 * whole mutation, with its audit row, as one batch.
 *
 * Overrides are keyed by `(entity_kind, server_id, provider ID)`, never by canonical ID, so they
 * outlive the canonical rows they point at and are honoured by every later sync (BR-3).
 */
import type { EntityKind } from '@cinewren/shared';
import { chunks } from './catalog-write';

const marks = (n: number) => Array.from({ length: n }, () => '?').join(',');

// --- guards ---

type GuardTable = 'media_items' | 'people' | 'collections' | 'sources';

/**
 * Aborts the whole batch (a NOT NULL violation, like `guardChangedStmt`) when the row vanished
 * between the operator's read and the write, for example because a sync purged it.
 */
export function requireRowStmt(db: D1Database, table: GuardTable, id: string): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO meta (k, v) SELECT 'cas_guard', NULL WHERE NOT EXISTS (SELECT 1 FROM ${table} WHERE id = ?)`,
    )
    .bind(id);
}

// --- overrides ---

export interface OverrideWrite {
  id: string;
  kind: 'pin' | 'separate';
  entityKind: EntityKind;
  /** The canonical item, person or collection the override points at. */
  targetId: string;
  serverId: string;
  providerId: string;
  createdBy: string;
  now: number;
}

/** Inserts or replaces the override for one provider record (`UNIQUE (entity_kind, server_id, provider_item_id)`). */
export function upsertOverrideStmt(db: D1Database, o: OverrideWrite): D1PreparedStatement {
  const item = o.entityKind === 'item' ? o.targetId : null;
  const person = o.entityKind === 'person' ? o.targetId : null;
  const collection = o.entityKind === 'collection' ? o.targetId : null;
  return db
    .prepare(
      `INSERT INTO curation_overrides (id, kind, entity_kind, media_item_id, person_id, collection_id,
         server_id, provider_item_id, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (entity_kind, server_id, provider_item_id) DO UPDATE SET
         kind = excluded.kind, media_item_id = excluded.media_item_id, person_id = excluded.person_id,
         collection_id = excluded.collection_id, created_by = excluded.created_by,
         created_at = excluded.created_at`,
    )
    .bind(
      o.id,
      o.kind,
      o.entityKind,
      item,
      person,
      collection,
      o.serverId,
      o.providerId,
      o.createdBy,
      o.now,
    );
}

export interface OverrideRow {
  id: string;
  kind: 'pin' | 'separate';
  entity_kind: EntityKind;
  target_id: string;
  server_id: string;
  server_name: string;
  provider_item_id: string;
  created_at: number;
}

export async function listOverridesPage(
  db: D1Database,
  after: [number, string] | undefined,
  limit: number,
): Promise<OverrideRow[]> {
  const where = after ? 'WHERE (o.created_at, o.id) < (?1, ?2)' : '';
  const stmt = db.prepare(
    `SELECT o.id, o.kind, o.entity_kind, COALESCE(o.media_item_id, o.person_id, o.collection_id) AS target_id,
            o.server_id, s.name AS server_name, o.provider_item_id, o.created_at
       FROM curation_overrides o JOIN servers s ON s.id = o.server_id
       ${where} ORDER BY o.created_at DESC, o.id DESC LIMIT ${after ? '?3' : '?1'}`,
  );
  const bound = after ? stmt.bind(after[0], after[1], limit) : stmt.bind(limit);
  return (await bound.all<OverrideRow>()).results;
}

export function getOverride(
  db: D1Database,
  id: string,
): Promise<{
  id: string;
  entity_kind: EntityKind;
  server_id: string;
  provider_item_id: string;
} | null> {
  return db
    .prepare(
      'SELECT id, entity_kind, server_id, provider_item_id FROM curation_overrides WHERE id = ?',
    )
    .bind(id)
    .first();
}

export function deleteOverrideStmt(db: D1Database, id: string): D1PreparedStatement {
  return db.prepare('DELETE FROM curation_overrides WHERE id = ?').bind(id);
}

// --- items ---

export interface CurationItemRow {
  id: string;
  type: 'movie' | 'series' | 'season' | 'episode';
  parent_id: string | null;
  title: string;
  season_number: number | null;
  episode_number: number | null;
}

export function getCurationItem(db: D1Database, id: string): Promise<CurationItemRow | null> {
  return db
    .prepare(
      'SELECT id, type, parent_id, title, season_number, episode_number FROM media_items WHERE id = ?',
    )
    .bind(id)
    .first<CurationItemRow>();
}

export interface CurationSourceRow {
  id: string;
  server_id: string;
  server_name: string;
  server_type: string;
  library_id: string;
  provider_item_id: string;
  provider_parent_id: string | null;
  media_item_id: string;
  item_type: 'movie' | 'series' | 'season' | 'episode';
  title: string;
  year: number | null;
  season_number: number | null;
  episode_number: number | null;
  match_method: string;
  status: 'present' | 'missing';
  date_added: number | null;
  meta: string;
}

const SOURCE_COLUMNS = `s.id, s.server_id, sv.name AS server_name, sv.type AS server_type, s.library_id,
  s.provider_item_id, s.provider_parent_id, s.media_item_id, s.item_type, s.title, s.year,
  s.season_number, s.episode_number, s.match_method, s.status, s.date_added, s.meta`;

export function listSourcesOfItem(db: D1Database, itemId: string): Promise<CurationSourceRow[]> {
  return db
    .prepare(
      `SELECT ${SOURCE_COLUMNS} FROM sources s JOIN servers sv ON sv.id = s.server_id
        WHERE s.media_item_id = ? ORDER BY sv.priority DESC, s.id`,
    )
    .bind(itemId)
    .all<CurationSourceRow>()
    .then((r) => r.results);
}

export function getCurationSource(db: D1Database, id: string): Promise<CurationSourceRow | null> {
  return db
    .prepare(
      `SELECT ${SOURCE_COLUMNS} FROM sources s JOIN servers sv ON sv.id = s.server_id WHERE s.id = ?`,
    )
    .bind(id)
    .first<CurationSourceRow>();
}

/** Seasons or episodes of one origin parent on one server (the subtree a split takes along). */
export async function listChildSourcesOf(
  db: D1Database,
  serverId: string,
  parentProviderIds: string[],
  type: 'season' | 'episode',
): Promise<CurationSourceRow[]> {
  const out: CurationSourceRow[] = [];
  for (const part of chunks(parentProviderIds)) {
    const rows = await db
      .prepare(
        `SELECT ${SOURCE_COLUMNS} FROM sources s JOIN servers sv ON sv.id = s.server_id
          WHERE s.server_id = ? AND s.item_type = ? AND s.provider_parent_id IN (${marks(part.length)})
          ORDER BY s.id`,
      )
      .bind(serverId, type, ...part)
      .all<CurationSourceRow>();
    out.push(...rows.results);
  }
  return out;
}

export function listChildItems(
  db: D1Database,
  parentId: string,
  type: 'season' | 'episode',
): Promise<{ id: string; number: number | null }[]> {
  const column = type === 'season' ? 'season_number' : 'episode_number';
  return db
    .prepare(`SELECT id, ${column} AS number FROM media_items WHERE parent_id = ? AND type = ?`)
    .bind(parentId, type)
    .all<{ id: string; number: number | null }>()
    .then((r) => r.results);
}

/** Moves one source and what hangs off it to another canonical item (merge). */
export function moveSourcesStmts(
  db: D1Database,
  fromItemId: string,
  intoItemId: string,
  options: { manual: boolean },
): D1PreparedStatement[] {
  return [
    db
      .prepare(
        options.manual
          ? "UPDATE sources SET media_item_id = ?1, match_method = 'manual' WHERE media_item_id = ?2"
          : 'UPDATE sources SET media_item_id = ?1 WHERE media_item_id = ?2',
      )
      .bind(intoItemId, fromItemId),
    db
      .prepare('UPDATE credits SET media_item_id = ?1 WHERE media_item_id = ?2')
      .bind(intoItemId, fromItemId),
    db
      .prepare('UPDATE collection_members SET media_item_id = ?1 WHERE media_item_id = ?2')
      .bind(intoItemId, fromItemId),
    db
      .prepare(
        `INSERT OR IGNORE INTO item_availability (media_item_id, library_id)
         SELECT ?1, library_id FROM item_availability WHERE media_item_id = ?2`,
      )
      .bind(intoItemId, fromItemId),
    // Progress follows the title (DR-003); where the survivor already has some, it wins.
    db
      .prepare('UPDATE OR IGNORE watch_progress SET media_item_id = ?1 WHERE media_item_id = ?2')
      .bind(intoItemId, fromItemId),
    db
      .prepare('UPDATE playback_sessions SET media_item_id = ?1 WHERE media_item_id = ?2')
      .bind(intoItemId, fromItemId),
  ];
}

export function reparentItemStmt(
  db: D1Database,
  itemId: string,
  parentId: string,
): D1PreparedStatement {
  return db.prepare('UPDATE media_items SET parent_id = ? WHERE id = ?').bind(parentId, itemId);
}

/**
 * Closes the open conflicts a merge settles: those on a source of `from`, and those on a source of
 * `into` that list `from` as a candidate (FR-CAT-010). Run before the sources move.
 */
export function resolveItemConflictsStmt(
  db: D1Database,
  intoId: string,
  fromId: string,
  actor: string,
  now: number,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE match_conflicts SET status = 'resolved', resolved_at = ?1, resolved_by = ?2
        WHERE status = 'open' AND entity_kind = 'item'
          AND (source_id IN (SELECT id FROM sources WHERE media_item_id = ?3)
               OR (source_id IN (SELECT id FROM sources WHERE media_item_id = ?4)
                   AND EXISTS (SELECT 1 FROM json_each(match_conflicts.details, '$.candidates') j
                                WHERE json_extract(j.value, '$.itemId') = ?3)))`,
    )
    .bind(now, actor, fromId, intoId);
}

/** Closes the open conflict on one subject (a source or a link). */
export function resolveSubjectConflictStmt(
  db: D1Database,
  kind: EntityKind,
  subjectId: string,
  actor: string,
  now: number,
): D1PreparedStatement {
  const column =
    kind === 'item' ? 'source_id' : kind === 'person' ? 'person_link_id' : 'collection_link_id';
  return db
    .prepare(
      `UPDATE match_conflicts SET status = 'resolved', resolved_at = ?1, resolved_by = ?2
        WHERE status = 'open' AND ${column} = ?3`,
    )
    .bind(now, actor, subjectId);
}

// --- people and collections ---

export interface CurationLinkRow {
  id: string;
  entity_id: string;
  server_id: string;
  server_name: string;
  server_type: string;
  priority: number;
  provider_id: string;
  name: string;
  overview: string | null;
  match_method: string;
}

export function listPersonLinksOf(db: D1Database, personId: string): Promise<CurationLinkRow[]> {
  return db
    .prepare(
      `SELECT l.id, l.person_id AS entity_id, l.server_id, sv.name AS server_name, sv.type AS server_type,
              sv.priority, l.provider_person_id AS provider_id, l.name, NULL AS overview, l.match_method
         FROM person_provider_links l JOIN servers sv ON sv.id = l.server_id
        WHERE l.person_id = ? ORDER BY sv.priority DESC, l.id`,
    )
    .bind(personId)
    .all<CurationLinkRow>()
    .then((r) => r.results);
}

export function getPersonLinkRow(db: D1Database, linkId: string): Promise<CurationLinkRow | null> {
  return db
    .prepare(
      `SELECT l.id, l.person_id AS entity_id, l.server_id, sv.name AS server_name, sv.type AS server_type,
              sv.priority, l.provider_person_id AS provider_id, l.name, NULL AS overview, l.match_method
         FROM person_provider_links l JOIN servers sv ON sv.id = l.server_id WHERE l.id = ?`,
    )
    .bind(linkId)
    .first<CurationLinkRow>();
}

export function listCollectionLinksOf(
  db: D1Database,
  collectionId: string,
): Promise<CurationLinkRow[]> {
  return db
    .prepare(
      `SELECT l.id, l.collection_id AS entity_id, l.server_id, sv.name AS server_name, sv.type AS server_type,
              sv.priority, l.provider_collection_id AS provider_id, l.name, l.overview, l.match_method
         FROM collection_provider_links l JOIN servers sv ON sv.id = l.server_id
        WHERE l.collection_id = ? ORDER BY sv.priority DESC, l.id`,
    )
    .bind(collectionId)
    .all<CurationLinkRow>()
    .then((r) => r.results);
}

export function getCollectionLinkRow(
  db: D1Database,
  linkId: string,
): Promise<CurationLinkRow | null> {
  return db
    .prepare(
      `SELECT l.id, l.collection_id AS entity_id, l.server_id, sv.name AS server_name, sv.type AS server_type,
              sv.priority, l.provider_collection_id AS provider_id, l.name, l.overview, l.match_method
         FROM collection_provider_links l JOIN servers sv ON sv.id = l.server_id WHERE l.id = ?`,
    )
    .bind(linkId)
    .first<CurationLinkRow>();
}

export interface EntityHead {
  name: string;
  metadata_link_id: string | null;
}

export function getPersonHead(db: D1Database, id: string): Promise<EntityHead | null> {
  return db
    .prepare('SELECT name, metadata_link_id FROM people WHERE id = ?')
    .bind(id)
    .first<EntityHead>();
}

export function getCollectionHead(db: D1Database, id: string): Promise<EntityHead | null> {
  return db
    .prepare('SELECT name, metadata_link_id FROM collections WHERE id = ?')
    .bind(id)
    .first<EntityHead>();
}

export function moveLinksStmts(
  db: D1Database,
  kind: 'person' | 'collection',
  fromId: string,
  intoId: string,
): D1PreparedStatement[] {
  if (kind === 'person') {
    return [
      db
        .prepare(
          "UPDATE person_provider_links SET person_id = ?1, match_method = 'manual' WHERE person_id = ?2",
        )
        .bind(intoId, fromId),
      db.prepare('UPDATE credits SET person_id = ?1 WHERE person_id = ?2').bind(intoId, fromId),
    ];
  }
  return [
    db
      .prepare(
        "UPDATE collection_provider_links SET collection_id = ?1, match_method = 'manual' WHERE collection_id = ?2",
      )
      .bind(intoId, fromId),
  ];
}

/** Closes open conflicts settled by merging two people or collections (see `resolveItemConflictsStmt`). */
export function resolveLinkConflictsStmt(
  db: D1Database,
  kind: 'person' | 'collection',
  intoId: string,
  fromId: string,
  actor: string,
  now: number,
): D1PreparedStatement {
  const column = kind === 'person' ? 'person_link_id' : 'collection_link_id';
  const links = kind === 'person' ? 'person_provider_links' : 'collection_provider_links';
  const owner = kind === 'person' ? 'person_id' : 'collection_id';
  const key = kind === 'person' ? '$.personId' : '$.collectionId';
  return db
    .prepare(
      `UPDATE match_conflicts SET status = 'resolved', resolved_at = ?1, resolved_by = ?2
        WHERE status = 'open' AND entity_kind = '${kind}'
          AND (${column} IN (SELECT id FROM ${links} WHERE ${owner} = ?3)
               OR (${column} IN (SELECT id FROM ${links} WHERE ${owner} = ?4)
                   AND EXISTS (SELECT 1 FROM json_each(match_conflicts.details, '$.candidates') j
                                WHERE json_extract(j.value, '${key}') = ?3)))`,
    )
    .bind(now, actor, fromId, intoId);
}

// --- conflicts ---

export interface ConflictRow {
  id: string;
  entity_kind: EntityKind;
  source_id: string | null;
  person_link_id: string | null;
  collection_link_id: string | null;
  reason: 'conflicting_ids' | 'multiple_candidates' | 'type_mismatch' | 'ambiguous_name';
  details: string;
  status: 'open' | 'resolved' | 'dismissed';
  detected_at: number;
}

const CONFLICT_COLUMNS =
  'id, entity_kind, source_id, person_link_id, collection_link_id, reason, details, status, detected_at';

export function getConflict(db: D1Database, id: string): Promise<ConflictRow | null> {
  return db
    .prepare(`SELECT ${CONFLICT_COLUMNS} FROM match_conflicts WHERE id = ?`)
    .bind(id)
    .first<ConflictRow>();
}

/** Newest first; keyset `(detected_at, id)` descending. */
export async function listConflictsPage(
  db: D1Database,
  f: { status: string; entityKind?: EntityKind | undefined; after?: [number, string] | undefined },
  limit: number,
): Promise<ConflictRow[]> {
  const binds: unknown[] = [f.status];
  const where = ['status = ?1'];
  if (f.entityKind) {
    binds.push(f.entityKind);
    where.push(`entity_kind = ?${String(binds.length)}`);
  }
  if (f.after) {
    binds.push(f.after[0], f.after[1]);
    where.push(`(detected_at, id) < (?${String(binds.length - 1)}, ?${String(binds.length)})`);
  }
  binds.push(limit);
  return (
    await db
      .prepare(
        `SELECT ${CONFLICT_COLUMNS} FROM match_conflicts WHERE ${where.join(' AND ')}
          ORDER BY detected_at DESC, id DESC LIMIT ?${String(binds.length)}`,
      )
      .bind(...binds)
      .all<ConflictRow>()
  ).results;
}

/** Closes (or dismisses) a conflict only while it is still open; pair with `guardChangedStmt`. */
export function closeConflictStmt(
  db: D1Database,
  id: string,
  status: 'resolved' | 'dismissed',
  actor: string,
  now: number,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE match_conflicts SET status = ?1, resolved_at = ?2, resolved_by = ?3
        WHERE id = ?4 AND status = 'open'`,
    )
    .bind(status, now, actor, id);
}

export interface SubjectRow {
  id: string;
  title: string;
  year: number | null;
  server_name: string;
  server_type: string;
  external_ids: string;
  current_id: string;
}

export async function loadItemSubjects(db: D1Database, ids: string[]): Promise<SubjectRow[]> {
  const out: SubjectRow[] = [];
  for (const part of chunks(ids)) {
    out.push(
      ...(
        await db
          .prepare(
            `SELECT s.id, s.title, s.year, sv.name AS server_name, sv.type AS server_type,
                    s.external_ids, s.media_item_id AS current_id
               FROM sources s JOIN servers sv ON sv.id = s.server_id WHERE s.id IN (${marks(part.length)})`,
          )
          .bind(...part)
          .all<SubjectRow>()
      ).results,
    );
  }
  return out;
}

export async function loadPersonSubjects(db: D1Database, ids: string[]): Promise<SubjectRow[]> {
  const out: SubjectRow[] = [];
  for (const part of chunks(ids)) {
    out.push(
      ...(
        await db
          .prepare(
            `SELECT l.id, l.name AS title, NULL AS year, sv.name AS server_name, sv.type AS server_type,
                    json_object('tmdb', l.tmdb_id, 'imdb', l.imdb_id) AS external_ids, l.person_id AS current_id
               FROM person_provider_links l JOIN servers sv ON sv.id = l.server_id
              WHERE l.id IN (${marks(part.length)})`,
          )
          .bind(...part)
          .all<SubjectRow>()
      ).results,
    );
  }
  return out;
}

export async function loadCollectionSubjects(db: D1Database, ids: string[]): Promise<SubjectRow[]> {
  const out: SubjectRow[] = [];
  for (const part of chunks(ids)) {
    out.push(
      ...(
        await db
          .prepare(
            `SELECT l.id, l.name AS title, NULL AS year, sv.name AS server_name, sv.type AS server_type,
                    json_object('tmdb', l.tmdb_collection_id) AS external_ids, l.collection_id AS current_id
               FROM collection_provider_links l JOIN servers sv ON sv.id = l.server_id
              WHERE l.id IN (${marks(part.length)})`,
          )
          .bind(...part)
          .all<SubjectRow>()
      ).results,
    );
  }
  return out;
}

export interface CandidateRow {
  id: string;
  title: string;
  year: number | null;
  /** `scheme:value` pairs, comma separated. */
  ids: string | null;
}

export async function loadItemCandidates(db: D1Database, ids: string[]): Promise<CandidateRow[]> {
  const out: CandidateRow[] = [];
  for (const part of chunks(ids)) {
    out.push(
      ...(
        await db
          .prepare(
            `SELECT i.id, i.title, i.year,
                    (SELECT group_concat(e.scheme || ':' || e.value) FROM external_ids e
                      WHERE e.media_item_id = i.id) AS ids
               FROM media_items i WHERE i.id IN (${marks(part.length)})`,
          )
          .bind(...part)
          .all<CandidateRow>()
      ).results,
    );
  }
  return out;
}

export async function loadPersonCandidates(db: D1Database, ids: string[]): Promise<CandidateRow[]> {
  const out: CandidateRow[] = [];
  for (const part of chunks(ids)) {
    out.push(
      ...(
        await db
          .prepare(
            `SELECT p.id, p.name AS title, NULL AS year,
                    (SELECT group_concat(x) FROM (
                       SELECT 'tmdb:' || l.tmdb_id AS x FROM person_provider_links l
                        WHERE l.person_id = p.id AND l.tmdb_id IS NOT NULL
                       UNION
                       SELECT 'imdb:' || l.imdb_id FROM person_provider_links l
                        WHERE l.person_id = p.id AND l.imdb_id IS NOT NULL)) AS ids
               FROM people p WHERE p.id IN (${marks(part.length)})`,
          )
          .bind(...part)
          .all<CandidateRow>()
      ).results,
    );
  }
  return out;
}

export async function loadCollectionCandidates(
  db: D1Database,
  ids: string[],
): Promise<CandidateRow[]> {
  const out: CandidateRow[] = [];
  for (const part of chunks(ids)) {
    out.push(
      ...(
        await db
          .prepare(
            `SELECT c.id, c.name AS title, NULL AS year,
                    (SELECT group_concat(x) FROM (
                       SELECT DISTINCT 'tmdb:' || l.tmdb_collection_id AS x FROM collection_provider_links l
                        WHERE l.collection_id = c.id AND l.tmdb_collection_id IS NOT NULL)) AS ids
               FROM collections c WHERE c.id IN (${marks(part.length)})`,
          )
          .bind(...part)
          .all<CandidateRow>()
      ).results,
    );
  }
  return out;
}
