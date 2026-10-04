import { Hono } from 'hono';
import { grantsRequest, pageQuery, updateUserRequest } from '@cinewren/shared';
import { parseQuery } from '../../catalog/service';
import * as users from '../../users/service';
import type { AppEnv } from '../context';
import { parseJson } from '../validation';

/**
 * Operator user management (FR-USR-005, FR-USR-007, FR-USR-008, BR-8). Mounted under
 * `/api/v1/admin/users`, so the operator guard and CSRF Origin check have already run.
 */
export const adminUsers = new Hono<AppEnv>()
  .get('/', async (c) => c.json(await users.list(c, parseQuery(c, pageQuery))))
  .patch('/:id', async (c) =>
    c.json(await users.update(c, c.req.param('id'), await parseJson(c, updateUserRequest))),
  )
  .delete('/:id', async (c) => {
    await users.remove(c, c.req.param('id'));
    return c.body(null, 204);
  })
  .put('/:id/grants', async (c) => {
    const { libraryIds } = await parseJson(c, grantsRequest);
    return c.json(await users.setGrants(c, c.req.param('id'), libraryIds));
  })
  .post('/:id/reenroll', async (c) => c.json(await users.reenroll(c, c.req.param('id')), 201));
