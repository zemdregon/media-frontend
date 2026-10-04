import { Hono } from 'hono';
import type { HealthResponse } from '@cinewren/shared';
import type { AppEnv } from '../context';

/** Public health endpoint (FR-OPS-007): overall status only, from a cheap D1 `SELECT 1`. */
export const health = new Hono<AppEnv>().get('/', async (c) => {
  let status: HealthResponse['status'] = 'ok';
  try {
    await c.env.DB.prepare('SELECT 1').first();
  } catch (err) {
    status = 'degraded';
    c.get('logger').warn('health.db_failed', { error: err });
  }
  c.header('Cache-Control', 'no-store');
  return c.json<HealthResponse>({ status });
});
