import { createMiddleware } from 'hono/factory';
import { ulid } from '../../platform/ids';
import type { AppEnv } from '../context';

const VALID_REQUEST_ID = /^[A-Za-z0-9._-]{8,64}$/;

/** Sets `x-request-id` on every response; reuses a well-formed inbound value (IR-001). */
export const requestId = createMiddleware<AppEnv>(async (c, next) => {
  const inbound = c.req.header('x-request-id');
  const id = inbound && VALID_REQUEST_ID.test(inbound) ? inbound : ulid();
  c.set('requestId', id);
  c.header('x-request-id', id);
  await next();
});
