import type { Env } from '../platform/env';
import type { Logger } from '../platform/logger';

/** Hono environment shared by every route and middleware. */
export interface AppEnv {
  Bindings: Env;
  Variables: { requestId: string; logger: Logger };
}
