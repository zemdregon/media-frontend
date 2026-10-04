import { Hono, type Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { playRequestSchema, playbackEventSchema, progressUpdateSchema } from '@cinewren/shared';
import { viewerOf } from '../../catalog/service';
import { getVisiblePlayItem } from '../../db/playback';
import { createPlaybackDeps, type PlaybackDeps } from '../../playback/deps';
import { idempotent, parseIdempotencyKey } from '../../playback/idempotency';
import { nextEpisodeCard } from '../../playback/progress';
import { handleEvent, play, putProgress } from '../../playback/service';
import type { AppEnv } from '../context';
import { AppError } from '../errors';
import { parseJson } from '../validation';

/**
 * Playback and progress (LLD-API; FR-PLAY-001 to FR-PLAY-010, FR-PROG-001 to FR-PROG-004).
 * Mounted under `/api/v1`; the session and CSRF guards have already run.
 *
 * No route here, or anywhere in the Worker, returns media bytes: the descriptor points the
 * browser at the origin's own host (FR-PLAY-008, ADR-0002). Responses are JSON or 204 only.
 */
export function playbackDeps(c: Context<AppEnv>): PlaybackDeps {
  return createPlaybackDeps(c.env, {
    fetchImpl: c.get('originFetch'),
    logger: c.get('logger'),
  });
}

/** Runs work after the response when the runtime allows it, inline otherwise (tests). */
async function afterResponse(
  c: Context<AppEnv>,
  deps: PlaybackDeps,
  task: (() => Promise<void>) | null,
): Promise<void> {
  if (!task) return;
  const guarded = () =>
    task().catch((err: unknown) => {
      deps.logger.error('playback.background_failed', { error: err });
    });
  let ctx: { waitUntil(promise: Promise<unknown>): void } | undefined;
  try {
    ctx = c.executionCtx;
  } catch {
    ctx = undefined;
  }
  if (ctx) ctx.waitUntil(guarded());
  else await guarded();
}

export const playbackRoutes = new Hono<AppEnv>()
  .post('/play', async (c) => {
    const key = parseIdempotencyKey(c.req.header('idempotency-key'), true) ?? '';
    const body = await parseJson(c, playRequestSchema);
    const deps = playbackDeps(c);
    const viewer = viewerOf(c);
    const res = await idempotent(
      {
        db: deps.db,
        env: deps.env,
        userId: viewer.userId,
        key,
        route: 'POST /play',
        request: body,
        seal: true,
        now: deps.now(),
      },
      async () => ({ status: 201, body: await play(deps, viewer, body) }),
    );
    c.header('Cache-Control', 'no-store');
    return c.json(res.body as object, res.status as ContentfulStatusCode);
  })
  .post('/play/:sessionId/events', async (c) => {
    const ev = await parseJson(c, playbackEventSchema);
    const deps = playbackDeps(c);
    const task = await handleEvent(deps, viewerOf(c), c.req.param('sessionId'), ev);
    await afterResponse(c, deps, task);
    return c.body(null, 204);
  })
  .put('/progress/:itemId', async (c) => {
    const key = parseIdempotencyKey(c.req.header('idempotency-key'), false);
    const update = await parseJson(c, progressUpdateSchema);
    const deps = playbackDeps(c);
    const viewer = viewerOf(c);
    const itemId = c.req.param('itemId');
    const run = async () => ({
      status: 200,
      body: await putProgress(deps, viewer, itemId, update),
    });
    const res = key
      ? await idempotent(
          {
            db: deps.db,
            env: deps.env,
            userId: viewer.userId,
            key,
            route: `PUT /progress/${itemId}`,
            request: update,
            seal: false,
            now: deps.now(),
          },
          run,
        )
      : await run();
    return c.json(res.body as object, res.status as ContentfulStatusCode);
  })
  .get('/items/:id/next-episode', async (c) => {
    const deps = playbackDeps(c);
    const viewer = viewerOf(c);
    const item = await getVisiblePlayItem(deps.db, viewer, c.req.param('id'));
    if (!item) throw new AppError('NOT_FOUND', 'Not found.');
    if (item.type !== 'series') return c.json(null);
    return c.json(await nextEpisodeCard(deps.db, viewer, item.id));
  });
