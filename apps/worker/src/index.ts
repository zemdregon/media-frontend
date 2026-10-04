import { createApp } from './api/app';
import type { Env } from './platform/env';
import { createSyncDeps } from './sync/deps';
import { handleQueue, handleScheduled } from './sync/jobs';

const app = createApp();

export default {
  fetch: app.fetch,

  // Scheduler tick and retention job (LLD-SYNC); `sweepPlaybackSessions`, `sweepAuth` and health
  // probing join the tick in their own tasks.
  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    await handleScheduled(createSyncDeps(env), controller.cron);
  },

  // One message is one sync run (or a purge or re-encryption job); failures retry per message.
  async queue(batch: MessageBatch, env: Env): Promise<void> {
    await handleQueue(batch, env);
  },
} satisfies ExportedHandler<Env>;
