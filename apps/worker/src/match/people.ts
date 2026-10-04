/**
 * People and collection matching (LLD-MATCH "People and collections", ADR-0015, BR-10, BR-3).
 * Pure decisions over candidates the caller loaded from D1.
 */
import type { ConflictCandidate, ConflictFlag } from './items';

/** One provider link of a canonical person, as stored in `person_provider_links`. */
export interface PersonLinkInfo {
  linkId: string;
  serverId: string;
  providerPersonId: string;
  name: string;
  tmdbId: string | null;
  imdbId: string | null;
  serverPriority: number;
}

export interface PersonCandidate {
  personId: string;
  /** The link whose name and portrait the person currently shows. */
  metadataLinkId?: string | null;
  links: PersonLinkInfo[];
}

export interface PersonSubject {
  serverId: string;
  providerPersonId: string;
  name: string;
  tmdbId: string | null;
  imdbId: string | null;
}

export type PersonOverride = { kind: 'pin'; targetId: string } | { kind: 'separate' } | null;

export type EntityDecision =
  | { kind: 'attach'; targetId: string; method: 'external_id' | 'name' | 'manual' }
  /** Keep the link's current entity, or create a new one. */
  | { kind: 'keep'; method: 'new' | 'manual' }
  | { kind: 'flag'; flag: ConflictFlag };

function sharedIds(l: PersonSubject, links: PersonLinkInfo[]): string[] {
  const out = new Set<string>();
  for (const o of links) {
    if (l.tmdbId && o.tmdbId === l.tmdbId) out.add(`tmdb:${l.tmdbId}`);
    if (l.imdbId && o.imdbId === l.imdbId) out.add(`imdb:${l.imdbId}`);
  }
  return [...out];
}

function conflictingIds(l: PersonSubject, links: PersonLinkInfo[]): string[] {
  const out = new Set<string>();
  for (const o of links) {
    if (l.tmdbId && o.tmdbId && o.tmdbId !== l.tmdbId) out.add(`tmdb:${l.tmdbId}!=${o.tmdbId}`);
    if (l.imdbId && o.imdbId && o.imdbId !== l.imdbId) out.add(`imdb:${l.imdbId}!=${o.imdbId}`);
  }
  return [...out];
}

const describe = (l: PersonSubject, c: PersonCandidate): ConflictCandidate => ({
  id: c.personId,
  sharedIds: sharedIds(l, c.links),
  conflictingIds: conflictingIds(l, c.links),
});

/** Links of other origin people only: the subject's own existing link never counts against it. */
const others = (l: PersonSubject, c: PersonCandidate): PersonLinkInfo[] =>
  c.links.filter((o) => !(o.serverId === l.serverId && o.providerPersonId === l.providerPersonId));

/**
 * `idCandidates`: people with a link sharing the subject's TMDB or IMDb ID.
 * `nameCandidates`: people whose `name_key` equals the subject's.
 * `separated`: people the subject must never join.
 */
export function decidePerson(input: {
  subject: PersonSubject;
  override: PersonOverride;
  idCandidates: PersonCandidate[];
  nameCandidates: PersonCandidate[];
  separated?: ReadonlySet<string>;
}): EntityDecision {
  const { subject: l, override } = input;
  const separated = input.separated ?? new Set<string>();
  if (override?.kind === 'pin') {
    return { kind: 'attach', targetId: override.targetId, method: 'manual' };
  }
  if (override?.kind === 'separate') return { kind: 'keep', method: 'manual' };

  const byId = input.idCandidates
    .filter((c) => !separated.has(c.personId))
    .map((c) => ({ c, links: others(l, c) }))
    .filter(({ links }) => sharedIds(l, links).length > 0);
  if (byId.length > 1) {
    return {
      kind: 'flag',
      flag: {
        reason: 'multiple_candidates',
        candidates: byId.map(({ c }) => describe(l, { ...c, links: others(l, c) })),
      },
    };
  }
  const only = byId[0];
  if (only) {
    if (conflictingIds(l, only.links).length > 0) {
      return {
        kind: 'flag',
        flag: {
          reason: 'conflicting_ids',
          candidates: [describe(l, { personId: only.c.personId, links: only.links })],
        },
      };
    }
    return { kind: 'attach', targetId: only.c.personId, method: 'external_id' };
  }

  const byName = input.nameCandidates.filter((c) => {
    if (separated.has(c.personId)) return false;
    const links = others(l, c);
    if (links.some((o) => o.serverId === l.serverId)) return false; // two origin people on one server are distinct
    if (conflictingIds(l, links).length > 0) return false; // two different "Chris Evans": no flag
    return true;
  });
  if (byName.length === 1 && byName[0]) {
    return { kind: 'attach', targetId: byName[0].personId, method: 'name' };
  }
  if (byName.length > 1) {
    return {
      kind: 'flag',
      flag: {
        reason: 'ambiguous_name',
        candidates: byName.map((c) => describe(l, { ...c, links: others(l, c) })),
      },
    };
  }
  return { kind: 'keep', method: 'new' };
}

// --- collections ---

export interface CollectionCandidate {
  collectionId: string;
  tmdbCollectionIds: string[];
}

/** TMDB collection ID is the only cross-server merge key (ADR-0015). */
export function decideCollection(input: {
  tmdbCollectionId: string | null;
  override: PersonOverride;
  candidates: CollectionCandidate[];
  separated?: ReadonlySet<string>;
}): EntityDecision {
  const { override } = input;
  if (override?.kind === 'pin') {
    return { kind: 'attach', targetId: override.targetId, method: 'manual' };
  }
  if (override?.kind === 'separate') return { kind: 'keep', method: 'manual' };
  const tmdb = input.tmdbCollectionId;
  if (!tmdb) return { kind: 'keep', method: 'new' }; // never merged by name
  const separated = input.separated ?? new Set<string>();
  const matches = input.candidates.filter(
    (c) => !separated.has(c.collectionId) && c.tmdbCollectionIds.includes(tmdb),
  );
  if (matches.length === 0) return { kind: 'keep', method: 'new' };
  if (matches.length > 1) {
    return {
      kind: 'flag',
      flag: {
        reason: 'multiple_candidates',
        candidates: matches.map((c) => ({
          id: c.collectionId,
          sharedIds: [`tmdb_collection:${tmdb}`],
          conflictingIds: [],
        })),
      },
    };
  }
  const only = matches[0];
  return only
    ? { kind: 'attach', targetId: only.collectionId, method: 'external_id' }
    : { kind: 'keep', method: 'new' };
}
