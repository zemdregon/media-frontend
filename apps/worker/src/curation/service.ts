/**
 * Operator curation (T5.2; WF-9, FR-CAT-007, FR-CAT-010, BR-3, BR-10, DR-005): merge and split for
 * titles, people and collections, the override list, and the match-conflict list with its
 * resolutions. Operator-only (the router mounts it under `/admin`). Every mutation is one `batch`
 * that ends with exactly one audit row (FR-OPS-005); audit details carry IDs only.
 *
 * Failure codes: `NOT_FOUND` (unknown, or changed since the screen loaded: the batch's guards
 * abort it), `TYPE_MISMATCH` (items of different types), `LAST_SOURCE` (splitting the only
 * record), `VALIDATION_FAILED` (merging something into itself, a candidate the flag never listed).
 */
import type { Context } from 'hono';
import type {
  ConflictCandidate,
  ConflictsPage,
  ConflictsQuery,
  CurationEntity,
  CurationOverride,
  EntityKind,
  MatchConflict,
  MergeResult,
  Page,
  ResolveConflictRequest,
  ResolveConflictResult,
  SplitResult,
} from '@cinewren/shared';
import type { AppEnv } from '../api/context';
import { AppError } from '../api/errors';
import { currentUser } from '../auth/sessions';
import { expectKey, isNumber, isString, openCursor, sealCursor } from '../catalog/cursor';
import { auditStmt, guardChangedStmt, isGuardOrConstraintError } from '../db/auth';
import {
  closeConflictStmt,
  deleteOverrideStmt,
  getConflict,
  getCollectionLinkRow,
  getCurationItem,
  getCurationSource,
  getOverride,
  getPersonLinkRow,
  listCollectionLinksOf,
  listConflictsPage,
  listOverridesPage,
  listPersonLinksOf,
  listSourcesOfItem,
  loadCollectionCandidates,
  loadCollectionSubjects,
  loadItemCandidates,
  loadItemSubjects,
  loadPersonCandidates,
  loadPersonSubjects,
  getCollectionHead,
  getPersonHead,
  upsertOverrideStmt,
  type CandidateRow,
  type ConflictRow,
  type SubjectRow,
} from '../db/curation';
import { isListedCandidate, parseCandidates } from '../match/curation';
import { ulid } from '../platform/ids';
import { runBatch } from '../sync/batch';
import { planItemMerge, planItemSplit, type Plan } from './items';
import { planLinkMerge, planLinkSplit } from './links';

/** Statements per `batch()` call; the audit row is always the last statement of the last one. */
const CHUNK = 400;

const notFound = () => new AppError('NOT_FOUND', 'Not found.');

function ctxOf(c: Context<AppEnv>) {
  return { db: c.env.DB, actor: currentUser(c).userId, now: Date.now(), newId: ulid };
}

interface AuditSpec {
  action: string;
  targetType: EntityKind;
  targetId: string;
  details: Record<string, unknown>;
}

/**
 * Runs a plan with its audit row. A statement that finds the world changed (a vanished row, a
 * conflict that is no longer open) violates a guard and rolls the batch back; that is reported as
 * a stale selection.
 */
async function commit(
  c: Context<AppEnv>,
  stmts: D1PreparedStatement[],
  audit: AuditSpec,
): Promise<void> {
  const db = c.env.DB;
  try {
    await runBatch(
      db,
      [
        ...stmts,
        auditStmt(db, {
          id: ulid(),
          now: Date.now(),
          actorUserId: currentUser(c).userId,
          action: audit.action,
          targetType: audit.targetType,
          targetId: audit.targetId,
          details: audit.details,
          requestId: c.get('requestId'),
        }),
      ],
      CHUNK,
    );
  } catch (err) {
    if (isGuardOrConstraintError(err)) {
      throw new AppError('NOT_FOUND', 'That changed since you loaded it. Refresh and try again.');
    }
    throw err;
  }
}

async function planMerge(
  c: Context<AppEnv>,
  kind: EntityKind,
  intoId: string,
  fromId: string,
): Promise<Plan> {
  const ctx = ctxOf(c);
  return kind === 'item'
    ? planItemMerge(ctx, intoId, fromId)
    : planLinkMerge(ctx, kind, intoId, fromId);
}

// --- merge and split ---

export async function merge(
  c: Context<AppEnv>,
  req: { entityKind: EntityKind; intoId: string; fromId: string },
): Promise<MergeResult> {
  const plan = await planMerge(c, req.entityKind, req.intoId, req.fromId);
  await commit(c, plan.stmts, {
    action: 'curation.merge',
    targetType: req.entityKind,
    targetId: req.intoId,
    details: { fromId: req.fromId, intoId: req.intoId, records: plan.moved },
  });
  return { id: req.intoId };
}

export async function split(
  c: Context<AppEnv>,
  req: { entityKind: EntityKind; id: string; recordId: string },
): Promise<SplitResult> {
  const ctx = ctxOf(c);
  const plan =
    req.entityKind === 'item'
      ? await planItemSplit(ctx, req.id, req.recordId)
      : await planLinkSplit(ctx, req.entityKind, req.id, req.recordId);
  if (!plan.newId) throw new AppError('INTERNAL', 'Something went wrong.');
  await commit(c, plan.stmts, {
    action: 'curation.split',
    targetType: req.entityKind,
    targetId: req.id,
    details: { recordId: req.recordId, newId: plan.newId, records: plan.moved },
  });
  return { newId: plan.newId };
}

/** What a merge or split would act on: the entity's provider records (for the operator screens). */
export async function entity(
  c: Context<AppEnv>,
  kind: EntityKind,
  id: string,
): Promise<CurationEntity> {
  const db = c.env.DB;
  if (kind === 'item') {
    const item = await getCurationItem(db, id);
    if (!item) throw notFound();
    const sources = await listSourcesOfItem(db, id);
    return {
      entityKind: kind,
      id,
      name: item.title,
      records: sources.map((s) => ({
        id: s.id,
        serverName: s.server_name,
        serverType: s.server_type,
        name: s.title,
        year: s.year,
        status: s.status,
        manual: s.match_method === 'manual',
      })),
    };
  }
  const head = kind === 'person' ? await getPersonHead(db, id) : await getCollectionHead(db, id);
  if (!head) throw notFound();
  const links =
    kind === 'person' ? await listPersonLinksOf(db, id) : await listCollectionLinksOf(db, id);
  return {
    entityKind: kind,
    id,
    name: head.name,
    records: links.map((l) => ({
      id: l.id,
      serverName: l.server_name,
      serverType: l.server_type,
      name: l.name,
      year: null,
      status: 'present',
      manual: l.match_method === 'manual',
    })),
  };
}

// --- overrides ---

export async function listOverrides(
  c: Context<AppEnv>,
  q: { cursor?: string | undefined; limit: number },
): Promise<Page<CurationOverride>> {
  const scope = 'curation-overrides';
  const key = expectKey<[number, string]>(await openCursor(c, scope, q.cursor), [
    isNumber,
    isString,
  ]);
  const rows = await listOverridesPage(c.env.DB, key, q.limit + 1);
  const more = rows.length > q.limit;
  const kept = more ? rows.slice(0, q.limit) : rows;
  const last = kept[kept.length - 1];
  return {
    items: kept.map((r) => ({
      id: r.id,
      kind: r.kind,
      entityKind: r.entity_kind,
      targetId: r.target_id,
      serverId: r.server_id,
      serverName: r.server_name,
      providerId: r.provider_item_id,
      createdAt: r.created_at,
    })),
    nextCursor: more && last ? await sealCursor(c, scope, [last.created_at, last.id]) : null,
  };
}

/** Removes an override; the record is matched again the next time a sync touches it (BR-3). */
export async function deleteOverride(c: Context<AppEnv>, id: string): Promise<void> {
  const db = c.env.DB;
  const row = await getOverride(db, id);
  if (!row) throw notFound();
  await commit(c, [deleteOverrideStmt(db, id)], {
    action: 'curation.override.delete',
    targetType: row.entity_kind,
    targetId: id,
    details: { serverId: row.server_id, providerId: row.provider_item_id },
  });
}

// --- conflicts (FR-CAT-010) ---

function parseIds(json: string): Record<string, string> {
  try {
    const v = JSON.parse(json) as Record<string, unknown> | null;
    const out: Record<string, string> = {};
    for (const [k, x] of Object.entries(v ?? {})) {
      if (typeof x === 'string' && x !== '') out[k] = x;
    }
    return out;
  } catch {
    return {};
  }
}

function candidateIdMap(pairs: string | null): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const pair of (pairs ?? '').split(',')) {
    const at = pair.indexOf(':');
    if (at <= 0) continue;
    (out[pair.slice(0, at)] ??= []).push(pair.slice(at + 1));
  }
  return out;
}

function subjectIdOf(r: ConflictRow): string {
  return r.source_id ?? r.person_link_id ?? r.collection_link_id ?? '';
}

async function hydrate(db: D1Database, rows: ConflictRow[]): Promise<MatchConflict[]> {
  const load = {
    item: [loadItemSubjects, loadItemCandidates],
    person: [loadPersonSubjects, loadPersonCandidates],
    collection: [loadCollectionSubjects, loadCollectionCandidates],
  } as const;
  const subjects = new Map<string, SubjectRow>();
  const candidates = new Map<string, CandidateRow>();
  for (const kind of ['item', 'person', 'collection'] as const) {
    const mine = rows.filter((r) => r.entity_kind === kind);
    if (mine.length === 0) continue;
    const [loadSubjects, loadCandidates] = load[kind];
    for (const s of await loadSubjects(db, [...new Set(mine.map(subjectIdOf))])) {
      subjects.set(`${kind}:${s.id}`, s);
    }
    const ids = [...new Set(mine.flatMap((r) => parseCandidates(r.details).map((x) => x.id)))];
    for (const x of await loadCandidates(db, ids)) candidates.set(`${kind}:${x.id}`, x);
  }
  const out: MatchConflict[] = [];
  for (const r of rows) {
    const subject = subjects.get(`${r.entity_kind}:${subjectIdOf(r)}`);
    if (!subject) continue; // its subject was purged; the cascade removes the row as well
    out.push({
      id: r.id,
      entityKind: r.entity_kind,
      status: r.status,
      reason: r.reason,
      detectedAt: r.detected_at,
      source: {
        id: subject.id,
        title: subject.title,
        year: subject.year,
        serverName: subject.server_name,
        serverType: subject.server_type,
        externalIds: parseIds(subject.external_ids),
        currentId: subject.current_id,
      },
      candidates: parseCandidates(r.details).flatMap((p): ConflictCandidate[] => {
        const row = candidates.get(`${r.entity_kind}:${p.id}`);
        return row
          ? [
              {
                id: p.id,
                title: row.title,
                year: row.year,
                externalIds: candidateIdMap(row.ids),
                sharedIds: p.sharedIds,
                conflictingIds: p.conflictingIds,
              },
            ]
          : [];
      }),
    });
  }
  return out;
}

export async function listConflicts(c: Context<AppEnv>, q: ConflictsQuery): Promise<ConflictsPage> {
  const scope = `curation-conflicts|${q.status}|${q.entityKind ?? ''}`;
  const key = expectKey<[number, string]>(await openCursor(c, scope, q.cursor), [
    isNumber,
    isString,
  ]);
  const rows = await listConflictsPage(
    c.env.DB,
    { status: q.status, entityKind: q.entityKind, after: key },
    q.limit + 1,
  );
  const more = rows.length > q.limit;
  const kept = more ? rows.slice(0, q.limit) : rows;
  const last = kept[kept.length - 1];
  return {
    items: await hydrate(c.env.DB, kept),
    nextCursor: more && last ? await sealCursor(c, scope, [last.detected_at, last.id]) : null,
  };
}

/** The canonical entity the conflict's subject belongs to right now. */
async function currentEntityOf(db: D1Database, r: ConflictRow): Promise<string | null> {
  if (r.entity_kind === 'item' && r.source_id) {
    return (await getCurationSource(db, r.source_id))?.media_item_id ?? null;
  }
  if (r.entity_kind === 'person' && r.person_link_id) {
    return (await getPersonLinkRow(db, r.person_link_id))?.entity_id ?? null;
  }
  if (r.collection_link_id)
    return (await getCollectionLinkRow(db, r.collection_link_id))?.entity_id ?? null;
  return null;
}

export async function resolveConflict(
  c: Context<AppEnv>,
  id: string,
  req: ResolveConflictRequest,
): Promise<ResolveConflictResult> {
  const db = c.env.DB;
  const ctx = ctxOf(c);
  const conflict = await getConflict(db, id);
  if (!conflict || conflict.status !== 'open') throw notFound(); // resolved elsewhere, or never existed
  const kind = conflict.entity_kind;
  const current = await currentEntityOf(db, conflict);
  const subjectId = subjectIdOf(conflict);
  if (!current) throw notFound();
  const done = (entityId: string): ResolveConflictResult =>
    kind === 'item' ? { id: entityId, itemId: entityId } : { id: entityId };
  const close = (status: 'resolved' | 'dismissed') => [
    closeConflictStmt(db, id, status, ctx.actor, ctx.now),
    guardChangedStmt(db), // aborts the batch when another operator closed it first
  ];

  if (req.action === 'dismiss') {
    await commit(c, close('dismissed'), {
      action: 'curation.conflict.resolve',
      targetType: kind,
      targetId: current,
      details: { conflictId: id, action: 'dismiss', subjectId },
    });
    return done(current);
  }

  if (req.action === 'keep_separate') {
    await commit(c, [...close('resolved'), ...(await separateStmts(ctx, conflict, current))], {
      action: 'curation.conflict.resolve',
      targetType: kind,
      targetId: current,
      details: { conflictId: id, action: 'keep_separate', subjectId },
    });
    return done(current);
  }

  // merge: the subject's entity folds into the chosen candidate.
  if (!isListedCandidate(conflict.details, req.intoId) || req.intoId === current) {
    throw new AppError(
      'VALIDATION_FAILED',
      'Choose one of the candidates listed for this conflict.',
      {
        fields: ['intoId'],
      },
    );
  }
  const plan = await planMerge(c, kind, req.intoId, current);
  await commit(c, [...close('resolved'), ...plan.stmts], {
    action: 'curation.conflict.resolve',
    targetType: kind,
    targetId: req.intoId,
    details: { conflictId: id, action: 'merge', fromId: current, intoId: req.intoId, subjectId },
  });
  return done(req.intoId);
}

/** "Keep separate": a `separate` override on the flagged subject, so it never joins the candidates. */
async function separateStmts(
  ctx: ReturnType<typeof ctxOf>,
  conflict: ConflictRow,
  currentId: string,
): Promise<D1PreparedStatement[]> {
  const { db } = ctx;
  let serverId: string;
  let providerId: string;
  if (conflict.entity_kind === 'item' && conflict.source_id) {
    const s = await getCurationSource(db, conflict.source_id);
    if (!s) throw notFound();
    serverId = s.server_id;
    providerId = s.provider_item_id;
  } else {
    const link =
      conflict.entity_kind === 'person' && conflict.person_link_id
        ? await getPersonLinkRow(db, conflict.person_link_id)
        : conflict.collection_link_id
          ? await getCollectionLinkRow(db, conflict.collection_link_id)
          : null;
    if (!link) throw notFound();
    serverId = link.server_id;
    providerId = link.provider_id;
  }
  return [
    upsertOverrideStmt(db, {
      id: ctx.newId(),
      kind: 'separate',
      entityKind: conflict.entity_kind,
      targetId: currentId,
      serverId,
      providerId,
      createdBy: ctx.actor,
      now: ctx.now,
    }),
  ];
}
