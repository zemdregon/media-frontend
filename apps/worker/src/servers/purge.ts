/**
 * Server removal and chunked purge (T2.6; FR-SRV-004, WF-10, DR-005, BR-1, LLD-SCHEMA
 * "Cascades and deletion"). Removal is two-phase so it is safe on large catalogs inside D1's
 * per-query limits:
 *
 *  1. `startServerRemoval` (one batch): the server becomes `removing`, which hides its sources
 *     from every catalog query at once (BR-1), its credentials are deleted, its open playback
 *     credentials are marked for revocation, and the audit row is written.
 *  2. `purgeServer` deletes versions, sources, availability and provider links in chunks (500,
 *     proposed), removes items left with no sources (children first, with their search rows),
 *     then deletes the `servers` row, whose cascades take the libraries, grants, sync runs and
 *     health probes with it. People and collections left without links are removed with their
 *     search rows. Every pass is idempotent, so a retried job simply continues.
 */
import type { Context } from 'hono';
import type { AppEnv } from '../api/context';
import { AppError } from '../api/errors';
import { currentUser } from '../auth/sessions';
import { auditStmt } from '../db/auth';
import type { Env } from '../platform/env';
import { createLogger } from '../platform/logger';
import { ulid } from '../platform/ids';

export const PURGE_CHUNK = 500;
/** Chunks one invocation may run before handing the rest to a queue message. */
export const PURGE_CHUNKS_PER_RUN = 10;

export interface PurgeServerJob {
  type: 'purge_server';
  serverId: string;
}

export function isPurgeServerJob(value: unknown): value is PurgeServerJob {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { type?: unknown }).type === 'purge_server' &&
    typeof (value as { serverId?: unknown }).serverId === 'string'
  );
}

export interface PurgeOptions {
  chunk?: number;
  maxChunks?: number;
}

const ITEM_TYPES_CHILDREN_FIRST = ['episode', 'season', 'series', 'movie'] as const;

async function changes(db: D1Database, sql: string, ...values: unknown[]): Promise<number> {
  const res = await db
    .prepare(sql)
    .bind(...values)
    .run();
  return res.meta.changes;
}

/** Deletes one chunk of a server's sources and what hangs off them. Returns rows removed. */
async function purgeSourceChunk(db: D1Database, serverId: string, chunk: number): Promise<number> {
  const { results } = await db
    .prepare('SELECT id, media_item_id FROM sources WHERE server_id = ? LIMIT ?')
    .bind(serverId, chunk)
    .all<{ id: string; media_item_id: string }>();
  if (results.length === 0) return 0;
  const sourceIds = JSON.stringify(results.map((r) => r.id));
  const itemIds = JSON.stringify([...new Set(results.map((r) => r.media_item_id))]);
  const orphan = `i.id IN (SELECT value FROM json_each(?2)) AND i.type = ?1
     AND NOT EXISTS (SELECT 1 FROM sources s WHERE s.media_item_id = i.id)
     AND NOT EXISTS (SELECT 1 FROM media_items ch WHERE ch.parent_id = i.id)`;
  await db.batch([
    db
      .prepare('DELETE FROM media_versions WHERE source_id IN (SELECT value FROM json_each(?))')
      .bind(sourceIds),
    // Cascades credits, collection_members and match_conflicts of these sources.
    db.prepare('DELETE FROM sources WHERE id IN (SELECT value FROM json_each(?))').bind(sourceIds),
    // Orphan items, children first. Their search rows go first so none outlives its item.
    ...ITEM_TYPES_CHILDREN_FIRST.flatMap((type) => [
      db
        .prepare(
          `DELETE FROM search_fts WHERE kind = 'title' AND entity_id IN
             (SELECT i.id FROM media_items i WHERE ${orphan})`,
        )
        .bind(type, itemIds),
      db
        .prepare(
          `DELETE FROM media_items WHERE id IN (SELECT i.id FROM media_items i WHERE ${orphan})`,
        )
        .bind(type, itemIds),
    ]),
  ]);
  return results.length;
}

/** People and collections with no provider link left, with their search rows (DR-005). */
async function purgeOrphanEntities(db: D1Database, chunk: number): Promise<void> {
  for (const [table, linkTable, fk, kind] of [
    ['people', 'person_provider_links', 'person_id', 'person'],
    ['collections', 'collection_provider_links', 'collection_id', 'collection'],
  ] as const) {
    const orphans = `SELECT e.id FROM ${table} e
       WHERE NOT EXISTS (SELECT 1 FROM ${linkTable} l WHERE l.${fk} = e.id) LIMIT ?2`;
    for (;;) {
      const res = await db.batch([
        db
          .prepare(`DELETE FROM search_fts WHERE kind = ?1 AND entity_id IN (${orphans})`)
          .bind(kind, chunk),
        db.prepare(`DELETE FROM ${table} WHERE id IN (${orphans.replace('?2', '?1')})`).bind(chunk),
      ]);
      if ((res[1]?.meta.changes ?? 0) === 0) break;
    }
  }
}

/**
 * Continues the purge of a `removing` server. Returns `done` once the server row is gone, or
 * `more` when the chunk budget ran out (the caller re-enqueues). Does nothing for a server that is
 * not `removing`, so a stray job can never delete a live server.
 */
export async function purgeServer(
  db: D1Database,
  serverId: string,
  options: PurgeOptions = {},
): Promise<'done' | 'more'> {
  const chunk = options.chunk ?? PURGE_CHUNK;
  const server = await db
    .prepare('SELECT status FROM servers WHERE id = ?')
    .bind(serverId)
    .first<{ status: string }>();
  if (!server) return 'done';
  if (server.status !== 'removing') return 'done';

  let budget = options.maxChunks ?? PURGE_CHUNKS_PER_RUN;
  /** Runs `step` until it does nothing; each productive chunk spends budget. False: out of budget. */
  const drain = async (step: () => Promise<number>): Promise<boolean> => {
    for (;;) {
      if (budget <= 0) return false;
      if ((await step()) === 0) return true;
      budget--;
    }
  };

  if (!(await drain(() => purgeSourceChunk(db, serverId, chunk)))) return 'more';
  for (const sql of [
    `DELETE FROM item_availability WHERE (media_item_id, library_id) IN
       (SELECT media_item_id, library_id FROM item_availability
         WHERE library_id IN (SELECT id FROM libraries WHERE server_id = ?1) LIMIT ?2)`,
    `DELETE FROM person_provider_links WHERE id IN
       (SELECT id FROM person_provider_links WHERE server_id = ?1 LIMIT ?2)`,
    `DELETE FROM collection_provider_links WHERE id IN
       (SELECT id FROM collection_provider_links WHERE server_id = ?1 LIMIT ?2)`,
  ]) {
    if (!(await drain(() => changes(db, sql, serverId, chunk)))) return 'more';
  }

  // Cascades: libraries (and their grants), sync runs, health probes, curation overrides.
  await db.prepare("DELETE FROM servers WHERE id = ? AND status = 'removing'").bind(serverId).run();
  await purgeOrphanEntities(db, chunk);
  return 'done';
}

/**
 * Queue entry point for `purge_server` messages: runs a bounded number of chunks and re-enqueues
 * itself when more remain. Wire it into the queue consumer's dispatch.
 */
export async function runPurgeJob(env: Env, job: PurgeServerJob): Promise<void> {
  const outcome = await purgeServer(env.DB, job.serverId);
  createLogger().info('server.purge', { server_id: job.serverId, outcome });
  if (outcome === 'more') await env.JOBS_QUEUE.send(job);
}

/**
 * WF-10 removal. Hides the server at once, then purges inline up to the chunk budget and hands
 * any remainder to the queue. Repeating the request for a server already `removing` just keeps
 * the purge going.
 */
export async function startServerRemoval(
  c: Context<AppEnv>,
  serverId: string,
): Promise<{ status: 'removing' | 'removed' }> {
  const db = c.env.DB;
  const server = await db
    .prepare('SELECT status FROM servers WHERE id = ?')
    .bind(serverId)
    .first<{ status: string }>();
  if (!server) throw new AppError('NOT_FOUND', 'Not found.');

  if (server.status !== 'removing') {
    const now = Date.now();
    await db.batch([
      db
        .prepare("UPDATE servers SET status = 'removing', updated_at = ? WHERE id = ?")
        .bind(now, serverId),
      db.prepare('DELETE FROM server_credentials WHERE server_id = ?').bind(serverId),
      // M3 revokes these origin credentials (BR-9); marking is enough to make them due.
      db
        .prepare(
          `UPDATE playback_sessions SET revoke_pending = 1
            WHERE server_id = ? AND status IN ('authorized','started') AND credential_envelope IS NOT NULL`,
        )
        .bind(serverId),
      auditStmt(db, {
        id: ulid(),
        now,
        actorUserId: currentUser(c).userId,
        action: 'server.remove',
        targetType: 'server',
        targetId: serverId,
        details: {},
        requestId: c.get('requestId'),
      }),
    ]);
  }
  const outcome = await purgeServer(db, serverId);
  if (outcome === 'more') {
    await c.env.JOBS_QUEUE.send({ type: 'purge_server', serverId } satisfies PurgeServerJob);
    return { status: 'removing' };
  }
  return { status: 'removed' };
}
