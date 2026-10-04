import { Hono } from 'hono';
import type { AppEnv } from './context';
import { errorHandler, notFoundHandler } from './errors';
import { requestId } from './middleware/request-id';
import { requestLog } from './middleware/request-log';
import { securityHeaders } from './middleware/security-headers';
import { health } from './routes/health';

export function createApp() {
  const app = new Hono<AppEnv>();

  app.use(requestId, securityHeaders, requestLog);

  const api = new Hono<AppEnv>();
  api.route('/health', health);
  app.route('/api/v1', api);

  // Anything else under /api is an unknown API route; everything else is the SPA.
  app.all('/api/*', notFoundHandler);
  app.all('*', (c) => c.env.ASSETS.fetch(c.req.raw));

  app.notFound(notFoundHandler);
  app.onError(errorHandler);
  return app;
}
