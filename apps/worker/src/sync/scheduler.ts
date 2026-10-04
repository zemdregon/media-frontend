/**
 * Scheduler tick and run creation (LLD-SYNC "Scheduler tick", FR-SYNC-001, FR-SYNC-002, ADR-0009).
 *
 * `enqueueRun` is the only way a run is created, for the schedule and for the operator's
 * "sync now": the insert fails on the `sync_one_active` unique index while the server already has
 * a queued or running run, which is the per-server lock (no separate lock table, no TTL bugs).
 */
import {
  failRunUnleased,
  getActiveRun,
  insertRun,
  listSchedulableServers,
  listStaleRuns,
  setCheckpoint,
  upgradeQueuedToFull,
  type RunType,
} from '../db/sync';
import { parseCheckpoint } from './run';
import type { SyncDeps } from './deps';

/** The cron tick cadence (every five minutes); a run due between ticks starts at the next one. */
export const TICK_INTERVAL_MS = 5 * 60_000;

export type EnqueueResult =
  | { ok: true; runId: string; type: RunType }
  /** The server already has an active run: the API maps this to `409 SYNC_IN_PROGRESS`. */
  | { ok: false; reason: 'in_progress'; runId: string | null };

export async function enqueueRun(
  deps: SyncDeps,
  serverId: string,
  type: RunType,
  trigger: 'schedule' | 'manual',
  options: { force?: boolean } = {},
): Promise<EnqueueResult> {
  const { db } = deps;
  const now = deps.now();
  let effective = type;
  let sinceMs: number | null = null;
  if (type === 'incremental') {
    const row = await db
      .prepare(
        `SELECT MAX(started_at) AS at FROM sync_runs WHERE server_id = ? AND status = 'succeeded'`,
      )
      .bind(serverId)
      .first<{ at: number | null }>();
    // With no successful run to measure from, an incremental has nothing to be incremental
    // against: list everything.
    if (row?.at == null) effective = 'full';
    else sinceMs = Math.max(0, row.at - deps.config.incrementalSkewMs);
  }
  const runId = deps.newId();
  const checkpoint = JSON.stringify({
    libraryIdx: 0,
    cursor: null,
    ...(options.force ? { force: true } : {}),
  });
  const inserted = await insertRun(db, {
    id: runId,
    serverId,
    type: effective,
    trigger,
    sinceMs,
    checkpoint,
    now,
  });
  if (!inserted) {
    if (effective === 'full') await upgradeQueuedToFull(db, serverId);
    return {
      ok: false,
      reason: 'in_progress',
      runId: (await getActiveRun(db, serverId))?.id ?? null,
    };
  }
  await deps.queue.send({ kind: 'sync', runId });
  return { ok: true, runId, type: effective };
}

export interface TickResult {
  enqueued: { serverId: string; runId: string; type: RunType }[];
  reaped: { requeued: string[]; failed: string[] };
}

/** Which run type a server is due for, or null (WF-2, FR-SYNC-001). */
export function dueType(
  server: { last_started: number | null; last_full_ok: number | null },
  now: number,
  config: Pick<SyncDeps['config'], 'incrementalIntervalMs' | 'fullIntervalMs'>,
): RunType | null {
  if (server.last_started === null) return 'full'; // first sync after registration (WF-1)
  // A failing server is retried at the incremental cadence, not on every tick.
  if (now - server.last_started < config.incrementalIntervalMs) return null;
  if (server.last_full_ok === null || now - server.last_full_ok >= config.fullIntervalMs)
    return 'full';
  return 'incremental';
}

export async function schedulerTick(deps: SyncDeps): Promise<TickResult> {
  const now = deps.now();
  const result: TickResult = { enqueued: [], reaped: { requeued: [], failed: [] } };
  for (const server of await listSchedulableServers(deps.db)) {
    const type = dueType(server, now, deps.config);
    if (!type) continue;
    try {
      const r = await enqueueRun(deps, server.id, type, 'schedule');
      if (r.ok) result.enqueued.push({ serverId: server.id, runId: r.runId, type: r.type });
    } catch (err) {
      // One server's enqueue failure must not stop the others (FR-SYNC-007).
      deps.logger.error('sync.enqueue_failed', {
        server_id: server.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  result.reaped = await reapStaleLeases(deps);
  return result;
}

/**
 * A run whose lease expired more than 15 minutes ago is re-enqueued (at most 3 times), then
 * failed (LLD-SYNC). A run that sat `queued` for as long (the queue send failed, or the message
 * was dead-lettered) is re-enqueued too, so it can never hold the server lock forever.
 */
export async function reapStaleLeases(deps: SyncDeps): Promise<TickResult['reaped']> {
  const { db, config } = deps;
  const now = deps.now();
  const out: TickResult['reaped'] = { requeued: [], failed: [] };
  for (const run of await listStaleRuns(db, now - config.reapAfterMs)) {
    const cp = parseCheckpoint(run.checkpoint);
    const reaps = (cp.reaps ?? 0) + 1;
    if (reaps > config.maxReaps) {
      if (
        await failRunUnleased(
          db,
          run.id,
          'The run stopped responding and was abandoned (dead-lettered).',
          now,
        )
      ) {
        out.failed.push(run.id);
      }
      continue;
    }
    await setCheckpoint(db, run.id, JSON.stringify({ ...cp, reaps }));
    await deps.queue.send({ kind: 'sync', runId: run.id });
    out.requeued.push(run.id);
  }
  const stuck = await db
    .prepare(`SELECT id FROM sync_runs WHERE status = 'queued' AND queued_at < ?`)
    .bind(now - config.reapAfterMs)
    .all<{ id: string }>();
  for (const r of stuck.results) {
    await deps.queue.send({ kind: 'sync', runId: r.id });
    out.requeued.push(r.id);
  }
  return out;
}
