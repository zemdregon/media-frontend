import { createMiddleware } from 'hono/factory';
import { createLogger } from '../../platform/logger';
import type { AppEnv } from '../context';

/** Binds a request-scoped logger and writes one `http.request` line per request. */
export const requestLog = createMiddleware<AppEnv>(async (c, next) => {
  const logger = createLogger({ request_id: c.get('requestId') });
  c.set('logger', logger);
  const start = Date.now();
  await next();
  logger.info('http.request', {
    method: c.req.method,
    route: new URL(c.req.url).pathname,
    status: c.res.status,
    duration_ms: Date.now() - start,
  });
});
