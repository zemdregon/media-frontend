import { createApp } from './api/app';
import { isProbeTick, probeAll } from './health/probe';
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
  // (LLD-TOKEN). The two run independently: one failing never skips the other. `sweepAuth` joins
  // the tick in its own task; health probing is one of the tick's tasks (LLD-SYNC).
  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    const logger = createLogger();
    const tasks: Promise<unknown>[] = [
      handleScheduled(createSyncDeps(env, { logger }), controller.cron),
    ];
    if (controller.cron === TICK_CRON) {
      // Health probing (FR-OPS-001): every HEALTH_PROBE_INTERVAL_MIN (default 5) minutes.
      const interval = Number(env.HEALTH_PROBE_INTERVAL_MIN);
      if (
        isProbeTick(
          controller.scheduledTime,
          Number.isFinite(interval) && interval > 0 ? interval : 5,
        )
      ) {
        const deps = createSyncDeps(env, { logger });
        tasks.push(
          probeAll(deps).then((o) => {
            logger.info('probe.round', {
              servers: o.length,
              failed: o.filter((x) => !x.ok).length,
            });
          }),
        );
      }
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
