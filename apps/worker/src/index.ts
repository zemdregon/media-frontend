import { createApp } from './api/app';
import { createLogger } from './platform/logger';
import type { Env } from './platform/env';

const app = createApp();

export default {
  fetch: app.fetch,

  // Placeholders so the cron and queue entries in wrangler.jsonc have handlers.
  // The scheduler (LLD-SYNC) and job consumers arrive in later milestones.
  scheduled(controller: ScheduledController): void {
    createLogger().info('scheduled.tick', { cron: controller.cron });
  },
  queue(batch: MessageBatch): void {
    createLogger().warn('queue.unhandled', { queue: batch.queue, size: batch.messages.length });
    batch.retryAll();
  },
} satisfies ExportedHandler<Env>;
