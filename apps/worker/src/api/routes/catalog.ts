import { Hono } from 'hono';
import { browseQuery, pageQuery, searchQuery } from '@cinewren/shared';
import * as catalog from '../../catalog/service';
import type { AppEnv } from '../context';

/**
 * Catalog reads for any signed-in user (LLD-API; FR-CAT-002 to FR-CAT-006, FR-CAT-008,
 * FR-CAT-011, FR-CAT-012). Mounted under `/api/v1`; the session guard has already run.
 */
export const catalogRoutes = new Hono<AppEnv>()
  .get('/home', async (c) => c.json(await catalog.home(c)))
  .get('/items', async (c) => c.json(await catalog.browse(c, catalog.parseQuery(c, browseQuery))))
  .get('/items/:id', async (c) => c.json(await catalog.itemDetail(c, c.req.param('id'))))
  .get('/items/:id/children', async (c) =>
    c.json(await catalog.itemChildren(c, c.req.param('id'), catalog.parseQuery(c, pageQuery))),
  )
  .get('/items/:id/versions', async (c) => c.json(await catalog.itemVersions(c, c.req.param('id'))))
  .get('/search', async (c) => c.json(await catalog.search(c, catalog.parseQuery(c, searchQuery))))
  .get('/people/:id', async (c) =>
    c.json(await catalog.person(c, c.req.param('id'), catalog.parseQuery(c, pageQuery))),
  )
  .get('/collections', async (c) =>
    c.json(await catalog.collections(c, catalog.parseQuery(c, pageQuery))),
  )
  .get('/collections/:id', async (c) =>
    c.json(await catalog.collection(c, c.req.param('id'), catalog.parseQuery(c, pageQuery))),
  );
