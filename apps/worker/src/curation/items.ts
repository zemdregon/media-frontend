/**
 * Statement plans for merging and splitting canonical titles (LLD-MATCH "Curation operations",
 * "Series merge cascades to children"; FR-CAT-007, BR-2, BR-3). Each builder reads what it needs,
 * decides with the pure planners in `match/curation.ts` and returns the statements; the service
 * submits them with the audit row as one batch.
 *
 * What a merge writes: a `pin` override per source of the item that goes away (keyed by the
 * origin's ID, so every later sync honours it), the re-keying of sources, credits, collection
 * members, availability and progress, and the recompute of the survivor's derived fields and
 * search row. What a split writes: a new item from the source's metadata, a `separate` override
 * for that source, and the same re-keying in the other direction.
 */
import { AppError } from '../api/errors';
import {
  deleteIfSourcelessStmts,
  detachStmts,
  insertItemStmt,
  recomputeItemStmts,
} from '../db/catalog-write';
import {
  getCurationItem,
  listChildItems,
  listChildSourcesOf,
  listSourcesOfItem,
  moveSourcesStmts,
  reparentItemStmt,
  requireRowStmt,
  resolveItemConflictsStmt,
  resolveSubjectConflictStmt,
  upsertOverrideStmt,
  type CurationSourceRow,
} from '../db/curation';
import { checkMerge, planChildMerge } from '../match/curation';
import { sortKey } from '../match/names';

export interface Plan {
  stmts: D1PreparedStatement[];
  /** Counts for the audit details. */
  moved: number;
  newId?: string;
}

interface Ctx {
  db: D1Database;
  actor: string;
  now: number;
  newId: () => string;
}

const notFound = () => new AppError('NOT_FOUND', 'Not found.');

/** Folds `fromId` into `intoId` at one level: sources, derived data and the search row. */
function foldItem(c: Ctx, intoId: string, fromId: string, manual: boolean): D1PreparedStatement[] {
  return [
    ...moveSourcesStmts(c.db, fromId, intoId, { manual }),
    ...recomputeItemStmts(c.db, intoId, c.now),
    ...deleteIfSourcelessStmts(c.db, fromId),
  ];
}

/** Children first: episodes of paired seasons merge, the rest move; then the seasons themselves. */
async function cascadeChildren(c: Ctx, intoSeries: string, fromSeries: string) {
  const stmts: D1PreparedStatement[] = [];
  const seasons = planChildMerge(
    await listChildItems(c.db, intoSeries, 'season'),
    await listChildItems(c.db, fromSeries, 'season'),
  );
  for (const pair of seasons.merge) {
    const episodes = planChildMerge(
      await listChildItems(c.db, pair.intoId, 'episode'),
      await listChildItems(c.db, pair.fromId, 'episode'),
    );
    for (const e of episodes.merge) stmts.push(...foldItem(c, e.intoId, e.fromId, false));
    for (const id of episodes.move) stmts.push(reparentItemStmt(c.db, id, pair.intoId));
    stmts.push(...foldItem(c, pair.intoId, pair.fromId, false));
  }
  for (const id of seasons.move) stmts.push(reparentItemStmt(c.db, id, intoSeries));
  return stmts;
}

/** Merge `fromId` into `intoId` (same type, `TYPE_MISMATCH` otherwise). */
export async function planItemMerge(c: Ctx, intoId: string, fromId: string): Promise<Plan> {
  const [into, from] = await Promise.all([
    getCurationItem(c.db, intoId),
    getCurationItem(c.db, fromId),
  ]);
  if (!into || !from) throw notFound();
  const check = checkMerge(into.type, from.type);
  if (check === 'type_mismatch') {
    throw new AppError('TYPE_MISMATCH', 'Only titles of the same type can be merged.', {
      into: into.type,
      from: from.type,
    });
  }
  if (check === 'not_curatable') {
    throw new AppError('VALIDATION_FAILED', 'Seasons and episodes follow their series.', {
      fields: ['fromId'],
    });
  }
  const sources = await listSourcesOfItem(c.db, fromId);
  const stmts: D1PreparedStatement[] = [
    requireRowStmt(c.db, 'media_items', intoId),
    requireRowStmt(c.db, 'media_items', fromId),
    resolveItemConflictsStmt(c.db, intoId, fromId, c.actor, c.now),
    ...sources.map((s) =>
      upsertOverrideStmt(c.db, {
        id: c.newId(),
        kind: 'pin',
        entityKind: 'item',
        targetId: intoId,
        serverId: s.server_id,
        providerId: s.provider_item_id,
        createdBy: c.actor,
        now: c.now,
      }),
    ),
  ];
  if (from.type === 'series') stmts.push(...(await cascadeChildren(c, intoId, fromId)));
  stmts.push(...foldItem(c, intoId, fromId, true));
  return { stmts, moved: sources.length };
}

interface Move {
  source: CurationSourceRow;
  newItemId: string;
}

const sortOf = (s: CurationSourceRow): string => {
  try {
    const meta = JSON.parse(s.meta) as { sort?: unknown };
    if (typeof meta.sort === 'string' && meta.sort !== '') return meta.sort;
  } catch {
    // fall through to the title
  }
  return sortKey(s.title);
};

/**
 * Split source `sourceId` out of item `itemId` into an item of its own (`LAST_SOURCE` when it is
 * the item's only source). A series takes its seasons and episodes from the same server along.
 */
export async function planItemSplit(
  c: Ctx,
  itemId: string,
  sourceId: string,
  options: { resolveConflict: boolean } = { resolveConflict: true },
): Promise<Plan> {
  const item = await getCurationItem(c.db, itemId);
  if (!item) throw notFound();
  if (item.type !== 'movie' && item.type !== 'series') {
    throw new AppError('VALIDATION_FAILED', 'Seasons and episodes follow their series.', {
      fields: ['id'],
    });
  }
  const sources = await listSourcesOfItem(c.db, itemId);
  const source = sources.find((s) => s.id === sourceId);
  if (!source) throw notFound();
  if (sources.length < 2) {
    throw new AppError(
      'LAST_SOURCE',
      'This title has only one source, so there is nothing to split.',
    );
  }

  const newItemId = c.newId();
  const moves: Move[] = [{ source, newItemId }];
  const seasonOf = new Map<string, string>(); // origin season ID -> new season item
  if (item.type === 'series') {
    const seasons = await listChildSourcesOf(
      c.db,
      source.server_id,
      [source.provider_item_id],
      'season',
    );
    for (const s of seasons) {
      const id = c.newId();
      seasonOf.set(s.provider_item_id, id);
      moves.push({ source: s, newItemId: id });
    }
    const episodes = await listChildSourcesOf(
      c.db,
      source.server_id,
      [...seasonOf.keys()],
      'episode',
    );
    for (const e of episodes) moves.push({ source: e, newItemId: c.newId() });
  }

  const parentOf = (m: Move): string | null => {
    if (m.source.item_type === 'season') return newItemId;
    if (m.source.item_type === 'episode') {
      return (m.source.provider_parent_id && seasonOf.get(m.source.provider_parent_id)) || null;
    }
    return null;
  };

  const stmts: D1PreparedStatement[] = [
    requireRowStmt(c.db, 'media_items', itemId),
    requireRowStmt(c.db, 'sources', sourceId),
  ];
  // New items first (parents before children), then the sources move onto them.
  const order = { series: 0, movie: 0, season: 1, episode: 2 } as const;
  const sorted = [...moves].sort((a, b) => order[a.source.item_type] - order[b.source.item_type]);
  for (const m of sorted) {
    stmts.push(
      insertItemStmt(c.db, {
        id: m.newItemId,
        type: m.source.item_type,
        parentId: parentOf(m),
        title: m.source.title,
        sortTitle: sortOf(m.source),
        year: m.source.year,
        seasonNumber: m.source.season_number,
        episodeNumber: m.source.episode_number,
        dateAdded: m.source.date_added ?? c.now,
        now: c.now,
      }),
    );
  }
  for (const m of sorted) {
    stmts.push(
      c.db
        .prepare(
          m.source.id === sourceId
            ? "UPDATE sources SET media_item_id = ?1, match_method = 'manual' WHERE id = ?2"
            : 'UPDATE sources SET media_item_id = ?1 WHERE id = ?2',
        )
        .bind(m.newItemId, m.source.id),
      c.db
        .prepare('UPDATE credits SET media_item_id = ?1 WHERE source_id = ?2')
        .bind(m.newItemId, m.source.id),
      c.db
        .prepare('UPDATE collection_members SET media_item_id = ?1 WHERE source_id = ?2')
        .bind(m.newItemId, m.source.id),
      c.db
        .prepare(
          `INSERT OR IGNORE INTO item_availability (media_item_id, library_id)
           SELECT ?1, library_id FROM sources WHERE id = ?2 AND status = 'present'`,
        )
        .bind(m.newItemId, m.source.id),
      ...recomputeItemStmts(c.db, m.newItemId, c.now),
    );
  }
  stmts.push(
    upsertOverrideStmt(c.db, {
      id: c.newId(),
      kind: 'separate',
      entityKind: 'item',
      targetId: newItemId,
      serverId: source.server_id,
      providerId: source.provider_item_id,
      createdBy: c.actor,
      now: c.now,
    }),
  );
  if (options.resolveConflict) {
    stmts.push(resolveSubjectConflictStmt(c.db, 'item', sourceId, c.actor, c.now));
  }
  // The old items lose the moved sources: availability pruned, derived fields recomputed, and
  // sourceless ones deleted, episodes before seasons before the series.
  const olds = new Map<string, { itemId: string; libraryId: string; rank: number }>();
  for (const m of sorted) {
    const key = `${m.source.media_item_id}|${m.source.library_id}`;
    olds.set(key, {
      itemId: m.source.media_item_id,
      libraryId: m.source.library_id,
      rank: order[m.source.item_type],
    });
  }
  for (const o of [...olds.values()].sort((a, b) => b.rank - a.rank)) {
    stmts.push(...detachStmts(c.db, o.itemId, o.libraryId, c.now));
  }
  return { stmts, moved: moves.length, newId: newItemId };
}
