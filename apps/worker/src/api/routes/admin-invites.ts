import { Hono } from 'hono';
import { createInviteRequest, inviteStatus } from '@cinewren/shared';
import { createInvite, listInvites, revokeInvite } from '../../auth/invites';
import type { AppEnv } from '../context';
import { AppError } from '../errors';
import { parseJson } from '../validation';

/** Operator invite management (FR-USR-004); the operator guard is applied by the router. */
export const adminInvites = new Hono<AppEnv>()
  .post('/', async (c) => c.json(await createInvite(c, await parseJson(c, createInviteRequest)), 201))
  .get('/', async (c) => {
    const raw = c.req.query('status');
    const status = raw === undefined ? undefined : inviteStatus.safeParse(raw);
    if (status && !status.success) {
      throw new AppError('VALIDATION_FAILED', 'The request was invalid.', { fields: ['status'] });
    }
    return c.json(await listInvites(c, status?.data));
  })
  .delete('/:id', async (c) => {
    await revokeInvite(c, c.req.param('id'));
    return c.body(null, 204);
  });
