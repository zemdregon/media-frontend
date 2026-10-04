/**
 * Operator sync API (LLD-API; FR-SYNC-002, FR-SYNC-006, FR-OPS-003): trigger a run and list a
 * server's run history. Runs are created only through `enqueueRun`, so the per-server lock
 * (`sync_one_active`) applies to manual and scheduled runs alike.
 */
import type { Context } from 'hono';
import type { Page, StartSyncRequest, SyncRun, SyncRunsPage } from '@cinewren/shared';
import type { AppEnv } from '../api/context';
import { AppError } from '../api/errors';
import { currentUser } from '../auth/sessions';
import { expectKey, isNumber, isString, openCursor, sealCursor } from '../catalog/cursor';
import { auditStmt } from '../db/auth';
import { getServer } from '../db/servers';
import { dueServer, listRunsPage, type RunRow } from '../db/sync';
import { ulid } from '../platform/ids';
import { createSyncDeps } from './deps';
import { dueType, enqueueRun, TICK_INTERVAL_MS } from './scheduler';

function toSyncRun(r: RunRow): SyncRun {
  return {
    id: r.id,
    type: r.type,
    trigger: r.trigger,
    status: r.status,
    added: r.added,
    updated: r.updated,
    missing: r.missing,
    errors: r.errors,
    errorSummary: r.error_summary,
    queuedAt: r.queued_at,
    startedAt: r.started_at,
    endedAt: r.ended_at,
  };
}

export async function trigger(
  c: Context<AppEnv>,
  serverId: string,
  body: StartSyncRequest,
): Promise<{ runId: string }> {
  const server = await getServer(c.env.DB, serverId);
  if (!server) throw new AppError('NOT_FOUND', 'Not found.');
  if (server.status !== 'active' && server.status !== 'degraded') {
    throw new AppError('SERVER_DISABLED', 'This server is not active, so it cannot be synced.', {
      status: server.status,
    });
  }
  const deps = createSyncDeps(c.env, { fetchImpl: c.get('originFetch'), logger: c.get('logger') });
  const result = await enqueueRun(deps, serverId, body.type, 'manual');
  if (!result.ok) {
    throw new AppError('SYNC_IN_PROGRESS', 'A sync is already queued or running for this server.', {
      ...(result.runId ? { runId: result.runId } : {}),
    });
  }
  await c.env.DB.batch([
    auditStmt(c.env.DB, {
      id: ulid(),
      now: Date.now(),
      actorUserId: currentUser(c).userId,
      action: 'sync.trigger',
      targetType: 'server',
      targetId: serverId,
      details: { runId: result.runId, type: result.type },
      requestId: c.get('requestId'),
    }),
  ]);
  return { runId: result.runId };
}

export async function listRuns(
  c: Context<AppEnv>,
  serverId: string,
  q: { cursor?: string | undefined; limit: number },
): Promise<SyncRunsPage> {
  const db = c.env.DB;
  const server = await getServer(db, serverId);
  if (!server) throw new AppError('NOT_FOUND', 'Not found.');
  const scope = `sync-runs|${serverId}`;
  const key = expectKey<[number, string]>(await openCursor(c, scope, q.cursor), [
    isNumber,
    isString,
  ]);
  const rows = await listRunsPage(db, serverId, key, q.limit + 1);
  const more = rows.length > q.limit;
  const kept = more ? rows.slice(0, q.limit) : rows;
  const last = kept[kept.length - 1];
  const page: Page<SyncRun> = {
    items: kept.map(toSyncRun),
    nextCursor: more && last ? await sealCursor(c, scope, [last.queued_at, last.id]) : null,
  };
  return { ...page, nextScheduled: await nextScheduled(c, serverId) };
}

/** When the scheduler will next start a run for this server; null when it never will. */
async function nextScheduled(c: Context<AppEnv>, serverId: string): Promise<number | null> {
  const due = await dueServer(c.env.DB, serverId);
  if (!due) return null; // disabled, removing, pending, or no enabled library
  const deps = createSyncDeps(c.env);
  const now = Date.now();
  let at = now;
  // Find the first tick at which a run is due; the answer is bounded by the full interval.
  if (due.last_started !== null) {
    const type = dueType(due, now, deps.config);
    if (!type) at = due.last_started + deps.config.incrementalIntervalMs;
  }
  // Ticks run on a fixed cadence, so the run starts at the first tick on or after it is due.
  return Math.ceil(Math.max(at, now) / TICK_INTERVAL_MS) * TICK_INTERVAL_MS;
}
