import { Hono } from 'hono';
import { originCheck, requireOperator, requireSession } from '../auth/sessions';
import type { AppEnv } from './context';
import { errorHandler, notFoundHandler } from './errors';
import { loadConfig } from './middleware/config';
import { requestId } from './middleware/request-id';
import { requestLog } from './middleware/request-log';
import { securityHeaders } from './middleware/security-headers';
import { adminInvites } from './routes/admin-invites';
import { adminServers } from './routes/admin-servers';
import { adminUsers } from './routes/admin-users';
import { artwork } from './routes/artwork';
import { catalogRoutes } from './routes/catalog';
import { login, logout } from './routes/auth';
import { health } from './routes/health';
import { publicInvites } from './routes/invites';
import { me } from './routes/me';
import { setup } from './routes/setup';

/**
 * Route table. Order matters: everything registered after `requireSession` needs a session
 * (FR-USR-001, SDD INV-9). The only public API routes are the ones listed in PUBLIC_API_ROUTES.
 */
export const PUBLIC_API_ROUTES = [
  'GET /api/v1/health',
  'GET /api/v1/setup',
  'POST /api/v1/setup/options',
  'POST /api/v1/setup/verify',
  'POST /api/v1/invites/inspect',
  'POST /api/v1/invites/redeem/options',
  'POST /api/v1/invites/redeem/verify',
  'POST /api/v1/auth/login/options',
  'POST /api/v1/auth/login/verify',
] as const;

export interface AppOptions {
  /**
   * The `fetch` used for every origin request (behind the host-pinning wrapper, TDD 6.4).
   * Defaults to the runtime's `fetch`; tests inject a fixture-backed fake.
   */
  originFetch?: typeof fetch;
}

export function createApp(options: AppOptions = {}) {
  const app = new Hono<AppEnv>();
  const originFetch: typeof fetch = options.originFetch ?? ((input, init) => fetch(input, init));

  app.use(requestId, securityHeaders, requestLog);
  app.use(async (c, next) => {
    c.set('originFetch', originFetch);
    await next();
  });

  // Public, and answers even when the Worker is misconfigured (TDD §4).
  app.route('/api/v1/health', health);

  app.use(loadConfig);
  app.use('/api/*', originCheck);

  // Public auth routes (rate limited inside each router).
  app.route('/api/v1/setup', setup);
  app.route('/api/v1/invites', publicInvites);
  app.route('/api/v1/auth/login', login);

  // Everything below requires a session.
  app.use('/api/*', requireSession);
  app.route('/api/v1/auth/logout', logout);
  app.route('/api/v1/me', me);
  app.route('/api/v1/artwork', artwork);
  app.route('/api/v1', catalogRoutes);

  app.use('/api/v1/admin/*', requireOperator);
  app.route('/api/v1/admin/invites', adminInvites);
  app.route('/api/v1/admin/users', adminUsers);
  app.route('/api/v1/admin', adminServers);

  // Anything else under /api is an unknown API route; everything else is the SPA.
  app.all('/api/*', notFoundHandler);
  app.all('*', (c) => c.env.ASSETS.fetch(c.req.raw));

  app.notFound(notFoundHandler);
  app.onError(errorHandler);
  return app;
}
