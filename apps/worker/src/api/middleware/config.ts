import { createMiddleware } from 'hono/factory';
import { getConfig } from '../../platform/config';
import type { AppEnv } from '../context';

/** Resolves config once per request; a misconfigured Worker answers 500 (TDD §4). */
export const loadConfig = createMiddleware<AppEnv>(async (c, next) => {
  c.set('config', getConfig(c.env));
  await next();
});
