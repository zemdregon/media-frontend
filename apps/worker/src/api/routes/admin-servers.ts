import { Hono } from 'hono';
import {
  pageQuery,
  registerServerRequest,
  replaceCredentialsRequest,
  startSyncRequest,
  updateLibraryRequest,
  updateServerRequest,
} from '@cinewren/shared';
import { parseQuery } from '../../catalog/service';
import * as sync from '../../sync/api';
import { startServerRemoval } from '../../servers/purge';
import * as servers from '../../servers/service';
import type { AppEnv } from '../context';
import { parseJson } from '../validation';

/**
 * Operator server registration (LLD-API; FR-SRV-001 to FR-SRV-003, FR-SRV-007, WF-1). Mounted
 * under `/api/v1/admin`, so the operator guard and the CSRF Origin check apply to every route.
 */
export const adminServers = new Hono<AppEnv>()
  .get('/servers', async (c) => c.json(await servers.list(c)))
  .post('/servers', async (c) =>
    c.json(await servers.register(c, await parseJson(c, registerServerRequest)), 201),
  )
  .get('/servers/:id', async (c) => c.json(await servers.get(c, c.req.param('id'))))
  .patch('/servers/:id', async (c) =>
    c.json(await servers.update(c, c.req.param('id'), await parseJson(c, updateServerRequest))),
  )
  .delete('/servers/:id', async (c) => c.json(await startServerRemoval(c, c.req.param('id')), 202))
  .put('/servers/:id/credentials', async (c) => {
    await servers.replaceCredentials(
      c,
      c.req.param('id'),
      await parseJson(c, replaceCredentialsRequest),
    );
    return c.body(null, 204);
  })
  .post('/servers/:id/validate', async (c) => c.json(await servers.validate(c, c.req.param('id'))))
  .get('/servers/:id/libraries', async (c) => c.json(await servers.libraries(c, c.req.param('id'))))
  .post('/servers/:id/sync', async (c) =>
    c.json(await sync.trigger(c, c.req.param('id'), await parseJson(c, startSyncRequest)), 202),
  )
  .get('/servers/:id/sync-runs', async (c) =>
    c.json(await sync.listRuns(c, c.req.param('id'), parseQuery(c, pageQuery))),
  )
  .patch('/libraries/:id', async (c) => {
    const { enabled } = await parseJson(c, updateLibraryRequest);
    return c.json(await servers.setLibraryEnabled(c, c.req.param('id'), enabled));
  });
