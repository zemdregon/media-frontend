import { createMiddleware } from 'hono/factory';
import { MIGRATIONS_PENDING_MESSAGE, schemaIsCurrent } from '../../platform/schema-version';
import type { AppEnv } from '../context';
import { errorResponse } from '../errors';

/** 503 `MIGRATIONS_PENDING` on API routes while D1 is behind the code (TDD §9.3). */
export const schemaGuard = createMiddleware<AppEnv>(async (c, next) => {
  if (!(await schemaIsCurrent(c.env.DB))) {
    c.header('Retry-After', '60');
    return errorResponse(c, 'MIGRATIONS_PENDING', MIGRATIONS_PENDING_MESSAGE);
  }
  await next();
});
