/**
 * Cron and queue entry points (LLD-SYNC "Triggers and queues"). `index.ts` only delegates here.
 *
 * Cron: the five-minute tick (TICK_CRON) is the scheduler, the daily one (RETENTION_CRON) the
 * retention job. Queue: one
 * message per sync run; each message is handled in isolation so one server's failure retries on
 * its own and never blocks another's (FR-SYNC-007).
 */
import type { Logger } from '../platform/logger';
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
    case 'purge_server':
    case 'reencrypt':
      // Owned by T2.6 (server removal) and the credential-rotation task; acknowledged so they do
      // not loop through the retry and dead-letter path before those handlers land.
      log.warn('queue.job_not_handled', { kind: job.kind });
      return;
  }
}

function isJob(body: unknown): body is JobMessage {
  if (typeof body !== 'object' || body === null) return false;
  const kind = (body as { kind?: unknown }).kind;
  return kind === 'sync' || kind === 'purge_server' || kind === 'reencrypt';
}

export async function handleQueue(
  batch: MessageBatch,
  env: Parameters<typeof createSyncDeps>[0],
  deps: SyncDeps = createSyncDeps(env),
): Promise<void> {
  for (const message of batch.messages) {
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
