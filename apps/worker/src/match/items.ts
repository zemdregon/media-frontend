/**
 * Item matching decisions (LLD-MATCH, BR-2, BR-3, ADR-0010, FR-CAT-001). Pure functions: the
 * caller reads the candidates from D1 and applies the decision, so every rule is table-testable.
 *
 * Rules in one place:
 * - a manual override wins (BR-3);
 * - automatic merge needs the same media type and at least one shared strong ID
 *   (movie: tmdb, imdb; series and episode: tmdb, imdb, tvdb); there is no fuzzy title matching;
 * - a shared ID with a conflicting ID on another scheme, or IDs matching several items, never
 *   merge and raise a conflict flag instead;
 * - episodes also align by (series, season number, episode number).
 */
import type { ItemType } from '../providers/types';

export type Scheme = 'tmdb' | 'imdb' | 'tvdb';
export const SCHEMES: readonly Scheme[] = ['tmdb', 'imdb', 'tvdb'];
export type IdSet = Partial<Record<Scheme, string>>;

export type ConflictReason =
  'conflicting_ids' | 'multiple_candidates' | 'type_mismatch' | 'ambiguous_name';

export interface ConflictCandidate {
  /** `itemId`, `personId` or `collectionId` depending on the entity kind. */
  id: string;
  /** `scheme:value` pairs the subject and the candidate agree on. */
  sharedIds: string[];
  /** `scheme:subjectValue!=candidateValue` pairs. */
  conflictingIds: string[];
}

export interface ConflictFlag {
  reason: ConflictReason;
  candidates: ConflictCandidate[];
}

/** A canonical item with every external ID it aggregates from its non-manual sources. */
export interface ItemCandidate {
  itemId: string;
  type: ItemType;
  ids: Record<Scheme, string[]>;
}

export type Override = { kind: 'pin'; targetId: string } | { kind: 'separate' } | null;

export type ItemDecision =
  | { kind: 'attach'; itemId: string; method: 'external_id' | 'manual' }
  /** Keep the source's current item, or create a new one. `manual` for a `separate` override. */
  | { kind: 'keep'; method: 'new' | 'manual' }
  | { kind: 'flag'; flag: ConflictFlag };

/** Strong schemes per type (BR-2). Seasons have none and align by number only. */
export function strongSchemes(type: ItemType): readonly Scheme[] {
  switch (type) {
    case 'movie':
      return ['tmdb', 'imdb'];
    case 'series':
    case 'episode':
      return ['tmdb', 'imdb', 'tvdb'];
    case 'season':
      return [];
  }
}

export function strongIds(type: ItemType, ids: IdSet): [Scheme, string][] {
  const out: [Scheme, string][] = [];
  for (const scheme of strongSchemes(type)) {
    const v = ids[scheme];
    if (v) out.push([scheme, v]);
  }
  return out;
}

function sharedWith(src: [Scheme, string][], c: ItemCandidate): string[] {
  return src.filter(([s, v]) => c.ids[s].includes(v)).map(([s, v]) => `${s}:${v}`);
}

function conflictsWith(src: [Scheme, string][], c: ItemCandidate): string[] {
  const out: string[] = [];
  for (const [s, v] of src) {
    const theirs = c.ids[s];
    if (theirs.length > 0 && !theirs.includes(v)) out.push(`${s}:${v}!=${theirs.join('|')}`);
  }
  return out;
}

/**
 * Decision for a movie, series or episode-by-ID. `candidates` are items that share at least one
 * `(scheme, value)` pair with the source, of any type (the caller cannot filter by type for IMDb
 * IDs, which are not namespaced by media type; TMDB IDs are). `separated` are item IDs the
 * source must never join.
 */
export function decideByExternalIds(
  type: ItemType,
  ids: IdSet,
  candidates: ItemCandidate[],
  separated: ReadonlySet<string> = new Set(),
): ItemDecision {
  const src = strongIds(type, ids);
  if (src.length === 0) return { kind: 'keep', method: 'new' }; // no fuzzy title matching
  const usable = candidates.filter((c) => !separated.has(c.itemId));
  const sameType: ItemCandidate[] = [];
  const otherType: ItemCandidate[] = [];
  for (const c of usable) {
    // TMDB and TVDB IDs are namespaced by type, so they only count within one type.
    const typed = src.filter(([s]) => s === 'imdb' || c.type === type);
    if (sharedWith(typed, c).length === 0) continue;
    (c.type === type ? sameType : otherType).push(c);
  }
  const describe = (c: ItemCandidate): ConflictCandidate => ({
    id: c.itemId,
    sharedIds: sharedWith(src, c),
    conflictingIds: conflictsWith(src, c),
  });
  if (sameType.length === 0) {
    const topLevel = (t: ItemType) => t === 'movie' || t === 'series';
    const mismatched = otherType.filter((c) => topLevel(c.type) && topLevel(type));
    return mismatched.length > 0
      ? { kind: 'flag', flag: { reason: 'type_mismatch', candidates: mismatched.map(describe) } }
      : { kind: 'keep', method: 'new' };
  }
  if (sameType.length > 1) {
    return {
      kind: 'flag',
      flag: { reason: 'multiple_candidates', candidates: sameType.map(describe) },
    };
  }
  const only = sameType[0];
  if (!only) return { kind: 'keep', method: 'new' };
  if (conflictsWith(src, only).length > 0) {
    return { kind: 'flag', flag: { reason: 'conflicting_ids', candidates: [describe(only)] } };
  }
  return { kind: 'attach', itemId: only.itemId, method: 'external_id' };
}

/** The override step shared by every item type. Returns null when automatic matching applies. */
export function decideOverride(override: Override): ItemDecision | null {
  if (!override) return null;
  if (override.kind === 'pin') {
    return { kind: 'attach', itemId: override.targetId, method: 'manual' };
  }
  return { kind: 'keep', method: 'manual' };
}

export type EpisodeDecision =
  | { kind: 'attach'; itemId: string; method: 'external_id' }
  /** Attach to (or create) the child at this position under the resolved parent item. */
  | { kind: 'align'; parentItemId: string; number: number }
  | { kind: 'keep'; method: 'new' }
  | { kind: 'flag'; flag: ConflictFlag };

/**
 * Episodes (BR-2): by episode external ID when exactly one non-conflicting candidate exists and
 * it lies under the same season item (a TVDB episode ID that points into a different, unmerged
 * series is ignored, never trusted over the series structure); otherwise by position under the
 * parent season item; otherwise a new item.
 */
export function decideEpisode(input: {
  ids: IdSet;
  candidates: ItemCandidate[];
  /** Parent id of each candidate item, by item id. */
  candidateParents: ReadonlyMap<string, string | null>;
  parentItemId: string | null;
  episodeNumber: number | undefined;
  separated?: ReadonlySet<string>;
}): EpisodeDecision {
  const byId = decideByExternalIds('episode', input.ids, input.candidates, input.separated);
  if (byId.kind === 'attach') {
    const candidateParent = input.candidateParents.get(byId.itemId) ?? null;
    if (input.parentItemId === null || candidateParent === input.parentItemId) {
      return { kind: 'attach', itemId: byId.itemId, method: 'external_id' };
    }
  } else if (byId.kind === 'flag' && byId.flag.reason !== 'type_mismatch') {
    // Episode IDs that conflict or are ambiguous do not block alignment by position when the
    // series structure is known; they only raise a flag when we cannot align.
    if (input.parentItemId === null || input.episodeNumber === undefined) {
      return { kind: 'flag', flag: byId.flag };
    }
  }
  if (input.parentItemId !== null && input.episodeNumber !== undefined) {
    return { kind: 'align', parentItemId: input.parentItemId, number: input.episodeNumber };
  }
  return { kind: 'keep', method: 'new' };
}
