/** Typed functions for the operator curation API: merge, split, conflicts (LLD-API; FR-CAT-007, FR-CAT-010). */
import type {
  ConflictsPage,
  CurationEntity,
  EntityKind,
  MergeResult,
  ResolveConflictRequest,
  ResolveConflictResult,
  SplitResult,
} from '@cinewren/shared';
import { api } from './index';
import { queryString } from './catalog';

const enc = encodeURIComponent;

export const getCurationEntity = (kind: EntityKind, id: string) =>
  api<CurationEntity>('GET', `/admin/curation/entities/${kind}/${enc(id)}`);

export const mergeEntities = (entityKind: EntityKind, intoId: string, fromId: string) =>
  api<MergeResult>('POST', '/admin/curation/merge', { entityKind, intoId, fromId });

/** `recordId` is the source ID for a title, the link ID for a person or collection. */
export const splitEntity = (entityKind: EntityKind, id: string, recordId: string) =>
  api<SplitResult>('POST', '/admin/curation/split', {
    entityKind,
    id,
    ...(entityKind === 'item' ? { sourceId: recordId } : { linkId: recordId }),
  });

export const listConflicts = (f: { entityKind?: EntityKind | ''; cursor?: string | null }) =>
  api<ConflictsPage>('GET', `/admin/curation/conflicts${queryString({ ...f, limit: 25 })}`);

export const resolveConflict = (id: string, body: ResolveConflictRequest) =>
  api<ResolveConflictResult>('POST', `/admin/curation/conflicts/${enc(id)}/resolve`, body);
