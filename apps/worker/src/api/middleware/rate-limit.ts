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
