import { Hono } from 'hono';
import { setupOptionsRequest, setupVerifyRequest, type SetupStatus } from '@cinewren/shared';
import { setupAvailable, setupOptions, setupVerify } from '../../auth/setup';
import type { AppEnv } from '../context';
import { authRateLimit } from '../middleware/rate-limit';
import { parseJson } from '../validation';

/** Public setup endpoints (FR-USR-002), rate limited per IP (NFR-SEC-004). */
export const setup = new Hono<AppEnv>()
  .use(authRateLimit)
  .get('/', async (c) => c.json<SetupStatus>({ available: await setupAvailable(c.env.DB) }))
  .post('/options', async (c) => c.json(await setupOptions(c, await parseJson(c, setupOptionsRequest))))
  .post('/verify', async (c) =>
    c.json({ user: await setupVerify(c, await parseJson(c, setupVerifyRequest)) }, 201),
  );
