import { createMiddleware } from 'hono/factory';
import type { AppEnv } from '../context';
import { errorResponse } from '../errors';

/**
 * Per-IP limit on the public auth endpoints: setup, invite redemption and login (NFR-SEC-004,
 * TDD §6.3). Uses the `RL_AUTH` Workers rate limiting binding; tests swap the binding.
 */
export const authRateLimit = createMiddleware<AppEnv>(async (c, next) => {
  const ip = c.req.header('cf-connecting-ip') ?? 'unknown';
  const { success } = await c.env.RL_AUTH.limit({ key: `auth:${ip}` });
  if (!success) {
    c.get('logger').warn('auth.rate_limited', { route: new URL(c.req.url).pathname });
    c.header('Retry-After', '60');
    return errorResponse(c, 'RATE_LIMITED', 'Too many requests. Try again in a moment.');
  }
  await next();
});

export type UserLimitClass = 'play' | 'mutation';

/**
 * Which per-user limiter a request counts against (NFR-SEC-008, TDD-D5): `POST /play` has its
 * own, tighter budget; progress events and operator mutations share the other.
 */
export function classifyUserLimit(method: string, path: string): UserLimitClass | null {
  if (method === 'POST' && path === '/api/v1/play') return 'play';
  if (method === 'POST' && /^\/api\/v1\/play\/[^/]+\/events$/.test(path)) return 'mutation';
  if (method === 'PUT' && path.startsWith('/api/v1/progress/')) return 'mutation';
  if (path.startsWith('/api/v1/admin/') && method !== 'GET' && method !== 'HEAD') return 'mutation';
  return null;
}

/**
 * Per-user limits on play, progress and operator mutations (NFR-SEC-008). Keyed by user ID, so
 * one viewer cannot spend another's budget. Uses the `RL_PLAY` and `RL_MUTATION` bindings; tests
 * swap the bindings. Runs after the session guard, so the user is known.
 */
export const userRateLimit = createMiddleware<AppEnv>(async (c, next) => {
  const auth = c.get('auth');
  const klass = auth ? classifyUserLimit(c.req.method, new URL(c.req.url).pathname) : null;
  if (auth && klass) {
    const limiter = klass === 'play' ? c.env.RL_PLAY : c.env.RL_MUTATION;
    const { success } = await limiter.limit({ key: `${klass}:${auth.userId}` });
    if (!success) {
      c.get('logger').warn('rate_limited', {
        route: new URL(c.req.url).pathname,
        limit: klass,
        metric: 'rate_limit.exceeded',
      });
      c.header('Retry-After', '60');
      return errorResponse(c, 'RATE_LIMITED', 'Too many requests. Try again in a moment.', {
        retryAfterS: 60,
      });
    }
  }
  await next();
});
