import { Hono } from 'hono';
import { inviteTokenRequest, redeemVerifyRequest } from '@cinewren/shared';
import { inspectInvite, redeemOptions, redeemVerify } from '../../auth/invites';
import type { AppEnv } from '../context';
import { authRateLimit } from '../middleware/rate-limit';
import { parseJson } from '../validation';

/** Public invite redemption (FR-USR-002, FR-USR-007), rate limited per IP (NFR-SEC-004). */
export const publicInvites = new Hono<AppEnv>()
  .use(authRateLimit)
  .post('/inspect', async (c) =>
    c.json(await inspectInvite(c, (await parseJson(c, inviteTokenRequest)).token)),
  )
  .post('/redeem/options', async (c) =>
    c.json(await redeemOptions(c, (await parseJson(c, inviteTokenRequest)).token)),
  )
  .post('/redeem/verify', async (c) =>
    c.json({ user: await redeemVerify(c, await parseJson(c, redeemVerifyRequest)) }, 201),
  );
