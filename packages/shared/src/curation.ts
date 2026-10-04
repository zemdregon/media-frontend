/**
 * Operator curation contracts (LLD-API "curation" rows, LLD-MATCH "Curation operations";
 * FR-CAT-007, FR-CAT-010, BR-3, BR-10). Merge, split and conflict resolution work on titles,
 * people and collections alike, selected by `entityKind`.
 */
import { z } from 'zod';
import type { Page } from './auth';

export const ENTITY_KINDS = ['item', 'person', 'collection'] as const;
export type EntityKind = (typeof ENTITY_KINDS)[number];
const entityKind = z.enum(ENTITY_KINDS);
const id = z.string().trim().min(1).max(64);
const cursor = z.string().min(1).max(2048);

/** `POST /admin/curation/merge`. `intoItemId` and `fromItemId` are aliases for items. */
export const mergeRequest = z
  .object({
    entityKind: entityKind.default('item'),
    intoId: id.optional(),
    fromId: id.optional(),
    intoItemId: id.optional(),
    fromItemId: id.optional(),
  })
  .transform((v, ctx) => {
    const intoId = v.intoId ?? v.intoItemId;
    const fromId = v.fromId ?? v.fromItemId;
    if (!intoId || !fromId) {
      ctx.addIssue({ code: 'custom', message: 'intoId and fromId are required', path: ['intoId'] });
      return z.NEVER;
    }
    if (intoId === fromId) {
      ctx.addIssue({ code: 'custom', message: 'Choose two different ones', path: ['fromId'] });
      return z.NEVER;
    }
    return { entityKind: v.entityKind, intoId, fromId };
  });
export type MergeRequest = z.input<typeof mergeRequest>;

/** `POST /admin/curation/split`: `sourceId` for an item, `linkId` for a person or collection. */
export const splitRequest = z
  .object({
    entityKind: entityKind.default('item'),
    id,
    sourceId: id.optional(),
    linkId: id.optional(),
  })
  .transform((v, ctx) => {
    const recordId = v.entityKind === 'item' ? (v.sourceId ?? v.linkId) : (v.linkId ?? v.sourceId);
    if (!recordId) {
      ctx.addIssue({
        code: 'custom',
        message: 'sourceId (items) or linkId (people, collections) is required',
        path: [v.entityKind === 'item' ? 'sourceId' : 'linkId'],
      });
      return z.NEVER;
    }
    return { entityKind: v.entityKind, id: v.id, recordId };
  });
export type SplitRequest = z.input<typeof splitRequest>;

export interface MergeResult {
  id: string;
}
export interface SplitResult {
  newId: string;
}

/** One provider record of a canonical entity: an item's source, or a person's or collection's link. */
export interface CurationRecord {
  /** `sources.id` for an item, the link ID for a person or collection. */
  id: string;
  serverName: string;
  serverType: string;
  /** The origin's own title or name for it. */
  name: string;
  year: number | null;
  /** Sources only; links are always `present`. */
  status: 'present' | 'missing';
  manual: boolean;
}

/** `GET /admin/curation/entities/{entityKind}/{id}`: what a merge or split would act on. */
export interface CurationEntity {
  entityKind: EntityKind;
  id: string;
  name: string;
  records: CurationRecord[];
}

export const overridesQuery = z.object({
  cursor: cursor.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export interface CurationOverride {
  id: string;
  kind: 'pin' | 'separate';
  entityKind: EntityKind;
  /** The canonical item, person or collection the override pins to or was split into. */
  targetId: string;
  serverId: string;
  serverName: string;
  providerId: string;
  createdAt: number;
}

export const conflictsQuery = z.object({
  status: z.enum(['open', 'resolved', 'dismissed']).default('open'),
  entityKind: entityKind.optional(),
  cursor: cursor.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
export type ConflictsQuery = z.output<typeof conflictsQuery>;

export type ConflictReason =
  'conflicting_ids' | 'multiple_candidates' | 'type_mismatch' | 'ambiguous_name';

export interface ConflictSubject {
  /** Source ID for an item, link ID for a person or collection. */
  id: string;
  /** Title or name as the origin reports it. */
  title: string;
  year: number | null;
  serverName: string;
  serverType: string;
  externalIds: Record<string, string>;
  /** The canonical entity the subject currently belongs to. */
  currentId: string;
}

export interface ConflictCandidate {
  id: string;
  title: string;
  year: number | null;
  externalIds: Record<string, string[]>;
  /** `scheme:value` pairs shared with the subject, and `scheme:a!=b` pairs that differ. */
  sharedIds: string[];
  conflictingIds: string[];
}

export interface MatchConflict {
  id: string;
  entityKind: EntityKind;
  status: 'open' | 'resolved' | 'dismissed';
  reason: ConflictReason;
  detectedAt: number;
  source: ConflictSubject;
  candidates: ConflictCandidate[];
}

export type ConflictsPage = Page<MatchConflict>;

/** `POST /admin/curation/conflicts/{id}/resolve`. */
export const resolveConflictRequest = z.discriminatedUnion('action', [
  z.object({ action: z.literal('merge'), intoId: id }),
  z.object({ action: z.literal('keep_separate') }),
  z.object({ action: z.literal('dismiss') }),
]);
export type ResolveConflictRequest = z.input<typeof resolveConflictRequest>;

export interface ResolveConflictResult {
  /** The canonical entity the subject belongs to afterwards. */
  id: string;
  /** Same as `id` for an item conflict (LLD-API `{itemId}`); absent for people and collections. */
  itemId?: string;
}
