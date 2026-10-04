/**
 * Pure planning for operator curation (LLD-MATCH "Curation operations", FR-CAT-007). The caller
 * reads the rows from D1 and turns the plans into statements, so every rule is table-testable.
 */

export interface NumberedChild {
  id: string;
  /** Season number for a season, episode number for an episode; null when the origin gave none. */
  number: number | null;
}

export interface ChildMergePlan {
  /** Children that exist under both parents: `from` folds into `into` (series merge cascade). */
  merge: { intoId: string; fromId: string }[];
  /** Children only `from` has: they move under the surviving parent. */
  move: string[];
}

/**
 * "Series merge cascades to children": seasons are re-keyed by `(series, season #)` and episodes
 * by `(season, episode #)`. Children with the same number merge; the rest move across. A child
 * without a number cannot be paired and moves. When the survivor has two children with one
 * number, the lowest ID takes the merge.
 */
export function planChildMerge(into: NumberedChild[], from: NumberedChild[]): ChildMergePlan {
  const byNumber = new Map<number, string>();
  for (const c of [...into].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    if (c.number !== null && !byNumber.has(c.number)) byNumber.set(c.number, c.id);
  }
  const plan: ChildMergePlan = { merge: [], move: [] };
  for (const c of [...from].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    const target = c.number === null ? undefined : byNumber.get(c.number);
    if (target) plan.merge.push({ intoId: target, fromId: c.id });
    else plan.move.push(c.id);
  }
  return plan;
}

/** Item types an operator can merge or split: a season or episode follows its series (BR-2). */
export const CURATABLE_ITEM_TYPES = ['movie', 'series'] as const;

export type MergeCheck = 'ok' | 'type_mismatch' | 'not_curatable';

export function checkMerge(intoType: string, fromType: string): MergeCheck {
  if (intoType !== fromType) return 'type_mismatch';
  return (CURATABLE_ITEM_TYPES as readonly string[]).includes(intoType) ? 'ok' : 'not_curatable';
}

/** The conflict candidates an operator may merge into: exactly the ones the flag listed. */
export function isListedCandidate(details: string, candidateId: string): boolean {
  return candidateIds(details).includes(candidateId);
}

/** IDs of the candidates in a conflict's `details` JSON, whatever the entity kind. */
export function candidateIds(details: string): string[] {
  return parseCandidates(details).map((c) => c.id);
}

export interface ParsedCandidate {
  id: string;
  sharedIds: string[];
  conflictingIds: string[];
}

export function parseCandidates(details: string): ParsedCandidate[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(details);
  } catch {
    return [];
  }
  const list = (parsed as { candidates?: unknown } | null)?.candidates;
  if (!Array.isArray(list)) return [];
  const out: ParsedCandidate[] = [];
  for (const entry of list as unknown[]) {
    const e = entry as Record<string, unknown> | null;
    const id = e?.itemId ?? e?.personId ?? e?.collectionId;
    if (typeof id !== 'string') continue;
    const strings = (v: unknown): string[] =>
      Array.isArray(v) ? (v as unknown[]).filter((x): x is string => typeof x === 'string') : [];
    out.push({ id, sharedIds: strings(e?.sharedIds), conflictingIds: strings(e?.conflictingIds) });
  }
  return out;
}
