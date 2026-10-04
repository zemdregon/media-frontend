/**
 * Cron and queue entry points (LLD-SYNC "Triggers and queues"). `index.ts` only delegates here.
 *
 * Cron: the five-minute tick (TICK_CRON) is the scheduler, the daily one (RETENTION_CRON) the
 * retention job. Queue: one
 * message per sync run; each message is handled in isolation so one server's failure retries on
 * its own and never blocks another's (FR-SYNC-007).
 */
import { isPurgeServerJob, runPurgeJob } from '../servers/purge';
import type { Env } from '../platform/env';
import type { Logger } from '../platform/logger';
import { ROTATION_TABLES, runRotationStep } from '../vault/rotation';
import { createSyncDeps, type JobMessage, type SyncDeps } from './deps';
import { runRetention } from './retention';
import { handleSyncMessage } from './run';
import { schedulerTick } from './scheduler';

export const TICK_CRON = '*/5 * * * *';
export const RETENTION_CRON = '17 3 * * *';

export async function handleScheduled(deps: SyncDeps, cron: string): Promise<void> {
  const log = deps.logger;
  if (cron === RETENTION_CRON) {
    const result = await runRetention(deps);
    log.info('retention.done', { ...result });
    return;
  }
  const tick = await schedulerTick(deps);
  log.info('scheduler.tick', {
    cron,
    enqueued: tick.enqueued.length,
    requeued: tick.reaped.requeued.length,
    failed: tick.reaped.failed.length,
  });
}

/** Handles one queue message. Returns normally to ack; throws to ask the queue to retry. */
export async function handleJob(deps: SyncDeps, job: JobMessage, log: Logger): Promise<void> {
  switch (job.kind) {
    case 'sync':
      await handleSyncMessage(deps, {
        runId: job.runId,
        ...(job.leaseToken ? { leaseToken: job.leaseToken } : {}),
      });
      return;
    case 'reencrypt':
      await handleReencrypt(deps, job, log);
      return;
  }
}

function isJob(body: unknown): body is JobMessage {
  if (typeof body !== 'object' || body === null) return false;
  const kind = (body as { kind?: unknown }).kind;
  return kind === 'sync' || kind === 'reencrypt';
}

export async function handleQueue(
  batch: MessageBatch,
  env: Env,
  deps: SyncDeps = createSyncDeps(env),
): Promise<void> {
  for (const message of batch.messages) {
    // Server removal is typed `{type:'purge_server'}` by T2.6; everything else is `{kind}`.
    if (isPurgeServerJob(message.body)) {
      try {
        await runPurgeJob(env, message.body);
        message.ack();
      } catch (err) {
        deps.logger.error('queue.job_failed', {
          type: 'purge_server',
          attempts: message.attempts,
          error: err instanceof Error ? err.message : String(err),
        });
        message.retry();
      }
      continue;
    }
    if (!isJob(message.body)) {
      deps.logger.warn('queue.unknown_message', { queue: batch.queue });
      message.ack();
      continue;
    }
    try {
      await handleJob(deps, message.body, deps.logger);
      message.ack();
    } catch (err) {
      deps.logger.error('queue.job_failed', {
        kind: message.body.kind,
        attempts: message.attempts,
        error: err instanceof Error ? err.message : String(err),
      });
      message.retry();
    }
  }
}

/**
 * One slice of a master-key rotation (SR-07). It rewrites a bounded number of batches, then
 * enqueues the continuation, so a large vault never runs against the Worker's time limit and an
 * interrupted job resumes from the "not on the current key" selection. A retry after a crash
 * repeats at most one batch, and the compare-and-set makes that harmless.
 */
async function handleReencrypt(
  deps: SyncDeps,
  job: Extract<JobMessage, { kind: 'reencrypt' }>,
  log: Logger,
): Promise<void> {
  const keyring = await deps.keyring();
  const table = job.table !== undefined && ROTATION_TABLES.includes(job.table) ? job.table : null;
  const step = await runRotationStep(
    deps.db,
    keyring,
    table ? { table, after: Math.max(0, Math.floor(Number(job.after) || 0)) } : undefined,
  );
  log.info('vault.rotate.step', {
    reencrypted: step.reencrypted,
    failed: step.failed,
    done: step.next === null,
  });
  if (step.next) await deps.queue.send({ kind: 'reencrypt', ...step.next });
}
