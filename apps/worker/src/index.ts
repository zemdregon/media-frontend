import { createApp } from './api/app';
import { createPlaybackDeps } from './playback/deps';
import { sweepPlaybackSessions } from './playback/lifecycle';
import type { Env } from './platform/env';
import { createLogger } from './platform/logger';
import { createSyncDeps } from './sync/deps';
import { handleQueue, handleScheduled, TICK_CRON } from './sync/jobs';

const app = createApp();

export default {
  fetch: app.fetch,

  // Scheduler tick and retention job (LLD-SYNC), plus the BR-9 playback sweep on the tick
  // (LLD-TOKEN). The two run independently: one failing never skips the other. `sweepAuth` and
  // health probing join the tick in their own tasks.
  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    const logger = createLogger();
    const tasks: Promise<unknown>[] = [
      handleScheduled(createSyncDeps(env, { logger }), controller.cron),
    ];
    if (controller.cron === TICK_CRON) {
      tasks.push(
        sweepPlaybackSessions(createPlaybackDeps(env, { logger })).then((r) => {
          logger.info('playback.sweep', { ...r });
        }),
      );
    }
    const results = await Promise.allSettled(tasks);
    const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (failed)
      throw failed.reason instanceof Error ? failed.reason : new Error('Scheduled task failed.');
  },

  // One message is one sync run (or a purge or re-encryption job); failures retry per message.
  async queue(batch: MessageBatch, env: Env): Promise<void> {
    await handleQueue(batch, env);
  },
} satisfies ExportedHandler<Env>;
