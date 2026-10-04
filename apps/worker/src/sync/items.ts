/**
 * Normalization and upsert of one page of provider items (FR-SYNC-003, FR-SYNC-004, FR-SYNC-008,
 * LLD-SYNC `upsertPage`).
 *
 * Idempotency. Sources are keyed by `(server_id, provider_item_id)`, versions by
 * `(source_id, provider_version_id)`, and a source whose `content_hash` is unchanged is skipped
 * apart from its `last_seen_sync_id`. Each changed item is written as one unit of batches whose
 * last statement commits `content_hash`, so a run killed part-way reprocesses that item and a
 * retried page never creates a second item or source.
 */
import {
  commitHashStmt,
  deleteIfSourcelessStmts,
  getItem,
  getSourcesByProviderIds,
  listChildSources,
  loadOverrides,
  touchSeenStmts,
  upsertSourceStmt,
  versionStmts,
  type SourceRow,
} from '../db/catalog-write';
import type { IdSet, Override } from '../match/items';
import { sortKey } from '../match/names';
import type { NormalizedItem, NormalizedVersion } from '../providers/types';
import { runBatch } from './batch';
import { contentHash } from './hash';
import { planCredits } from './people';
import {
  placementStmts,
  planPlacement,
  settleStmts,
  type MatchInput,
  type PlaceContext,
  type Placement,
} from './place';

export interface PageOutcome {
  added: number;
  updated: number;
  unchanged: number;
  /** Bookkeeping statements for sources seen but not rewritten; the caller commits them. */
  seenStmts: D1PreparedStatement[];
  /** Set when an item could not be written; the library must not be treated as completed. */
  failure: string | null;
}

const RANK: Record<NormalizedItem['type'], number> = { series: 0, season: 1, movie: 2, episode: 3 };

const idsJson = (ids: NormalizedItem['externalIds']): string =>
  JSON.stringify({
    ...(ids.imdb ? { imdb: ids.imdb } : {}),
    ...(ids.tmdb ? { tmdb: ids.tmdb } : {}),
    ...(ids.tvdb ? { tvdb: ids.tvdb } : {}),
  });

function parseIds(json: string): IdSet {
  try {
    const v = JSON.parse(json) as Partial<Record<'tmdb' | 'imdb' | 'tvdb', unknown>> | null;
    const out: IdSet = {};
    for (const k of ['tmdb', 'imdb', 'tvdb'] as const) {
      const x = v?.[k];
      if (typeof x === 'string' && x !== '') out[k] = x;
    }
    return out;
  } catch {
    return {};
  }
}

function sourceMeta(item: NormalizedItem): string {
  return JSON.stringify({
    sort: sortKey(item.title, item.sortTitle),
    ...(item.originalTitle ? { originalTitle: item.originalTitle } : {}),
    ...(item.overview ? { overview: item.overview } : {}),
    genres: item.genres,
    ...(item.runtimeMs === undefined ? {} : { runtimeMs: item.runtimeMs }),
  });
}

function artworkJson(item: NormalizedItem): string {
  const out: Record<string, { tag: string }> = {};
  for (const [kind, ref] of Object.entries(item.artwork)) out[kind] = { tag: ref.tag };
  return JSON.stringify(out);
}

function versionWrite(v: NormalizedVersion) {
  return {
    providerVersionId: v.providerVersionId,
    container: v.container,
    videoCodec: v.videoCodec,
    videoProfile: v.videoProfile,
    width: v.width,
    height: v.height,
    hdr: v.hdr,
    bitrate: v.bitrate,
    runtimeMs: v.runtimeMs,
    sizeBytes: v.sizeBytes,
    audioTracks: JSON.stringify(
      v.audio.map((a) => ({
        index: a.index,
        codec: a.codec ?? null,
        channels: a.channels ?? null,
        language: a.language ?? null,
        title: a.title ?? null,
        default: a.isDefault,
      })),
    ),
    subtitleTracks: JSON.stringify(
      v.subtitles.map((s) => ({
        index: s.index,
        format: s.codec ?? null,
        kind: s.kind,
        language: s.language ?? null,
        title: s.title ?? null,
        forced: s.isForced,
        default: s.isDefault,
        external: s.isExternal,
      })),
    ),
  };
}

export function matchInputOf(item: NormalizedItem, sourceId: string, now: number): MatchInput {
  return {
    sourceId,
    providerItemId: item.providerItemId,
    providerParentId: item.providerParentId ?? null,
    type: item.type,
    ids: item.externalIds,
    title: item.title,
    sortTitle: sortKey(item.title, item.sortTitle),
    year: item.year ?? null,
    seasonNumber: item.seasonNumber ?? null,
    episodeNumber: item.episodeNumber ?? null,
    dateAdded: item.dateAdded ?? now,
  };
}

function matchInputOfRow(row: SourceRow): MatchInput {
  let sort = row.title.toLowerCase();
  try {
    const meta = JSON.parse(row.meta) as { sort?: unknown };
    if (typeof meta.sort === 'string' && meta.sort !== '') sort = meta.sort;
  } catch {
    // keep the default
  }
  return {
    sourceId: row.id,
    providerItemId: row.provider_item_id,
    providerParentId: row.provider_parent_id,
    type: row.item_type,
    ids: parseIds(row.external_ids),
    title: row.title,
    sortTitle: sort,
    year: row.year,
    seasonNumber: row.season_number,
    episodeNumber: row.episode_number,
    dateAdded: 0,
  };
}

export interface PageContext extends PlaceContext {
  runId: string;
}

/** Applies one page of items for one library. Never throws for a single bad item. */
export async function processPage(pc: PageContext, items: NormalizedItem[]): Promise<PageOutcome> {
  const { deps } = pc;
  const outcome: PageOutcome = { added: 0, updated: 0, unchanged: 0, seenStmts: [], failure: null };
  const byId = new Map<string, NormalizedItem>();
  for (const item of items) byId.set(item.providerItemId, item);
  const page = [...byId.values()];
  if (page.length === 0) return outcome;

  const existing = await getSourcesByProviderIds(
    deps.db,
    pc.server.id,
    page.map((i) => i.providerItemId),
  );
  const unchangedIds: string[] = [];
  const todo: { item: NormalizedItem; hash: string; row: SourceRow | undefined }[] = [];
  for (const item of page) {
    const hash = await contentHash(item, pc.library.id);
    const row = existing.get(item.providerItemId);
    if (row && row.status === 'present' && row.content_hash === hash) {
      unchangedIds.push(item.providerItemId);
      pc.itemOfSource.set(item.providerItemId, row.media_item_id);
    } else {
      todo.push({ item, hash, row });
    }
  }
  outcome.unchanged = unchangedIds.length;
  outcome.seenStmts.push(...touchSeenStmts(deps.db, pc.server.id, unchangedIds, pc.runId));

  // Parents before children within a page; a child whose parent arrives later is adopted by
  // `reparentOrphans` at the end of the library pass (LLD-SYNC).
  todo.sort((a, b) => RANK[a.item.type] - RANK[b.item.type]);
  const overrides = await loadOverrides(
    deps.db,
    'item',
    pc.server.id,
    todo.map((t) => t.item.providerItemId),
  );
  for (const { item, hash, row } of todo) {
    try {
      await processOne(pc, item, hash, row, overrides.get(item.providerItemId) ?? null);
      if (row) outcome.updated++;
      else outcome.added++;
    } catch (err) {
      outcome.failure ??= `Item write failed: ${err instanceof Error ? err.message.slice(0, 200) : 'unknown error'}`;
      deps.logger.error('sync.item_failed', {
        server_id: pc.server.id,
        run_id: pc.runId,
        provider_item_id: item.providerItemId,
        error: err instanceof Error ? err.message : String(err),
      });
      // Keep the source from being marked missing by this run.
      if (row)
        outcome.seenStmts.push(
          ...touchSeenStmts(deps.db, pc.server.id, [item.providerItemId], pc.runId),
        );
    }
  }
  return outcome;
}

async function processOne(
  pc: PageContext,
  item: NormalizedItem,
  hash: string,
  row: SourceRow | undefined,
  override: Override,
): Promise<void> {
  const { deps } = pc;
  const now = deps.now();
  const sourceId = row?.id ?? deps.newId();
  const input = matchInputOf(item, sourceId, now);
  const newIds = idsJson(item.externalIds);
  const sameIdentity =
    row !== undefined && row.external_ids === newIds && row.item_type === item.type;

  let currentItemId: string | null = null;
  let currentOrphan = false;
  if (row && row.item_type === item.type) {
    currentItemId = row.media_item_id;
    if (item.type === 'season' || item.type === 'episode') {
      currentOrphan = (await getItem(deps.db, row.media_item_id))?.parent_id === null;
    }
  }
  const current =
    currentItemId === null
      ? null
      : {
          itemId: currentItemId,
          method: row?.match_method ?? 'new',
          orphan: currentOrphan,
        };

  // New sources and sources whose external IDs changed are matched; so is any source with an
  // override (BR-3 wins on every sync). Others keep their item, so merges do not flip-flop.
  const keepAsIs = current !== null && sameIdentity && override === null && !currentOrphan;
  const placement: Placement = keepAsIs
    ? {
        itemId: current.itemId,
        create: false,
        parentId: null,
        adopt: false,
        method: current.method,
        flag: null,
      }
    : await planPlacement(pc, input, current, override);

  const stmts: D1PreparedStatement[] = [
    ...placementStmts(pc, placement, input),
    upsertSourceStmt(deps.db, {
      id: sourceId,
      serverId: pc.server.id,
      libraryId: pc.library.id,
      providerItemId: item.providerItemId,
      providerParentId: item.providerParentId ?? null,
      mediaItemId: placement.itemId,
      type: item.type,
      title: item.title,
      year: item.year ?? null,
      seasonNumber: item.seasonNumber ?? null,
      episodeNumber: item.episodeNumber ?? null,
      externalIds: newIds,
      matchMethod: placement.method,
      artwork: artworkJson(item),
      meta: sourceMeta(item),
      syncId: pc.runId,
      dateAdded: item.dateAdded ?? null,
      now,
    }),
    ...versionStmts(deps.db, sourceId, item.versions.map(versionWrite), () => deps.newId()),
    ...settleStmts(pc, placement, input, row?.media_item_id ?? null, { rematched: !keepAsIs }),
  ];
  if (item.type === 'movie' || item.type === 'series') {
    stmts.push(
      ...(
        await planCredits(
          deps,
          pc.server,
          { id: sourceId, mediaItemId: placement.itemId },
          item.credits,
        )
      ).stmts,
    );
  }

  const moved = row !== undefined && row.media_item_id !== placement.itemId;
  const subtreeMoved = moved && (item.type === 'series' || item.type === 'season');
  if (!subtreeMoved) stmts.push(commitHashStmt(deps.db, sourceId, hash));
  await runBatch(deps.db, stmts);
  pc.itemOfSource.set(item.providerItemId, placement.itemId);

  if (subtreeMoved) {
    // The seasons and episodes of a moved series follow it (LLD-MATCH "Series merge cascades").
    await rematchSubtree(pc, item.providerItemId);
    await deps.db.batch([
      ...deleteIfSourcelessStmts(deps.db, row.media_item_id),
      commitHashStmt(deps.db, sourceId, hash),
    ]);
  }
}

/** Re-runs placement for a stored source (used by series moves and orphan adoption). */
async function rematchRow(pc: PlaceContext, row: SourceRow): Promise<boolean> {
  const { deps } = pc;
  const input = matchInputOfRow(row);
  const item = await getItem(deps.db, row.media_item_id);
  const overrides = await loadOverrides(deps.db, 'item', pc.server.id, [row.provider_item_id]);
  const libPc: PlaceContext = { ...pc, library: { id: row.library_id } };
  const placement = await planPlacement(
    libPc,
    input,
    {
      itemId: row.media_item_id,
      method: row.match_method,
      orphan:
        item?.parent_id === null && (row.item_type === 'season' || row.item_type === 'episode'),
    },
    overrides.get(row.provider_item_id) ?? null,
  );
  const moved = placement.itemId !== row.media_item_id;
  if (!moved && !placement.adopt && !placement.flag) return false;
  const stmts = [
    ...placementStmts(libPc, placement, input),
    deps.db
      .prepare('UPDATE sources SET media_item_id = ?, match_method = ? WHERE id = ?')
      .bind(placement.itemId, placement.method, row.id),
    ...settleStmts(libPc, placement, input, row.media_item_id, { rematched: true }),
  ];
  await runBatch(deps.db, stmts);
  pc.itemOfSource.set(row.provider_item_id, placement.itemId);
  if (moved && (row.item_type === 'season' || row.item_type === 'series')) {
    await rematchSubtree(pc, row.provider_item_id);
    await deps.db.batch(deleteIfSourcelessStmts(deps.db, row.media_item_id));
  }
  return true;
}

async function rematchSubtree(pc: PlaceContext, parentProviderId: string): Promise<void> {
  const children = await listChildSources(pc.deps.db, pc.server.id, parentProviderId);
  // Seasons first so their episodes find the season's new item.
  children.sort((a, b) => (a.item_type === b.item_type ? 0 : a.item_type === 'season' ? -1 : 1));
  for (const child of children) await rematchRow(pc, child);
}

/**
 * Seasons and episodes whose parent was not yet known when they were written get matched now
 * (LLD-SYNC "A child whose parent source is not yet known is deferred to the end of the library
 * pass"). Returns how many were placed.
 */
export async function reparentOrphans(pc: PlaceContext, orphans: SourceRow[]): Promise<number> {
  let placed = 0;
  const ordered = [...orphans].sort((a, b) =>
    a.item_type === b.item_type ? 0 : a.item_type === 'season' ? -1 : 1,
  );
  for (const row of ordered) {
    if (row.provider_parent_id === null) continue;
    const parent = (
      await getSourcesByProviderIds(pc.deps.db, pc.server.id, [row.provider_parent_id])
    ).get(row.provider_parent_id);
    if (!parent) continue;
    const fresh = (
      await getSourcesByProviderIds(pc.deps.db, pc.server.id, [row.provider_item_id])
    ).get(row.provider_item_id);
    if (fresh && (await rematchRow(pc, fresh))) placed++;
  }
  return placed;
}
