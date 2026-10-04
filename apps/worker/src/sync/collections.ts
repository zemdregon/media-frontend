/**
 * Collections sync and matching (FR-SYNC-008, FR-CAT-012, BR-10, ADR-0015, LLD-SYNC `upsertPage`
 * and LLD-MATCH `matchCollection`).
 *
 * Each origin collection is a link `(server_id, provider_collection_id)`. A link merges into a
 * canonical collection only on a shared TMDB collection ID; same-name collections without one
 * stay separate. Membership is stored per link as the sources the origin lists (members the
 * origin lists that Cinewren has not synced are ignored), and a canonical collection's members
 * are the union over its links, filtered by BR-1 at read time.
 */
import {
  clearFlagStmt,
  collectionCandidatesByTmdb,
  collectionSearchStmts,
  deleteCollectionIfLinklessStmts,
  flagStmt,
  getCollectionLink,
  getSourcesByProviderIds,
  insertCollectionStmt,
  listCollectionLinks,
  listLinkMemberSourceIds,
  loadOverrides,
  markLinkSeenStmt,
  replaceMembersStmts,
  updateCollectionStmt,
  upsertCollectionLinkStmt,
  type CollectionLinkInfo,
} from '../db/catalog-write';
import { sortKey } from '../match/names';
import { decideCollection } from '../match/people';
import type { NormalizedCollection } from '../providers/types';
import { runBatch } from './batch';
import type { SyncDeps } from './deps';

export interface CollectionsOutcome {
  seen: number;
  changed: number;
}

interface Shown {
  id: string;
  name: string;
  overview: string | null;
}

/** The link a collection shows: highest server priority, then the lowest link ID. */
function pickShown(links: CollectionLinkInfo[]): CollectionLinkInfo | null {
  return links[0] ?? null; // `listCollectionLinks` orders by priority DESC, id
}

function altNames(links: { name: string }[], shownName: string): string {
  return [...new Set(links.filter((l) => l.name !== shownName).map((l) => l.name))].join(' ');
}

function artworkJson(c: NormalizedCollection): string {
  const out: Record<string, { tag: string }> = {};
  for (const [kind, ref] of Object.entries(c.artwork)) out[kind] = { tag: ref.tag };
  return JSON.stringify(out);
}

/** Upserts one page of origin collections for a server. */
export async function processCollections(
  deps: SyncDeps,
  server: { id: string; priority: number },
  runId: string,
  collections: NormalizedCollection[],
): Promise<CollectionsOutcome> {
  const { db } = deps;
  const outcome: CollectionsOutcome = { seen: collections.length, changed: 0 };
  const overrides = await loadOverrides(
    db,
    'collection',
    server.id,
    collections.map((c) => c.providerCollectionId),
  );
  for (const c of collections) {
    const now = deps.now();
    const link = await getCollectionLink(db, server.id, c.providerCollectionId);
    const members = [
      ...(await getSourcesByProviderIds(db, server.id, c.memberProviderItemIds)).values(),
    ]
      .filter((s) => s.item_type === 'movie' || s.item_type === 'series')
      .sort((a, b) => (a.id < b.id ? -1 : 1));
    const overview = c.overview ?? null;
    const tmdb = c.externalIds.tmdb ?? null;
    const artwork = artworkJson(c);

    const sameLink =
      link !== null &&
      link.name === c.name &&
      link.overview === overview &&
      link.tmdb_collection_id === tmdb &&
      link.artwork === artwork;
    if (link && sameLink) {
      const current = await listLinkMemberSourceIds(db, link.id);
      if (current.join('|') === members.map((m) => m.id).join('|')) {
        await db.batch([markLinkSeenStmt(db, link.id, runId)]);
        continue;
      }
    }

    outcome.changed++;
    const linkId = link?.id ?? deps.newId();
    const stmts: D1PreparedStatement[] = [];
    let collectionId: string;
    let method: 'external_id' | 'new' | 'manual';
    let flag = null;
    let create = false;
    if (
      link &&
      link.tmdb_collection_id === tmdb &&
      overrides.get(c.providerCollectionId) === undefined
    ) {
      // IDs unchanged: the link keeps its canonical collection (no flip-flop).
      collectionId = link.collection_id;
      method = link.match_method as typeof method;
    } else {
      const candidates = tmdb ? await collectionCandidatesByTmdb(db, tmdb) : [];
      const d = decideCollection({
        tmdbCollectionId: tmdb,
        override: overrides.get(c.providerCollectionId) ?? null,
        candidates,
      });
      if (d.kind === 'attach') {
        collectionId = d.targetId;
        method = d.method === 'manual' ? 'manual' : 'external_id';
      } else {
        if (d.kind === 'flag') flag = d.flag;
        if (link) {
          collectionId = link.collection_id;
          method = link.match_method as typeof method;
        } else {
          collectionId = deps.newId();
          create = true;
          method = d.kind === 'keep' && d.method === 'manual' ? 'manual' : 'new';
        }
      }
    }

    if (create) {
      stmts.push(
        insertCollectionStmt(db, {
          id: collectionId,
          name: c.name,
          sortName: sortKey(c.name),
          overview,
          linkId,
          now,
        }),
      );
    }
    stmts.push(
      upsertCollectionLinkStmt(db, {
        id: linkId,
        collectionId,
        serverId: server.id,
        providerCollectionId: c.providerCollectionId,
        name: c.name,
        overview,
        tmdbCollectionId: tmdb,
        artwork,
        matchMethod: method,
        syncId: runId,
        now,
      }),
      ...replaceMembersStmts(
        db,
        linkId,
        members.map((m) => ({ sourceId: m.id, mediaItemId: m.media_item_id })),
      ),
    );

    // What the collection shows after this link joins (or stays): recompute from its links.
    const existingLinks = create ? [] : await listCollectionLinks(db, collectionId);
    const all: CollectionLinkInfo[] = [
      ...existingLinks.filter((l) => l.id !== linkId),
      { id: linkId, name: c.name, overview, priority: server.priority },
    ].sort((a, b) => b.priority - a.priority || (a.id < b.id ? -1 : 1));
    const shown = pickShown(all);
    if (shown) {
      const display: Shown = shown;
      stmts.push(
        updateCollectionStmt(db, {
          id: collectionId,
          name: display.name,
          sortName: sortKey(display.name),
          overview: display.overview,
          linkId: display.id,
          now,
        }),
        ...collectionSearchStmts(db, collectionId, altNames(all, display.name)),
      );
    }
    // The link left another collection: tidy it (DR-005).
    if (link && link.collection_id !== collectionId) {
      stmts.push(...(await tidyCollection(deps, link.collection_id, linkId)));
    }
    stmts.push(
      flag
        ? flagStmt(db, deps.newId(), { kind: 'collection', linkId }, flag, now)
        : clearFlagStmt(db, 'collection', linkId, now),
    );
    await runBatch(db, stmts);
  }
  return outcome;
}

/** Recomputes (or deletes) a collection that lost a link; `excluding` is the departing link. */
async function tidyCollection(
  deps: SyncDeps,
  collectionId: string,
  excluding: string | null,
): Promise<D1PreparedStatement[]> {
  const { db } = deps;
  const remaining = (await listCollectionLinks(db, collectionId)).filter((l) => l.id !== excluding);
  const shown = pickShown(remaining);
  if (!shown) return deleteCollectionIfLinklessStmts(db, collectionId);
  return [
    updateCollectionStmt(db, {
      id: collectionId,
      name: shown.name,
      sortName: sortKey(shown.name),
      overview: shown.overview,
      linkId: shown.id,
      now: deps.now(),
    }),
    ...collectionSearchStmts(db, collectionId, altNames(remaining, shown.name)),
  ];
}

/**
 * After a completed full pass: links of this server the pass did not see are removed with their
 * members (derived data, DR-001), and the collections they belonged to are recomputed or deleted.
 */
export async function removeUnseenCollections(
  deps: SyncDeps,
  serverId: string,
  runId: string,
): Promise<number> {
  const { db } = deps;
  const stale = await db
    .prepare(
      `SELECT id, collection_id FROM collection_provider_links
        WHERE server_id = ? AND (last_seen_sync_id IS NULL OR last_seen_sync_id <> ?)`,
    )
    .bind(serverId, runId)
    .all<{ id: string; collection_id: string }>();
  if (stale.results.length === 0) return 0;
  const staleIds = new Set(stale.results.map((r) => r.id));
  const affected = [...new Set(stale.results.map((r) => r.collection_id))];
  const stmts: D1PreparedStatement[] = [
    db
      .prepare(
        `DELETE FROM collection_provider_links
          WHERE server_id = ? AND (last_seen_sync_id IS NULL OR last_seen_sync_id <> ?)`,
      )
      .bind(serverId, runId),
  ];
  for (const collectionId of affected) {
    const remaining = (await listCollectionLinks(db, collectionId)).filter(
      (l) => !staleIds.has(l.id),
    );
    const shown = pickShown(remaining);
    if (!shown) {
      stmts.push(...deleteCollectionIfLinklessStmts(db, collectionId));
    } else {
      stmts.push(
        updateCollectionStmt(db, {
          id: collectionId,
          name: shown.name,
          sortName: sortKey(shown.name),
          overview: shown.overview,
          linkId: shown.id,
          now: deps.now(),
        }),
        ...collectionSearchStmts(db, collectionId, altNames(remaining, shown.name)),
      );
    }
  }
  await runBatch(db, stmts);
  return stale.results.length;
}
