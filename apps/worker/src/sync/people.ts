/**
 * Credits and people matching during sync (FR-SYNC-008, BR-10, ADR-0015, LLD-SYNC `upsertPage`).
 * For one source, replaces its `credits` rows. Each credit's person link is upserted by
 * `(server_id, provider_person_id)` and goes through `matchPerson` only when the link is new or
 * its name or IDs changed, so merges do not flip-flop between syncs.
 */
import {
  deletePersonIfLinklessStmts,
  flagStmt,
  clearFlagStmt,
  getPersonLinks,
  insertPersonStmt,
  loadOverrides,
  loadPersonCandidate,
  personCandidatesByIds,
  personCandidatesByName,
  personSearchStmts,
  rekeyCreditsStmt,
  replaceCreditsStmts,
  updateLinkArtworkStmt,
  updatePersonStmt,
  upsertPersonLinkStmt,
  type PersonLinkRow,
} from '../db/catalog-write';
import { nameKey, sortKey } from '../match/names';
import { decidePerson, type PersonCandidate, type PersonLinkInfo } from '../match/people';
import type { NormalizedCredit } from '../providers/types';
import type { SyncDeps } from './deps';

interface LinkChoice {
  linkId: string;
  name: string;
  priority: number;
}

/** The link a person shows: highest server priority, ties keep the current one, then lowest ID. */
function pickShown(links: LinkChoice[], currentId: string | null | undefined): LinkChoice | null {
  let best: LinkChoice | null = null;
  for (const l of links) {
    if (
      !best ||
      l.priority > best.priority ||
      (l.priority === best.priority &&
        best.linkId !== currentId &&
        (l.linkId === currentId || l.linkId < best.linkId))
    ) {
      best = l;
    }
  }
  return best;
}

const choiceOf = (l: PersonLinkInfo): LinkChoice => ({
  linkId: l.linkId,
  name: l.name,
  priority: l.serverPriority,
});

const altNames = (links: LinkChoice[], shown: LinkChoice): string =>
  [...new Set(links.filter((l) => l.name !== shown.name).map((l) => l.name))].join(' ');

export interface CreditPlan {
  stmts: D1PreparedStatement[];
  /** People matched or created in this plan, for diagnostics and tests. */
  matched: number;
}

export async function planCredits(
  deps: SyncDeps,
  server: { id: string; priority: number },
  source: { id: string; mediaItemId: string },
  credits: NormalizedCredit[],
): Promise<CreditPlan> {
  const { db } = deps;
  const now = deps.now();
  const stmts: D1PreparedStatement[] = [];
  let matched = 0;

  const unique = new Map<string, NormalizedCredit['person']>();
  for (const c of credits)
    if (!unique.has(c.person.providerPersonId)) unique.set(c.person.providerPersonId, c.person);
  const providerIds = [...unique.keys()];
  const existing =
    providerIds.length > 0
      ? await getPersonLinks(db, server.id, providerIds)
      : new Map<string, PersonLinkRow>();
  const overrides =
    providerIds.length > 0 ? await loadOverrides(db, 'person', server.id, providerIds) : new Map();
  const resolved = new Map<string, { linkId: string; personId: string }>();

  for (const [providerPersonId, person] of unique) {
    const tmdbId = person.externalIds.tmdb ?? null;
    const imdbId = person.externalIds.imdb ?? null;
    const artwork = JSON.stringify(person.artwork ? { poster: { tag: person.artwork.tag } } : {});
    const link = existing.get(providerPersonId);
    if (link && link.name === person.name && link.tmdb_id === tmdbId && link.imdb_id === imdbId) {
      if (link.artwork !== artwork) stmts.push(updateLinkArtworkStmt(db, link.id, artwork));
      resolved.set(providerPersonId, { linkId: link.id, personId: link.person_id });
      continue;
    }

    // New link, or its name or IDs changed: match (LLD-MATCH `matchPerson`).
    matched++;
    const subject = { serverId: server.id, providerPersonId, name: person.name, tmdbId, imdbId };
    const idCandidates = await personCandidatesByIds(db, tmdbId, imdbId);
    const nameCandidates = await personCandidatesByName(db, nameKey(person.name));
    const decision = decidePerson({
      subject,
      override: overrides.get(providerPersonId) ?? null,
      idCandidates,
      nameCandidates,
    });
    const linkId = link?.id ?? deps.newId();
    const flag = decision.kind === 'flag' ? decision.flag : null;

    let targetPersonId: string;
    let method: 'external_id' | 'name' | 'new' | 'manual';
    let create = false;
    if (decision.kind === 'attach') {
      targetPersonId = decision.targetId;
      method = decision.method;
    } else if (link) {
      targetPersonId = link.person_id; // keep the current entity
      method =
        decision.kind === 'keep' && decision.method === 'manual'
          ? 'manual'
          : (link.match_method as typeof method);
    } else {
      targetPersonId = deps.newId();
      method = decision.kind === 'keep' ? decision.method : 'new';
      create = true;
    }

    const shown = { linkId, name: person.name, priority: server.priority };
    if (create) {
      stmts.push(
        insertPersonStmt(db, {
          id: targetPersonId,
          name: person.name,
          sortName: sortKey(person.name),
          nameKey: nameKey(person.name),
          linkId,
          now,
        }),
      );
    }
    stmts.push(
      upsertPersonLinkStmt(db, {
        id: linkId,
        personId: targetPersonId,
        serverId: server.id,
        providerPersonId,
        name: person.name,
        tmdbId,
        imdbId,
        artwork,
        matchMethod: method,
        now,
      }),
    );
    if (create) {
      stmts.push(...personSearchStmts(db, targetPersonId, ''));
    } else {
      // Attached to (or staying with) an existing person: recompute what it shows.
      const target: PersonCandidate | null =
        [...idCandidates, ...nameCandidates].find((c) => c.personId === targetPersonId) ??
        (await loadPersonCandidate(db, targetPersonId));
      const others = (target?.links ?? []).filter((l) => l.linkId !== linkId).map(choiceOf);
      const all = [...others, shown];
      const best = pickShown(all, target?.metadataLinkId) ?? shown;
      stmts.push(
        updatePersonStmt(db, {
          id: targetPersonId,
          name: best.name,
          sortName: sortKey(best.name),
          nameKey: nameKey(best.name),
          linkId: best.linkId,
          now,
        }),
        ...personSearchStmts(db, targetPersonId, altNames(all, best)),
      );
    }
    if (link && link.person_id !== targetPersonId) {
      // The link moved: re-key its credits and tidy the person it left (DR-005).
      stmts.push(rekeyCreditsStmt(db, linkId, targetPersonId));
      const left = await loadPersonCandidate(db, link.person_id);
      const remaining = (left?.links ?? []).filter((l) => l.linkId !== linkId).map(choiceOf);
      const best = pickShown(remaining, left?.metadataLinkId);
      if (!best) {
        stmts.push(...deletePersonIfLinklessStmts(db, link.person_id));
      } else if (left?.metadataLinkId === linkId) {
        stmts.push(
          updatePersonStmt(db, {
            id: link.person_id,
            name: best.name,
            sortName: sortKey(best.name),
            nameKey: nameKey(best.name),
            linkId: best.linkId,
            now,
          }),
          ...personSearchStmts(db, link.person_id, altNames(remaining, best)),
        );
      }
    }
    stmts.push(
      flag
        ? flagStmt(db, deps.newId(), { kind: 'person', linkId }, flag, now)
        : clearFlagStmt(db, 'person', linkId, now),
    );
    resolved.set(providerPersonId, { linkId, personId: targetPersonId });
  }

  const rows: {
    linkId: string;
    personId: string;
    role: string;
    character: string | null;
    order: number;
  }[] = [];
  const seen = new Set<string>();
  for (const c of credits) {
    const r = resolved.get(c.person.providerPersonId);
    if (!r) continue;
    const key = `${r.linkId}|${c.role}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({ ...r, role: c.role, character: c.character ?? null, order: c.order });
  }
  stmts.push(...replaceCreditsStmts(db, source.id, source.mediaItemId, rows));
  return { stmts, matched };
}
