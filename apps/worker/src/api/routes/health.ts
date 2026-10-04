import { Hono } from 'hono';
import type { HealthResponse } from '@cinewren/shared';
import { schemaIsCurrent } from '../../platform/schema-version';
import type { AppEnv } from '../context';

/** Public health endpoint (FR-OPS-007): overall status only, from a cheap D1 `SELECT 1` plus the schema-version check. */
export const health = new Hono<AppEnv>().get('/', async (c) => {
  let status: HealthResponse['status'] = 'ok';
  try {
    await c.env.DB.prepare('SELECT 1').first();
  } catch (err) {
    status = 'degraded';
    c.get('logger').warn('health.db_failed', { error: err });
  }
  // Migrations behind the code (TDD §9.3) is also degraded; the detail is in the API 503s.
  if (status === 'ok' && !(await schemaIsCurrent(c.env.DB))) {
    status = 'degraded';
    c.get('logger').warn('health.migrations_pending');
  }
  c.header('Cache-Control', 'no-store');
  return c.json<HealthResponse>({ status });
});
