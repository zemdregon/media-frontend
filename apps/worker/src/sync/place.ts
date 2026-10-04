/**
 * Places a source on a canonical item (LLD-MATCH `match`, `attach`, `findOrCreateChild`): reads
 * the candidates the pure decision functions need, applies the decision and returns the writes.
 * Used by the page upsert and by re-matching (series moved, orphans whose parent arrived).
 */
import {
  adoptItemStmt,
  availabilityStmt,
  clearFlagStmt,
  detachStmts,
  findChildItem,
  flagStmt,
  getSourcesByProviderIds,
  insertItemStmt,
  loadItemCandidates,
  loadItemParents,
  recomputeItemStmts,
} from '../db/catalog-write';
import {
  decideByExternalIds,
  decideEpisode,
  decideOverride,
  strongIds,
  type ConflictFlag,
  type IdSet,
  type Override,
} from '../match/items';
import type { ItemType } from '../providers/types';
import type { SyncDeps } from './deps';

/** What the matcher needs to know about a source, from a normalized item or a stored row. */
export interface MatchInput {
  sourceId: string;
  providerItemId: string;
  providerParentId: string | null;
  type: ItemType;
  ids: IdSet;
  title: string;
  sortTitle: string;
  year: number | null;
  seasonNumber: number | null;
  episodeNumber: number | null;
  dateAdded: number;
}

export interface PlaceContext {
  deps: SyncDeps;
  server: { id: string; priority: number };
  library: { id: string };
  /** Provider item ID to canonical item ID for sources placed during this invocation. */
  itemOfSource: Map<string, string>;
}

export type MatchMethod = 'external_id' | 'episode_position' | 'new' | 'manual';

export interface Placement {
  itemId: string;
  create: boolean;
  /** Parent for a created item, or the parent an orphan adopts. */
  parentId: string | null;
  adopt: boolean;
  method: MatchMethod;
  flag: ConflictFlag | null;
}

async function itemOfProviderSource(
  pc: PlaceContext,
  providerId: string | null,
): Promise<string | null> {
  if (providerId === null) return null;
  const cached = pc.itemOfSource.get(providerId);
  if (cached) return cached;
  const rows = await getSourcesByProviderIds(pc.deps.db, pc.server.id, [providerId]);
  const row = rows.get(providerId);
  if (!row) return null;
  pc.itemOfSource.set(providerId, row.media_item_id);
  return row.media_item_id;
}

/**
 * The matching decision for one source. `current` is the item the source already belongs to
 * (null for a new source); `currentIsOrphan` marks a season or episode item with no parent yet.
 */
export async function planPlacement(
  pc: PlaceContext,
  input: MatchInput,
  current: { itemId: string; method: MatchMethod; orphan: boolean } | null,
  override: Override,
): Promise<Placement> {
  const { deps } = pc;
  const keep = (
    method: MatchMethod,
    parentId: string | null,
    flag: ConflictFlag | null,
  ): Placement =>
    current
      ? {
          itemId: current.itemId,
          create: false,
          parentId,
          adopt: false,
          method: current.method,
          flag,
        }
      : { itemId: deps.newId(), create: true, parentId, adopt: false, method, flag };
  const attach = (itemId: string, method: MatchMethod): Placement => ({
    itemId,
    create: false,
    parentId: null,
    adopt: false,
    method,
    flag: null,
  });

  const ov = decideOverride(override);
  if (ov?.kind === 'attach') return attach(ov.itemId, 'manual');
  if (ov?.kind === 'keep') {
    const p = keep('manual', null, null);
    return current ? { ...p, method: 'manual' } : p;
  }

  if (input.type === 'season' || input.type === 'episode') {
    const parentItemId = await itemOfProviderSource(pc, input.providerParentId);
    const aligned = async (parentId: string, number: number): Promise<Placement | null> => {
      const childType = input.type === 'season' ? 'season' : 'episode';
      const found = await findChildItem(deps.db, parentId, childType, number);
      if (found) return attach(found, 'episode_position');
      if (current?.orphan) {
        return {
          itemId: current.itemId,
          create: false,
          parentId,
          adopt: true,
          method: 'episode_position',
          flag: null,
        };
      }
      return current
        ? null
        : {
            itemId: deps.newId(),
            create: true,
            parentId,
            adopt: false,
            method: 'episode_position',
            flag: null,
          };
    };
    const number = input.type === 'season' ? input.seasonNumber : input.episodeNumber;

    if (input.type === 'episode') {
      const pairs = strongIds('episode', input.ids);
      const candidates = await loadItemCandidates(deps.db, pairs);
      const candidateParents = await loadItemParents(
        deps.db,
        candidates.map((c) => c.itemId),
      );
      const d = decideEpisode({
        ids: input.ids,
        candidates,
        candidateParents,
        parentItemId,
        episodeNumber: number ?? undefined,
      });
      if (d.kind === 'attach') return attach(d.itemId, 'external_id');
      if (d.kind === 'flag') return keep('new', parentItemId, d.flag);
      if (d.kind === 'align') {
        const placed = await aligned(d.parentItemId, d.number);
        if (placed) return placed;
        return keep('episode_position', parentItemId, null);
      }
      return keep('new', parentItemId, null);
    }
    if (parentItemId !== null && number !== null) {
      const placed = await aligned(parentItemId, number);
      if (placed) return placed;
    }
    return keep(parentItemId === null ? 'new' : 'episode_position', parentItemId, null);
  }

  // Movies and series: strong external IDs only (BR-2); no fuzzy title matching.
  const candidates = await loadItemCandidates(deps.db, strongIds(input.type, input.ids));
  const d = decideByExternalIds(input.type, input.ids, candidates);
  if (d.kind === 'attach') return attach(d.itemId, 'external_id');
  if (d.kind === 'flag') return keep('new', null, d.flag);
  return keep('new', null, null);
}

/** Statements that create or adopt the target item of a placement. */
export function placementStmts(
  pc: PlaceContext,
  placement: Placement,
  input: MatchInput,
): D1PreparedStatement[] {
  const { db } = pc.deps;
  const now = pc.deps.now();
  if (placement.create) {
    return [
      insertItemStmt(db, {
        id: placement.itemId,
        type: input.type,
        parentId: placement.parentId,
        title: input.title,
        sortTitle: input.sortTitle,
        year: input.year,
        seasonNumber: input.seasonNumber,
        episodeNumber: input.episodeNumber,
        dateAdded: input.dateAdded,
        now,
      }),
    ];
  }
  if (placement.adopt && placement.parentId) {
    return [
      adoptItemStmt(
        db,
        placement.itemId,
        placement.parentId,
        input.seasonNumber,
        input.episodeNumber,
      ),
    ];
  }
  return [];
}

/**
 * Statements that finish a placement once the source row points at `placement.itemId`:
 * availability, denormalized credit and membership keys, derived fields, the detached item, and
 * the conflict flag (opened, or closed when the source now matches cleanly).
 */
export function settleStmts(
  pc: PlaceContext,
  placement: Placement,
  input: MatchInput,
  previousItemId: string | null,
  options: { rematched: boolean },
): D1PreparedStatement[] {
  const { db, now: clock, newId } = pc.deps;
  const now = clock();
  const stmts: D1PreparedStatement[] = [availabilityStmt(db, placement.itemId, pc.library.id)];
  const moved = previousItemId !== null && previousItemId !== placement.itemId;
  if (moved) {
    stmts.push(
      db
        .prepare('UPDATE credits SET media_item_id = ? WHERE source_id = ?')
        .bind(placement.itemId, input.sourceId),
      db
        .prepare('UPDATE collection_members SET media_item_id = ? WHERE source_id = ?')
        .bind(placement.itemId, input.sourceId),
    );
  }
  stmts.push(...recomputeItemStmts(db, placement.itemId, now));
  if (moved) stmts.push(...detachStmts(db, previousItemId, pc.library.id, now));
  if (placement.flag) {
    stmts.push(
      flagStmt(
        db,
        newId(),
        {
          kind: 'item',
          sourceId: input.sourceId,
          mediaItemId: placement.flag.candidates[0]?.id ?? null,
        },
        placement.flag,
        now,
      ),
    );
  } else if (options.rematched) {
    stmts.push(clearFlagStmt(db, 'item', input.sourceId, now));
  }
  return stmts;
}
