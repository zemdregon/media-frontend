import { Hono } from 'hono';
import { loginVerifyRequest } from '@cinewren/shared';
import { loginOptions, loginVerify } from '../../auth/login';
import { endSession } from '../../auth/sessions';
import type { AppEnv } from '../context';
import { authRateLimit } from '../middleware/rate-limit';
import { parseJson } from '../validation';

/** Public login ceremony (FR-USR-001), rate limited per IP (NFR-SEC-004). */
export const login = new Hono<AppEnv>()
  .use(authRateLimit)
  .post('/options', async (c) => c.json(await loginOptions(c)))
  .post('/verify', async (c) =>
    c.json({ user: await loginVerify(c, await parseJson(c, loginVerifyRequest)) }),
  );

/** Session-only auth routes. */
export const logout = new Hono<AppEnv>().post('/', async (c) => {
  await endSession(c);
  return c.body(null, 204);
});
