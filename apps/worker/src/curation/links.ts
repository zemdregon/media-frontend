/**
 * Statement plans for merging and splitting people and collections (LLD-MATCH "Curation
 * operations", ADR-0015, BR-10; FR-CAT-007). An entity here is a canonical person or collection;
 * a record is one provider link under it. Merge pins every link of `from` to `into`; split moves
 * one link out into a new entity with a `separate` override.
 */
import { AppError } from '../api/errors';
import {
  collectionSearchStmts,
  deleteCollectionIfLinklessStmts,
  deletePersonIfLinklessStmts,
  insertCollectionStmt,
  insertPersonStmt,
  personSearchStmts,
  rekeyCreditsStmt,
  updateCollectionStmt,
  updatePersonStmt,
} from '../db/catalog-write';
import {
  getCollectionHead,
  getCollectionLinkRow,
  getPersonHead,
  getPersonLinkRow,
  listCollectionLinksOf,
  listPersonLinksOf,
  moveLinksStmts,
  requireRowStmt,
  resolveLinkConflictsStmt,
  resolveSubjectConflictStmt,
  upsertOverrideStmt,
  type CurationLinkRow,
} from '../db/curation';
import { nameKey, sortKey } from '../match/names';
import { altNames, pickShown, type LinkChoice } from '../sync/people';
import type { Plan } from './items';

interface Ctx {
  db: D1Database;
  actor: string;
  now: number;
  newId: () => string;
}

const notFound = () => new AppError('NOT_FOUND', 'Not found.');
const choice = (l: CurationLinkRow): LinkChoice => ({
  linkId: l.id,
  name: l.name,
  priority: l.priority,
});

/** Statements that make a person show its best link (highest server priority) and refresh its search row. */
function personShownStmts(
  c: Ctx,
  personId: string,
  links: CurationLinkRow[],
  currentLinkId: string | null,
): D1PreparedStatement[] {
  const choices = links.map(choice);
  const best = pickShown(choices, currentLinkId);
  if (!best) return deletePersonIfLinklessStmts(c.db, personId);
  return [
    updatePersonStmt(c.db, {
      id: personId,
      name: best.name,
      sortName: sortKey(best.name),
      nameKey: nameKey(best.name),
      linkId: best.linkId,
      now: c.now,
    }),
    ...personSearchStmts(c.db, personId, altNames(choices, best)),
  ];
}

function collectionShownStmts(
  c: Ctx,
  collectionId: string,
  links: CurationLinkRow[],
): D1PreparedStatement[] {
  const shown = links[0]; // ordered by server priority, then ID
  if (!shown) return deleteCollectionIfLinklessStmts(c.db, collectionId);
  return [
    updateCollectionStmt(c.db, {
      id: collectionId,
      name: shown.name,
      sortName: sortKey(shown.name),
      overview: shown.overview,
      linkId: shown.id,
      now: c.now,
    }),
    ...collectionSearchStmts(c.db, collectionId, alternativeNames(links, shown.name)),
  ];
}

const alternativeNames = (links: { name: string }[], shown: string): string =>
  [...new Set(links.filter((l) => l.name !== shown).map((l) => l.name))].join(' ');

const byPriority = (links: CurationLinkRow[]) =>
  [...links].sort((a, b) => b.priority - a.priority || (a.id < b.id ? -1 : 1));

export async function planLinkMerge(
  c: Ctx,
  kind: 'person' | 'collection',
  intoId: string,
  fromId: string,
): Promise<Plan> {
  const table = kind === 'person' ? 'people' : 'collections';
  const [into, from] = await Promise.all(
    [intoId, fromId].map((id) =>
      kind === 'person' ? getPersonHead(c.db, id) : getCollectionHead(c.db, id),
    ),
  );
  if (!into || !from) throw notFound();
  const [intoLinks, fromLinks] = await Promise.all(
    [intoId, fromId].map((id) =>
      kind === 'person' ? listPersonLinksOf(c.db, id) : listCollectionLinksOf(c.db, id),
    ),
  );
  const all = byPriority([...(intoLinks ?? []), ...(fromLinks ?? [])]);
  const stmts: D1PreparedStatement[] = [
    requireRowStmt(c.db, table, intoId),
    requireRowStmt(c.db, table, fromId),
    resolveLinkConflictsStmt(c.db, kind, intoId, fromId, c.actor, c.now),
    ...(fromLinks ?? []).map((l) =>
      upsertOverrideStmt(c.db, {
        id: c.newId(),
        kind: 'pin',
        entityKind: kind,
        targetId: intoId,
        serverId: l.server_id,
        providerId: l.provider_id,
        createdBy: c.actor,
        now: c.now,
      }),
    ),
    ...moveLinksStmts(c.db, kind, fromId, intoId),
    ...(kind === 'person'
      ? personShownStmts(c, intoId, all, into.metadata_link_id)
      : collectionShownStmts(c, intoId, all)),
    ...(kind === 'person'
      ? deletePersonIfLinklessStmts(c.db, fromId)
      : deleteCollectionIfLinklessStmts(c.db, fromId)),
  ];
  return { stmts, moved: fromLinks?.length ?? 0 };
}

/** Moves one provider link out into a new entity (`LAST_SOURCE` when it is the only link). */
export async function planLinkSplit(
  c: Ctx,
  kind: 'person' | 'collection',
  entityId: string,
  linkId: string,
  options: { resolveConflict: boolean } = { resolveConflict: true },
): Promise<Plan> {
  const link =
    kind === 'person'
      ? await getPersonLinkRow(c.db, linkId)
      : await getCollectionLinkRow(c.db, linkId);
  if (!link || link.entity_id !== entityId) throw notFound();
  const head =
    kind === 'person'
      ? await getPersonHead(c.db, entityId)
      : await getCollectionHead(c.db, entityId);
  if (!head) throw notFound();
  const links =
    kind === 'person'
      ? await listPersonLinksOf(c.db, entityId)
      : await listCollectionLinksOf(c.db, entityId);
  if (links.length < 2) {
    throw new AppError(
      'LAST_SOURCE',
      'This entry has only one provider record, so there is nothing to split.',
    );
  }
  const remaining = byPriority(links.filter((l) => l.id !== linkId));
  const newId = c.newId();
  const stmts: D1PreparedStatement[] = [
    requireRowStmt(c.db, kind === 'person' ? 'people' : 'collections', entityId),
    ...(kind === 'person'
      ? [
          insertPersonStmt(c.db, {
            id: newId,
            name: link.name,
            sortName: sortKey(link.name),
            nameKey: nameKey(link.name),
            linkId,
            now: c.now,
          }),
          c.db
            .prepare(
              "UPDATE person_provider_links SET person_id = ?1, match_method = 'manual' WHERE id = ?2",
            )
            .bind(newId, linkId),
          rekeyCreditsStmt(c.db, linkId, newId),
          ...personSearchStmts(c.db, newId, ''),
        ]
      : [
          insertCollectionStmt(c.db, {
            id: newId,
            name: link.name,
            sortName: sortKey(link.name),
            overview: link.overview,
            linkId,
            now: c.now,
          }),
          c.db
            .prepare(
              "UPDATE collection_provider_links SET collection_id = ?1, match_method = 'manual' WHERE id = ?2",
            )
            .bind(newId, linkId),
          ...collectionSearchStmts(c.db, newId, ''),
        ]),
    upsertOverrideStmt(c.db, {
      id: c.newId(),
      kind: 'separate',
      entityKind: kind,
      targetId: newId,
      serverId: link.server_id,
      providerId: link.provider_id,
      createdBy: c.actor,
      now: c.now,
    }),
    ...(kind === 'person'
      ? personShownStmts(c, entityId, remaining, head.metadata_link_id)
      : collectionShownStmts(c, entityId, remaining)),
  ];
  if (options.resolveConflict) {
    stmts.push(resolveSubjectConflictStmt(c.db, kind, linkId, c.actor, c.now));
  }
  return { stmts, moved: 1, newId };
}
