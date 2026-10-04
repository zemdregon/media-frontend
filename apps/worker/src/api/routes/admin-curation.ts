import { Hono } from 'hono';
import {
  conflictsQuery,
  ENTITY_KINDS,
  mergeRequest,
  overridesQuery,
  resolveConflictRequest,
  splitRequest,
  type EntityKind,
} from '@cinewren/shared';
import { parseQuery } from '../../catalog/service';
import * as curation from '../../curation/service';
import type { AppEnv } from '../context';
import { AppError } from '../errors';
import { parseJson } from '../validation';

/**
 * Operator curation (LLD-API; FR-CAT-007, FR-CAT-010, WF-9). Mounted under `/api/v1/admin/curation`,
 * so the operator guard and the CSRF Origin check apply to every route.
 */
const kindParam = (value: string): EntityKind => {
  const kind = ENTITY_KINDS.find((k) => k === value);
  if (!kind) throw new AppError('NOT_FOUND', 'Not found.');
  return kind;
};

export const adminCuration = new Hono<AppEnv>()
  .post('/merge', async (c) => c.json(await curation.merge(c, await parseJson(c, mergeRequest))))
  .post('/split', async (c) => c.json(await curation.split(c, await parseJson(c, splitRequest))))
  .get('/entities/:kind/:id', async (c) =>
    c.json(await curation.entity(c, kindParam(c.req.param('kind')), c.req.param('id'))),
  )
  .get('/overrides', async (c) =>
    c.json(await curation.listOverrides(c, parseQuery(c, overridesQuery))),
  )
  .delete('/overrides/:id', async (c) => {
    await curation.deleteOverride(c, c.req.param('id'));
    return c.body(null, 204);
  })
  .get('/conflicts', async (c) =>
    c.json(await curation.listConflicts(c, parseQuery(c, conflictsQuery))),
  )
  .post('/conflicts/:id/resolve', async (c) =>
    c.json(
      await curation.resolveConflict(
        c,
        c.req.param('id'),
        await parseJson(c, resolveConflictRequest),
      ),
    ),
  );
